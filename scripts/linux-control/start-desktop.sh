#!/bin/sh
set -eu
export DISPLAY=:91
export CUA_DRIVER_RS_TELEMETRY_ENABLED=0
export CUA_DRIVER_REQUIRE_FOCUSED_TARGET=1
export CUA_DRIVER_PERMISSION_MODE=unrestricted
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
# All applications and the driver share this job's private session bus.
exec dbus-run-session -- sh -c '
  openbox >/tmp/openbox.log 2>&1 &
  python3 /repo/scripts/linux-control/fixture.py "Mako target" /tmp/target.json >/tmp/target.log 2>&1 &
  sleep 1
  python3 /repo/scripts/linux-control/fixture.py "User typing" /tmp/user.json >/tmp/user.log 2>&1 &
  "${MAKO_TEST_DRIVER:-/target/debug/cua-driver}" serve --no-overlay --dangerously-bypass-approvals --socket /tmp/mako-driver.sock >/tmp/driver.log 2>&1 &
  node /repo/scripts/linux-control/probe.mjs
'
