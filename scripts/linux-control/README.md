# Isolated Linux acceptance

Each run gets its own X server and D-Bus session. It cannot send desktop input to
the Mac host or to another container. The fixture compares Mako's observations
with GTK's own state file and sends tagged keyboard input to another window.

For a portable payload and a credential-free contributor workflow, use
[disposable-machine acceptance](../../docs/local-control-ci.md). Native Intel x64
acceptance now passes on EC2; the shared control server runs under Node without
Electron. The commands below also support local isolated development.

Build the repository's control package and shared host modules first, then:

```sh
docker build -t mako-control-linux:platform-v2 - < scripts/linux-control/Dockerfile
node scripts/package-control-driver-linux.mjs /absolute/path/to/patched-cua --arch=arm64
```

The packager requires the exact commit and patch in `vendor/cua-driver/release.json`.
It writes a release executable, MIT license and provenance under
`release/control-driver/<version>/linux-<arch>`. The requested architecture is
mandatory and checked against the build image; each architecture has a separate
Cargo target volume. Use `--arch=x64 --image=<x64-image>` for an x64 build. It does not
install or change the running Mac driver. Linux x64 requires its own build and
acceptance; ARM64 results do not establish x64 coverage. +mako.13 now has
[translated x64 functional acceptance](../../docs/audits/2026-09-22/local-control-acceptance13/README.md), including the complete job and recording suites.

Run the suite with an empty evidence directory:

```sh
docker run --rm \
  --mount type=bind,source="$PWD",target=/repo,readonly \
  --mount type=bind,source=/absolute/path/to/evidence,target=/evidence \
  --mount type=volume,source=mako-control-linux-target,target=/target,readonly \
  -e MAKO_TEST_DRIVER=/target/release/cua-driver \
  mako-control-linux:platform-v2 sh /repo/scripts/linux-control/start-desktop.sh
```

The suite covers exact values, full and capped reads, public strict locators,
30 save jobs, concurrent tagged typing, foreground refusal at both boundaries,
reordered and destroyed controls, modal parent refusal, and a value longer than
the read cap. It intentionally starts an unrestricted driver only inside this
private test desktop. Production hosts keep their authorization boundary.

The runtime requires an accessibility bus and an X11 desktop. On Wayland the
host accepts foreground delivery only when a fresh compositor check attests the
exact PID/window and readiness for input. Sway and GNOME helper 10 supply this
evidence; missing or older helper fields remain unknown and refuse. Do not derive shared-desktop promises from isolated X11 results.

## labwc and Weston background form acceptance

Build `mako-control-linux:gnome` with `Dockerfile.gnome`, then build the test-only
compositor image. These packages do not enter the shipped application:

```sh
docker build -t mako-control-linux:portable-wayland - < scripts/linux-control/Dockerfile.portable-wayland
docker run --name mako-portable-wayland \
  -v "$PWD:/repo:ro" \
  -v "$PWD/release/control-driver/0.28.2+mako.17/linux-arm64:/driver:ro" \
  -e MAKO_COMPOSITOR=labwc \
  mako-control-linux:portable-wayland sh /repo/scripts/linux-control/start-portable-wayland.sh
docker cp mako-portable-wayland:/tmp/portable-wayland-evidence.json ./portable-wayland-evidence.json
docker rm mako-portable-wayland
```

Use `MAKO_COMPOSITOR=weston` and a different container name for Weston. Both run
native Wayland GTK clients with a compositor nested in a private Xvfb display,
which supplies an input seat. Twenty jobs each verify two exact field writes,
one Save, no focus-change notifications, and an untouched second app with the
same title and control names. Unverified raw input and window capture must
refuse. This is semantic background-work acceptance, not a gesture/capture or
physical-device claim. The evidence includes runtime versions and hashes.

## GNOME Wayland

`Dockerfile.gnome` supplies GNOME 46, AT-SPI, GTK, fonts and FFmpeg in a private
headless session. Build it with `docker build -t mako-control-linux:gnome - <
scripts/linux-control/Dockerfile.gnome`. Then run the compiled host and the
packaged driver/helper together:

```sh
docker run --name mako-gnome-acceptance --user root \
  -v "$PWD:/repo:ro" \
  -v "$PWD/release/control-driver/0.28.2+mako.13/linux-arm64:/driver:ro" \
  -v "$PWD/release/control-driver/0.28.2+mako.13/linux-arm64/wayland-helper/winrects@cua:/helper:ro" \
  mako-control-linux:gnome sh -c 'rmdir /run/systemd/seats; dbus-daemon --system --fork; exec runuser -u ubuntu -- sh /repo/scripts/linux-control/start-gnome.sh'
docker cp mako-gnome-acceptance:/tmp/gnome-evidence.json ./gnome-evidence.json
# Copy recording/PNG artifacts too before removing the stopped container.
docker rm mako-gnome-acceptance
```

The empty `/run/systemd/seats` directory is removed only inside this container to
select GNOME's supported dummy login manager; this fixture has no systemd/logind.
The helper is installed only into the container user's temporary desktop.

The probe checks exact Unicode values, covered-window screenshot colors and
geometry, current text after a covered write, target-only video, retained video
after minimization, and ten minimized writes while the covering window keeps
focus. It does not establish physical typing, other GNOME releases, fractional
scales, KDE or all Wayland compositors. Retain `/tmp/gnome-recording` and the
PNG artifacts before removing the exited container.

