#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"
# WSL exposes the Windows NVIDIA driver through this directory instead of the
# normal Linux PATH. Keep the doctor output and setup detection consistent.
if [ -d /usr/lib/wsl/lib ] && [[ ":$PATH:" != *":/usr/lib/wsl/lib:"* ]]; then
  export PATH="/usr/lib/wsl/lib:$PATH"
fi
if [ -z "${PYTHON_BIN:-}" ]; then
  if command -v python3.10 >/dev/null 2>&1; then
    PYTHON_BIN=python3.10
  else
    PYTHON_BIN=python3
  fi
fi

echo "Avatar Studio doctor"
echo "  OS: $(uname -s) $(uname -m)"
command -v node >/dev/null 2>&1 && echo "  Node: $(node --version)" || echo "  Node: missing"
command -v npm >/dev/null 2>&1 && echo "  npm: $(npm --version)" || echo "  npm: missing"
command -v "$PYTHON_BIN" >/dev/null 2>&1 && echo "  Python: $($PYTHON_BIN --version 2>&1)" || echo "  Python: missing ($PYTHON_BIN)"
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: ready" || echo "  ffmpeg: missing"
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "  NVIDIA driver: ready"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
  echo "  NVIDIA driver: nvidia-smi missing"
fi

if [ -x "$ROOT/runner/.venv/bin/python" ]; then
	  echo "  Runner venv: ready"
else
	  echo "  Runner venv: missing"
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

LIVEPORTRAIT_PYTHON="$LIVEPORTRAIT_ROOT/.venv/bin/python"
if [ -x "$LIVEPORTRAIT_PYTHON" ]; then
  LIVEPORTRAIT_PYTHON="$LIVEPORTRAIT_PYTHON" python3 - <<'PY'
import os
import subprocess
import sys

python_bin = os.environ["LIVEPORTRAIT_PYTHON"]
try:
    result = subprocess.run(
        [python_bin, "-c", "import torch; print(torch.__version__); print(torch.version.cuda or 'cpu'); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"],
        check=True,
        capture_output=True,
        text=True,
    )
    version, cuda, available, gpu = result.stdout.strip().splitlines()
    print(f"  LivePortrait torch: {version} ({cuda})")
    print(f"  CUDA available: {available}")
    print(f"  CUDA device: {gpu}")
except Exception as exc:
    print(f"  LivePortrait torch: error ({exc})")
PY
fi
