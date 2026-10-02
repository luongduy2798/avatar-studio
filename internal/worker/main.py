from __future__ import annotations

import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[2] / "runner" / "runtime"
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

from app.config import Settings  # noqa: E402
from app.infrastructure import build_infrastructure  # noqa: E402
from app.providers import LivePortraitProvider  # noqa: E402
from app.service import ExpressionService  # noqa: E402
from internal.worker.worker import GenerationWorker  # noqa: E402


def main() -> None:
    settings = Settings.from_env()
    job_store, storage, queue = build_infrastructure(settings)
    provider = LivePortraitProvider(settings)
    provider.start()
    if not provider.ready:
        raise RuntimeError(provider.startup_error or "LivePortrait worker failed to start")
    try:
        GenerationWorker(
            settings=settings,
            job_store=job_store,
            storage=storage,
            queue=queue,
            service=ExpressionService({"liveportrait": provider}),
        ).run_forever()
    finally:
        provider.stop()


if __name__ == "__main__":
    main()
