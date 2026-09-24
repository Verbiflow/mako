#!/bin/sh
# Run all three compositors against one existing image and frozen payload.
set -eu
test "$#" -eq 3 || { echo 'Usage: sh run-compositors.sh <prepared payload> <packaged driver directory> <new evidence directory>' >&2; exit 2; }
payload=$(cd "$1" && pwd)
driver=$(cd "$2" && pwd)
mkdir "$3" # Never mix this run with old evidence.
evidence=$(cd "$3" && pwd)
image=${MAKO_COMPOSITOR_IMAGE:-mako-control-linux:compositors-current}
docker image inspect "$image" --format '{{.Id}} {{.Architecture}}' >"$evidence/image.txt"
prefix="mako-compositor-$$"
current=
cleanup() {
  test -n "$current" || return 0
  docker logs "$prefix-$current" >"$evidence/$current/container.log" 2>&1 || true
  for file in portable-wayland-evidence.json compositor.log driver.log target.json user.json; do
    docker cp "$prefix-$current:/tmp/$file" "$evidence/$current/$file" 2>/dev/null || true
  done
  docker rm -f "$prefix-$current" >/dev/null 2>&1 || true
  current=
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
status=0
for compositor in labwc weston kwin_wayland; do
  current=$compositor
  mkdir "$evidence/$current"
  docker run --name "$prefix-$current" --init --network none \
    --label dev.mako.control.test=compositor \
    --mount "type=bind,source=$payload,target=/repo,readonly" \
    --mount "type=bind,source=$driver,target=/driver,readonly" \
    -e "MAKO_COMPOSITOR=$current" \
    "$image" sh /repo/scripts/linux-control/start-portable-wayland.sh || status=1
  cleanup
done
exit "$status"
