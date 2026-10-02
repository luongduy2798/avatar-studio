from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
import json
import os
from queue import Empty, Queue
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
import onnxruntime as ort

from src.config.inference_config import InferenceConfig
from src.config.crop_config import CropConfig
from src.live_portrait_wrapper import LivePortraitWrapper
from src.utils.camera import get_rotation_matrix
from src.utils.cropper import Cropper
from src.utils.human_landmark_runner import LandmarkRunner
from src.utils.retargeting_utils import calc_eye_close_ratio, calc_lip_close_ratio

from head_cutout import HeadSegmenter, PortraitMatte, composite_rgba, frame_head_sprites


NEUTRAL_BACKGROUND = (127, 127, 127)


@dataclass(frozen=True)
class ExpressionPreset:
    eye_open: float = 0.26
    eyebrow: float = 0.0
    smile: float = 0.0
    mouth_open: float = 0.0
    grin: float = 0.0
    pursing: float = 0.0
    mouth_shift: float = 0.0
    smirk: float = 0.0


# Deliberately readable at game-avatar size. Opening the mouth alone produces
# surprise, not panic; eyes, brows and mouth shape must change together.
EXPRESSION_PRESETS = {
    "unbothered": ExpressionPreset(),
    "locked_in": ExpressionPreset(eye_open=0.34, eyebrow=-28, smile=-0.25, pursing=18),
    "cracking_up": ExpressionPreset(eye_open=0.025, eyebrow=5, smile=1.6, mouth_open=80, grin=12),
    "full_panic": ExpressionPreset(eye_open=0.43, eyebrow=20, smile=-0.8, mouth_open=105, grin=12),
    "big_winner": ExpressionPreset(eye_open=0.22, eyebrow=-5, smile=1.0, grin=4, smirk=0.006),
    "spectacular_flop": ExpressionPreset(
        eye_open=0.19, eyebrow=19, smile=-1.4, mouth_open=16, mouth_shift=-0.018,
    ),
}


@dataclass
class PreparedGeneration:
    expressions: list[str]
    output_root: Path
    progress_name: str | None
    total_start: float
    source_feature: torch.Tensor
    source_keypoints: torch.Tensor
    target_keypoints: torch.Tensor


@dataclass
class SourcePrepared:
    expressions: list[str]
    output_root: Path
    progress_name: str | None
    total_start: float
    source_256: np.ndarray
    eye_ratios: np.ndarray
    lip_ratio: float


@dataclass
class PipelineTask:
    request: dict[str, object]
    future: Future[dict[str, Path] | Exception]
    enqueued_at: float


def mark_progress(progress_file: str | None, expression: str, total: int, stage: str) -> None:
    if not progress_file:
        return

    path = Path(progress_file)
    payload = {"prepared": [], "completed": [], "total": total}
    if path.is_file():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
            for key in ("prepared", "completed"):
                if isinstance(stored.get(key), list):
                    payload[key] = [str(item) for item in stored[key]]
            if isinstance(stored.get("timings"), dict):
                payload["timings"] = stored["timings"]
        except (json.JSONDecodeError, OSError):
            pass

    if expression not in payload[stage]:
        payload[stage].append(expression)

    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload),
        encoding="utf-8",
    )
    os.replace(temp_path, path)


def record_timing(progress_file: str | None, stage: str, duration: float) -> None:
    if not progress_file:
        return
    path = Path(progress_file)
    payload: dict[str, object] = {}
    if path.is_file():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                payload = stored
        except (json.JSONDecodeError, OSError):
            pass
    timings = payload.setdefault("timings", {})
    if isinstance(timings, dict):
        timings[stage] = round(float(duration), 4)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(temp_path, path)


def apply_smile(delta: torch.Tensor, value: float) -> None:
    delta[0, 20, 1] += value * -0.01
    delta[0, 14, 1] += value * -0.02
    delta[0, 17, 1] += value * 0.0065
    delta[0, 17, 2] += value * 0.003
    delta[0, 13, 1] += value * -0.00275
    delta[0, 16, 1] += value * -0.00275
    delta[0, 3, 1] += value * -0.0035
    delta[0, 7, 1] += value * -0.0035


def apply_eyebrow(delta: torch.Tensor, value: float) -> None:
    if value > 0:
        delta[0, 1, 1] += value * 0.001
        delta[0, 2, 1] += value * -0.001
    else:
        delta[0, 1, 0] += value * -0.001
        delta[0, 2, 0] += value * 0.001
        delta[0, 1, 1] += value * 0.0003
        delta[0, 2, 1] += value * -0.0003


def apply_pursing(delta: torch.Tensor, value: float) -> None:
    delta[0, 14, 1] += value * 0.001
    delta[0, 3, 1] += value * -0.0005
    delta[0, 7, 1] += value * -0.0005
    delta[0, 17, 2] += value * -0.0005


def apply_grin(delta: torch.Tensor, value: float) -> None:
    delta[0, 20, 2] += value * -0.001
    delta[0, 20, 1] += value * -0.001
    delta[0, 14, 1] += value * -0.001


def apply_lip_open(delta: torch.Tensor, value: float) -> None:
    delta[0, 19, 1] += value * 0.001
    delta[0, 19, 2] += value * 0.0001
    delta[0, 17, 1] += value * -0.0001


