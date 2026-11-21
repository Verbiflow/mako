# Isolated Linux acceptance

Each run gets its own X server and D-Bus session. It cannot send desktop input to
the Mac host or to another container. The fixture compares Mako's observations
with GTK's own state file and sends tagged keyboard input to another window.

For a portable payload and a credential-free contributor workflow, use
[disposable-machine acceptance](../../docs/local-control-ci.md). Native Intel x64
acceptance now passes on EC2; the shared control server runs under Node without
Electron. The commands below also support local isolated development.

## A person's Linux desktop

On a desktop session the person logged into (`linuxDesktop()`: `XDG_SESSION_TYPE`
x11 or wayland with its display, or `MAKO_DESKTOP_CONTROL=1`; a bare `DISPLAY`
such as `xvfb-run`'s is not one), the host starts its embedded driver as it
does on a Mac, with `CUA_DRIVER_RS_ENABLE_WAYLAND=1` on Wayland, and grants task
sessions to it. Without the desktop app, a window's live video comes from the
video helper: XComposite on X11, and on Wayland the monitor the person shares
through the ScreenCast portal (PipeWire, shared memory or a linear DMA-BUF),
asked once and restored from `~/.local/state/mako/portal-monitor.token`. The
helper encodes a picture only when it changed: XDamage on X11, and on Wayland a
buffer with an empty damage list or the same pixels as the last one is skipped.
On wlroots, whose portal sends nothing until something changes, a still
screen's first frame is the Screenshot portal's (`--still screenshot`). GNOME
sends its own first frame (60 of 60 captures of a still screen), and its
Screenshot portal refuses an unattended request.

Recordings are Mako's own the same way, never FFmpeg's: the helper's capture
goes into the recording's MP4. A window recorded by its X id carries no pointer,
so the driver keeps its action journal (`record_video: false`) and the helper's
`composite` mode, which decodes the recording with OpenH264, draws the pointer
in at the end. A shared monitor is recorded with the screen's own pointer in the
picture (the portal's embedded cursor mode), which the agent's pointer input
moves. The driver's Linux build has no FFmpeg path at all (0007).

`desktop-probe.mjs` takes the host's own path: the bundled `cua-embedded.ts`,
the broker, a task session and the `mako-control` CLI. It launches apps from
desktop entries (quoted `Exec=` with a field code), lists windows, screenshots,
reads accessibility, types and clicks into a GTK fixture and into terminals
(xterm, and foot on Wayland), drives an XWayland GTK app, writes and reads the
clipboard, then measures live video (first frame, frames and CPU over 5 idle
seconds, frames under input, its units written to MP4) and records with a
click, read back with Mediabunny. It refuses to start with `ffmpeg` on PATH;
the images install none. Each run writes `desktop-<kind>.json` with every
operation's time. Run one desktop at a time:

```sh
npm run build:control-runtime
npx esbuild packages/host/src/control/cua-embedded.ts --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json --external:@mako/control-runtime/* --external:zod --outfile=build/cua-embedded.mjs
sh scripts/linux-control/run-desktop.sh x11|sway|gnome|kde|kde6 <root> <driver package> <evidence>
```

`<root>` needs Linux `node_modules`; on a Mac, use a payload laid out like the
checkout. The GNOME and KDE 6 desktops answer the portal's consent dialogs with
`portal-consent.py` through AT-SPI and log each answer, so a restored session
shows none. The session's own logs (compositor, portal, consent answerer) are
kept beside the report in `logs-<kind>/`. `linux-desktop-control.yml` runs all
five on x64. `MAKO_RECORD_LOOPS=N` repeats the recording N times, and
`MAKO_DESKTOP_CPUS=N` with `MAKO_DESKTOP_LOAD=N` hold the container to N
processors beside N busy loops, for an intermittent failure's count.

Coverage on 2026-11-21 (driver 0.28.2+mako.32; Ubuntu 24.04 images, KDE Plasma
6.7 on Debian testing):

| | X11 (Openbox) | GNOME 46 Wayland | KDE Plasma 6.7 Wayland | KDE Plasma 5.27 Wayland | wlroots (Sway 1.9) |
| --- | --- | --- | --- | --- | --- |
| Window list | EWMH | Shell helper | KWin script | KWin script | Sway IPC |
| Window screenshot | yes | yes | KWin's own capture, XWayland too | KWin's own capture, XWayland too | yes, XWayland too |
| AT-SPI read, set value, press | yes | yes | yes | yes | yes |
| Focus and foreground keys and clicks | yes | libei, after one RemoteDesktop consent | KWin activation and libei, after one RemoteDesktop consent | activation only: its portal has no libei, input is refused and says so | yes (keys through `wtype`), XWayland too |
| XWayland app | n/a | yes | yes | AT-SPI and screenshot | yes |
| Clipboard | X selections | yes | yes | yes | wl data-control |
| Launch by desktop entry | yes | yes | yes | yes | yes |
| Live video (helper) | XDamage + XComposite | portal, consent once, restored | portal, consent once, restored | portal; the person's consent is not automated here | portal (xdpw), still screen from the Screenshot portal |
| Recording to MP4 | window | shared monitor | shared monitor | shared monitor, as live video | shared monitor |
| Pointer in the recording | drawn in from the driver's journal | the screen's own, pixel-checked | the screen's own, pixel-checked | not run | the screen's own, pixel-checked |

Idle cost of live video, 5 s with nothing changing: 0 frames and 0 CPU on X11,
Sway, GNOME and KDE 6, with the driver's GNOME agent cursor at rest (helper
v11). The Sway image builds xdg-desktop-portal-wlr 0.7.1 with shared-memory
screencopy allowed, since Ubuntu's refuses a GPU-less compositor, and installs
`wtype`, `grim` and the GTK portal backend, as a Sway desktop has them.

### KDE

Nothing is installed into KWin. The driver hands KWin one short script per
request over D-Bus (`org.kde.kwin.Scripting`), which lists the windows with
their geometry, activates one by KWin's own id when asked, and reports back to
the driver alone (0009 in `vendor/cua-driver/README.md`). A window's pixels are
KWin's own capture of that window (`org.kde.KWin.ScreenShot2.CaptureWindow`),
which KWin gives only to a program whose desktop entry asks for it. The host
never writes that entry on its own: Settings shows "Window capture" under
Computer use with one action, "Allow window capture", which writes
`~/.local/share/applications/app.mako.computer-control.desktop` for the driver
(hidden from the app menu), and "Remove", which deletes it
(`desktop-grants.ts`). Until it is allowed, a screenshot is refused and the
refusal tells the agent to ask the person for that action by name. The probe
takes that refused screenshot first, then allows capture through the same host
method Settings calls.

KWin composites with OpenGL on any real session, and its screen cast and window
capture exist only then. Headless, that is the whole difference between a KDE
that shares its screen and one that does not, which the earlier coverage could
not show:

- The KDE portal backend binds KWin's screen cast only when KWin finds the
  backend's desktop entry in its service cache, which needs an applications
  menu (`XDG_MENU_PREFIX=plasma-`, from `plasma-workspace`), and its share
  dialog needs `plasma-workspace`'s QML modules.
- With those in place the backend answers "OpenGL compositing is required for
  screencasting" under QPainter compositing.
- KWin 5.27's virtual backend gets OpenGL from Mesa's surfaceless EGL
  (llvmpipe), with no device: `KWIN_COMPOSE=O2ES`. XWayland then needs
  `XWAYLAND_NO_GLAMOR=1`.
- KWin 6's virtual backend takes OpenGL only from a DRM device, which a machine
  with no GPU has in the kernel's `vgem` (`modprobe vgem`; `run-desktop.sh`
  hands it to the container). From kernel 6.16 `vgem` sits on the faux bus,
  which libdrm knows from 2.4.126 and KWin from 6.7: Debian 13's KWin 6.3 finds
  no device there, so the `kde6` image is Debian testing's Plasma 6.7. A
  machine without `vgem` (Docker on a Mac) runs `kde6` under QPainter, where
  screenshots, live video and recording fail and everything else passes.

