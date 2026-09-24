#!/bin/sh
# Run on a disposable Linux machine with Docker and this prepared payload.
set -eu
cd "$(dirname "$0")/../.."
test "$(uname -m)" = x86_64 || { echo 'Native x64 host required' >&2; exit 1; }
mkdir evidence # A run must not mix results with an older attempt.
suites="jobs recording sway-normal sway-fractional sway-rotated"
for suite in $suites; do mkdir "evidence/$suite"; done
uname -a >evidence/uname.txt
lscpu --json >evidence/cpu.json
docker info --format '{{.Architecture}}' >evidence/docker-architecture.txt
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
assert.equal(process.arch, 'x64');
const cpu=JSON.parse(readFileSync('evidence/cpu.json')).lscpu;
assert.equal(cpu.find(row=>row.field==='Architecture:')?.data, 'x86_64');
assert.match(cpu.find(row=>row.field==='Vendor ID:')?.data ?? '', /^(GenuineIntel|AuthenticAMD)$/);
assert.match(readFileSync('evidence/docker-architecture.txt','utf8').trim(), /^(x86_64|amd64)$/);
const payload=JSON.parse(readFileSync('payload.json'));
assert.equal(payload.platform, 'linux-x64');
for (const file of payload.files) {
  assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'), file.sha256, file.path);
}
JS
# Dependency installation happens before network-isolated desktop execution.
npm ci --ignore-scripts --no-audit --no-fund
docker build --platform linux/amd64 -t mako-local-control-acceptance - <scripts/linux-control/Dockerfile.acceptance
prefix="mako-acceptance-$$"
cleanup() {
  for suite in $suites; do
    name="$prefix-$suite"
    docker logs "$name" >"evidence/$suite/container.log" 2>&1 || true
    docker cp "$name:/tmp/driver.log" "evidence/$suite/driver.log" 2>/dev/null || true
    case "$suite" in sway-*)
      for file in wayland-evidence.json wayland-visible.png sway.log fixture.log; do
        docker cp "$name:/tmp/$file" "evidence/$suite/$file" 2>/dev/null || true
      done
      ;;
    esac
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
status=0
docker run --name "$prefix-jobs" --network none --platform linux/amd64 --user "$(id -u):$(id -g)" \
  -v "$PWD:/repo:ro" -v "$PWD/driver:/driver:ro" -v "$PWD/evidence/jobs:/evidence" \
  -e HOME=/tmp/mako-acceptance-home -e MAKO_TEST_DRIVER=/driver/cua-driver \
  mako-local-control-acceptance sh /repo/scripts/linux-control/start-desktop.sh || status=1
docker run --name "$prefix-recording" --network none --platform linux/amd64 --user "$(id -u):$(id -g)" \
  -v "$PWD:/repo:ro" -v "$PWD/driver:/driver:ro" -v "$PWD/evidence/recording:/evidence" \
  -e HOME=/tmp/mako-acceptance-home -e MAKO_RECORDING_DRIVER=/driver/cua-driver -e MAKO_GESTURE_ACCEPTANCE=1 \
  mako-local-control-acceptance sh /repo/scripts/linux-control/start-recording.sh || status=1
for suite in sway-normal sway-fractional sway-rotated; do
  scale=1; transform=normal
  case "$suite" in
    sway-fractional) scale=1.5 ;;
    sway-rotated) scale=1.5; transform=90 ;;
  esac
  docker run --name "$prefix-$suite" --network none --platform linux/amd64 --user "$(id -u):$(id -g)" \
    -v "$PWD:/repo:ro" -v "$PWD/driver:/driver:ro" \
    -e HOME=/tmp/mako-acceptance-home -e XDG_RUNTIME_DIR=/tmp/mako-wayland-runtime \
    -e XDG_SESSION_TYPE=wayland -e GDK_BACKEND=wayland -e WLR_BACKENDS=headless \
    -e WLR_LIBINPUT_NO_DEVICES=1 -e WLR_RENDERER=pixman -e CUA_DRIVER_RS_ENABLE_WAYLAND=1 \
    -e "MAKO_WAYLAND_SCALE=$scale" -e "MAKO_WAYLAND_TRANSFORM=$transform" \
    mako-local-control-acceptance sh /repo/scripts/linux-control/start-wayland.sh || status=1
done
cp driver/provenance.json payload.json evidence/
exit "$status"
