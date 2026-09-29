from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    infrastructure_mode: str
    liveportrait_root: Path
    liveportrait_python: Path
    runtime_root: Path
    worker_queue_size: int
    worker_queue_timeout_seconds: float
    worker_startup_timeout_seconds: float
    worker_request_timeout_seconds: float
    worker_decode_batch_size: int
    worker_job_batch_size: int
    worker_job_batch_wait_seconds: float
    worker_poll_seconds: float
    worker_visibility_timeout_seconds: int
    worker_max_attempts: int
    aws_region: str
    aws_bucket: str | None
    aws_queue_url: str | None
    aws_jobs_table: str | None

    @classmethod
    def from_env(cls) -> "Settings":
        service_root = Path(__file__).resolve().parents[1]
        liveportrait_root = Path(
            os.getenv(
                "LIVEPORTRAIT_ROOT",
                str(Path.home() / ".cache" / "avatar-studio" / "LivePortrait"),
            )
        ).expanduser()

        liveportrait_python = Path(
            os.getenv(
                "LIVEPORTRAIT_PYTHON",
                str(liveportrait_root / ".venv" / "bin" / "python"),
            )
        ).expanduser()

        runtime_root = Path(
            os.getenv(
                "AVATAR_RUNTIME_ROOT",
                str(service_root / ".runtime"),
            )
        ).expanduser()

        def env_int(name: str, default: int) -> int:
            try:
                return max(0, int(os.getenv(name, str(default))))
            except ValueError:
                return default

        def env_float(name: str, default: float) -> float:
            try:
                return max(0.1, float(os.getenv(name, str(default))))
            except ValueError:
                return default

        def env_milliseconds(name: str, default: float) -> float:
            try:
                return max(0.0, float(os.getenv(name, str(default)))) / 1000.0
            except ValueError:
                return default / 1000.0

        return cls(
            infrastructure_mode=os.getenv("AVATAR_INFRA_MODE", "local").strip().lower(),
            liveportrait_root=liveportrait_root,
            liveportrait_python=liveportrait_python,
            runtime_root=runtime_root,
            worker_queue_size=env_int("AVATAR_WORKER_QUEUE_SIZE", 2),
            worker_queue_timeout_seconds=env_float("AVATAR_WORKER_QUEUE_TIMEOUT", 30.0),
            worker_startup_timeout_seconds=env_float("AVATAR_WORKER_STARTUP_TIMEOUT", 900.0),
            worker_request_timeout_seconds=env_float("AVATAR_WORKER_REQUEST_TIMEOUT", 900.0),
            worker_decode_batch_size=env_int("AVATAR_DECODE_BATCH_SIZE", 0),
            worker_job_batch_size=max(1, env_int("AVATAR_JOB_BATCH_SIZE", 4)),
            worker_job_batch_wait_seconds=env_milliseconds("AVATAR_JOB_BATCH_WAIT_MS", 25.0),
            worker_poll_seconds=env_float("AVATAR_WORKER_POLL_SECONDS", 1.0),
            worker_visibility_timeout_seconds=env_int("AVATAR_VISIBILITY_TIMEOUT_SECONDS", 900),
            worker_max_attempts=max(1, env_int("AVATAR_WORKER_MAX_ATTEMPTS", 3)),
            aws_region=os.getenv("AWS_REGION", "ap-southeast-1"),
            aws_bucket=os.getenv("AVATAR_S3_BUCKET"),
            aws_queue_url=os.getenv("AVATAR_SQS_QUEUE_URL"),
            aws_jobs_table=os.getenv("AVATAR_DYNAMODB_JOBS_TABLE"),
        )
