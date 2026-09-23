#!/bin/sh
set -eu
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export CUA_DRIVER_REQUIRE_FOCUSED_TARGET=1 CUA_DRIVER_PERMISSION_MODE=unrestricted
export XDG_CURRENT_DESKTOP="$MAKO_COMPOSITOR"
# Headless compositor backends may have no keyboard device. Nest in this job's
# private X server so focus assertions use a real seat and native Wayland clients.
export DISPLAY=:91 WLR_BACKENDS=x11
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
python3 /repo/scripts/linux-control/wait-desktop.py server
exec dbus-run-session -- sh -c '
  set -eu
  case "$MAKO_COMPOSITOR" in
    weston) weston --backend=x11-backend.so --use-pixman --width=1280 --height=900 --socket=wayland-test --idle-time=0 >/tmp/compositor.log 2>&1 & ;;
    labwc) labwc -s "true" >/tmp/compositor.log 2>&1 & ;;
    *) echo "Choose weston or labwc" >&2; exit 2 ;;
  esac
  ready=0
  for n in $(seq 1 100); do
    for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
      if [ -S "$socket" ]; then export WAYLAND_DISPLAY=${socket##*/}; ready=1; break; fi
    done
    [ "$ready" = 1 ] && break
    sleep .1
  done
  [ "$ready" = 1 ] || { cat /tmp/compositor.log; exit 1; }
  python3 /repo/scripts/linux-control/fixture.py "Mako target" /tmp/target.json >/tmp/target.log 2>&1 &
  for n in $(seq 1 100); do [ ! -f /tmp/target.json ] || break; sleep .1; done
  # Same title and control names: pid/window identity must disambiguate them.
  python3 /repo/scripts/linux-control/fixture.py "Mako target" /tmp/user.json >/tmp/user.log 2>&1 &
  /driver/cua-driver serve --no-overlay --dangerously-bypass-approvals --socket /tmp/mako-driver.sock >/tmp/driver.log 2>&1 &
  node /repo/scripts/linux-control/portable-wayland-probe.mjs
'