What a person on KDE gets:

- **Plasma 6.1 or later:** everything in the table. The first pointer or
  keyboard action shows KDE's "Remote Control" dialog and the first live video
  or recording its "Share screen" dialog, each once (both keep a restore
  token).
- **Plasma 5.27:** windows, screenshots, accessibility actions, clipboard,
  launch and activation, and live video and recording after the same share
  dialog. Its RemoteDesktop portal backend (version 1) has no libei
  connection, so pointer and keyboard input is refused at once (40 ms, no
  dialog) with "libei input is unavailable: ... this desktop's RemoteDesktop
  portal (version 1) hands out no libei connection; pointer and keyboard input
  needs KDE Plasma 6.1 or GNOME 45 or later". A window's bounds and screenshot
  are its client surface; for an X11 app under a KWin title bar, 5.27 does not
  say where the client lies in its frame, so its bounds are the frame and its
  screenshot the client alone. Settings says the same under Computer use:
  "Clicks and typing: Upgrade to KDE Plasma 6.1 or later for these." Its share dialog
  (Qt 5 on Wayland) does not appear on the accessibility bus in this desktop,
  so the consent answerer cannot press it: live video and recording are listed
  as known gaps for `kde`, and are the same portal path `kde6` passes. KWin
  5.27 does create the stream: the dialog's own preview of the screen is drawn
  from it.