def apply_pout(delta: torch.Tensor, value: float) -> None:
    delta[0, 19, 0] += value



def apply_expression_preset(
    expression: str,
    source_expression: torch.Tensor,
    intensity: float,
) -> torch.Tensor:
    delta = source_expression.clone()
    amount = float(np.clip(intensity, 0.5, 1.5))
    preset = EXPRESSION_PRESETS[expression]
    # Keep each control within its useful range even at maximum intensity.
    apply_smile(delta, float(np.clip(preset.smile * amount, -2, 2)))
    apply_eyebrow(delta, float(np.clip(preset.eyebrow * amount, -40, 20)))
    apply_grin(delta, float(np.clip(preset.grin * amount, -20, 20)))
    apply_pursing(delta, float(np.clip(preset.pursing * amount, -20, 20)))
    apply_lip_open(delta, float(np.clip(preset.mouth_open * amount, 0, 120)))
    apply_pout(delta, preset.mouth_shift * amount)
    delta[0, 14, 1] -= preset.smirk * amount
    return delta


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate multiple frontal expression presets from one LivePortrait feature extraction."
    )
    parser.add_argument("--daemon", action="store_true")
    parser.add_argument("--source")
    parser.add_argument("--output-root")
    parser.add_argument("--intensity", type=float)
    parser.add_argument("--expressions-json")
    parser.add_argument("--progress-file")
    parser.add_argument("--head-parser", required=True)
    parser.add_argument("--hair-matte", required=True)
    parser.add_argument("--decode-batch-size", type=int, default=0)
    return parser.parse_args()



