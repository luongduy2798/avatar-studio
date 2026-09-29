from __future__ import annotations

import json
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .infrastructure import JobStore, Queue, QueueMessage, Storage
from .service import ExpressionBatchRequest, ExpressionService


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class _PendingGeneration:
    message: QueueMessage
    job: dict[str, Any]
    attempt: int
    scratch: Path
    input_path: Path
    job_dir: Path


class GenerationWorker:
    def __init__(
        self,
        settings: Settings,
        job_store: JobStore,
        storage: Storage,
        queue: Queue,
        service: ExpressionService,
    ) -> None:
        self.settings = settings
        self.job_store = job_store
        self.storage = storage
        self.queue = queue
        self.service = service

    def run_forever(self) -> None:
        while True:
            messages = self.queue.receive_batch(
                self.settings.worker_job_batch_size,
                self.settings.worker_job_batch_wait_seconds,
            )
            if not messages:
                time.sleep(self.settings.worker_poll_seconds)
                continue
            self._process_messages(messages)

    def _save(self, job: dict[str, Any], **changes: Any) -> dict[str, Any]:
        job.update(changes)
        job["updatedAt"] = utc_now()
        self.job_store.put(job)
        return job

    def _sync_progress(self, job: dict[str, Any], progress_path: Path) -> dict[str, Any]:
        if not progress_path.is_file():
            return job
        try:
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return job
        total = max(1, len(job["expressions"]))
        prepared = min(len(progress.get("prepared", [])), total)
        completed = min(len(progress.get("completed", [])), total)
        next_progress = {
            "prepared": prepared,
            "completed": completed,
            "total": total,
            "percent": round(((0.9 * prepared + 0.1 * completed) / total) * 100),
        }
        if next_progress == job.get("progress"):
            return job
        return self._save(
            job,
            stage="expressions" if prepared < total else "export",
            progress=next_progress,
        )

    def _mark_failed(
        self,
        message: QueueMessage,
        job: dict[str, Any],
        attempt: int,
        error: Exception | str,
    ) -> None:
        final_attempt = attempt >= self.settings.worker_max_attempts
        self._save(
            job,
            status="failed" if final_attempt else "retrying",
            stage="failed" if final_attempt else "retrying",
            error=str(error),
            attempt=attempt,
        )
        if final_attempt:
            self.queue.dead_letter(message)
        else:
            self.queue.retry(message)

    def _prepare_message(self, message: QueueMessage) -> _PendingGeneration | None:
        job_id = str(message.body.get("jobId", ""))
        job = self.job_store.get(job_id)
        if job is None or job.get("status") == "completed":
            self.queue.ack(message)
            return None

        attempt = max(int(job.get("attempt", 0)) + 1, message.receive_count)
        if attempt > self.settings.worker_max_attempts:
            self._save(
                job,
                status="failed",
                stage="failed",
                error="Generation failed after the maximum retry count.",
                attempt=attempt,
            )
            self.queue.dead_letter(message)
            return None

        scratch = self.settings.runtime_root / "work" / job_id
        shutil.rmtree(scratch, ignore_errors=True)
        scratch.mkdir(parents=True, exist_ok=True)
        input_path = scratch / f"source{Path(str(job['inputKey'])).suffix or '.jpg'}"
        job_dir = scratch / "generation"
        job_dir.mkdir(parents=True, exist_ok=True)

        try:
            self._save(
                job,
                status="processing",
                stage="preprocess",
                attempt=attempt,
                startedAt=job.get("startedAt") or utc_now(),
                error=None,
            )
            self.storage.materialize_input(str(job["inputKey"]), input_path)
            return _PendingGeneration(
                message=message,
                job=job,
                attempt=attempt,
                scratch=scratch,
                input_path=input_path,
                job_dir=job_dir,
            )
        except Exception as exc:
            self._mark_failed(message, job, attempt, exc)
            shutil.rmtree(scratch, ignore_errors=True)
            return None

    def _process_messages(self, messages: list[QueueMessage]) -> None:
        pending = [
            prepared
            for message in messages
            if (prepared := self._prepare_message(message)) is not None
        ]
        if not pending:
            return

        requests = [
            ExpressionBatchRequest(
                generator=str(item.job.get("generator", "liveportrait")),
                source_image=item.input_path,
                expressions=[str(value) for value in item.job["expressions"]],
                intensity=float(item.job["intensity"]),
                job_dir=item.job_dir,
            )
            for item in pending
        ]

        batch_results: list[Any]
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(self.service.generate_batch, requests)
                last_heartbeat = time.monotonic()
                while not future.done():
                    time.sleep(0.35)
                    for item in pending:
                        item.job = self._sync_progress(
                            item.job,
                            item.job_dir / "progress.json",
                        )
                    if time.monotonic() - last_heartbeat >= 30:
                        for item in pending:
                            self.queue.heartbeat(item.message)
                        last_heartbeat = time.monotonic()
                batch_results = future.result()
        except Exception as exc:
            for item in pending:
                self._mark_failed(item.message, item.job, item.attempt, exc)
                shutil.rmtree(item.scratch, ignore_errors=True)
            return

        if len(batch_results) != len(pending):
            error = RuntimeError("Generation batch returned an incomplete result set.")
            for item in pending:
                self._mark_failed(item.message, item.job, item.attempt, error)
                shutil.rmtree(item.scratch, ignore_errors=True)
            return

        for item, result in zip(pending, batch_results):
            try:
                if isinstance(result, Exception):
                    raise result
                job_id = str(item.job["jobId"])
                self._save(item.job, stage="uploading")
                outputs: list[dict[str, str]] = []
                for generated in result:
                    key = f"jobs/{job_id}/outputs/{generated.expression}.png"
                    self.storage.put_output(key, generated.file_path)
                    outputs.append({"expression": generated.expression, "key": key})
                total = len(outputs)
                self._save(
                    item.job,
                    status="completed",
                    stage="completed",
                    outputs=outputs,
                    progress={
                        "prepared": total,
                        "completed": total,
                        "total": total,
                        "percent": 100,
                    },
                    completedAt=utc_now(),
                    error=None,
                )
                self.queue.ack(item.message)
            except Exception as exc:
                self._mark_failed(item.message, item.job, item.attempt, exc)
            finally:
                shutil.rmtree(item.scratch, ignore_errors=True)

    def _process_message(self, message: QueueMessage) -> None:
        self._process_messages([message])
