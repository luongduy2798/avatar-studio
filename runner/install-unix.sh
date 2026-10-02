#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_SOURCE_ROOT="$ROOT"
INSTALL_ROOT="${AVATAR_RUNNER_INSTALL_ROOT:-$HOME/.avatar-runner}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || true)}"
MASTER_URL="${AVATAR_MASTER_URL:-}"
ENROLL_CODE="${AVATAR_RUNNER_ENROLL_CODE:-}"
LIVEPORTRAIT_ROOT="${LIVEPORTRAIT_ROOT:-$HOME/.cache/avatar-studio/LivePortrait}"

[ -n "$PYTHON_BIN" ] || { echo 'python3 is required.' >&2; exit 1; }
[ -n "$MASTER_URL" ] || { echo 'AVATAR_MASTER_URL is required.' >&2; exit 1; }
if [ ! -d "$LIVEPORTRAIT_ROOT" ] && [ "${AVATAR_SKIP_LIVEPORTRAIT_SETUP:-0}" != "1" ]; then
  if [ "$(uname -s)" = "Linux" ] && [ -f "$RUNNER_SOURCE_ROOT/setup-liveportrait-linux.sh" ]; then
    LIVEPORTRAIT_ROOT="$LIVEPORTRAIT_ROOT" PYTHON_BIN="$PYTHON_BIN" bash "$RUNNER_SOURCE_ROOT/setup-liveportrait-linux.sh"
  elif [ "$(uname -s)" = "Darwin" ] && [ -f "$RUNNER_SOURCE_ROOT/setup-liveportrait-macos.sh" ]; then
    LIVEPORTRAIT_ROOT="$LIVEPORTRAIT_ROOT" PYTHON_BIN="$PYTHON_BIN" bash "$RUNNER_SOURCE_ROOT/setup-liveportrait-macos.sh"
  fi
fi
[ -d "$LIVEPORTRAIT_ROOT" ] || { echo "LivePortrait runtime not found: $LIVEPORTRAIT_ROOT" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo 'ffmpeg is required.' >&2; exit 1; }

mkdir -p "$INSTALL_ROOT"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude '.venv' --exclude '.runtime' --exclude '__pycache__' "$RUNNER_SOURCE_ROOT/" "$INSTALL_ROOT/runner/"
else
  rm -rf "$INSTALL_ROOT/runner"
  cp -R "$RUNNER_SOURCE_ROOT" "$INSTALL_ROOT/runner"
  rm -rf "$INSTALL_ROOT/runner/.venv" "$INSTALL_ROOT/runner/.runtime" "$INSTALL_ROOT/runner/__pycache__" "$INSTALL_ROOT/runner/agent/__pycache__" "$INSTALL_ROOT/runner/runtime/__pycache__" "$INSTALL_ROOT/runner/runtime/app/__pycache__"
fi

if [ ! -x "$INSTALL_ROOT/.venv/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$INSTALL_ROOT/.venv"
fi
"$INSTALL_ROOT/.venv/bin/python" -m pip install --upgrade pip
"$INSTALL_ROOT/.venv/bin/python" -m pip install -r "$INSTALL_ROOT/runner/requirements.txt"

cat > "$INSTALL_ROOT/.env" <<EOF
AVATAR_MASTER_URL=$MASTER_URL
AVATAR_RUNTIME_CODE_ROOT=$INSTALL_ROOT/runner/runtime
AVATAR_RUNNER_RUNTIME_ROOT=$INSTALL_ROOT/.runtime
AVATAR_RUNTIME_ROOT=$INSTALL_ROOT/.runtime
AVATAR_RUNNER_CREDENTIALS=$INSTALL_ROOT/credentials.json
LIVEPORTRAIT_ROOT=$LIVEPORTRAIT_ROOT
LIVEPORTRAIT_PYTHON=$LIVEPORTRAIT_ROOT/.venv/bin/python
AVATAR_PIPELINE_MODE=staged
AVATAR_MAX_INFLIGHT_JOBS=${AVATAR_MAX_INFLIGHT_JOBS:-3}
AVATAR_MAX_DECODE_BATCH=${AVATAR_MAX_DECODE_BATCH:-3}
AVATAR_DECODE_BATCH_SIZE=${AVATAR_DECODE_BATCH_SIZE:-24}
AVATAR_ONNX_DEVICE=${AVATAR_ONNX_DEVICE:-cpu}
AVATAR_ONNX_THREADS=${AVATAR_ONNX_THREADS:-16}
EOF

if [ -n "$ENROLL_CODE" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$INSTALL_ROOT/.env"
  export AVATAR_RUNNER_ENROLL_CODE="$ENROLL_CODE"
  (cd "$INSTALL_ROOT" && "$INSTALL_ROOT/.venv/bin/python" -m runner.agent.main) &
  PID=$!
  for _ in $(seq 1 30); do
    [ -f "$INSTALL_ROOT/credentials.json" ] && break
    sleep 1
  done
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" 2>/dev/null || true
  [ -f "$INSTALL_ROOT/credentials.json" ] || { echo 'Runner enrollment did not complete.' >&2; exit 1; }
fi
[ -f "$INSTALL_ROOT/credentials.json" ] || {
  echo 'Provide AVATAR_RUNNER_ENROLL_CODE for first enrollment.' >&2
  exit 1
}

OS="$(uname -s)"
if [ "$OS" = "Linux" ]; then
  SERVICE_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_DIR/avatar-runner.service" <<EOF
[Unit]
Description=Avatar Runner
After=network-online.target

[Service]
WorkingDirectory=$INSTALL_ROOT
EnvironmentFile=$INSTALL_ROOT/.env
ExecStart=$INSTALL_ROOT/.venv/bin/python -m runner.agent.main
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now avatar-runner.service
else
  PLIST="$HOME/Library/LaunchAgents/com.avatar.runner.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.avatar.runner</string>
<key>WorkingDirectory</key><string>$INSTALL_ROOT</string>
<key>ProgramArguments</key><array><string>$INSTALL_ROOT/.venv/bin/python</string><string>-m</string><string>runner.agent.main</string></array>
<key>EnvironmentVariables</key><dict>
<key>AVATAR_MASTER_URL</key><string>$MASTER_URL</string>
<key>AVATAR_RUNTIME_CODE_ROOT</key><string>$INSTALL_ROOT/runner/runtime</string>
<key>AVATAR_RUNNER_RUNTIME_ROOT</key><string>$INSTALL_ROOT/.runtime</string>
<key>AVATAR_RUNTIME_ROOT</key><string>$INSTALL_ROOT/.runtime</string>
<key>AVATAR_RUNNER_CREDENTIALS</key><string>$INSTALL_ROOT/credentials.json</string>
<key>LIVEPORTRAIT_ROOT</key><string>$LIVEPORTRAIT_ROOT</string>
<key>LIVEPORTRAIT_PYTHON</key><string>$LIVEPORTRAIT_ROOT/.venv/bin/python</string>
<key>AVATAR_PIPELINE_MODE</key><string>staged</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
fi

echo "Avatar Runner installed at $INSTALL_ROOT"
