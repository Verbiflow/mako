#!/bin/sh
set -eu
mkdir -p "$HOME"
export DISPLAY=:91
export NODE_PATH=/opt/mako-test/node_modules
# Native image dependencies are installed at image build time. Desktop tests
# can run with --network none and never download code while accepting input.
export CUA_DRIVER_RS_TELEMETRY_ENABLED=0
export CUA_DRIVER_REQUIRE_FOCUSED_TARGET=1
export CUA_DRIVER_PERMISSION_MODE=unrestricted
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
python3 /repo/scripts/linux-control/wait-desktop.py server
# All applications and the driver share this job's private session bus.
exec dbus-run-session -- sh -c '
  set -eu
  rm -f /tmp/mako-openbox-ready
  openbox --startup "touch /tmp/mako-openbox-ready" >/tmp/openbox.log 2>&1 &
  python3 /repo/scripts/linux-control/wait-desktop.py manager /tmp/mako-openbox-ready
  python3 /repo/scripts/linux-control/fixture.py "Mako target" /tmp/target.json >/tmp/target.log 2>&1 &
  sleep 1
  python3 /repo/scripts/linux-control/fixture.py "User typing" /tmp/user.json >/tmp/user.log 2>&1 &
  "${MAKO_TEST_DRIVER:-/target/debug/cua-driver}" serve --no-overlay --dangerously-bypass-approvals --socket /tmp/mako-driver.sock >/tmp/driver.log 2>&1 &
  node /repo/scripts/linux-control/probe.mjs
'
