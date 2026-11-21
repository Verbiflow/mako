#!/bin/sh
# Mako's computer control on one private Linux desktop in a container (Dockerfile.desktop), with no network:
#
#   sh run-desktop.sh x11|sway|gnome|kde <root> <driver> <evidence>
#
# <root> is a checkout, or a payload laid out like one, with Linux node_modules, the control packages built
# (`npm run build:control-runtime`) and the host's embedded driver bundled at build/cua-embedded.mjs (see README.md);
# <driver> holds the Linux cua-driver and its wayland-helper; <evidence> receives desktop-<kind>.json, the screenshots
# and the MP4s. The container is removed on every exit; the image is kept for the next run.
set -eu
kind=$1
root=$(cd "$2" && pwd)
driver=$(cd "$3" && pwd)
mkdir -p "$4"
evidence=$(cd "$4" && pwd)
chmod 777 "$evidence"
target=desktop
case "$kind" in gnome | kde) target=$kind ;; esac
image="mako-linux-desktop:$target"
docker build -q -t "$image" --target "$target" - <"$root/scripts/linux-control/Dockerfile.desktop" >/dev/null
name="mako-linux-desktop-$kind-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --name "$name" --network none --user root -e HOME=/home/person \
  -v "$root:/repo:ro" -v "$driver:/driver:ro" -v "$evidence:/evidence" \
  -e MAKO_EVIDENCE=/evidence -e MAKO_DRIVER_DIR=/driver -e MAKO_VIDEO_HELPER=/tmp/mako-video \
  -e MAKO_CUA_EMBEDDED=/repo/build/cua-embedded.mjs \
  "$image" sh -c '
    set -eu
    node /repo/scripts/build-video-helper.mjs --require --portal --output /tmp/mako-video
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
    # GNOME without systemd-logind: with no seats, Mutter takes its dummy login manager.
    rmdir /run/systemd/seats 2>/dev/null || true
    mkdir -p /run/dbus && dbus-daemon --system --fork
    exec runuser -u person -w HOME,MAKO_EVIDENCE,MAKO_DRIVER_DIR,MAKO_VIDEO_HELPER,MAKO_CUA_EMBEDDED -- \
      sh /repo/scripts/linux-control/desktop-session.sh "$0"
  ' "$kind"
