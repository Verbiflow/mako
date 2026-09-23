#!/bin/sh
set -eu
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export CUA_DRIVER_REQUIRE_FOCUSED_TARGET=1 CUA_DRIVER_PERMISSION_MODE=unrestricted
export MAKO_RECORDING_DRIVER=/driver/cua-driver
exec dbus-run-session -- sh -c '
 set -eu
 printf "%s\n" "output HEADLESS-1 resolution 1280x900" "seat seat0 fallback true" "default_border none" > /tmp/sway.conf
 sway -c /tmp/sway.conf >/tmp/sway.log 2>&1 &
 ready=0
 for n in $(seq 1 100); do
   for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
     if [ -S "$socket" ]; then export WAYLAND_DISPLAY=${socket##*/}; ready=1; break; fi
   done
   [ "$ready" = 1 ] && break
   sleep .1
 done
 [ "$ready" = 1 ] || { cat /tmp/sway.log; exit 1; }
 for socket in "$XDG_RUNTIME_DIR"/sway-ipc*.sock; do [ ! -S "$socket" ] || export SWAYSOCK="$socket"; done
 swaymsg -t get_outputs > /tmp/outputs.json
 python3 /repo/scripts/linux-control/recording-fixture.py "Mako Wayland target" /tmp/wayland-target.json 2b5f8f >/tmp/fixture.log 2>&1 &
 "$MAKO_RECORDING_DRIVER" serve --no-overlay --dangerously-bypass-approvals --socket /tmp/mako-driver.sock >/tmp/driver.log 2>&1 &
 node /repo/scripts/linux-control/wayland-probe.mjs
'
