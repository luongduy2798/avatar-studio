from __future__ import annotations

import json
import os
import select
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

from .config import Settings


EXPRESSION_DRIVERS: Final[dict[str, None]] = {
    "unbothered": None,
    "locked_in": None,
    "cracking_up": None,
    "full_panic": None,
    "big_winner": None,
    "spectacular_flop": None,
}

GENERATION_MODES: Final[dict[str, str]] = {
    "liveportrait": "LivePortrait",
}


class ProviderUnavailable(RuntimeError):
    pass


class ProviderBusy(RuntimeError):
    pass


class ExpressionGenerationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExpressionBatchInput:
    source_image: Path
    expressions: list[str]
    intensity: float
    job_dir: Path


class ExpressionProvider(Protocol):
    name: str

    @property
    def ready(self) -> bool: ...

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def generate_many(
        self,
        source_image: Path,
        expressions: list[str],
        intensity: float,
        job_dir: Path,
    ) -> dict[str, Path]: ...

    def generate_batch(
        self,
        requests: list[ExpressionBatchInput],
    ) -> list[dict[str, Path] | Exception]: ...


class LivePortraitProvider:
    """Client for one long-lived LivePortrait process per GPU instance."""

    name = "liveportrait"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._process: subprocess.Popen[str] | None = None
        self._log_handle = None
        self._ready = False
        self._startup_error: str | None = None
        self._device: str | None = None
        self._gpu_name: str | None = None
        self._peak_memory_mb: float | None = None
        self._lifecycle_lock = threading.RLock()
        self._io_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(settings.worker_queue_size + 1)

    def _weights_ready(self) -> bool:
        required_weights = [
            "liveportrait/base_models/appearance_feature_extractor.pth",
            "liveportrait/base_models/motion_extractor.pth",
            "liveportrait/base_models/spade_generator.pth",
            "liveportrait/retargeting_models/stitching_retargeting_module.pth",
            "liveportrait/base_models/warping_module.pth",
            "liveportrait/landmark.onnx",
            "insightface/models/buffalo_l/2d106det.onnx",
            "insightface/models/buffalo_l/det_10g.onnx",
            "head_parser/resnet18.onnx",
            "hair_matting/birefnet-general-lite.onnx",
        ]
        weights_root = self.settings.liveportrait_root / "pretrained_weights"
        return (
            self.settings.liveportrait_root.is_dir()
            and self.settings.liveportrait_python.is_file()
            and all((weights_root / relative_path).is_file() for relative_path in required_weights)
        )

    @property
    def ready(self) -> bool:
        with self._lifecycle_lock:
            return bool(
                self._ready
                and self._process is not None
                and self._process.poll() is None
            )

    @property
    def startup_error(self) -> str | None:
        with self._lifecycle_lock:
            return self._startup_error

    @property
    def device(self) -> str | None:
        with self._lifecycle_lock:
            return self._device

    @property
    def gpu_name(self) -> str | None:
        with self._lifecycle_lock:
            return self._gpu_name

    @property
    def peak_memory_mb(self) -> float | None:
        with self._lifecycle_lock:
            return self._peak_memory_mb

    def _readline(self, timeout: float) -> str:
        process = self._process
        if process is None or process.stdout is None:
            raise RuntimeError("LivePortrait worker is not running.")
        ready, _, _ = select.select([process.stdout], [], [], timeout)
        if not ready:
            raise TimeoutError("LivePortrait worker did not respond before timeout.")
        line = process.stdout.readline()
        if not line:
            details = ""
            if process.poll() is not None:
                details = f" (exit code {process.returncode})"
            raise RuntimeError(f"LivePortrait worker exited{details}.")
        return line.strip()

    def _stop_unlocked(self) -> None:
        process = self._process
        self._ready = False
        self._process = None
        if process is not None:
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except OSError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None

    def start(self) -> None:
        with self._lifecycle_lock:
            if self.ready:
                return
            self._startup_error = None
            if not self._weights_ready():
                self._startup_error = (
                    "Model detect mặt, biểu cảm hoặc tách đầu chưa sẵn sàng. "
                    "Chạy make setup rồi khởi động lại API."
                )
                return

            self._stop_unlocked()
            worker = Path(__file__).resolve().parents[1] / "liveportrait_batch_worker.py"
            weights_root = self.settings.liveportrait_root / "pretrained_weights"
            command = [
                str(self.settings.liveportrait_python),
                str(worker),
                "--daemon",
                "--head-parser",
                str(weights_root / "head_parser" / "resnet18.onnx"),
                "--hair-matte",
                str(weights_root / "hair_matting" / "birefnet-general-lite.onnx"),
                "--decode-batch-size",
                str(self.settings.worker_decode_batch_size),
            ]
            environment = os.environ.copy()
            # Keep the existing local MPS fallback; CUDA production workers do
            # not use this path.
            environment.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            existing_pythonpath = environment.get("PYTHONPATH", "")
            environment["PYTHONPATH"] = os.pathsep.join(
                part for part in [str(self.settings.liveportrait_root), existing_pythonpath] if part
            )
            log_path = self.settings.runtime_root / "liveportrait-worker.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_handle = log_path.open("a", encoding="utf-8")
            self._log_handle.write(
                f"\n[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] starting worker\n"
            )
            self._log_handle.flush()
            try:
                self._process = subprocess.Popen(
                    command,
                    cwd=self.settings.liveportrait_root,
                    env=environment,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=self._log_handle,
                    text=True,
                    bufsize=1,
                )
                deadline = time.monotonic() + self.settings.worker_startup_timeout_seconds
                ready_payload: dict[str, object] | None = None
                while time.monotonic() < deadline:
                    line = self._readline(max(0.1, deadline - time.monotonic()))
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("event") == "ready":
                        ready_payload = payload
                        break
                    if payload.get("event") == "error":
                        raise RuntimeError(str(payload.get("error", "worker startup failed")))
                if ready_payload is None:
                    raise TimeoutError("LivePortrait worker startup timed out.")
                self._device = str(ready_payload.get("device", "unknown"))
                raw_gpu_name = ready_payload.get("gpu_name")
                self._gpu_name = str(raw_gpu_name) if raw_gpu_name else None
                raw_peak_memory = ready_payload.get("peak_memory_mb")
                self._peak_memory_mb = float(raw_peak_memory) if isinstance(raw_peak_memory, (int, float)) else None
                self._ready = True
            except Exception as exc:
                self._startup_error = str(exc)
                self._stop_unlocked()

    def stop(self) -> None:
        with self._lifecycle_lock:
            self._stop_unlocked()

    def _request(self, request: dict[str, object]) -> dict[str, object]:
        with self._io_lock:
            if not self.ready:
                self.start()
            if not self.ready:
                raise ProviderUnavailable(self.startup_error or "LivePortrait worker is not ready.")
            process = self._process
            if process is None or process.stdin is None:
                raise ProviderUnavailable("LivePortrait worker is not running.")
            try:
                process.stdin.write(json.dumps(request) + "\n")
                process.stdin.flush()
                line = self._readline(self.settings.worker_request_timeout_seconds)
                response = json.loads(line)
            except (BrokenPipeError, OSError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
                self._stop_unlocked()
                raise ExpressionGenerationError(
                    f"LivePortrait worker stopped unexpectedly: {exc}"
                ) from exc
            if not isinstance(response, dict):
                raise ExpressionGenerationError("LivePortrait worker returned an invalid response.")
            runtime = response.get("runtime")
            if isinstance(runtime, dict):
                peak_memory = runtime.get("peak_memory_mb")
                if isinstance(peak_memory, (int, float)):
                    self._peak_memory_mb = float(peak_memory)
            return response

    def generate_many(
        self,
        source_image: Path,
        expressions: list[str],
        intensity: float,
        job_dir: Path,
    ) -> dict[str, Path]:
        result = self.generate_batch([
            ExpressionBatchInput(
                source_image=source_image,
                expressions=expressions,
                intensity=intensity,
                job_dir=job_dir,
            )
        ])[0]
        if isinstance(result, Exception):
            raise result
        return result

    def generate_batch(
        self,
        requests: list[ExpressionBatchInput],
    ) -> list[dict[str, Path] | Exception]:
        if not requests:
            return []
        for request in requests:
            unsupported = [
                item for item in request.expressions if item not in EXPRESSION_DRIVERS
            ]
            if unsupported:
                return [
                    ExpressionGenerationError(
                        f"Unsupported expressions: {', '.join(unsupported)}"
                    )
                    for _ in requests
                ]
        if not self.ready:
            self.start()
        if not self.ready:
            error = ProviderUnavailable(self.startup_error or "LivePortrait worker is not ready.")
            return [error for _ in requests]
        if not self._slots.acquire(timeout=self.settings.worker_queue_timeout_seconds):
            error = ProviderBusy("GPU generation queue is full. Please retry shortly.")
            return [error for _ in requests]
        try:
            payloads: list[dict[str, object]] = []
            for request in requests:
                progress_path = request.job_dir / "progress.json"
                progress_path.write_text(
                    json.dumps({
                        "completed": [],
                        "prepared": [],
                        "total": len(request.expressions),
                    }),
                    encoding="utf-8",
                )
                payloads.append({
                    "source": str(request.source_image),
                    "output_root": str(request.job_dir),
                    "intensity": request.intensity,
                    "expressions": request.expressions,
                    "progress_file": str(progress_path),
                })
            response = self._request({
                "command": "generate_batch",
                "requests": payloads,
            })
            raw_results = response.get("results")
            if not response.get("ok") or not isinstance(raw_results, list):
                error = ExpressionGenerationError(
                    str(response.get("error", "LivePortrait batch generation failed."))
                )
                return [error for _ in requests]
            results: list[dict[str, Path] | Exception] = []
            for request, raw_result in zip(requests, raw_results):
                if not isinstance(raw_result, dict) or not raw_result.get("ok"):
                    results.append(ExpressionGenerationError(
                        str(
                            raw_result.get("error", "LivePortrait generation failed.")
                            if isinstance(raw_result, dict)
                            else "LivePortrait returned an invalid batch result."
                        )
                    ))
                    continue
                raw_outputs = raw_result.get("outputs")
                if not isinstance(raw_outputs, dict):
                    results.append(ExpressionGenerationError(
                        "LivePortrait returned no output paths."
                    ))
                    continue
                item_outputs: dict[str, Path] = {}
                item_error: Exception | None = None
                for expression in request.expressions:
                    output_path = Path(str(raw_outputs.get(expression, "")))
                    if not output_path.is_file():
                        item_error = ExpressionGenerationError(
                            "LivePortrait completed but no generated image was found "
                            f"for {expression}."
                        )
                        break
                    item_outputs[expression] = output_path
                results.append(item_error or item_outputs)
            if len(results) < len(requests):
                results.extend(
                    ExpressionGenerationError("LivePortrait batch response was incomplete.")
                    for _ in range(len(requests) - len(results))
                )
            return results
        finally:
            self._slots.release()
