from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import shutil
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import websockets


RUNNER_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = Path(
    os.getenv(
        "AVATAR_RUNTIME_CODE_ROOT",
        str(RUNNER_ROOT / "runtime"),
    )
).expanduser()
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

from app.config import Settings  # noqa: E402
from app.providers import LivePortraitProvider  # noqa: E402
from app.service import ExpressionBatchRequest, ExpressionService  # noqa: E402


def env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


@dataclass
class PreparedJob:
    assignment: dict[str, Any]
    request: ExpressionBatchRequest
    work: Path
    started: float


class RunnerAgent:
    def __init__(self) -> None:
        self.master_url = os.getenv("AVATAR_MASTER_URL", "ws://127.0.0.1:8000/runner/ws")
        self.runner_name = os.getenv("AVATAR_RUNNER_NAME", platform.node() or "avatar-runner")
        self.enrollment_code = os.getenv("AVATAR_RUNNER_ENROLL_CODE", "").strip()
        self.credentials_path = Path(
            os.getenv("AVATAR_RUNNER_CREDENTIALS", str(Path.home() / ".avatar-runner" / "credentials.json"))
        ).expanduser()
        self.runtime_root = Path(
            os.getenv("AVATAR_RUNNER_RUNTIME_ROOT", str(Path.home() / ".avatar-runner" / "runtime"))
        ).expanduser()
        self.max_inflight = env_int("AVATAR_MAX_INFLIGHT_JOBS", 3)
        self.max_decode_batch = env_int("AVATAR_MAX_DECODE_BATCH", 3)
        self.settings = Settings.from_env()
        self.provider = LivePortraitProvider(self.settings)
        self.service = ExpressionService({"liveportrait": self.provider})
        self.executor = ThreadPoolExecutor(max_workers=self.max_inflight, thread_name_prefix="avatar-runner-job")
        self.semaphore = asyncio.Semaphore(self.max_inflight)
        self.decode_queue: asyncio.Queue[tuple[PreparedJob, asyncio.Future[dict[str, Any] | Exception]]] = asyncio.Queue()
        self.decode_wait_ms = env_int("AVATAR_DECODE_BATCH_WAIT_MS", 25)
        self.ws: Any = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.runner_id: str | None = None
        self.token: str | None = None
        self.stop_event = asyncio.Event()

    def load_credentials(self) -> None:
        try:
            payload = json.loads(self.credentials_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        self.runner_id = str(payload.get("runner_id")) if payload.get("runner_id") else None
        self.token = str(payload.get("token")) if payload.get("token") else None

    def save_credentials(self) -> None:
        if not self.runner_id or not self.token:
            return
        self.credentials_path.parent.mkdir(parents=True, exist_ok=True)
        self.credentials_path.write_text(
            json.dumps({"runner_id": self.runner_id, "token": self.token}, indent=2),
            encoding="utf-8",
        )
        try:
            self.credentials_path.chmod(0o600)
        except OSError:
            pass

    def capabilities(self) -> dict[str, Any]:
        metadata = self.service.runtime_metadata()
        return {
            "os": platform.system().lower(),
            "arch": platform.machine(),
            "gpu": metadata.get("gpuName"),
            "backend": metadata.get("device"),
            "vramMb": metadata.get("peakMemoryMb"),
            "modelVersion": os.getenv("AVATAR_MODEL_VERSION", "liveportrait-v1"),
            "runtimeVersion": os.getenv("AVATAR_RUNNER_VERSION", "1.0.0"),
            "maxInflightJobs": self.max_inflight,
            "maxDecodeBatch": self.max_decode_batch,
            "generators": ["liveportrait"],
        }

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.load_credentials()
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self.provider.start()
        if not self.provider.ready:
            raise RuntimeError(self.provider.startup_error or "LivePortrait provider is not ready")
        decode_task: asyncio.Task[None] | None = None
        try:
            decode_task = asyncio.create_task(self.decode_loop())
            while not self.stop_event.is_set():
                try:
                    await self.connect_once()
                except Exception as exc:
                    print(f"runner connection failed: {exc}", flush=True)
                if not self.stop_event.is_set():
                    await asyncio.sleep(3)
        finally:
            if decode_task is not None:
                decode_task.cancel()
                await asyncio.gather(decode_task, return_exceptions=True)
            self.provider.stop()
            self.executor.shutdown(wait=False, cancel_futures=True)

    async def connect_once(self) -> None:
        async with websockets.connect(self.master_url, ping_interval=20, ping_timeout=20, max_size=4 * 1024 * 1024) as ws:
            self.ws = ws
            if self.runner_id and self.token:
                await self.send({
                    "type": "runner.auth",
                    "runner_id": self.runner_id,
                    "token": self.token,
                    "capabilities": self.capabilities(),
                })
            else:
                if not self.enrollment_code:
                    raise RuntimeError("AVATAR_RUNNER_ENROLL_CODE is required for first enrollment")
                await self.send({
                    "type": "runner.enroll",
                    "code": self.enrollment_code,
                    "name": self.runner_name,
                    "capabilities": self.capabilities(),
                    "runtimeVersion": os.getenv("AVATAR_RUNNER_VERSION", "1.0.0"),
                })
            heartbeat = asyncio.create_task(self.heartbeat_loop())
            try:
                async for raw in ws:
                    await self.handle_message(json.loads(raw))
            finally:
                heartbeat.cancel()
                self.ws = None

    async def heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(10)
            await self.send({
                "type": "runner.heartbeat",
                "runner_id": self.runner_id,
                "token": self.token,
                "capabilities": self.capabilities(),
                "runtimeVersion": os.getenv("AVATAR_RUNNER_VERSION", "1.0.0"),
            })

    async def handle_message(self, message: dict[str, Any]) -> None:
        message_type = str(message.get("type", ""))
        if message_type == "runner.enrolled":
            self.runner_id = str(message["runner_id"])
            self.token = str(message["token"])
            self.enrollment_code = ""
            self.save_credentials()
            print(f"runner enrolled: {self.runner_id}", flush=True)
            return
        if message_type in {"runner.authenticated", "runner.heartbeat_ack"}:
            minimum = message.get("minimum_version")
            local = os.getenv("AVATAR_RUNNER_VERSION", "1.0.0")
            if minimum and str(minimum) != local:
                print(f"runner version {local} is behind required version {minimum}; update the runner package", flush=True)
            return
        if message_type == "job.assign":
            asyncio.create_task(self.run_job(message))

    async def send(self, payload: dict[str, Any]) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps(payload))

    async def run_job(self, assignment: dict[str, Any]) -> None:
        async with self.semaphore:
            job_id = str(assignment["job_id"])
            lease_id = str(assignment["lease_id"])
            await self.send({"type": "job.accepted", "job_id": job_id, "lease_id": lease_id})
            await self.send({"type": "job.started", "job_id": job_id, "lease_id": lease_id})
            loop = asyncio.get_running_loop()
            try:
                prepared = await loop.run_in_executor(self.executor, self.prepare_job, assignment)
                future: asyncio.Future[dict[str, Any] | Exception] = loop.create_future()
                await self.decode_queue.put((prepared, future))
                result = await future
                if isinstance(result, Exception):
                    raise result
                await self.send({
                    "type": "job.completed",
                    "job_id": job_id,
                    "lease_id": lease_id,
                    "outputs": result["outputs"],
                    "timings": result["timings"],
                })
            except Exception as exc:
                await self.send({
                    "type": "job.failed",
                    "job_id": job_id,
                    "lease_id": lease_id,
                    "error": str(exc),
                })

    def process_job(self, assignment: dict[str, Any]) -> dict[str, Any]:
        prepared = self.prepare_job(assignment)
        result = self.service.generate_batch([prepared.request])[0]
        if isinstance(result, Exception):
            raise result
        return self.finish_job(prepared, result)

    def prepare_job(self, assignment: dict[str, Any]) -> PreparedJob:
        job_id = str(assignment["job_id"])
        work = self.runtime_root / "jobs" / job_id
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        source = work / "source.jpg"
        generation = work / "generation"
        generation.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        self._download(str(assignment["input_url"]), source)
        self._send_progress_sync(job_id, str(assignment["lease_id"]), "materialize", 0)
        request = ExpressionBatchRequest(
            generator=str(assignment.get("generator", "liveportrait")),
            source_image=source,
            expressions=[str(value) for value in assignment["expressions"]],
            intensity=float(assignment.get("intensity", 1)),
            job_dir=generation,
        )
        return PreparedJob(assignment=assignment, request=request, work=work, started=started)

    def finish_job(self, prepared: PreparedJob, result: dict[str, Path]) -> dict[str, Any]:
        assignment = prepared.assignment
        job_id = str(assignment["job_id"])
        request = prepared.request
        self._send_progress_sync(job_id, str(assignment["lease_id"]), "decode", 80)
        output_urls = [str(value) for value in assignment.get("output_urls", [])]
        outputs = []
        for index, expression in enumerate(request.expressions):
            output_path = result[expression]
            if index >= len(output_urls):
                raise RuntimeError(f"Missing output URL for {expression}")
            payload = output_path.read_bytes()
            self._upload(output_urls[index], payload)
            outputs.append({
                "expression": expression,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "bytes": len(payload),
            })
        self._send_progress_sync(job_id, str(assignment["lease_id"]), "upload", 100)
        timings = self._read_timings(prepared.work / "generation" / "progress.json")
        timings["total"] = round(time.perf_counter() - prepared.started, 4)
        shutil.rmtree(prepared.work, ignore_errors=True)
        return {"outputs": outputs, "timings": timings}

    async def decode_loop(self) -> None:
        while True:
            first = await self.decode_queue.get()
            batch = [first]
            deadline = asyncio.get_running_loop().time() + self.decode_wait_ms / 1000
            while len(batch) < self.max_decode_batch:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                try:
                    batch.append(await asyncio.wait_for(self.decode_queue.get(), timeout=remaining))
                except asyncio.TimeoutError:
                    break
            loop = asyncio.get_running_loop()
            requests = [prepared.request for prepared, _ in batch]
            results = await loop.run_in_executor(self.executor, self.service.generate_batch, requests)
            if len(results) != len(batch):
                results = [RuntimeError("LivePortrait returned an incomplete decode batch.")] * len(batch)
            for (prepared, future), result in zip(batch, results):
                if future.done():
                    continue
                if isinstance(result, Exception):
                    future.set_result(result)
                    shutil.rmtree(prepared.work, ignore_errors=True)
                    continue
                try:
                    value = await loop.run_in_executor(self.executor, self.finish_job, prepared, result)
                    future.set_result(value)
                except Exception as exc:
                    shutil.rmtree(prepared.work, ignore_errors=True)
                    future.set_result(exc)

    def _send_progress_sync(self, job_id: str, lease_id: str, stage: str, percent: int) -> None:
        if self.ws is None:
            return
        payload = {
            "type": "job.progress",
            "job_id": job_id,
            "lease_id": lease_id,
            "stage": stage,
            "progress": {"prepared": 0, "completed": 0, "total": 1, "percent": percent},
        }
        if self.loop is not None:
            asyncio.run_coroutine_threadsafe(self.send(payload), self.loop).result(timeout=10)

    @staticmethod
    def _download(url: str, destination: Path) -> None:
        with urllib.request.urlopen(url, timeout=120) as response:
            destination.write_bytes(response.read())

    @staticmethod
    def _upload(url: str, payload: bytes) -> None:
        request = urllib.request.Request(url, data=payload, method="PUT", headers={"Content-Type": "image/png"})
        with urllib.request.urlopen(request, timeout=120) as response:
            if response.status >= 300:
                raise RuntimeError(f"S3 upload failed with status {response.status}")

    @staticmethod
    def _read_timings(path: Path) -> dict[str, float]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        values = payload.get("timings", {})
        if not isinstance(values, dict):
            return {}
        return {str(key): float(value) for key, value in values.items() if isinstance(value, (int, float))}


def main() -> None:
    asyncio.run(RunnerAgent().run())


if __name__ == "__main__":
    main()