class GenerationEngine:
    """Long-lived LivePortrait runtime reused by all requests on one GPU."""

    def __init__(
        self,
        head_parser_path: Path,
        hair_matte_path: Path,
        decode_batch_size: int = 0,
    ) -> None:
        self.use_cuda = bool(torch.cuda.is_available())
        onnx_device = os.getenv("AVATAR_ONNX_DEVICE", "auto").strip().lower()
        if onnx_device not in {"auto", "cuda", "cpu"}:
            raise ValueError("AVATAR_ONNX_DEVICE must be auto, cuda, or cpu")
        available_onnx_cuda = "CUDAExecutionProvider" in ort.get_available_providers()

        def resolve_onnx_cuda(variable: str) -> bool:
            requested = os.getenv(variable, onnx_device).strip().lower()
            if requested not in {"auto", "cuda", "cpu"}:
                raise ValueError(f"{variable} must be auto, cuda, or cpu")
            return bool(
                requested != "cpu"
                and self.use_cuda
                and available_onnx_cuda
            )

        # Preprocessing (face detection/landmarks) and matte/export can use
        # different providers. This is useful when small ONNX CUDA calls
        # contend with the LivePortrait decoder on WSL.
        self.onnx_preprocess_use_cuda = resolve_onnx_cuda("AVATAR_ONNX_PREPROCESS_DEVICE")
        self.onnx_matte_use_cuda = resolve_onnx_cuda("AVATAR_ONNX_MATTE_DEVICE")
        self.use_mps = bool(torch.backends.mps.is_available())
        self.decode_batch_size = max(
            1,
            decode_batch_size
            or int(os.getenv("AVATAR_DECODE_BATCH_SIZE", "24" if self.use_cuda else "1")),
        )

        inference_cfg = InferenceConfig(
            flag_do_crop=False,
            flag_pasteback=False,
            flag_force_cpu=not (self.use_cuda or self.use_mps),
            flag_use_half_precision=self.use_cuda,
        )
        self.inference_cfg = inference_cfg
        self.crop_cfg = CropConfig(
            dsize=512,
            scale=2.3,
            vx_ratio=0.0,
            vy_ratio=-0.125,
            max_face_num=1,
            flag_do_rot=True,
            direction="large-small",
        )

        # RetinaFace/CoreML is unreliable on Apple Silicon, but CUDA is the
        # intended production path and lets the whole detector pipeline use GPU.
        self.cropper = Cropper(
            crop_cfg=self.crop_cfg,
            flag_force_cpu=not self.onnx_preprocess_use_cuda,
        )
        preprocess_provider = "cuda" if self.onnx_preprocess_use_cuda else "cpu"
        matte_provider = "cuda" if self.onnx_matte_use_cuda else "cpu"
        self.segmenter = HeadSegmenter(head_parser_path, execution_provider=matte_provider)
        self.portrait_matte = PortraitMatte(hair_matte_path, execution_provider=matte_provider)
        self.wrapper = LivePortraitWrapper(inference_cfg)
        self.device = self.wrapper.device
        if self.use_cuda:
            self.gpu_name = torch.cuda.get_device_name(0)
            self.peak_memory_mb = None
        elif self.use_mps:
            self.gpu_name = "Apple GPU"
            self.peak_memory_mb = None
        else:
            self.gpu_name = "CPU"
            self.peak_memory_mb = None
        landmark_path = Path(inference_cfg.checkpoint_M).parents[1] / "landmark.onnx"
        self.landmark_runner = LandmarkRunner(
            ckpt_path=str(landmark_path),
            onnx_provider=preprocess_provider,
        )
        # The preset table is immutable and shared by every request. The
        # intensity-dependent tensors are still built from the user's source.
        self.preset_order = tuple(EXPRESSION_PRESETS)
        def env_int(name: str, default: int) -> int:
            try:
                return int(os.getenv(name, str(default)))
            except (TypeError, ValueError):
                return default

        def env_float(name: str, default: float) -> float:
            try:
                return float(os.getenv(name, str(default)))
            except (TypeError, ValueError):
                return default

        self.preprocess_workers = max(1, env_int("AVATAR_PREPROCESS_WORKERS", 2))
        self.export_workers = max(1, env_int("AVATAR_EXPORT_WORKERS", 2))
        self.preprocess_queue_size = max(1, env_int("AVATAR_PREPROCESS_QUEUE_SIZE", 6))
        self.decode_queue_size = max(1, env_int("AVATAR_DECODE_QUEUE_SIZE", 6))
        legacy_batch = env_int("AVATAR_JOB_BATCH_SIZE", 3)
        self.max_decode_jobs = max(1, env_int("AVATAR_MAX_DECODE_BATCH", legacy_batch))
        wait_ms = os.getenv("AVATAR_DECODE_BATCH_WAIT_MS", os.getenv("AVATAR_JOB_BATCH_WAIT_MS", "25"))
        try:
            self.decode_batch_wait_seconds = max(0.0, float(wait_ms)) / 1000.0
        except (TypeError, ValueError):
            self.decode_batch_wait_seconds = max(0.0, env_float("AVATAR_DECODE_BATCH_WAIT_MS", 25.0)) / 1000.0
        self.pipeline: PipelineCoordinator | None = None

    def warmup(self) -> None:
        """Materialize CUDA/ONNX kernels before the first real request."""
        self.portrait_matte.warmup()
        self.segmenter.warmup()
        self.landmark_runner.warmup()
        dummy_rgb = np.full((512, 512, 3), 127, dtype=np.uint8)
        source_256 = cv2.resize(dummy_rgb, (256, 256), interpolation=cv2.INTER_AREA)
        source_tensor = self.wrapper.prepare_source(source_256)
        source_info = self.wrapper.get_kp_info(source_tensor)
        source_keypoints = self.wrapper.transform_keypoint(source_info)
        source_feature = self.wrapper.extract_feature_3d(source_tensor)
        batch = min(self.decode_batch_size, 1)
        self.wrapper.warp_decode(
            source_feature.repeat(batch, 1, 1, 1, 1),
            source_keypoints.repeat(batch, 1, 1),
            source_keypoints.repeat(batch, 1, 1),
        )
        if self.use_cuda:
            torch.cuda.synchronize()

    def _synchronize_cuda(self) -> None:
        """Include pending CUDA/ONNX work in the stage that caused it."""
        if self.use_cuda:
            torch.cuda.synchronize()

    def _decode_chunk(
        self,
        source_feature: torch.Tensor,
        source_keypoints: torch.Tensor,
        target_keypoints: torch.Tensor,
    ) -> list[np.ndarray]:
        batch_size = target_keypoints.shape[0]
        if source_feature.shape[0] == 1 and batch_size > 1:
            source_feature = source_feature.expand(
                batch_size, *source_feature.shape[1:]
            ).contiguous()
        elif source_feature.shape[0] != batch_size:
            raise ValueError("source feature batch does not match target batch")
        if source_keypoints.shape[0] == 1 and batch_size > 1:
            source_keypoints = source_keypoints.expand(
                batch_size, *source_keypoints.shape[1:]
            ).contiguous()
        elif source_keypoints.shape[0] != batch_size:
            raise ValueError("source keypoint batch does not match target batch")
        try:
            decoded = self.wrapper.warp_decode(
                source_feature,
                source_keypoints,
                target_keypoints,
            )
            return [
                cv2.resize(frame, (512, 512), interpolation=cv2.INTER_CUBIC)
                for frame in self.wrapper.parse_output(decoded["out"])
            ]
        except RuntimeError as exc:
            message = str(exc).lower()
            if not self.use_cuda or batch_size <= 1 or "out of memory" not in message:
                raise
            torch.cuda.empty_cache()
            split = max(1, batch_size // 2)
            output: list[np.ndarray] = []
            for start in range(0, batch_size, split):
                stop = min(start + split, batch_size)
                output.extend(
                    self._decode_chunk(
                        source_feature[start:stop],
                        source_keypoints[start:stop],
                        target_keypoints[start:stop],
                    )
                )
            return output

    @staticmethod
    def _validate_request(expressions: list[str], intensity: float) -> None:
        if not expressions:
            raise ValueError("expressions must contain at least one item")
        unsupported = [item for item in expressions if item not in EXPRESSION_PRESETS]
        if unsupported:
            raise ValueError(f"Unsupported expressions: {', '.join(unsupported)}")
        if not np.isfinite(intensity) or not 0.5 <= intensity <= 1.5:
            raise ValueError("intensity must be between 0.5 and 1.5")

    def _prepare_source(
        self,
        source_path: Path,
        expressions: list[str],
        intensity: float,
        output_root: Path,
        progress_file: Path | None = None,
    ) -> SourcePrepared:
        self._validate_request(expressions, intensity)
        progress_name = str(progress_file) if progress_file else None
        output_root = Path(output_root)
        total_start = time.perf_counter()
        source_bgr = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        if source_bgr is None:
            raise RuntimeError(f"Could not read source image: {source_path}")
        original_rgb = cv2.cvtColor(source_bgr, cv2.COLOR_BGR2RGB)

        self._synchronize_cuda()
        stage_start = time.perf_counter()
        crop_result = self.cropper.crop_source_image(original_rgb, self.crop_cfg)
        if crop_result is None:
            raise RuntimeError("Không tìm thấy khuôn mặt rõ ràng trong ảnh gốc.")
        source_rgb = crop_result["img_crop"]
        crop_landmarks = crop_result.get("lmk_crop")
        source_height, source_width = original_rgb.shape[:2]
        source_is_near_square = abs(source_width - source_height) <= 0.05 * max(
            source_width, source_height
        )
        if (
            source_is_near_square
            and isinstance(crop_landmarks, np.ndarray)
            and crop_landmarks.ndim == 2
            and crop_landmarks.shape[1] >= 2
            and crop_landmarks.shape[0] > 0
        ):
            landmarks_inside = (
                (crop_landmarks[:, 0] >= 0)
                & (crop_landmarks[:, 0] < self.crop_cfg.dsize)
                & (crop_landmarks[:, 1] >= 0)
                & (crop_landmarks[:, 1] < self.crop_cfg.dsize)
            )
            if float(np.mean(landmarks_inside)) < 0.5:
                interpolation = (
                    cv2.INTER_AREA
                    if max(source_width, source_height) > self.crop_cfg.dsize
                    else cv2.INTER_CUBIC
                )
                source_rgb = cv2.resize(
                    original_rgb,
                    (self.crop_cfg.dsize, self.crop_cfg.dsize),
                    interpolation=interpolation,
                )
        self._synchronize_cuda()
        record_timing(progress_name, "crop", time.perf_counter() - stage_start)

        self._synchronize_cuda()
        stage_start = time.perf_counter()
        source_alpha = self.portrait_matte.matte(source_rgb)
        source_rgba = self.segmenter.cutout(source_rgb, source_alpha)
        clean_source_rgb = composite_rgba(source_rgba, NEUTRAL_BACKGROUND)
        source_256 = cv2.resize(clean_source_rgb, (256, 256), interpolation=cv2.INTER_AREA)
        self._synchronize_cuda()
        matte_duration = time.perf_counter() - stage_start
        record_timing(progress_name, "matte", matte_duration)
        record_timing(progress_name, "matte_and_source_cutout", matte_duration)

        stage_start = time.perf_counter()
        landmarks = self.landmark_runner.run(source_rgb)[None]
        eye_ratios = calc_eye_close_ratio(landmarks)
        lip_ratio = float(calc_lip_close_ratio(landmarks)[0, 0])
        if not np.isfinite(eye_ratios).all() or not np.isfinite(lip_ratio):
            raise RuntimeError("Không đo được mắt/miệng. Hãy dùng ảnh nhìn rõ cả hai mắt.")
        self._synchronize_cuda()
        record_timing(progress_name, "landmarks", time.perf_counter() - stage_start)
        return SourcePrepared(
            expressions=list(expressions),
            output_root=output_root,
            progress_name=progress_name,
            total_start=total_start,
            source_256=source_256,
            eye_ratios=eye_ratios,
            lip_ratio=lip_ratio,
        )

    def _prepare_model_inputs(self, source: SourcePrepared, intensity: float) -> PreparedGeneration:
        self._synchronize_cuda()
        stage_start = time.perf_counter()
        source_tensor = self.wrapper.prepare_source(source.source_256)
        source_info = self.wrapper.get_kp_info(source_tensor)
        canonical_keypoints = source_info["kp"]
        source_keypoints = self.wrapper.transform_keypoint(source_info)
        source_feature = self.wrapper.extract_feature_3d(source_tensor)
        scale = source_info["scale"][..., None]
        translation = source_info["t"][:, None, :].clone()
        translation[..., 2].fill_(0)

        lip_correction = torch.zeros_like(source_keypoints)
        if source.lip_ratio >= self.inference_cfg.lip_normalize_threshold:
            lip_input = torch.tensor([[source.lip_ratio, 0.0]], dtype=torch.float32, device=self.device)
            lip_correction = self.wrapper.retarget_lip(source_keypoints, lip_input)
        zero = torch.zeros_like(source_info["pitch"])
        frontal_rotation = get_rotation_matrix(zero, zero, zero).to(self.device)
        self._synchronize_cuda()
        record_timing(source.progress_name, "feature_and_landmarks", time.perf_counter() - stage_start)

        stage_start = time.perf_counter()
        target_keypoints: list[torch.Tensor] = []
        for expression in source.expressions:
            delta = apply_expression_preset(
                expression,
                source_info["exp"],
                intensity,
            )
            target = scale * (canonical_keypoints @ frontal_rotation + delta) + translation
            target = target + lip_correction
            target_eye_ratio = float(np.clip(
                0.26 + (EXPRESSION_PRESETS[expression].eye_open - 0.26) * intensity,
                0.02,
                0.45,
            ))
            eye_input = torch.tensor(
                [[float(source.eye_ratios[0, 0]), float(source.eye_ratios[0, 1]), target_eye_ratio]],
                dtype=torch.float32,
                device=self.device,
            )
            target = target + self.wrapper.retarget_eye(source_keypoints, eye_input)
            target_keypoints.append(target[0])
        target_batch = torch.stack(target_keypoints, dim=0)
        return PreparedGeneration(
            expressions=source.expressions,
            output_root=source.output_root,
            progress_name=source.progress_name,
            total_start=source.total_start,
            source_feature=source_feature,
            source_keypoints=source_keypoints,
            target_keypoints=target_batch,
        )

    def _prepare_generation(
        self,
        source_path: Path,
        expressions: list[str],
        intensity: float,
        output_root: Path,
        progress_file: Path | None = None,
    ) -> PreparedGeneration:
        source = self._prepare_source(
            source_path,
            expressions,
            intensity,
            output_root,
            progress_file,
        )
        return self._prepare_model_inputs(source, intensity)

    def _decode_prepared(
        self,
        prepared: list[PreparedGeneration],
    ) -> list[list[np.ndarray]]:
        source_features: list[torch.Tensor] = []
        source_keypoints: list[torch.Tensor] = []
        target_keypoints: list[torch.Tensor] = []
        positions: list[tuple[int, int]] = []
        for job_index, item in enumerate(prepared):
            count = len(item.expressions)
            source_features.append(
                item.source_feature.expand(
                    count, *item.source_feature.shape[1:]
                ).contiguous()
            )
            source_keypoints.append(
                item.source_keypoints.expand(
                    count, *item.source_keypoints.shape[1:]
                ).contiguous()
            )
            target_keypoints.append(item.target_keypoints)
            positions.extend((job_index, expression_index) for expression_index in range(count))

        feature_batch = torch.cat(source_features, dim=0)
        source_keypoint_batch = torch.cat(source_keypoints, dim=0)
        target_keypoint_batch = torch.cat(target_keypoints, dim=0)
        generated: list[list[np.ndarray | None]] = [
            [None] * len(item.expressions) for item in prepared
        ]
        self._synchronize_cuda()
        stage_start = time.perf_counter()
        for start in range(0, len(positions), self.decode_batch_size):
            stop = min(start + self.decode_batch_size, len(positions))
            frames = self._decode_chunk(
                feature_batch[start:stop],
                source_keypoint_batch[start:stop],
                target_keypoint_batch[start:stop],
            )
            for offset, frame in enumerate(frames):
                job_index, expression_index = positions[start + offset]
                generated[job_index][expression_index] = frame
                item = prepared[job_index]
                mark_progress(
                    item.progress_name,
                    item.expressions[expression_index],
                    len(item.expressions),
                    "prepared",
                )
        self._synchronize_cuda()
        decode_duration = time.perf_counter() - stage_start
        for item in prepared:
            record_timing(item.progress_name, "decode", decode_duration)

        finalized: list[list[np.ndarray]] = []
        for frames in generated:
            if any(frame is None for frame in frames):
                raise RuntimeError("LivePortrait decode returned an incomplete batch.")
            finalized.append([frame for frame in frames if frame is not None])
        return finalized

    def _export_generation(
        self,
        prepared: PreparedGeneration,
        generated_rgbs: list[np.ndarray],
    ) -> dict[str, Path]:
        expressions = prepared.expressions
        output_root = prepared.output_root
        progress_name = prepared.progress_name
        self._synchronize_cuda()
        stage_start = time.perf_counter()
        reference_index = expressions.index("unbothered") if "unbothered" in expressions else 0
        shared_template = self.segmenter.make_shared_template(
            generated_rgbs[reference_index],
            None,
            known_background=NEUTRAL_BACKGROUND,
        )
        cutouts = [
            self.segmenter.apply_shared_template(
                output_rgb,
                shared_template,
                known_background=NEUTRAL_BACKGROUND,
            )
            for output_rgb in generated_rgbs
        ]
        outputs: dict[str, Path] = {}
        for expression, output_rgba in zip(expressions, frame_head_sprites(cutouts)):
            output_bgra = cv2.cvtColor(output_rgba, cv2.COLOR_RGBA2BGRA)
            expression_dir = output_root / expression
            expression_dir.mkdir(parents=True, exist_ok=True)
            output_path = expression_dir / f"{expression}.png"
            if not cv2.imwrite(str(output_path), output_bgra):
                raise RuntimeError(f"Could not save generated image: {output_path}")
            outputs[expression] = output_path
            mark_progress(progress_name, expression, len(expressions), "completed")
        self._synchronize_cuda()
        export_duration = time.perf_counter() - stage_start
        record_timing(progress_name, "export", export_duration)
        record_timing(progress_name, "parser_and_export", export_duration)
        record_timing(progress_name, "total", time.perf_counter() - prepared.total_start)
        return outputs

    def _update_peak_memory(self) -> None:
        if self.use_cuda:
            self.peak_memory_mb = round(torch.cuda.max_memory_reserved() / (1024 * 1024), 1)
        elif self.use_mps:
            allocated = torch.mps.current_allocated_memory() / (1024 * 1024)
            driver_memory = getattr(torch.mps, "driver_allocated_memory", None)
            if callable(driver_memory):
                allocated = driver_memory() / (1024 * 1024)
            self.peak_memory_mb = round(float(allocated), 1)

    def generate_batch(
        self,
        requests: list[dict[str, object]],
    ) -> list[dict[str, Path] | Exception]:
        if self.pipeline is not None:
            return self.pipeline.submit_batch(requests)
        results: list[dict[str, Path] | Exception | None] = [None] * len(requests)
        active: list[tuple[int, PreparedGeneration]] = []
        for index, request in enumerate(requests):
            try:
                active.append((
                    index,
                    self._prepare_generation(
                        Path(str(request["source"])),
                        [str(item) for item in request["expressions"]],
                        float(request["intensity"]),
                        Path(str(request["output_root"])),
                        Path(str(request["progress_file"])) if request.get("progress_file") else None,
                    ),
                ))
            except Exception as exc:
                results[index] = exc

        if active:
            try:
                decoded = self._decode_prepared([item for _, item in active])
            except Exception as exc:
                for index, _ in active:
                    results[index] = exc
            else:
                for (index, item), frames in zip(active, decoded):
                    try:
                        results[index] = self._export_generation(item, frames)
                    except Exception as exc:
                        results[index] = exc

        self._update_peak_memory()
        return [
            item if item is not None else RuntimeError("Generation did not produce a result.")
            for item in results
        ]

    def generate(
        self,
        source_path: Path,
        expressions: list[str],
        intensity: float,
        output_root: Path,
        progress_file: Path | None = None,
    ) -> dict[str, Path]:
        result = self.generate_batch([{
            "source": str(source_path),
            "expressions": expressions,
            "intensity": intensity,
            "output_root": str(output_root),
            "progress_file": str(progress_file) if progress_file else None,
        }])[0]
        if isinstance(result, Exception):
            raise result
        return result

    def start_pipeline(self) -> None:
        if self.pipeline is None:
            self.pipeline = PipelineCoordinator(self)

    def stop_pipeline(self) -> None:
        if self.pipeline is not None:
            self.pipeline.stop()
            self.pipeline = None


class PipelineCoordinator:
    """Stage scheduler for one long-lived LivePortrait model.

    Source preprocessing is allowed to overlap in bounded CPU workers. Model
    preparation and decode stay on one coordinator thread so the shared
    LivePortrait wrapper is never used concurrently. Ready jobs are collected
    for a short window and decoded together when possible.
    """

    def __init__(self, engine: GenerationEngine) -> None:
        self.engine = engine
        incoming_size = engine.preprocess_queue_size + engine.decode_queue_size
        self.decode_queue_size = engine.decode_queue_size
        self.incoming: Queue[PipelineTask] = Queue(maxsize=max(1, incoming_size))
        self.source_results: Queue[tuple[PipelineTask, SourcePrepared | Exception]] = Queue()
        self.ready: deque[tuple[PipelineTask, PreparedGeneration]] = deque()
        self.ready_since: float | None = None
        self.stop_event = threading.Event()
        self.preprocess_executor = ThreadPoolExecutor(
            max_workers=engine.preprocess_workers,
            thread_name_prefix="avatar-preprocess",
        )
        self.export_executor = ThreadPoolExecutor(
            max_workers=engine.export_workers,
            thread_name_prefix="avatar-export",
        )
        self.metrics_lock = threading.Lock()
        self.active_preprocess = 0
        self.active_decode = False
        self.active_export = 0
        self.last_decode_batch_size = 0
        self.last_decode_seconds = 0.0
        self.completed_jobs = 0
        self.thread = threading.Thread(
            target=self._run,
            name="avatar-pipeline-coordinator",
            daemon=True,
        )
        self.thread.start()

    def submit_batch(
        self,
        requests: list[dict[str, object]],
    ) -> list[dict[str, Path] | Exception]:
        futures: list[Future[dict[str, Path] | Exception]] = []
        for request in requests:
            future: Future[dict[str, Path] | Exception] = Future()
            task = PipelineTask(
                request=request,
                future=future,
                enqueued_at=time.perf_counter(),
            )
            self.incoming.put(task)
            futures.append(future)

        results: list[dict[str, Path] | Exception] = []
        for future in futures:
            try:
                results.append(future.result())
            except Exception as exc:
                results.append(exc)
        return results

    def _preprocess(self, task: PipelineTask) -> SourcePrepared:
        request = task.request
        return self.engine._prepare_source(
            Path(str(request["source"])),
            [str(item) for item in request["expressions"]],
            float(request["intensity"]),
            Path(str(request["output_root"])),
            Path(str(request["progress_file"])) if request.get("progress_file") else None,
        )

    def _preprocess_done(self, task: PipelineTask, future: Future[SourcePrepared]) -> None:
        try:
            value: SourcePrepared | Exception = future.result()
        except Exception as exc:
            value = exc
        self.source_results.put((task, value))
        with self.metrics_lock:
            self.active_preprocess = max(0, self.active_preprocess - 1)
        self._schedule_preprocess()

    def _schedule_preprocess(self) -> None:
        while not self.stop_event.is_set():
            with self.metrics_lock:
                if self.active_preprocess >= self.engine.preprocess_workers:
                    return
                try:
                    task = self.incoming.get_nowait()
                except Empty:
                    return
                self.active_preprocess += 1
            try:
                future = self.preprocess_executor.submit(self._preprocess, task)
                future.add_done_callback(
                    lambda completed, task=task: self._preprocess_done(task, completed)
                )
            except Exception as exc:
                with self.metrics_lock:
                    self.active_preprocess = max(0, self.active_preprocess - 1)
                task.future.set_exception(exc)

    def _decode_ready(self) -> None:
        if not self.ready:
            self.ready_since = None
            return
        batch: list[tuple[PipelineTask, PreparedGeneration]] = []
        while self.ready and len(batch) < self.engine.max_decode_jobs:
            batch.append(self.ready.popleft())
        self.ready_since = time.perf_counter() if self.ready else None
        prepared = [item for _, item in batch]
        with self.metrics_lock:
            self.active_decode = True
            self.last_decode_batch_size = len(batch)
        decode_started = time.perf_counter()
        try:
            decoded = self.engine._decode_prepared(prepared)
        except Exception as exc:
            for task, _ in batch:
                task.future.set_exception(exc)
            with self.metrics_lock:
                self.active_decode = False
                self.last_decode_seconds = time.perf_counter() - decode_started
            return

        with self.metrics_lock:
            self.active_decode = False
            self.last_decode_seconds = time.perf_counter() - decode_started
        self.engine._update_peak_memory()

        for (task, item), frames in zip(batch, decoded):
            with self.metrics_lock:
                self.active_export += 1
            future = self.export_executor.submit(self.engine._export_generation, item, frames)
            future.add_done_callback(
                lambda completed, task=task: self._export_done(task, completed)
            )

    def _export_done(
        self,
        task: PipelineTask,
        future: Future[dict[str, Path]],
    ) -> None:
        try:
            task.future.set_result(future.result())
        except Exception as exc:
            task.future.set_exception(exc)
        finally:
            with self.metrics_lock:
                self.active_export = max(0, self.active_export - 1)
                self.completed_jobs += 1

    def snapshot(self) -> dict[str, object]:
        with self.metrics_lock:
            active_preprocess = self.active_preprocess
            active_decode = self.active_decode
            active_export = self.active_export
            last_decode_batch_size = self.last_decode_batch_size
            last_decode_seconds = self.last_decode_seconds
            completed_jobs = self.completed_jobs
        return {
            "preprocess_queue": self.incoming.qsize(),
            "preprocess_active": active_preprocess,
            "preprocess_completed_waiting": self.source_results.qsize(),
            "decode_ready": len(self.ready),
            "decode_active": active_decode,
            "export_active": active_export,
            "last_decode_batch_size": last_decode_batch_size,
            "last_decode_seconds": round(last_decode_seconds, 4),
            "completed_jobs": completed_jobs,
            "peak_memory_mb": self.engine.peak_memory_mb,
        }

    def _run(self) -> None:
        while not self.stop_event.is_set():
            self._schedule_preprocess()

            # Keep prepared tensors bounded. If the decoder is behind, stop
            # admitting more preprocess results until one decode group drains.
            if len(self.ready) >= self.decode_queue_size:
                self._decode_ready()
                continue

            try:
                task, source = self.source_results.get(timeout=0.01)
            except Empty:
                if self.ready and self.ready_since is not None:
                    if (
                        len(self.ready) >= self.engine.max_decode_jobs
                        or time.perf_counter() - self.ready_since
                        >= self.engine.decode_batch_wait_seconds
                    ):
                        self._decode_ready()
                continue

            if isinstance(source, Exception):
                task.future.set_exception(source)
                continue
            try:
                prepared = self.engine._prepare_model_inputs(
                    source,
                    float(task.request["intensity"]),
                )
                record_timing(
                    prepared.progress_name,
                    "pipeline_wait",
                    max(0.0, time.perf_counter() - task.enqueued_at),
                )
                self.ready.append((task, prepared))
                if self.ready_since is None:
                    self.ready_since = time.perf_counter()
            except Exception as exc:
                task.future.set_exception(exc)
                continue

            if (
                len(self.ready) >= self.engine.max_decode_jobs
                or (
                    self.ready_since is not None
                    and time.perf_counter() - self.ready_since
                    >= self.engine.decode_batch_wait_seconds
                )
            ):
                self._decode_ready()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=5)
        self.preprocess_executor.shutdown(wait=False, cancel_futures=True)
        self.export_executor.shutdown(wait=False, cancel_futures=True)


