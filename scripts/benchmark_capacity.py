from __future__ import annotations

import argparse
import json
import math
import os
import resource
import shutil
import sys
import time
from pathlib import Path

if sys.platform == "darwin":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = REPO_ROOT / "gpu-service"
sys.path.insert(0, str(SERVICE_ROOT))


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile_value
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def parse_cases(value: str) -> list[tuple[int, int]]:
    cases: list[tuple[int, int]] = []
    for raw_case in value.split(","):
        jobs_text, decode_text = raw_case.strip().split(":", 1)
        jobs = max(1, int(jobs_text))
        decode_batch = max(1, int(decode_text))
        cases.append((jobs, decode_batch))
    return cases


def device_memory_snapshot() -> dict[str, float]:
    snapshot: dict[str, float] = {}
    rss = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    if sys.platform == "darwin":
        rss /= 1024 * 1024
    else:
        rss /= 1024
    snapshot["process_peak_rss_mb"] = round(rss, 1)
    if torch.cuda.is_available():
        snapshot["cuda_peak_allocated_mb"] = round(
            torch.cuda.max_memory_allocated() / (1024 * 1024),
            1,
        )
        snapshot["cuda_peak_reserved_mb"] = round(
            torch.cuda.max_memory_reserved() / (1024 * 1024),
            1,
        )
    elif torch.backends.mps.is_available():
        snapshot["mps_allocated_mb"] = round(
            torch.mps.current_allocated_memory() / (1024 * 1024),
            1,
        )
        driver_memory = getattr(torch.mps, "driver_allocated_memory", None)
        if callable(driver_memory):
            snapshot["mps_driver_allocated_mb"] = round(
                driver_memory() / (1024 * 1024),
                1,
            )
    return snapshot


def synchronize() -> None:
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    elif torch.backends.mps.is_available():
        torch.mps.synchronize()


def clear_device_cache() -> None:
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    elif torch.backends.mps.is_available():
        torch.mps.empty_cache()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark multi-user LivePortrait batching on the current device."
    )
    parser.add_argument("--source", required=True)
    parser.add_argument(
        "--cases",
        default="1:1,1:6,2:12,4:24",
        help="Comma-separated job_count:decode_batch_size pairs.",
    )
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--intensity", type=float, default=1.0)
    parser.add_argument("--output-root", default=str(SERVICE_ROOT / ".runtime" / "capacity-benchmark"))
    parser.add_argument(
        "--liveportrait-root",
        default=os.getenv(
            "LIVEPORTRAIT_ROOT",
            str(Path.home() / ".cache" / "avatar-studio" / "LivePortrait"),
        ),
    )
    args = parser.parse_args()

    liveportrait_root = Path(args.liveportrait_root).expanduser()
    sys.path.insert(0, str(liveportrait_root))
    from liveportrait_batch_worker import EXPRESSION_PRESETS, GenerationEngine

    weights_root = liveportrait_root / "pretrained_weights"
    source = Path(args.source).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    shutil.rmtree(output_root, ignore_errors=True)
    output_root.mkdir(parents=True, exist_ok=True)

    engine = GenerationEngine(
        weights_root / "head_parser" / "resnet18.onnx",
        weights_root / "hair_matting" / "birefnet-general-lite.onnx",
        decode_batch_size=1,
    )
    startup_start = time.perf_counter()
    engine.warmup()
    synchronize()
    startup_seconds = time.perf_counter() - startup_start

    expressions = list(EXPRESSION_PRESETS)
    results: list[dict[str, object]] = []

    for jobs, decode_batch_size in parse_cases(args.cases):
        engine.decode_batch_size = decode_batch_size
        durations: list[float] = []
        stage_samples: dict[str, list[float]] = {}
        error: str | None = None

        for repeat in range(max(1, args.repeats)):
            clear_device_cache()
            case_root = output_root / f"jobs-{jobs}-decode-{decode_batch_size}" / f"run-{repeat + 1}"
            requests: list[dict[str, object]] = []
            progress_paths: list[Path] = []
            for job_index in range(jobs):
                job_root = case_root / f"job-{job_index + 1}"
                progress_path = job_root / "progress.json"
                job_root.mkdir(parents=True, exist_ok=True)
                requests.append({
                    "source": str(source),
                    "expressions": expressions,
                    "intensity": args.intensity,
                    "output_root": str(job_root),
                    "progress_file": str(progress_path),
                })
                progress_paths.append(progress_path)

            synchronize()
            started = time.perf_counter()
            batch_results = engine.generate_batch(requests)
            synchronize()
            elapsed = time.perf_counter() - started
            failures = [item for item in batch_results if isinstance(item, Exception)]
            if failures:
                error = str(failures[0])
                break
            durations.append(elapsed)

            for progress_path in progress_paths:
                if not progress_path.is_file():
                    continue
                progress = json.loads(progress_path.read_text(encoding="utf-8"))
                timings = progress.get("timings", {})
                if not isinstance(timings, dict):
                    continue
                for stage, duration in timings.items():
                    if isinstance(duration, (int, float)):
                        stage_samples.setdefault(str(stage), []).append(float(duration))

        case_result: dict[str, object] = {
            "jobs": jobs,
            "decode_batch_size": decode_batch_size,
            "repeats": len(durations),
            "error": error,
            "memory": device_memory_snapshot(),
        }
        if durations:
            p50 = percentile(durations, 0.50)
            p95 = percentile(durations, 0.95)
            p99 = percentile(durations, 0.99)
            case_result.update({
                "batch_latency_p50_seconds": round(p50, 4),
                "batch_latency_p95_seconds": round(p95, 4),
                "batch_latency_p99_seconds": round(p99, 4),
                "effective_seconds_per_job_p50": round(p50 / jobs, 4),
                "jobs_per_second_at_p50": round(jobs / p50, 4),
                "jobs_per_15s_at_p50_rate": round(15.0 * jobs / p50, 2),
                "all_jobs_meet_15s_at_p95": p95 <= 15.0,
                "stage_average_seconds": {
                    stage: round(sum(values) / len(values), 4)
                    for stage, values in stage_samples.items()
                    if values
                },
            })
        results.append(case_result)
        print(json.dumps(case_result, ensure_ascii=False), flush=True)

        if error:
            break

    summary = {
        "device": str(engine.device),
        "cuda": engine.use_cuda,
        "mps": engine.use_mps,
        "onnx_cuda": engine.onnx_use_cuda,
        "startup_warmup_seconds": round(startup_seconds, 4),
        "source": str(source),
        "expressions_per_job": len(expressions),
        "results": results,
    }
    summary_path = output_root / "summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"summary": str(summary_path)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
