#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"
PYTHON_BIN="${PYTHON_BIN:-python3.10}"

echo "Avatar Studio doctor"
echo "  OS: $(uname -s) $(uname -m)"
command -v node >/dev/null 2>&1 && echo "  Node: $(node --version)" || echo "  Node: missing"
command -v npm >/dev/null 2>&1 && echo "  npm: $(npm --version)" || echo "  npm: missing"
command -v "$PYTHON_BIN" >/dev/null 2>&1 && echo "  Python: $($PYTHON_BIN --version 2>&1)" || echo "  Python: missing ($PYTHON_BIN)"
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: ready" || echo "  ffmpeg: missing"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true

if [ -x "$ROOT/gpu-service/.venv/bin/python" ]; then
  echo "  GPU service venv: ready"
else
  echo "  GPU service venv: missing"
fi
if [ -x "$LIVEPORTRAIT_ROOT/.venv/bin/python" ]; then
  echo "  LivePortrait venv: ready"
else
  echo "  LivePortrait venv: missing ($LIVEPORTRAIT_ROOT/.venv/bin/python)"
fi
if [ -d "$LIVEPORTRAIT_ROOT/pretrained_weights" ]; then
  echo "  LivePortrait weights: directory found"
else
  echo "  LivePortrait weights: missing"
fi
