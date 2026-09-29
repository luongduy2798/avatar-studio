from __future__ import annotations

from .config import Settings
from .infrastructure import build_infrastructure
from .providers import LivePortraitProvider
from .service import ExpressionService
from .worker import GenerationWorker


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
