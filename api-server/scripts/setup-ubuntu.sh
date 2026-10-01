#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GPU_DIR="$ROOT/gpu-service"
PYTHON_BIN="${PYTHON_BIN:-python3.10}"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"

command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "$PYTHON_BIN is required." >&2; exit 1; }

npm --prefix "$ROOT/api-server" install --no-audit --no-fund --package-lock=false
npm --prefix "$ROOT/web-client" install --no-audit --no-fund --package-lock=false

if [ ! -x "$GPU_DIR/.venv/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$GPU_DIR/.venv"
fi
"$GPU_DIR/.venv/bin/python" -m pip install -r "$GPU_DIR/requirements.txt"

LIVEPORTRAIT_ROOT="$LIVEPORTRAIT_ROOT" PYTHON_BIN="$PYTHON_BIN" \
  bash "$GPU_DIR/scripts/setup-liveportrait-linux.sh"

echo "Avatar Studio Ubuntu setup is ready."
