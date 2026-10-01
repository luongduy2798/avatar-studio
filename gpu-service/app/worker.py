from __future__ import annotations

import json
import shutil
import time
import traceback
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
    message: QueueMessage | None
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
            try:
                self._process_messages(messages)
            except Exception as exc:
                print(f"Worker message failed: {exc}", flush=True)
                traceback.print_exc()
                for message in messages:
                    self._recover_failed_message(message, exc)

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
        raw_timings = progress.get("timings", {})
        if isinstance(raw_timings, dict):
            next_timings = {
                str(key): float(value)
                for key, value in raw_timings.items()
                if isinstance(value, (int, float))
            }
        else:
            next_timings = {}
        if next_progress == job.get("progress") and next_timings == job.get("timings", {}):
            return job
        changes: dict[str, Any] = {
            "stage": "expressions" if prepared < total else "export",
            "progress": next_progress,
        }
        if next_timings:
            changes["timings"] = next_timings
        return self._save(job, **changes)

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

    def _process_generation_messages(self, messages: list[QueueMessage]) -> None:
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

    def _prepare_benchmark_job(self, job: dict[str, Any]) -> _PendingGeneration | None:
        if job.get("status") in {"completed", "failed"}:
            return None

        job_id = str(job["jobId"])
        run_id = str(job.get("runId", "benchmark"))
        scratch = self.settings.runtime_root / "work" / run_id / job_id
        shutil.rmtree(scratch, ignore_errors=True)
        scratch.mkdir(parents=True, exist_ok=True)
        input_path = scratch / f"source{Path(str(job['inputKey'])).suffix or '.jpg'}"
        job_dir = scratch / "generation"
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            attempt = max(1, int(job.get("attempt", 0)) + 1)
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
                message=None,
                job=job,
                attempt=attempt,
                scratch=scratch,
                input_path=input_path,
                job_dir=job_dir,
            )
        except Exception as exc:
            self._save(
                job,
                status="failed",
                stage="failed",
                attempt=1,
                error=str(exc),
                completedAt=utc_now(),
            )
            shutil.rmtree(scratch, ignore_errors=True)
            return None

    def _run_provider_batch(
        self,
        pending: list[_PendingGeneration],
        heartbeat_message: QueueMessage | None = None,
    ) -> list[Any] | Exception:
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
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(self.service.generate_batch, requests)
                last_heartbeat = time.monotonic()
                while not future.done():
                    time.sleep(0.35)
                    for item in pending:
                        item.job = self._sync_progress(item.job, item.job_dir / "progress.json")
                    if heartbeat_message and time.monotonic() - last_heartbeat >= 30:
                        self.queue.heartbeat(heartbeat_message)
                        last_heartbeat = time.monotonic()
                return future.result()
        except Exception as exc:
            return exc

    def _progress_timings(self, item: _PendingGeneration) -> dict[str, float]:
        path = item.job_dir / "progress.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        timings = payload.get("timings", {})
        if not isinstance(timings, dict):
            return {}
        return {
            str(key): float(value)
            for key, value in timings.items()
            if isinstance(value, (int, float))
        }

    def _finish_benchmark_item(
        self,
        item: _PendingGeneration,
        result: Any,
    ) -> None:
        timings = self._progress_timings(item)
        try:
            if isinstance(result, Exception):
                raise result
            outputs: list[dict[str, str]] = []
            if item.job.get("phase") == "measure":
                job_id = str(item.job["jobId"])
                for generated in result:
                    key = f"jobs/{job_id}/outputs/{generated.expression}.png"
                    self.storage.put_output(key, generated.file_path)
                    outputs.append({"expression": generated.expression, "key": key})
            total = len(item.job["expressions"])
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
                timings=timings,
                completedAt=utc_now(),
                error=None,
            )
        except Exception as exc:
            self._save(
                item.job,
                status="failed",
                stage="failed",
                timings=timings,
                completedAt=utc_now(),
                error=str(exc),
            )
        finally:
            shutil.rmtree(item.scratch, ignore_errors=True)

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        position = (len(ordered) - 1) * percentile
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        fraction = position - lower
        return ordered[lower] * (1 - fraction) + ordered[upper] * fraction

    @staticmethod
    def _phase_seconds(jobs: list[dict[str, Any]]) -> float | None:
        starts: list[float] = []
        completions: list[float] = []
        for job in jobs:
            try:
                started_at = job.get("startedAt")
                completed_at = job.get("completedAt")
                if started_at:
                    starts.append(datetime.fromisoformat(str(started_at)).timestamp())
                if completed_at:
                    completions.append(datetime.fromisoformat(str(completed_at)).timestamp())
            except (TypeError, ValueError):
                continue
        if not starts or not completions:
            return None
        return max(0.0, max(completions) - min(starts))

    def _refresh_benchmark_run(self, run: dict[str, Any], final: bool = False) -> None:
        child_jobs = [
            self.job_store.get(str(job_id))
            for job_id in run.get("childJobIds", [])
        ]
        child_jobs = [job for job in child_jobs if job is not None]
        total_jobs = len(run.get("childJobIds", []))
        completed_jobs = sum(job.get("status") == "completed" for job in child_jobs)
        failed_jobs = sum(job.get("status") == "failed" for job in child_jobs)
        terminal_jobs = completed_jobs + failed_jobs
        total_expressions = int(run.get("progress", {}).get("totalExpressions", 0))
        completed_expressions = sum(
            min(int(job.get("progress", {}).get("completed", 0)), len(job.get("expressions", [])))
            for job in child_jobs
        )
        measured = [job for job in child_jobs if job.get("phase") == "measure"]
        warmup = [job for job in child_jobs if job.get("phase") == "warmup"]
        successful_measured = [job for job in measured if job.get("status") == "completed"]
        failed_measured = [job for job in measured if job.get("status") == "failed"]
        warmup_seconds = self._phase_seconds(warmup)
        measured_seconds = self._phase_seconds(measured)
        latencies = [
            float(job.get("timings", {}).get("total"))
            for job in successful_measured
            if isinstance(job.get("timings", {}).get("total"), (int, float))
        ]
        started_at = run.get("startedAt") or utc_now()
        completed_at = run.get("completedAt")
        if final or terminal_jobs >= total_jobs:
            completed_at = completed_at or utc_now()
        try:
            total_seconds = (
                datetime.fromisoformat(completed_at).timestamp()
                - datetime.fromisoformat(started_at).timestamp()
                if completed_at
                else None
            )
        except (TypeError, ValueError):
            total_seconds = None
        metrics = dict(run.get("metrics", {}))
        runtime_metadata = self.service.runtime_metadata()
        metrics.update({
            "totalSeconds": round(total_seconds, 4) if total_seconds is not None else None,
            "warmupSeconds": round(warmup_seconds, 4) if warmup_seconds is not None else None,
            "measuredSeconds": round(measured_seconds, 4) if measured_seconds is not None else None,
            "batchSeconds": round(measured_seconds / max(1, int(run.get("measuredRuns", 1))), 4)
            if measured_seconds is not None else None,
            "measuredJobs": len(measured),
            "successfulJobs": len(successful_measured),
            "failedJobs": len(failed_measured),
            "jobsPerSecond": round(len(successful_measured) / measured_seconds, 4)
            if measured_seconds and measured_seconds > 0 else None,
            "expressionsPerSecond": round(
                len(successful_measured) * len(run.get("expressions", [])) / measured_seconds, 4
            ) if measured_seconds and measured_seconds > 0 else None,
            "latencySeconds": [round(value, 4) for value in latencies],
            "p50Seconds": self._percentile(latencies, 0.5),
            "p95Seconds": self._percentile(latencies, 0.95),
            "device": runtime_metadata.get("device"),
            "gpuName": runtime_metadata.get("gpuName"),
            "peakMemoryMb": runtime_metadata.get("peakMemoryMb"),
        })
        progress = {
            "totalJobs": total_jobs,
            "completedJobs": terminal_jobs,
            "failedJobs": failed_jobs,
            "totalExpressions": total_expressions,
            "completedExpressions": completed_expressions,
            "percent": round((terminal_jobs / total_jobs) * 100) if total_jobs else 100,
        }
        status = "processing"
        if terminal_jobs >= total_jobs and total_jobs > 0:
            status = "failed" if failed_jobs else "completed"
        error = next((str(job.get("error")) for job in child_jobs if job.get("error")), None)
        self._save(
            run,
            status=status,
            progress=progress,
            metrics=metrics,
            startedAt=started_at,
            completedAt=completed_at,
            error=error,
        )

    def _process_benchmark_message(self, message: QueueMessage) -> None:
        run_id = str(message.body.get("runId", ""))
        run = self.job_store.get(run_id)
        if not isinstance(run, dict) or run.get("kind") != "benchmark":
            self.queue.ack(message)
            return
        if run.get("status") in {"completed", "failed"}:
            self.queue.ack(message)
            return

        self._refresh_benchmark_run(run)
        groups = message.body.get("groups", [])
        if not isinstance(groups, list):
            self._save(run, status="failed", error="Invalid benchmark groups")
            self.queue.ack(message)
            return

        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("jobs"), list):
                continue
            pending: list[_PendingGeneration] = []
            for payload in group["jobs"]:
                if not isinstance(payload, dict):
                    continue
                job = self.job_store.get(str(payload.get("jobId", "")))
                if not isinstance(job, dict):
                    continue
                prepared = self._prepare_benchmark_job(job)
                if prepared is not None:
                    pending.append(prepared)
            if pending:
                batch_results = self._run_provider_batch(pending, message)
                if isinstance(batch_results, Exception):
                    batch_results = [batch_results] * len(pending)
                if len(batch_results) != len(pending):
                    batch_results = [RuntimeError("Generation batch returned an incomplete result set.")] * len(pending)
                for item, result in zip(pending, batch_results):
                    self._finish_benchmark_item(item, result)
            self._refresh_benchmark_run(run)

        self._refresh_benchmark_run(run, final=True)
        self.queue.ack(message)

    def _process_messages(self, messages: list[QueueMessage]) -> None:
        benchmark_messages = [message for message in messages if message.body.get("kind") == "benchmark"]
        generation_messages = [message for message in messages if message.body.get("kind") != "benchmark"]
        for message in benchmark_messages:
            self._process_benchmark_message(message)
        if generation_messages:
            self._process_generation_messages(generation_messages)

    def _recover_failed_message(self, message: QueueMessage, error: Exception) -> None:
        """Keep one bad message from stopping the worker or staying invisible."""
        final_attempt = message.receive_count >= self.settings.worker_max_attempts
        error_text = f"Worker error: {error}"
        if final_attempt:
            if message.body.get("kind") == "benchmark":
                run = self.job_store.get(str(message.body.get("runId", "")))
                if isinstance(run, dict):
                    try:
                        self._save(
                            run,
                            status="failed",
                            completedAt=utc_now(),
                            error=error_text,
                        )
                    except Exception:
                        traceback.print_exc()
            else:
                job = self.job_store.get(str(message.body.get("jobId", "")))
                if isinstance(job, dict):
                    try:
                        self._save(
                            job,
                            status="failed",
                            stage="failed",
                            completedAt=utc_now(),
                            error=error_text,
                        )
                    except Exception:
                        traceback.print_exc()
            self.queue.dead_letter(message)
            return

        self.queue.retry(message)

    def _process_message(self, message: QueueMessage) -> None:
        self._process_messages([message])
