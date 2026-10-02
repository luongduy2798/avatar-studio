from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .providers import ExpressionBatchInput, ExpressionProvider, ProviderUnavailable


@dataclass(frozen=True)
class ExpressionOutput:
    expression: str
    file_path: Path


@dataclass(frozen=True)
class ExpressionBatchRequest:
    generator: str
    source_image: Path
    expressions: list[str]
    intensity: float
    job_dir: Path


class ExpressionService:
    def __init__(self, providers: Mapping[str, ExpressionProvider]) -> None:
        self.providers = dict(providers)

    def generate_many(
        self,
        generator: str,
        source_image: Path,
        expressions: list[str],
        intensity: float,
        job_dir: Path,
    ) -> list[ExpressionOutput]:
        provider = self.providers.get(generator)
        if provider is None:
            raise ProviderUnavailable(f"Unknown generation mode: {generator}")
        generated = provider.generate_many(
            source_image=source_image,
            expressions=expressions,
            intensity=intensity,
            job_dir=job_dir,
        )
        return [
            ExpressionOutput(expression=expression, file_path=generated[expression])
            for expression in expressions
        ]

    def generate_batch(
        self,
        requests: list[ExpressionBatchRequest],
    ) -> list[list[ExpressionOutput] | Exception]:
        if not requests:
            return []
        generators = {request.generator for request in requests}
        if len(generators) != 1:
            return [
                self.generate_many(
                    request.generator,
                    request.source_image,
                    request.expressions,
                    request.intensity,
                    request.job_dir,
                )
                for request in requests
            ]
        generator = next(iter(generators))
        provider = self.providers.get(generator)
        if provider is None:
            error = ProviderUnavailable(f"Unknown generation mode: {generator}")
            return [error for _ in requests]
        generated = provider.generate_batch([
            ExpressionBatchInput(
                source_image=request.source_image,
                expressions=request.expressions,
                intensity=request.intensity,
                job_dir=request.job_dir,
            )
            for request in requests
        ])
        results: list[list[ExpressionOutput] | Exception] = []
        for request, item in zip(requests, generated):
            if isinstance(item, Exception):
                results.append(item)
                continue
            results.append([
                ExpressionOutput(expression=expression, file_path=item[expression])
                for expression in request.expressions
            ])
        return results

    def runtime_metadata(self) -> dict[str, object]:
        provider = self.providers.get("liveportrait")
        if provider is None:
            return {}
        return {
            "device": getattr(provider, "device", None),
            "gpuName": getattr(provider, "gpu_name", None),
            "peakMemoryMb": getattr(provider, "peak_memory_mb", None),
        }