def _validate_generation_request(request: object) -> dict[str, object]:
    if not isinstance(request, dict):
        raise ValueError("worker request must be an object")
    expressions = request.get("expressions")
    if not isinstance(expressions, list):
        raise ValueError("expressions must be a list")
    return {
        "source": str(request["source"]),
        "output_root": str(request["output_root"]),
        "intensity": float(request["intensity"]),
        "expressions": [str(item) for item in expressions],
        "progress_file": str(request.get("progress_file", "")) or None,
    }


def run_daemon(args: argparse.Namespace) -> int:
    protocol_out = sys.stdout
    # Third-party model loaders log to stdout. Keep stdout exclusively for the
    # JSON protocol and send runtime logs to stderr.
    sys.stdout = sys.stderr
    metrics_stop = threading.Event()
    metrics_thread: threading.Thread | None = None
    try:
        engine = GenerationEngine(
            Path(args.head_parser),
            Path(args.hair_matte),
            args.decode_batch_size,
        )
        engine.warmup()
        pipeline_mode = os.getenv("AVATAR_PIPELINE_MODE", "staged").strip().lower()
        if pipeline_mode == "staged":
            engine.start_pipeline()

        def log_metrics() -> None:
            while not metrics_stop.wait(10.0):
                pipeline = engine.pipeline
                if pipeline is None:
                    continue
                print(
                    "pipeline metrics " + json.dumps(pipeline.snapshot(), sort_keys=True),
                    file=sys.stderr,
                    flush=True,
                )

        metrics_thread = threading.Thread(
            target=log_metrics,
            name="avatar-pipeline-metrics",
            daemon=True,
        )
        metrics_thread.start()
        protocol_out.write(json.dumps({
            "event": "ready",
            "pipeline_mode": pipeline_mode,
            "device": engine.device,
            "gpu_name": engine.gpu_name,
            "peak_memory_mb": engine.peak_memory_mb,
            "decode_batch_size": engine.decode_batch_size,
            "max_decode_jobs": engine.max_decode_jobs,
            "preprocess_workers": engine.preprocess_workers,
            "export_workers": engine.export_workers,
            "decode_batch_wait_ms": round(engine.decode_batch_wait_seconds * 1000, 2),
        }) + "\n")
        protocol_out.flush()
    except Exception as exc:
        protocol_out.write(json.dumps({
            "event": "error",
            "error": str(exc),
        }) + "\n")
        protocol_out.flush()
        return 1

    response_lock = threading.Lock()
    request_threads: set[threading.Thread] = set()
    request_threads_lock = threading.Lock()

    def write_response(request_id: object, response: dict[str, object]) -> None:
        if request_id is not None:
            response["request_id"] = request_id
        with response_lock:
            protocol_out.write(json.dumps(response) + "\n")
            protocol_out.flush()

    def handle_request(payload: dict[str, object]) -> None:
        request_id = payload.get("request_id")
        try:
            command = str(payload.get("command", "generate"))
            if command == "generate":
                request = _validate_generation_request(payload)
                result = engine.generate_batch([request])[0]
                if isinstance(result, Exception):
                    raise result
                response = {
                    "ok": True,
                    "outputs": {name: str(path) for name, path in result.items()},
                    "runtime": {"peak_memory_mb": engine.peak_memory_mb},
                }
            elif command == "generate_batch":
                raw_requests = payload.get("requests")
                if not isinstance(raw_requests, list) or not raw_requests:
                    raise ValueError("generate_batch requires a non-empty requests list")
                requests = [_validate_generation_request(item) for item in raw_requests]
                batch_results = engine.generate_batch(requests)
                response = {
                    "ok": True,
                    "results": [
                        (
                            {"ok": False, "error": str(item)}
                            if isinstance(item, Exception)
                            else {
                                "ok": True,
                                "outputs": {
                                    name: str(path) for name, path in item.items()
                                },
                            }
                        )
                        for item in batch_results
                    ],
                    "runtime": {"peak_memory_mb": engine.peak_memory_mb},
                }
            else:
                raise ValueError(f"unsupported worker command: {command}")
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        write_response(request_id, response)

    def run_request(payload: dict[str, object]) -> None:
        try:
            handle_request(payload)
        finally:
            with request_threads_lock:
                request_threads.discard(threading.current_thread())

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError("worker request must be an object")
        except Exception as exc:
            write_response(None, {"ok": False, "error": str(exc)})
            continue
        thread = threading.Thread(target=run_request, args=(payload,), daemon=True)
        with request_threads_lock:
            request_threads.add(thread)
        thread.start()

    while True:
        with request_threads_lock:
            pending_threads = list(request_threads)
        if not pending_threads:
            break
        for thread in pending_threads:
            thread.join()
    metrics_stop.set()
    if metrics_thread is not None:
        metrics_thread.join(timeout=1)
    engine.stop_pipeline()
    return 0


def run_once(args: argparse.Namespace) -> int:
    if not args.source or not args.output_root or args.intensity is None or not args.expressions_json:
        raise ValueError("one-shot mode requires source, output-root, intensity and expressions-json")
    expressions = json.loads(args.expressions_json)
    engine = GenerationEngine(
        Path(args.head_parser),
        Path(args.hair_matte),
        args.decode_batch_size,
    )
    engine.generate(
        Path(args.source),
        [str(item) for item in expressions],
        args.intensity,
        Path(args.output_root),
        Path(args.progress_file) if args.progress_file else None,
    )
    return 0


def main() -> None:
    args = parse_args()
    if args.daemon:
        raise SystemExit(run_daemon(args))
    raise SystemExit(run_once(args))


if __name__ == "__main__":
    main()
