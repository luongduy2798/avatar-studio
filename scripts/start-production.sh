#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_ROOT="$REPO_ROOT/gpu-service"
cd "$SERVICE_ROOT"

: "${AVATAR_S3_BUCKET:?AVATAR_S3_BUCKET is required}"
: "${AVATAR_SQS_QUEUE_URL:?AVATAR_SQS_QUEUE_URL is required}"
: "${AVATAR_DYNAMODB_JOBS_TABLE:?AVATAR_DYNAMODB_JOBS_TABLE is required}"
: "${LIVEPORTRAIT_ROOT:?LIVEPORTRAIT_ROOT is required}"

export AVATAR_INFRA_MODE=aws
export LIVEPORTRAIT_PYTHON="${LIVEPORTRAIT_PYTHON:-$LIVEPORTRAIT_ROOT/.venv/bin/python}"
exec "${GPU_SERVICE_PYTHON:-.venv/bin/python}" -m app.main
