#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MASTER_DIR="$ROOT/master"
RUNNER_DIR="$ROOT/runner"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"

if [ -z "${PYTHON_BIN:-}" ]; then
  if command -v python3.10 >/dev/null 2>&1; then
    PYTHON_BIN=python3.10
  else
    PYTHON_BIN=python3
  fi
fi

command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "$PYTHON_BIN is required." >&2; exit 1; }

npm --prefix "$MASTER_DIR" install --no-audit --no-fund --package-lock=false
npm --prefix "$MASTER_DIR" run setup:admin
npm --prefix "$MASTER_DIR" run build:admin
npm --prefix "$ROOT/internal/web-client" install --no-audit --no-fund --package-lock=false

if [ ! -x "$RUNNER_DIR/.venv/bin/python" ]; then
	  "$PYTHON_BIN" -m venv "$RUNNER_DIR/.venv"
fi
"$RUNNER_DIR/.venv/bin/python" -m pip install -r "$RUNNER_DIR/requirements.txt" -r "$ROOT/internal/worker/requirements.txt"

LIVEPORTRAIT_ROOT="$LIVEPORTRAIT_ROOT" PYTHON_BIN="$PYTHON_BIN" \
  bash "$RUNNER_DIR/setup-liveportrait-linux.sh"

echo "Avatar Studio Ubuntu setup is ready."
