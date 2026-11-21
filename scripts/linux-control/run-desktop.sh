#!/bin/sh
# Mako's computer control on one private Linux desktop in a container (Dockerfile.desktop), with no network:
#
#   sh run-desktop.sh x11|sway|gnome|kde|kde6 <root> <driver> <evidence>
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
case "$kind" in gnome | kde | kde6) target=$kind ;; esac
image="mako-linux-desktop:$target"
docker build -q -t "$image" --target "$target" - <"$root/scripts/linux-control/Dockerfile.desktop" >/dev/null
name="mako-linux-desktop-$kind-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
# KWin 6 composites with OpenGL only on a DRM device, and its screen cast and window capture need OpenGL: vgem is
# that device on a machine with no GPU (`modprobe vgem`), given alone so KWin picks no other. KWin 5.27 needs none.
devices=""
for card in /sys/class/drm/card[0-9]*; do
  case "$(readlink -f "$card/device" 2>/dev/null)" in */vgem)
    devices="--device /dev/dri/${card##*/}"
    for node in "$card"/device/drm/renderD*; do [ ! -e "/dev/dri/${node##*/}" ] || devices="$devices --device /dev/dri/${node##*/}"; done
    ;;
  esac
done
# MAKO_DESKTOP_CPUS=N holds the container to N processors and MAKO_DESKTOP_LOAD=N runs N busy loops beside the
# desktop: a small, loaded machine, for the loops that hold an intermittent failure to a count.
cpus=""
[ -z "${MAKO_DESKTOP_CPUS:-}" ] || cpus="--cpus $MAKO_DESKTOP_CPUS"
# shellcheck disable=SC2086
docker run --name "$name" --network none --user root -e HOME=/home/person $devices $cpus -e MAKO_KWIN_COMPOSE="${MAKO_KWIN_COMPOSE:-}" \
  -e MAKO_DESKTOP_LOAD="${MAKO_DESKTOP_LOAD:-0}" \
  -v "$root:/repo:ro" -v "$driver:/driver:ro" -v "$evidence:/evidence" \
  -e MAKO_EVIDENCE=/evidence -e MAKO_DRIVER_DIR=/driver -e MAKO_VIDEO_HELPER=/tmp/mako-video \
  -e MAKO_CUA_EMBEDDED=/repo/build/cua-embedded.mjs -e MAKO_DESKTOP_GRANTS=/repo/build/desktop-grants.mjs -e MAKO_RECORD_LOOPS="${MAKO_RECORD_LOOPS:-0}" -e MAKO_FIRST_FRAME_LOOPS="${MAKO_FIRST_FRAME_LOOPS:-0}" -e MAKO_STILL_LOOPS="${MAKO_STILL_LOOPS:-0}" \
  "$image" sh -c '
    set -eu
    node /repo/scripts/build-video-helper.mjs --require --portal --output /tmp/mako-video
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
    # GNOME without systemd-logind: with no seats, Mutter takes its dummy login manager.
    rmdir /run/systemd/seats 2>/dev/null || true
    mkdir -p /run/dbus && dbus-daemon --system --fork
    for _ in $(seq 1 "$MAKO_DESKTOP_LOAD"); do (while :; do :; done) & done
    code=0
    runuser -u person -w HOME,MAKO_EVIDENCE,MAKO_DRIVER_DIR,MAKO_VIDEO_HELPER,MAKO_CUA_EMBEDDED,MAKO_DESKTOP_GRANTS,MAKO_RECORD_LOOPS,MAKO_FIRST_FRAME_LOOPS,MAKO_STILL_LOOPS,MAKO_KWIN_COMPOSE -- \
      sh /repo/scripts/linux-control/desktop-session.sh "$0" || code=$?
    # What the compositor, the portal and the consent answerer said, beside the report.
    mkdir -p "/evidence/logs-$0" && cp /tmp/*.log "/evidence/logs-$0/" 2>/dev/null || true
    chmod -R a+rX "/evidence/logs-$0" 2>/dev/null || true
    exit "$code"
  ' "$kind"