## Gesture and scale checks

GNOME's fixture establishes a real Mutter RemoteDesktop/ScreenCast session and
passes its EIS connection through a private Unix socket. This tests actual libei
delivery without automating the desktop portal's consent dialog. It does not
establish portal onboarding. PipeWire must be running before that session starts.
The probe compares delivered GTK drag/scroll events with the requested endpoints
and the recording timeline, including the held button and its final release.

The Sway probe uses `Dockerfile.wayland`. Run `start-wayland.sh` with
`MAKO_WAYLAND_SCALE=1` and `=2` in separate containers, mounting the packaged driver
at `/driver` and this repository at `/repo:ro`. It verifies a marker near the
window's far corner as well as screenshot dimensions: matching dimensions alone
missed a crop that contained only half the target. The current virtual-pointer
mapping requires one known output. +mako.14 uses `xdg-output` logical geometry and accepts all eight
rotation/mirror transforms, normal 150%/200%, and combined 150% + 90° in the
headless Sway fixture. Set `MAKO_WAYLAND_TRANSFORM=90` (or `180`, `270`,
`flipped`, `flipped-90`, `flipped-180`, `flipped-270`). Multiple outputs and
nonzero output origins still refuse. This does not establish other compositors. Hidden Sway capture refuses explicitly.

For x64, build the image with `--platform linux/amd64`, package with
`--arch=x64 --image=mako-control-linux:x64`, and run both `start-desktop.sh` and
`start-recording.sh` with the same platform. Point `MAKO_TEST_DRIVER` and
`MAKO_RECORDING_DRIVER` at `/driver/cua-driver`; mount a separate writable
`/evidence` for each run. `MAKO_GESTURE_ACCEPTANCE=1` enables the X11 gesture phase.
An x64 executable running under OrbStack translation proves functional behavior
in that environment; it does not establish native Intel/AMD performance.

The manual GitHub workflow `local-control-linux-x64.yml` runs these jobs on an
x64 Ubuntu runner, records CPU/architecture metadata and retains failure logs.
Its presence is not acceptance: inspect a completed run and its artifacts.
The readiness fixture runs GTK's main loop and requires the actual test window
to appear in the window manager's client list before launching app/driver checks.
The blocking `xprop` query runs on a worker thread so child-process latency does
not block GTK. Two +mako.17 translated runs initially left the readiness window
unmapped. Final reruns pass, but a slow-query control passed both implementations;
the original startup cause remains unproven and its diagnostics are retained.
For local container runs while editing files, mount a frozen copy of the fixture
folder and package.json: this Mac's shared filesystem returned truncated live
files during two runs; neither run reached driver acceptance.


## KWin semantic background acceptance

KWin 5.27.11 on ARM64 passed the same twenty-job semantic suite on September 24.
Build `Dockerfile.kwin` after `Dockerfile.portable-wayland`, then use the portable
runner with `MAKO_COMPOSITOR=kwin_wayland`. Run with `--network none`, a read-only
checkout and the reviewed `/driver` mount. The nested compositor needs no resource
capability: its test image removes the executable's file capability instead of
privileging the container. This test dependency is not bundled into Mako.

The test checks exact Unicode values, independent Save counts, an unchanged second
app with duplicate names, no target/cover focus changes, and refusal of unverified
raw input/capture. It does not establish KDE recording/gestures, Plasma 6, native
x64 or physical keyboard behavior. Collect `/tmp/portable-wayland-evidence.json`
and `/tmp/compositor.log`, then remove the named test container.


## Current compositor versions and cleanup

The September 24 current-version suite passes KWin 6.3.6, labwc 0.8.3 and
Weston 14.0.2 on ARM64. Each runs twenty semantic background form jobs. This
extends the earlier versions above; it does not establish KDE capture/gestures.
Current AT-SPI reports `button` instead of `push button`; both map to the public
`Button` role. The unmodified host failed before its first Save on all three.

Build this test-only image once, then reuse it across source changes. It needs no
checkout context and contains neither Rust tooling nor the full GNOME desktop:

```sh
docker build -t mako-control-linux:compositors-current - < scripts/linux-control/Dockerfile.compositors
sh scripts/linux-control/run-compositors.sh /absolute/prepared-payload /absolute/packaged-driver /absolute/new-evidence
```

Use a frozen, compiled payload with Linux `npm ci` dependencies and the portable
runner/probe/fixture files. `MAKO_COMPOSITOR_IMAGE` selects an existing image for
older-version coverage. The runner uses one image for all three isolated desktops,
collects each run's evidence and removes its container on success, failure or a
handled interruption. It does not build an image for each test. SIGKILL or an
engine crash can bypass shell cleanup; the `dev.mako.control.test` label identifies
these new test containers for inspection. Never prune unrelated containers or
volumes on a shared development machine.

Build caches and the architecture-specific Cargo volumes deliberately survive
runs to avoid recompilation. Keep stable image tags per environment/target; don't
create another tag for each attempt. Separate evidence files from container
retention. `docker image ls` sizes include shared layers and cannot be summed to
calculate occupied disk space. Audit `docker system df -v` and `docker buildx du`
before choosing a bounded cleanup. Runtime images use the prepared release
context in `runtime/control/Dockerfile`; never build that Dockerfile with the
whole checkout as context.
