from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


def _onnx_providers(execution_provider: str | None) -> list[str]:
    """Prefer CUDA in production, while retaining a CPU fallback for dev."""
    available = set(ort.get_available_providers())
    if execution_provider == "cuda" and "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


@dataclass(frozen=True)
class SharedHeadTemplate:
    """One clean hair layer reused by every expression in a batch.

    The face/jaw alpha must stay dynamic. Reusing the whole neutral-head alpha
    clips the chin on wide-mouth expressions because LivePortrait actually
    moves the lower face silhouette.
    """

    rgba: np.ndarray
    hair_guard: np.ndarray
    face_bridge_alpha: np.ndarray


class PortraitMatte:
    """BiRefNet foreground matte used to preserve fine hair detail.

    The semantic parser is intentionally kept separate: BiRefNet is good at
    foreground/background boundaries, while CelebAMask labels are what let us
    reject neck and clothing for a head-only sprite.
    """

    INPUT_SIZE = (1024, 1024)
    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def __init__(self, model_path: Path, execution_provider: str | None = None) -> None:
        if not model_path.is_file():
            raise RuntimeError("Thiếu model matting tóc. Chạy make setup trước khi tạo biểu cảm.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=_onnx_providers(execution_provider),
        )
        self.input_name = self.session.get_inputs()[0].name

    def warmup(self) -> None:
        self.matte(np.full((512, 512, 3), 127, dtype=np.uint8))

    def matte(self, image_rgb: np.ndarray) -> np.ndarray:
        height, width = image_rgb.shape[:2]
        image = cv2.resize(image_rgb, self.INPUT_SIZE, interpolation=cv2.INTER_LANCZOS4)
        tensor = image.astype(np.float32) / 255.0
        tensor = (tensor - self.MEAN) / self.STD
        tensor = np.ascontiguousarray(tensor.transpose(2, 0, 1)[None])
        prediction = self.session.run(None, {self.input_name: tensor})[0]
        logits = prediction[0, 0].astype(np.float32, copy=False)
        logits = np.clip(logits, -30.0, 30.0)
        alpha = 1.0 / (1.0 + np.exp(-logits))
        minimum = float(alpha.min())
        maximum = float(alpha.max())
        if maximum > minimum + 1e-6:
            alpha = (alpha - minimum) / (maximum - minimum)
        return cv2.resize(alpha, (width, height), interpolation=cv2.INTER_LANCZOS4)


