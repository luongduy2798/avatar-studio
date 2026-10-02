#!/usr/bin/env bash
set -euo pipefail

RUNNER_ROOT="${AVATAR_RUNNER_ROOT:-$HOME/.avatar-runner}"
RUNNER_PYTHON="${RUNNER_PYTHON:-$RUNNER_ROOT/.venv/bin/python}"

[ -x "$RUNNER_PYTHON" ] || { echo "Runner Python not found: $RUNNER_PYTHON" >&2; exit 1; }
: "${AVATAR_MASTER_URL:?AVATAR_MASTER_URL is required}"
: "${AVATAR_RUNTIME_CODE_ROOT:=$RUNNER_ROOT/runner/runtime}"
: "${AVATAR_RUNNER_RUNTIME_ROOT:=$RUNNER_ROOT/.runtime}"
: "${AVATAR_RUNTIME_ROOT:=$RUNNER_ROOT/.runtime}"
export AVATAR_RUNTIME_CODE_ROOT
export AVATAR_RUNNER_RUNTIME_ROOT
export AVATAR_RUNTIME_ROOT
cd "$RUNNER_ROOT"
exec "$RUNNER_PYTHON" -m runner.agent.main