- **When the screen is never shared** (the dialog unanswered for a minute, or
  declined): the recording's start fails with "The desktop's screen sharing
  request wasn't answered within a minute. Ask the person to answer its share
  dialog, then start the recording again; no recording was made." or "The
  person didn't share their screen; no recording was made."

### GNOME

GNOME's window list, screenshots, activation and agent cursor come from the
driver's Shell helper (`wayland-helper/winrects@cua`), an extension that lets
Mako list and activate windows. Nothing installs it on its own. Settings shows
"Shell helper" under Computer use with "Install helper", which copies it into
`~/.local/share/gnome-shell/extensions/` with the driver's whole path beside it,
and enables it through GNOME's own `gnome-extensions` tool, which touches that
one entry. Without the tool the host adds the entry to the printed list itself,
and only when the list holds nothing but plain quoted ids: one printed with a
double quote or a backslash is never rewritten, and the row says so. The helper
answers only that driver (it checks its caller's executable; version 12), and
its version to anyone. Where GNOME has user extensions turned off the row says
so, with "Turn on user extensions". The Shell loads a new extension only at
login, so the row then reads "Log out and back in once to finish", and
"Installed" once the helper of that version answers on the session bus.
"Uninstall" removes both. Without it GNOME lists windows through AT-SPI alone
and refuses screenshots and foreground input, and the refusal names "Install
helper" for the agent to ask for. A driver at a path that is not plain letters,
digits and `/._+-` gets neither grant, on KDE or GNOME, and the row says why.
This desktop installs it the same way:
`desktop-grant.mjs` runs the host's grant before the Shell starts, and the
probe then finds it granted.

A recording's start now waits for the portal's answer, not three seconds: on a
loaded machine a restored answer can come later than that, and a short
recording stopped before it had no picture ("The capture sent no picture"). The
Shell is one thread, and while it starts a screen cast an activation asked of
its helper went unanswered and was refused after 800 ms; it is now asked again
inside three seconds (0009). 300 recordings in a row on 2 processors beside 2
busy loops: 300 of 300 on arm64 before either change and 300 of 300 on an x64
runner with both, so neither failure was reproduced; both changes close a
window that the code plainly left open.

### What is not measured

- **DMA-BUF.** Every desktop here composites in software, so the portal hands
  the helper shared memory. The helper also maps a linear DMA-BUF (no modifier
  offered), which a compositor on a GPU may send instead: that path is
  untested, and a GPU's own formats (tiled, NV12) are not negotiated.
- **A pointer moving over a still screen.** A compositor sends a picture when
  the content changes; on wlroots a pointer that only moves is in the next
  picture that something else causes.
- **Fractional scaling and more than one monitor.** One 1280 by 800 screen at
  scale 1 throughout.

## Recording worker without a desktop

`continuous-recording-probe.mjs` tests the shared recording worker with a synthetic
image and cursor. Run it from a directory whose installed dependencies include
`@mako/control-runtime` and `sharp`. It requires FFmpeg/FFprobe, creates only
temporary media, and needs no browser, display, driver or network. It checks
continuous encoding, timeline v3, stop, output counts and absence of source JPEG
files. It does not establish compositor capture rates or native x64 acceptance.

The September 24 run reused the existing ARM64 Node acceptance image with
read-only mounts of the current package `dist` directories and this probe. It
used `--pull=never --network=none --read-only --cap-drop=ALL`, a 256 MiB `/tmp`,
two CPUs and 1 GiB RAM. No image was built or downloaded. Keep this media-only
check separate from the complete desktop jobs below. Launching through
`node --input-type=module -e 'await import("./recording-probe.mjs")'` also checks
that the encoder worker does not inherit a parent flag invalid for worker files.

## Isolated streaming comparison

`run-streaming-probe.mjs` is an experiment runner, not a packaged backend or a
self-provisioning installer. It reuses an existing ARM64 image with Python 3.11,
GTK, Xvfb, Chromium and the public control packages. It never builds or pulls an
image. The staged cache is intentionally outside the shipped package:

- `python/`: extracted pixelflux 2.1.0 CPython 3.11 ARM64 wheel from revision
  `40a9d46ba9b8c137b9812825041c68977ddf615f`. The runner verifies its wheel SHA-256.
- `selkies-source/selkies-3a46db7d58e4bddf2dd1f031ee9577720545e8ab/`: the pinned
  upstream archive; `web/` is its `addons/selkies-web-core` Vite output.
- `dependencies/python/`: Linux Python dependencies from that source's pyproject;
  retain pip's `--report` with resolved versions, public URLs and hashes.
- `cairo/`: matching ARM64 CPython 3.11 Pycairo and GI Cairo bindings. The test
  fails at startup if they are absent; a blank fixture is not acceptance.

The default cache is `node_modules/.cache/mako-streaming-prototype`.
`MAKO_STREAMING_CACHE` and `MAKO_STREAMING_IMAGE` select prepared alternatives.
Do not silently install upstream dependencies into the contributor's environment.
A portable artifact-preparation command and x64 wheel selection remain work;
these experiments do not establish a supported distribution.

After `npm run build:control-runtime`, run one measurement at a time:

```sh
node scripts/linux-control/run-streaming-probe.mjs capture420 /absolute/new-evidence
# Other modes: capture444, websockets, webrtc. Use a different empty directory.
FFMPEG=/absolute/path/to/ffmpeg node scripts/linux-control/analyze-streaming-probe.mjs /absolute/new-evidence
```

Each job has a private desktop, read-only mounts, four CPU cores, a 2 GiB limit
and a deadline. Capture and WebSocket tests disable networking; WebRTC uses a
per-run internal bridge for ICE, without an external route or published ports.
The runner removes its container and network on completion/handled interruption.
SIGKILL may leave named resources; inspect the exact `mako-streaming-*` resource
before removing it. No host desktop, home directory or credentials are mounted.
View-only credentials are generated inside the container and deleted on exit.
Selkies input is not a Mako input adapter and must not be enabled for agents.

The independent pixel oracle measures decoded marker changes, frame gaps and
invalid markers. Capture analysis also compares stationary colored text against
GTK's source screenshot. Cgroup memory includes page cache; container CPU includes
the fixture and browser. These are ARM64 Xvfb/software-encoding measurements, not
physical display, GPU, network-distance, Wayland or x64 performance acceptance.

## Desktop jobs

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
