#!/bin/sh
# Private media-only fixture. The pinned prototype wheel is mounted separately.
set -eu
export DISPLAY=:97
export PYTHONPATH=/opt/prototype:/opt/dependencies:/selkies/src
export PYTHONDONTWRITEBYTECODE=1
export XDG_RUNTIME_DIR=/tmp/runtime
export XDG_CACHE_HOME=/tmp/cache
export XDG_CONFIG_HOME=/tmp/config
export NO_AT_BRIDGE=1
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT INT TERM
i=0
until xdpyinfo >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 100 ]; then cat /tmp/xvfb.log; exit 1; fi
  sleep 0.05
done
if [ "${1-}" = selkies ]; then
  shift
  python3 /probe/selkies-probe.py "$@"
else
  python3 /probe/streaming-probe.py "$@"
fi
