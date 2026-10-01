#!/usr/bin/env bash
set -euo pipefail

ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"
PYTHON_BIN="${PYTHON_BIN:-python3.10}"

for command_name in "$PYTHON_BIN" git ffmpeg curl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing $command_name. Install it before running setup." >&2
    exit 1
  }
done

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
"$ROOT/.venv/bin/pip" install -r "$ROOT/requirements.txt"

# The upstream Linux requirements intentionally leave PyTorch to the machine
# setup. Install the pinned pair used by this worker so the daemon can import
# torch on both CUDA servers and CPU-only hosts. Override TORCH_INDEX_URL when
# the server uses another CUDA wheel channel.
TORCH_INDEX_URL="${TORCH_INDEX_URL:-}"
if [ -z "$TORCH_INDEX_URL" ]; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    TORCH_INDEX_URL="https://download.pytorch.org/whl/cu121"
  else
    TORCH_INDEX_URL="https://download.pytorch.org/whl/cpu"
  fi
fi
"$ROOT/.venv/bin/pip" install \
  --index-url "$TORCH_INDEX_URL" \
  torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0
"$ROOT/.venv/bin/pip" install 'requests>=2.31,<3' 'huggingface_hub[cli]'

download_weights() {
  local include="$1"
  if [ -x "$ROOT/.venv/bin/hf" ]; then
    "$ROOT/.venv/bin/hf" download KlingTeam/LivePortrait --local-dir "$ROOT/pretrained_weights" --include "$include"
  else
    "$ROOT/.venv/bin/huggingface-cli" download KlingTeam/LivePortrait --local-dir "$ROOT/pretrained_weights" --include "$include"
  fi
}

missing_weights=false
for weight in \
  base_models/appearance_feature_extractor.pth \
  base_models/motion_extractor.pth \
  base_models/spade_generator.pth \
  base_models/warping_module.pth \
  retargeting_models/stitching_retargeting_module.pth \
  landmark.onnx; do
  [ -s "$ROOT/pretrained_weights/liveportrait/$weight" ] || missing_weights=true
done
[ "$missing_weights" = false ] || download_weights 'liveportrait/*'

missing_face_weights=false
for weight in 2d106det.onnx det_10g.onnx; do
  [ -s "$ROOT/pretrained_weights/insightface/models/buffalo_l/$weight" ] || missing_face_weights=true
done
[ "$missing_face_weights" = false ] || download_weights 'insightface/models/buffalo_l/*'

PARSER_DIR="$ROOT/pretrained_weights/head_parser"
PARSER_FILE="$PARSER_DIR/resnet18.onnx"
PARSER_SHA256="0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f"
mkdir -p "$PARSER_DIR"
parser_checksum=""
if command -v sha256sum >/dev/null 2>&1 && [ -s "$PARSER_FILE" ]; then
  parser_checksum="$(sha256sum "$PARSER_FILE" | awk '{print $1}')"
fi
if [ "$parser_checksum" != "$PARSER_SHA256" ]; then
  parser_temp="$(mktemp "$PARSER_DIR/.resnet18.XXXXXX")"
  trap 'rm -f "$parser_temp"' EXIT
  curl --fail --location --retry 3 --output "$parser_temp" \
    https://github.com/yakhyo/face-parsing/releases/download/weights/resnet18.onnx
  [ "$(sha256sum "$parser_temp" | awk '{print $1}')" = "$PARSER_SHA256" ] || {
    echo "Head segmentation model checksum mismatch." >&2
    exit 1
  }
  mv "$parser_temp" "$PARSER_FILE"
  trap - EXIT
fi

MATTING_DIR="$ROOT/pretrained_weights/hair_matting"
MATTING_FILE="$MATTING_DIR/birefnet-general-lite.onnx"
MATTING_MD5="4fab47adc4ff364be1713e97b7e66334"
mkdir -p "$MATTING_DIR"
matting_checksum=""
if command -v md5sum >/dev/null 2>&1 && [ -s "$MATTING_FILE" ]; then
  matting_checksum="$(md5sum "$MATTING_FILE" | awk '{print $1}')"
fi
if [ "$matting_checksum" != "$MATTING_MD5" ]; then
  matting_temp="$(mktemp "$MATTING_DIR/.birefnet.XXXXXX")"
  trap 'rm -f "$matting_temp"' EXIT
  curl --fail --location --retry 3 --output "$matting_temp" \
    https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx
  [ "$(md5sum "$matting_temp" | awk '{print $1}')" = "$MATTING_MD5" ] || {
    echo "Hair matting model checksum mismatch." >&2
    exit 1
  }
  mv "$matting_temp" "$MATTING_FILE"
  trap - EXIT
fi

echo "LivePortrait and auxiliary models are ready at $ROOT"
