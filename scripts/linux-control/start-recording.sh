#!/bin/sh
set -eu
mkdir -p "$HOME"
. /repo/scripts/linux-control/identity.sh
export DISPLAY=:92
# A desktop session, as a person's login names it: the host's worker records its windows with the video helper.
export XDG_SESSION_TYPE=x11
export MAKO_RECORDING_DRIVER=${MAKO_RECORDING_DRIVER:-/target/debug/cua-driver}
export NODE_PATH=/opt/mako-test/node_modules
# Mako's video helper, compiled here from the payload against the image's libraries: recordings encode with it.
gcc -O2 -o /tmp/mako-video /repo/native/video-linux/mako-video.c \
  $(pkg-config --cflags --libs x11 xext xdamage xfixes xcomposite openh264 libturbojpeg) -lyuv -lm
export MAKO_VIDEO_HELPER=/tmp/mako-video
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
