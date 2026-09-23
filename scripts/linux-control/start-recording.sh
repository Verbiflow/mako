#!/bin/sh
set -eu
mkdir -p "$HOME"
export DISPLAY=:92
export MAKO_RECORDING_DRIVER=${MAKO_RECORDING_DRIVER:-/target/debug/cua-driver}
export NODE_PATH=/opt/mako-test/node_modules
export CUA_DRIVER_RS_TELEMETRY_ENABLED=0
export CUA_DRIVER_REQUIRE_FOCUSED_TARGET=1
export CUA_DRIVER_PERMISSION_MODE=unrestricted
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
python3 /repo/scripts/linux-control/wait-desktop.py server
exec dbus-run-session -- sh -c '
 set -eu
 rm -f /tmp/mako-openbox-ready
 openbox --startup "touch /tmp/mako-openbox-ready" >/tmp/openbox.log 2>&1 &
 python3 /repo/scripts/linux-control/wait-desktop.py manager /tmp/mako-openbox-ready
 python3 /repo/scripts/linux-control/recording-fixture.py "Mako record target" /tmp/record-target.json 2b5f8f >/tmp/target.log 2>&1 &
 "$MAKO_RECORDING_DRIVER" serve --no-overlay --dangerously-bypass-approvals --socket /tmp/mako-driver.sock >/tmp/driver.log 2>&1 &
 sleep 2
 node /repo/scripts/linux-control/recording-probe.mjs
'
