#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MASTER_DIR="$ROOT/master"
RUNNER_DIR="$ROOT/runner"
RUNTIME_ROOT="$RUNNER_DIR/.runtime"
WEB_DIR="$ROOT/internal/web-client"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"
# Setup is an explicit command; dev-stack only starts services by default.
# Set AVATAR_SKIP_SETUP=0 only when intentionally bootstrapping dependencies.
AVATAR_SKIP_SETUP="${AVATAR_SKIP_SETUP:-1}"
AVATAR_RESET_RUNTIME="${AVATAR_RESET_RUNTIME:-1}"
# Keep local benchmark runs comparable across macOS and Ubuntu. These remain
# overridable for capacity experiments.
export AVATAR_ONNX_DEVICE="${AVATAR_ONNX_DEVICE:-cpu}"
export AVATAR_ONNX_THREADS="${AVATAR_ONNX_THREADS:-16}"
export AVATAR_DECODE_BATCH_SIZE="${AVATAR_DECODE_BATCH_SIZE:-24}"
export AVATAR_PIPELINE_MODE="${AVATAR_PIPELINE_MODE:-staged}"
export AVATAR_MAX_DECODE_BATCH="${AVATAR_MAX_DECODE_BATCH:-3}"
export AVATAR_DECODE_BATCH_WAIT_MS="${AVATAR_DECODE_BATCH_WAIT_MS:-25}"
export AVATAR_PREPROCESS_WORKERS="${AVATAR_PREPROCESS_WORKERS:-2}"
export AVATAR_EXPORT_WORKERS="${AVATAR_EXPORT_WORKERS:-2}"
export AVATAR_PREPROCESS_QUEUE_SIZE="${AVATAR_PREPROCESS_QUEUE_SIZE:-6}"
export AVATAR_DECODE_QUEUE_SIZE="${AVATAR_DECODE_QUEUE_SIZE:-6}"

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
RUNNER_PID=""
WEB_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$WEB_PID" "$API_PID" "$RUNNER_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "$PYTHON_BIN is required." >&2; exit 1; }

if [ "$AVATAR_SKIP_SETUP" != "1" ]; then
  npm --prefix "$MASTER_DIR" install --no-audit --no-fund --package-lock=false
  npm --prefix "$MASTER_DIR" run setup:admin
  npm --prefix "$MASTER_DIR" run build:admin
  npm --prefix "$WEB_DIR" install --no-audit --no-fund --package-lock=false

  if [ ! -x "$RUNNER_DIR/.venv/bin/python" ]; then
    "$PYTHON_BIN" -m venv "$RUNNER_DIR/.venv"
  fi
  "$RUNNER_DIR/.venv/bin/python" -m pip install -r "$RUNNER_DIR/requirements.txt" -r "$ROOT/internal/worker/requirements.txt"

  if [ ! -x "$LIVEPORTRAIT_ROOT/.venv/bin/python" ]; then
    if [ "$(uname -s)" = "Linux" ]; then
      setup_script="$RUNNER_DIR/setup-liveportrait-linux.sh"
    else
      setup_script="$RUNNER_DIR/setup-liveportrait-macos.sh"
    fi
    LIVEPORTRAIT_ROOT="$LIVEPORTRAIT_ROOT" PYTHON_BIN="$PYTHON_BIN" bash "$setup_script"
  fi
fi

if [ "$AVATAR_RESET_RUNTIME" = "1" ]; then
  echo "Resetting local runtime state..."
  for runtime_path in jobs queue storage work outputs; do
    rm -rf -- "$RUNTIME_ROOT/$runtime_path"
  done
  mkdir -p "$RUNTIME_ROOT"
  : > "$RUNTIME_ROOT/liveportrait-worker.log"
fi

export AVATAR_INFRA_MODE=local
export AVATAR_MASTER_ENABLED=0
export AVATAR_LOCAL_BENCHMARKS=1
export AVATAR_RUNTIME_ROOT="$RUNTIME_ROOT"
export LIVEPORTRAIT_ROOT
export LIVEPORTRAIT_PYTHON="$LIVEPORTRAIT_ROOT/.venv/bin/python"

(cd "$ROOT" && exec "$RUNNER_DIR/.venv/bin/python" -m internal.worker.main) &
RUNNER_PID=$!
(cd "$MASTER_DIR" && exec npm run dev) &
API_PID=$!
(cd "$WEB_DIR" && exec npm run dev) &
WEB_PID=$!

echo "Avatar Studio:"
echo "  web: http://127.0.0.1:5173"
echo "  api: http://127.0.0.1:8000"
echo "  runner: local runtime pid $RUNNER_PID"
echo "  pipeline: $AVATAR_PIPELINE_MODE, ONNX $AVATAR_ONNX_DEVICE, ${AVATAR_ONNX_THREADS} threads, decode batch $AVATAR_DECODE_BATCH_SIZE expressions / $AVATAR_MAX_DECODE_BATCH jobs"
echo "  resources: preprocess $AVATAR_PREPROCESS_WORKERS, export $AVATAR_EXPORT_WORKERS, queues $AVATAR_PREPROCESS_QUEUE_SIZE/$AVATAR_DECODE_QUEUE_SIZE, decode wait ${AVATAR_DECODE_BATCH_WAIT_MS}ms"
wait
