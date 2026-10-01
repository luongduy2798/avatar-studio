#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/api-server"
GPU_DIR="$ROOT/gpu-service"
WEB_DIR="$ROOT/web-client"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"
AVATAR_SKIP_SETUP="${AVATAR_SKIP_SETUP:-0}"
AVATAR_RESET_RUNTIME="${AVATAR_RESET_RUNTIME:-1}"

if [ -z "${PYTHON_BIN:-}" ]; then
  if command -v python3.10 >/dev/null 2>&1; then
    PYTHON_BIN=python3.10
  else
    PYTHON_BIN=python3
  fi
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [ "$PYTHON_BIN" = "python3.10" ] && command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
fi

API_PID=""
GPU_PID=""
WEB_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$WEB_PID" "$API_PID" "$GPU_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "$PYTHON_BIN is required." >&2; exit 1; }

if [ "$AVATAR_SKIP_SETUP" != "1" ]; then
  npm --prefix "$API_DIR" install --no-audit --no-fund --package-lock=false
  npm --prefix "$WEB_DIR" install --no-audit --no-fund --package-lock=false

  if [ ! -x "$GPU_DIR/.venv/bin/python" ]; then
    "$PYTHON_BIN" -m venv "$GPU_DIR/.venv"
  fi
  "$GPU_DIR/.venv/bin/python" -m pip install -r "$GPU_DIR/requirements.txt"

  if [ ! -x "$LIVEPORTRAIT_ROOT/.venv/bin/python" ]; then
    if [ "$(uname -s)" = "Linux" ]; then
      setup_script="$ROOT/scripts/setup-liveportrait-linux.sh"
    else
      setup_script="$ROOT/scripts/setup-liveportrait-macos.sh"
    fi
    LIVEPORTRAIT_ROOT="$LIVEPORTRAIT_ROOT" PYTHON_BIN="$PYTHON_BIN" bash "$setup_script"
  fi
fi

if [ "$AVATAR_RESET_RUNTIME" = "1" ]; then
  echo "Resetting local runtime state..."
  for runtime_path in jobs queue storage work outputs; do
    rm -rf -- "$GPU_DIR/.runtime/$runtime_path"
  done
  mkdir -p "$GPU_DIR/.runtime"
  : > "$GPU_DIR/.runtime/liveportrait-worker.log"
fi

export AVATAR_INFRA_MODE=local
export AVATAR_RUNTIME_ROOT="$GPU_DIR/.runtime"
export LIVEPORTRAIT_ROOT
export LIVEPORTRAIT_PYTHON="$LIVEPORTRAIT_ROOT/.venv/bin/python"

(cd "$GPU_DIR" && exec .venv/bin/python -m app.main) &
GPU_PID=$!
(cd "$API_DIR" && exec npm run dev) &
API_PID=$!
(cd "$WEB_DIR" && exec npm run dev) &
WEB_PID=$!

echo "Avatar Studio:"
echo "  web: http://127.0.0.1:5173"
echo "  api: http://127.0.0.1:8000"
echo "  gpu: local worker pid $GPU_PID"
wait