class HeadSegmenter:
    """Parser-guided soft head matte for transparent avatar sprites.

    BiSeNet still supplies semantic evidence, but the output is no longer an
    argmax mask with a feathered hard edge. We keep the full class confidence
    around the selected head and use it as a soft alpha matte. This preserves
    thin hair strands and lets us decontaminate edge colours before compositing.

    Model and label map: https://github.com/yakhyo/face-parsing
    ONNX Runtime is already part of the LivePortrait environment.
    """

    # Skin, brows, eyes, glasses, ears, earrings, nose, mouth, lips, hair, hat.
    HEAD_LABELS = (*range(1, 14), 17, 18)

    def __init__(self, model_path: Path, execution_provider: str | None = None) -> None:
        if not model_path.is_file():
            raise RuntimeError("Thiếu model tách đầu. Chạy make setup trước khi tạo biểu cảm.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=_onnx_providers(execution_provider),
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

    def warmup(self) -> None:
        image = np.full((512, 512, 3), 127, dtype=np.uint8)
        tensor = image.astype(np.float32) / 255.0
        tensor = (tensor - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array(
            [0.229, 0.224, 0.225], dtype=np.float32
        )
        tensor = np.ascontiguousarray(tensor.transpose(2, 0, 1)[None])
        self.session.run([self.output_name], {self.input_name: tensor})

    @staticmethod
    def _class_probabilities(scores: np.ndarray) -> np.ndarray:
        """Return per-class probabilities for either logits or probabilities."""
        values = scores.astype(np.float32, copy=False)
        channel_sum = values.sum(axis=0)
        looks_like_probabilities = (
            float(values.min()) >= -1e-5
            and float(values.max()) <= 1.00001
            and float(np.mean(np.abs(channel_sum - 1.0))) < 1e-3
        )
        if looks_like_probabilities:
            return values

        shifted = values - values.max(axis=0, keepdims=True)
        exp_scores = np.exp(shifted)
        return exp_scores / np.maximum(exp_scores.sum(axis=0, keepdims=True), 1e-8)

    @staticmethod
    def _decontaminate_edge_colour(
        image: np.ndarray,
        alpha: np.ndarray,
        known_background: tuple[int, int, int] | None = None,
    ) -> np.ndarray:
        """Estimate foreground RGB for translucent hair instead of keeping spill."""
        image_f = image.astype(np.float32) / 255.0
        alpha_f = alpha.astype(np.float32) / 255.0
        if known_background is not None:
            background_rgb = np.array(known_background, dtype=np.float32) / 255.0
            background = np.broadcast_to(background_rgb, image_f.shape)
        else:
            # Infer the local background from pixels that the matte considers
            # confidently transparent. This lets us undo the original blend:
            # C = a*F + (1-a)*B  ->  F = (C - (1-a)*B) / a.
            background_seed = (alpha_f <= 0.035).astype(np.float32)
            weight = cv2.GaussianBlur(background_seed, (0, 0), sigmaX=5.0, sigmaY=5.0)
            weighted_rgb = cv2.GaussianBlur(
                image_f * background_seed[..., None],
                (0, 0),
                sigmaX=5.0,
                sigmaY=5.0,
            )
            background = np.divide(
                weighted_rgb,
                weight[..., None],
                out=np.zeros_like(image_f),
                where=weight[..., None] > 1e-5,
            )
            fallback = np.median(image_f[background_seed > 0], axis=0) if np.any(background_seed) else np.zeros(3)
            missing = weight <= 1e-5
            background[missing] = fallback

        safe_alpha = np.maximum(alpha_f, 0.08)[..., None]
        unmixed = (image_f - (1.0 - alpha_f[..., None]) * background) / safe_alpha
        unmixed = np.clip(unmixed, 0.0, 1.0)

        # Alpha below ~8% is too ill-conditioned to invert directly. Pull only
        # those very faint pixels toward nearby solid foreground colour.
        confident = (alpha_f >= 0.92).astype(np.float32)
        if int(np.count_nonzero(confident)) >= 64:
            fg_weight = cv2.GaussianBlur(confident, (0, 0), sigmaX=3.0, sigmaY=3.0)
            weighted_fg = cv2.GaussianBlur(
                image_f * confident[..., None], (0, 0), sigmaX=3.0, sigmaY=3.0
            )
            neighbour_fg = np.divide(
                weighted_fg,
                fg_weight[..., None],
                out=unmixed.copy(),
                where=fg_weight[..., None] > 1e-5,
            )
            faint = np.clip((0.10 - alpha_f) / 0.10, 0.0, 1.0)[..., None]
            unmixed = unmixed * (1.0 - faint) + neighbour_fg * faint

        edge = ((alpha_f > 0.0) & (alpha_f < 0.985)).astype(np.float32)[..., None]
        corrected = image_f * (1.0 - edge) + unmixed * edge
        return np.rint(np.clip(corrected, 0.0, 1.0) * 255.0).astype(np.uint8)

    def _cutout_with_labels(
        self,
        image_rgb: np.ndarray,
        foreground_alpha: np.ndarray | None = None,
        known_background: tuple[int, int, int] | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        image = cv2.resize(image_rgb, (512, 512), interpolation=cv2.INTER_LINEAR)
        tensor = image.astype(np.float32) / 255.0
        tensor = (tensor - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array(
            [0.229, 0.224, 0.225], dtype=np.float32
        )
        tensor = np.ascontiguousarray(tensor.transpose(2, 0, 1)[None])
        scores = self.session.run([self.output_name], {self.input_name: tensor})[0]
        class_scores = scores[0]
        labels = class_scores.argmax(axis=0).astype(np.uint8)
        labels = cv2.resize(labels, (512, 512), interpolation=cv2.INTER_NEAREST)
        probabilities = self._class_probabilities(class_scores)
        head_probability = probabilities[list(self.HEAD_LABELS)].sum(axis=0)
        head_probability = cv2.resize(head_probability, (512, 512), interpolation=cv2.INTER_LINEAR)
        mask = np.isin(labels, self.HEAD_LABELS).astype(np.uint8)

        # Choose the head containing the most facial skin. Background objects
        # occasionally receive hair/hat labels; those must not become sprites.
        count, components, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        skin_counts = np.bincount(components[labels == 1], minlength=count)
        skin_counts[0] = 0
        main_component = int(skin_counts.argmax())
        if skin_counts[main_component] < 512:
            # LivePortrait frames are rendered onto a known neutral background.
            # Stylized SDXL/FLUX faces can make the parser call most of the head
            # "hat" (label 18), leaving too few skin pixels even though there is
            # one large, centered head component. Allow that narrow generated-
            # frame fallback, but keep ordinary photo cutouts strict.
            if known_background is None:
                raise RuntimeError("Không tách được vùng đầu rõ ràng. Hãy chọn ảnh rõ mặt và đủ sáng.")
            areas = stats[:, cv2.CC_STAT_AREA].copy()
            areas[0] = 0
            largest_component = int(areas.argmax())
            largest_area = int(areas[largest_component])
            image_area = 512 * 512
            if (
                largest_area < 4096
                or largest_area > int(image_area * 0.9)
                or int(components[256, 256]) != largest_component
            ):
                raise RuntimeError("Không tách được vùng đầu rõ ràng. Hãy chọn ảnh rõ mặt và đủ sáng.")
            main_component = largest_component
        main_mask = (components == main_component).astype(np.uint8)
        nearby = cv2.dilate(main_mask, np.ones((15, 15), dtype=np.uint8))
        keep = [main_component]
        for component in range(1, count):
            if stats[component, cv2.CC_STAT_AREA] >= 16 and np.any(nearby[components == component]):
                keep.append(component)
        mask = np.isin(components, keep).astype(np.uint8)

        # Repair tiny isolated holes without filling spaces between hair strands.
        hole_count, holes, hole_stats, _ = cv2.connectedComponentsWithStats(1 - mask, connectivity=8)
        border_components = set(np.concatenate((holes[0], holes[-1], holes[:, 0], holes[:, -1])))
        for component in range(1, hole_count):
            if component not in border_components and hole_stats[component, cv2.CC_STAT_AREA] <= 64:
                mask[holes == component] = 1

        # BiRefNet supplies the detailed person/background alpha. Use a tight
        # semantic support around skin/ears/chin so the neutral backing colour
        # cannot become a grey outline there, while keeping a much wider band
        # only around hair/hat to preserve thin strands missed by the parser.
        semantic_hair = (np.isin(labels, (17, 18)) & (mask > 0)).astype(np.uint8)
        semantic_face = ((mask > 0) & (semantic_hair == 0)).astype(np.uint8)
        face_support = cv2.dilate(
            semantic_face,
            np.ones((7, 7), dtype=np.uint8),
            iterations=1,
        )
        hair_support = cv2.dilate(
            semantic_hair,
            np.ones((17, 17), dtype=np.uint8),
            iterations=1,
        )
        support = np.maximum(face_support, hair_support)
        support[np.isin(labels, (14, 15, 16))] = 0  # neck, neck_l, cloth

        if foreground_alpha is None:
            soft_alpha = np.clip((head_probability - 0.04) / 0.90, 0.0, 1.0)
            soft_alpha = soft_alpha * soft_alpha * (3.0 - 2.0 * soft_alpha)
        else:
            soft_alpha = cv2.resize(
                foreground_alpha.astype(np.float32),
                (512, 512),
                interpolation=cv2.INTER_LANCZOS4,
            )
            soft_alpha = np.clip(soft_alpha, 0.0, 1.0)
        soft_alpha *= support.astype(np.float32)

        # Skin and the interior of the selected head should stay opaque. This
        # avoids tiny confidence dents from a general foreground model turning
        # into pinholes in cheeks, eyes or solid hair masses.
        distance = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
        soft_alpha[distance >= 2.5] = 1.0
        alpha = np.rint(np.clip(soft_alpha, 0.0, 1.0) * 255.0).astype(np.uint8)

        clean_rgb = self._decontaminate_edge_colour(image, alpha, known_background)
        rgba = np.dstack((clean_rgb, alpha))
        rgba[alpha == 0, :3] = 0
        return rgba, labels

    def cutout(
        self,
        image_rgb: np.ndarray,
        foreground_alpha: np.ndarray | None = None,
        known_background: tuple[int, int, int] | None = None,
    ) -> np.ndarray:
        rgba, _ = self._cutout_with_labels(image_rgb, foreground_alpha, known_background)
        return rgba

    def make_shared_template(
        self,
        image_rgb: np.ndarray,
        foreground_alpha: np.ndarray | None,
        known_background: tuple[int, int, int],
    ) -> SharedHeadTemplate:
        """Build the one static hair/alpha layer used by all expressions.

        LivePortrait changes the face expression, but hair does not need to be
        regenerated and re-matted for every frame. Freezing the hair from one
        frontal reference frame also prevents expression-specific decoder
        noise/background spill from appearing along the hair boundary.
        """
        rgba, labels = self._cutout_with_labels(
            image_rgb,
            foreground_alpha,
            known_background,
        )
        # Parser label 17 is hair and 18 is hat. Do not use the portrait
        # matte's long soft fringe as the final hair alpha: LivePortrait's
        # decoder already anti-aliases against the neutral backing colour, so
        # keeping that fringe produces the obvious grey halo seen in the UI.
        # Instead build a crisp semantic silhouette and add only ~1 px of
        # antialiasing at export time.
        base_alpha = rgba[..., 3].copy()
        hair_core = np.isin(labels, (17, 18)).astype(np.uint8)
        reference_face = np.isin(labels, tuple(range(1, 14))).astype(np.uint8)
        kernel3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        eroded_hair = cv2.erode(hair_core, kernel3, iterations=1)

        # Recover genuine one-pixel strands when their colour is clearly not
        # the known neutral background. The threshold adapts to dark, blond or
        # grey hair from the interior hair colour instead of assuming a fixed
        # luminance range.
        image = cv2.resize(image_rgb, (512, 512), interpolation=cv2.INTER_LINEAR)
        background = np.array(known_background, dtype=np.float32).reshape(1, 1, 3)
        background_distance = np.linalg.norm(image.astype(np.float32) - background, axis=2)
        interior_distance = background_distance[eroded_hair > 0]
        if interior_distance.size:
            strand_threshold = max(14.0, float(np.percentile(interior_distance, 20)) * 0.65)
        else:
            strand_threshold = 24.0
        strong_strand = (hair_core > 0) & (background_distance >= strand_threshold)
        clean_hair_mask = np.maximum(eroded_hair, strong_strand.astype(np.uint8))

        # Drop tiny isolated parser specks that otherwise become dark dots in
        # transparent PNGs.
        count, components, stats, _ = cv2.connectedComponentsWithStats(clean_hair_mask, connectivity=8)
        if count > 1:
            keep = np.zeros(count, dtype=np.uint8)
            keep[1:] = (stats[1:, cv2.CC_STAT_AREA] >= 12).astype(np.uint8)
            clean_hair_mask = keep[components]

        hair_alpha = cv2.GaussianBlur(
            clean_hair_mask.astype(np.float32),
            (0, 0),
            sigmaX=0.48,
            sigmaY=0.48,
        )
        # Compress the blur into a narrow antialias band instead of a wide
        # translucent matte. This is intentionally "sticker clean" like the
        # reference demo rather than trying to preserve every contaminated
        # subpixel from the source photo.
        hair_alpha = np.clip((hair_alpha - 0.18) / 0.72, 0.0, 1.0)
        hair_alpha_u8 = np.rint(hair_alpha * 255.0).astype(np.uint8)

        # Replace RGB near the outside silhouette with colour propagated from
        # deep inside the hair. This removes any neutral-background RGB that
        # the decoder baked into the antialiased edge, even for pixels whose
        # semantic label itself says "hair".
        distance_inside = cv2.distanceTransform(clean_hair_mask, cv2.DIST_L2, 3)
        solid_hair = (distance_inside >= 3.0).astype(np.float32)
        if int(np.count_nonzero(solid_hair)) >= 64:
            colour_weight = cv2.GaussianBlur(
                solid_hair,
                (0, 0),
                sigmaX=5.0,
                sigmaY=5.0,
            )
            weighted_colour = cv2.GaussianBlur(
                rgba[..., :3].astype(np.float32) * solid_hair[..., None],
                (0, 0),
                sigmaX=5.0,
                sigmaY=5.0,
            )
            local_hair = np.divide(
                weighted_colour,
                colour_weight[..., None],
                out=rgba[..., :3].astype(np.float32).copy(),
                where=colour_weight[..., None] > 1e-5,
            )
            edge_strength = np.clip((3.25 - distance_inside) / 2.75, 0.0, 1.0)
            edge_strength *= (hair_alpha_u8 > 0).astype(np.float32)
            rgb = (
                rgba[..., :3].astype(np.float32) * (1.0 - edge_strength[..., None])
                + local_hair * edge_strength[..., None]
            )
            rgba[..., :3] = np.rint(np.clip(rgb, 0, 255)).astype(np.uint8)
        rgba[..., 3] = hair_alpha_u8
        rgba[hair_alpha_u8 == 0, :3] = 0

        # Used only to suppress the generated frame's own hair before the
        # frozen clean layer is composited back. Keep this tight so skin at the
        # forehead/temples is not accidentally removed.
        hair_guard = cv2.dilate(
            (hair_alpha_u8 > 0).astype(np.uint8),
            np.ones((5, 5), dtype=np.uint8),
            iterations=1,
        )

        # Preserve only a tiny neutral-expression face strip under the
        # hairline. Extreme expressions can make the semantic parser flip a few
        # forehead pixels from skin -> hair/background, which otherwise opens a
        # transparent crack even though the actual forehead has not moved.
        # This bridge never reaches the jaw/chin, so lower-face silhouette stays
        # fully dynamic.
        face_near_hair = (
            cv2.dilate(
                reference_face,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
                iterations=1,
            )
            & cv2.dilate(hair_core, np.ones((11, 11), dtype=np.uint8), iterations=1)
        )
        face_bridge_alpha = np.where(face_near_hair > 0, base_alpha, 0).astype(np.uint8)
        return SharedHeadTemplate(
            rgba=rgba,
            hair_guard=hair_guard,
            face_bridge_alpha=face_bridge_alpha,
        )

    def apply_shared_template(
        self,
        image_rgb: np.ndarray,
        template: SharedHeadTemplate,
        known_background: tuple[int, int, int],
    ) -> np.ndarray:
        """Combine a per-expression face/jaw matte with the one clean hair layer.

        BiRefNet is still run only once per batch. The much smaller semantic
        parser is run here so an open mouth can move the chin without being
        clipped by the neutral expression's silhouette.
        """
        dynamic_rgba, labels = self._cutout_with_labels(
            image_rgb,
            foreground_alpha=None,
            known_background=known_background,
        )

        dynamic_alpha = dynamic_rgba[..., 3].copy()
        dynamic_hair = np.isin(labels, (17, 18)).astype(np.uint8)
        dynamic_hair = cv2.dilate(
            dynamic_hair,
            np.ones((5, 5), dtype=np.uint8),
            iterations=1,
        )
        semantic_face = np.isin(labels, tuple(range(1, 14))).astype(np.uint8)
        face_support = cv2.dilate(
            semantic_face,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
            iterations=1,
        )

        # The dynamic layer is face/ears/jaw only. _cutout_with_labels has a
        # deliberately wide hair support for ordinary one-shot cutouts; if we
        # leave that enabled here it reintroduces the decoder's grey halo just
        # outside the frozen clean hair. Restrict this layer to a tiny semantic
        # face band, then let the shared template own the entire upper-head
        # silhouette.
        dynamic_alpha[face_support == 0] = 0
        # Suppress generated hair only where the frozen hair is guaranteed to
        # cover it. Using the union here can create transparent cracks at the
        # moving forehead/hairline when the parser changes a few labels between
        # expressions.
        suppress_hair = (
            (dynamic_hair > 0)
            & (template.hair_guard > 0)
            & (semantic_face == 0)
        )
        dynamic_alpha[suppress_hair] = 0
        dynamic_alpha = np.maximum(dynamic_alpha, template.face_bridge_alpha)

        # Recompute face RGB after adding the bridge so newly restored pixels
        # use the current expression frame rather than zero/transparent RGB.
        image = cv2.resize(image_rgb, (512, 512), interpolation=cv2.INTER_LINEAR)
        dynamic_rgb = self._decontaminate_edge_colour(
            image,
            dynamic_alpha,
            known_background,
        )
        dynamic_rgba = np.dstack((dynamic_rgb, dynamic_alpha))
        dynamic_rgba[dynamic_alpha == 0, :3] = 0

        # Alpha-composite frozen clean hair over the dynamic face. Premultiplied
        # math keeps partially transparent strands clean and avoids dark seams.
        face_a = dynamic_rgba[..., 3:4].astype(np.float32) / 255.0
        hair_a = template.rgba[..., 3:4].astype(np.float32) / 255.0
        face_rgb = dynamic_rgba[..., :3].astype(np.float32) / 255.0
        hair_rgb = template.rgba[..., :3].astype(np.float32) / 255.0
        out_a = hair_a + face_a * (1.0 - hair_a)
        premultiplied = hair_rgb * hair_a + face_rgb * face_a * (1.0 - hair_a)
        out_rgb = np.divide(
            premultiplied,
            out_a,
            out=np.zeros_like(premultiplied),
            where=out_a > 1e-6,
        )
        rgba = np.dstack((
            np.rint(np.clip(out_rgb, 0.0, 1.0) * 255.0).astype(np.uint8),
            np.rint(np.clip(out_a[..., 0], 0.0, 1.0) * 255.0).astype(np.uint8),
        ))
        rgba[rgba[..., 3] == 0, :3] = 0
        return rgba


def composite_rgba(rgba: np.ndarray, background: tuple[int, int, int]) -> np.ndarray:
    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    foreground = rgba[..., :3].astype(np.float32)
    background_rgb = np.array(background, dtype=np.float32).reshape(1, 1, 3)
    composited = foreground * alpha + background_rgb * (1.0 - alpha)
    return np.rint(np.clip(composited, 0.0, 255.0)).astype(np.uint8)


def frame_head_sprites(images: list[np.ndarray], size: int = 512) -> list[np.ndarray]:
    """Apply one transform to the whole set, leaving room for the widest jaw.

    Independently fitting every expression makes the head jump/resize when a
    game switches sprites. All outputs share a canvas, scale and pivot instead.
    """
    union = np.maximum.reduce([image[..., 3] for image in images])
    points = cv2.findNonZero((union > 0).astype(np.uint8))
    if points is None:
        raise RuntimeError("Không tìm thấy vùng đầu để xuất PNG.")
    x, y, width, height = cv2.boundingRect(points)
    scale = size * 0.82 / max(width, height)
    transform = np.array(
        [[scale, 0, size / 2 - (x + width / 2) * scale],
         [0, scale, size / 2 - (y + height / 2) * scale]],
        dtype=np.float32,
    )
    framed = []
    for image in images:
        # Resample premultiplied colour to avoid black outlines on light scenes.
        premultiplied = image.astype(np.float32) / 255.0
        premultiplied[..., :3] *= premultiplied[..., 3:4]
        resized = cv2.warpAffine(
            premultiplied, transform, (size, size), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0),
        )
        alpha = resized[..., 3:4]
        resized[..., :3] = np.divide(
            resized[..., :3], alpha, out=np.zeros_like(resized[..., :3]), where=alpha > 0,
        )
        framed.append(np.rint(np.clip(resized, 0, 1) * 255).astype(np.uint8))
    return framed
