#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"
PYTHON_BIN="${PYTHON_BIN:-python3.10}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Missing $PYTHON_BIN. LivePortrait upstream recommends Python 3.10."
  echo "Install it first (for example: brew install python@3.10), then rerun this script."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. Install it with: brew install ffmpeg"
  exit 1
fi

mkdir -p "$(dirname "$ROOT")"

if [ ! -d "$ROOT/.git" ]; then
  git clone https://github.com/KlingAIResearch/LivePortrait.git "$ROOT"
else
  echo "LivePortrait already exists at $ROOT; keeping the current checkout."
fi

if [ ! -x "$ROOT/.venv/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$ROOT/.venv"
fi

"$ROOT/.venv/bin/pip" install --upgrade pip
"$ROOT/.venv/bin/pip" install -r "$ROOT/requirements_macOS.txt"
"$ROOT/.venv/bin/pip" install 'requests>=2.31,<3'
"$ROOT/.venv/bin/pip" install 'huggingface_hub[cli]'

missing_weights=false
for weight in \
  base_models/appearance_feature_extractor.pth \
  base_models/motion_extractor.pth \
  base_models/spade_generator.pth \
  base_models/warping_module.pth \
  retargeting_models/stitching_retargeting_module.pth \
  landmark.onnx; do
  if [ ! -s "$ROOT/pretrained_weights/liveportrait/$weight" ]; then
    missing_weights=true
  fi
done

if [ "$missing_weights" = true ]; then
  if [ -x "$ROOT/.venv/bin/hf" ]; then
    "$ROOT/.venv/bin/hf" download KlingTeam/LivePortrait \
      --local-dir "$ROOT/pretrained_weights" \
      --include "liveportrait/*"
  else
    "$ROOT/.venv/bin/huggingface-cli" download KlingTeam/LivePortrait \
      --local-dir "$ROOT/pretrained_weights" \
      --include "liveportrait/*"
  fi
fi

# Server-side input normalization uses LivePortrait's bundled InsightFace
# detector, so the GPU service can receive the original upload instead of relying
# on a browser-generated 512x512 crop.
missing_face_weights=false
for weight in 2d106det.onnx det_10g.onnx; do
  if [ ! -s "$ROOT/pretrained_weights/insightface/models/buffalo_l/$weight" ]; then
    missing_face_weights=true
  fi
done

if [ "$missing_face_weights" = true ]; then
  if [ -x "$ROOT/.venv/bin/hf" ]; then
    "$ROOT/.venv/bin/hf" download KlingTeam/LivePortrait \
      --local-dir "$ROOT/pretrained_weights" \
      --include "insightface/models/buffalo_l/*"
  else
    "$ROOT/.venv/bin/huggingface-cli" download KlingTeam/LivePortrait \
      --local-dir "$ROOT/pretrained_weights" \
      --include "insightface/models/buffalo_l/*"
  fi
fi

# Semantic face parsing excludes the neck/clothes as well as the background.
# Reuse LivePortrait's ONNX Runtime; no additional Python package is required.
PARSER_DIR="$ROOT/pretrained_weights/head_parser"
PARSER_SHA256="0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f"
mkdir -p "$PARSER_DIR"
if [ ! -s "$PARSER_DIR/resnet18.onnx" ] || \
  [ "$(shasum -a 256 "$PARSER_DIR/resnet18.onnx" | awk '{print $1}')" != "$PARSER_SHA256" ]; then
  echo "Downloading head segmentation model..."
  parser_temp="$(mktemp "$PARSER_DIR/.resnet18.XXXXXX")"
  trap 'rm -f "$parser_temp"' EXIT
  curl --fail --location --retry 3 \
    --output "$parser_temp" \
    https://github.com/yakhyo/face-parsing/releases/download/weights/resnet18.onnx
  if [ "$(shasum -a 256 "$parser_temp" | awk '{print $1}')" != "$PARSER_SHA256" ]; then
    echo "Head segmentation model checksum mismatch. Rerun make setup."
    exit 1
  fi
  mv "$parser_temp" "$PARSER_DIR/resnet18.onnx"
  trap - EXIT
fi

# Fine hair needs an image-matting model, not only semantic face parsing. The
# Lite BiRefNet ONNX model is small enough for local development and reuses the
# same ONNX Runtime already used by LivePortrait. It runs on CPU because this
# graph contains tensors that CoreML's ONNX provider cannot compile efficiently.
MATTING_DIR="$ROOT/pretrained_weights/hair_matting"
MATTING_MD5="4fab47adc4ff364be1713e97b7e66334"
MATTING_FILE="$MATTING_DIR/birefnet-general-lite.onnx"
mkdir -p "$MATTING_DIR"
matting_ok=false
if [ -s "$MATTING_FILE" ]; then
  if command -v md5 >/dev/null 2>&1 && [ "$(md5 -q "$MATTING_FILE")" = "$MATTING_MD5" ]; then
    matting_ok=true
  fi
fi
if [ "$matting_ok" != true ]; then
  echo "Downloading BiRefNet hair matting model (~214 MiB)..."
  matting_temp="$(mktemp "$MATTING_DIR/.birefnet.XXXXXX")"
  trap 'rm -f "$matting_temp"' EXIT
  curl --fail --location --retry 3 \
    --output "$matting_temp" \
    https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx
  if command -v md5 >/dev/null 2>&1 && [ "$(md5 -q "$matting_temp")" != "$MATTING_MD5" ]; then
    echo "Hair matting model checksum mismatch. Rerun make setup."
    exit 1
  fi
  mv "$matting_temp" "$MATTING_FILE"
  trap - EXIT
fi

cat <<EOF

LivePortrait, face detection, head parsing and hair matting are ready at:
  $ROOT

The LivePortrait model is ready for the Runner installer.
EOF
