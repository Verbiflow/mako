# Native and cloud validation, September 24

The current CLI and +mako.19 Linux driver pass on native AMD x64: X11 jobs,
three Sway configurations, both standalone CLI workflows and all eleven
standalone lifecycle scenarios. This extends the older Intel/+mako.17 evidence.
It does not establish all-platform parity with ChatGPT.

[Machine-readable results](local-control-native-validation-results.json) retain
the driver/patch hashes and measured checks. Raw synthetic fixtures and media
are in `docs/audits/2026-09-24/local-control-native-parity/` (gitignored).

## Physical Mac typing

The English fixture retained the exact requested two-line text while eight
background edit/save jobs completed. It observed 78 keydowns overlapping those
jobs, eight independent saves, and no activation notification or sampled
foreground change during the 22.15-second test interval. The fixture never wrote
into the human field. It used installed driver +mako.17 through the CLI.

Human attestation that the input was physical and felt uninterrupted is pending.
This run did not test IME composition or deliberate focus stealing. Notifications
plus samples provide stronger evidence than samples alone; they are not proof of
every internal keyboard-focus transition.

The test now defaults to `node scripts/test-native-human-input.mjs typing`, using
the person's normal English keyboard. `ime` is a separate explicit mode requiring
actual marked-text events during the test. It requires setting up an input method
and explaining conversion/commit before starting. SIGINT/SIGTERM now pass through
the fixture's cleanup. The initial Japanese-only trial was cancelled before Start;
it is not a failed input-delivery result. A save-count assertion was added after
the English run; the retained independent state also confirms eight saves.

## Native AMD Linux

The VM reported AMD EPYC 9R14 / AuthenticAMD / x86_64. The driver was built from
the pinned source and reviewed patch using the existing x64 build image on the
Mac; execution on EC2 was native AMD, not translation. This is not a claim of a
native AMD source build.

- X11: thirty exact-value save jobs, untouched decoys, stale/replaced-target and
  modal refusals, bounded reads and all 400 concurrent synthetic keystrokes.
  Median three-action job time was 273.5 ms through the current CLI. The older
  Intel timing used a different interface/build and is not a paired comparison.
- X11 recording: covered-window capture, gesture delivery, cursor timeline and
  retained playable media after target loss passed. The 30 fps fixture recording
  decoded fully; an extracted pressed-cursor frame was visually inspected.
- Sway 1.7: normal scale, 150%, and 150% plus 90-degree rotation passed. Each
  configuration verified exact Unicode, screenshot dimensions and its far-corner
  color, received drag endpoints and ten hidden-workspace edits while the cover
  retained focus. Requested 400 ms drags lasted 401, 401 and 403 ms. Hidden capture
  and unsupported recording refused. The rotated screenshot was inspected.
- Standalone browser CLI: scoped edit/help examples, ambiguity refusal, independent
  Save count, element captures interleaved with recording, finalization and cleanup.
- Standalone native CLI: exact Unicode, PNG/JPEG/resized captures, rejection of an
  invalid rate, recording at the driver-advertised ceiling, four concurrent
  programs sharing state and process cleanup.
- Eleven standalone lifecycle cases passed, including concurrent isolated jobs,
  worker/backend/supervisor crashes, cancellation with held input, startup failure,
  deadlines and retained recording artifacts. All four retained cloud videos
  decoded. CLI screenshots were visually inspected.

The browser clip contains ten source samples and 49 encoded frames. The native
clip reports 38 source frames and 37 encoded frames over about 0.62 seconds. Neither
is a sustained 1080p/60 fps benchmark. Cloud-owned Chromium uses explicit private
CDP; this does not replace installed Aside/Chrome extension acceptance.

## Mac menus and current Linux compositors

A shared projection bug hid every native menu role, including an AppKit popup
inside the target window. Filtering now omits only proven menu-bar branches;
scoped reads and locators retain popup/context-menu controls and their exact refs.
The public CLI selected three different items in a real background AppKit popup.
The fixture independently recorded three opens/closes, correct selections and no
activation notifications. Observations/actions emitted no screenshots. Repeat
with `node scripts/test-native-menu.mjs`. This is one popup route, not general
menu/dialog or proactive focus prevention coverage.

The fixture's original default-mode timer stopped during AppKit menu tracking.
Its evidence timer now runs in the common run-loop modes and logs menu callbacks;
the earlier apparent lack of a menu was partly an observation failure in the test.

KWin 6.3.6, labwc 0.8.3 and Weston 14.0.2 each pass twenty background form jobs on
ARM64 with +mako.19. Before the fix, all three stopped before the first Save:
newer AT-SPI names the role `button`, whereas the host only normalized the older
`push button`. Both now map to `Button`. Tests verify independently saved exact
values, untouched duplicate-name controls, unchanged focus histories and refusal
of unsupported capture/raw input. These are native Wayland clients under nested
software-rendered compositors, not physical GPU or KDE gesture/capture evidence.

The first run through the maintained cleanup runner failed before labwc started:
an X server readiness query exceeded its individual two-second limit and escaped
the existing ten-second readiness loop. The poll now retries transient query
timeouts within that deadline and still refuses persistent failures. Controlled
probes verify both outcomes; the repeated compositor suite passes all sixty jobs. A failed-run cleanup check
returns failure and leaves no labeled containers. SIGTERM during a controlled
long-running fixture returns 143 and removes its exact container after collecting
logs. These checks build no images.

## Local Docker retention

Tests normally reuse an existing image, but earlier ad-hoc runs retained 72 stopped
Mako containers with 7,488,356,352 writable bytes and seventeen Mako image tags.
Several build containers each downloaded a separate ~554 MB Rust toolchain: the
build image has Rust 1.93.1 but the pinned source requests 1.97.1. Aligning that
image with the source toolchain belongs in the next build-image revision.
The four shared Cargo/target/media volumes occupy about 6.39 GB combined and
intentionally preserve compiled dependencies. The global builder reports 25.85 GB
private cache plus 21.62 GB shared; it includes other projects. Image-size sums
would double-count shared layers. `docker system df -v` failed on missing overlay
snapshot 16546, so a reliable whole-engine total is unavailable.

The new compositor runner reuses one test-only image across all three desktops,
collects evidence, and removes containers on success, failure and handled signals.
It uses no checkout build context. README examples now show explicit cleanup for
older manual runs. No unrelated Docker resources or global caches were pruned.
Historical containers remain inventoried until their unique evidence is retained.
SIGKILL/engine crashes can still bypass shell traps; new test containers carry an
ownership label for inspection. The broader bounded-cache/retention policy and
the missing Docker snapshot remain separate maintenance work.

An earlier build exhausted local free space. Cleanup removed task-owned duplicate
payloads/source archives and superseded release executables only, retaining current
+mako.17/+mako.19, provenance and a deletion manifest. Older release directories
whose executable was removed are no longer installable packages.

## Repeatability and fixes to the tests

The portable contributor payload now includes Sway checks. All five desktop
suites execute without network access, as a non-root user, without a host display,
Docker socket or credentials. Each test uses its own desktop/bus. The workflow
retains CLI screenshots, timelines and videos instead of deleting the only media
when its containers exit. It remains locally prepared, not a published GitHub run.

The native CLI test previously assumed that 60 fps must be rejected, which was
correct only for the older fixed-rate driver. It now requests the advertised
ceiling and verifies that 61 fps refuses before dispatch. Media counts remain
separate from encoded frame rates.

The standalone image's first build failed before tests because Ubuntu's legacy
Docker builder lacked BuildKit cache-mount support. Installing Buildx and enabling
BuildKit fixed the build. The failed build log is retained, and the runtime guide
now names that prerequisite. Acceptance checks were not weakened.

Payload boundary tests, runtime compilation, full lint and diff checks pass.
Lint retains five existing React/TanStack warnings and no errors.

The EC2 instance had no IAM role, encrypted storage deleted on termination,
operator-only SSH and a bounded shutdown timer. Metadata was disabled and checked
before uploading test code. Only allowlisted packages and fixtures were uploaded.
The instance, key pair, security group, subnet, gateway and VPC were removed after
collection. Temporary SSH key files were removed locally too.

## Remaining gates

Proactive Mac focus prevention, real IME composition, broader native app/menu/dialog
coverage, KDE capture/gestures and physical GPU/display coverage remain open. The
physical English result applies to this fixture and driver. The reference Linux
executable is still unavailable.

The safe desktop update expired without replacing `/Applications/Mako.app`, which
still reports build `345bfd91c64009c6`. New candidate `a0c8c955359372bb` includes the menu/role fixes and passes packaged
startup, CLI worker/state/cleanup, regular-profile Aside save/dialog/capture and
native exact-text/capture/menu workflows. It contains 662,922,799 installed bytes
and 684 verified imports. Both screenshots were inspected. Installed-host and
extension rollout remain separate from this candidate acceptance.


The prior safe rollout of `a0c8c955359372bb` aborted after the host changed.
No rollout is currently queued. See
[`local-control-cli-deployment.json`](local-control-cli-deployment.json).

## Capture, gestures and file sheets

The earlier Mac +19 installation selected it for new driver launches, with a recorded rollback
selection and no forced daemon restarts. Source-runtime capture trials passed
the existing 57 fps floor at 1080p: 57.44 distinct fps for 30 seconds and 57.35
for 60 seconds. All foreground samples stayed unchanged. The earlier 56.62 fps
failed run remains in [capture evidence](local-control-native-capture-evidence.md).

Bounded settling, background click/right/middle/double-click/scroll, exact cursor
positions and a decoded 862-frame recording passed. Background drag remains
refused; this does not close touch/pinch or general gesture coverage.

A real NSOpenPanel exposed two failure cases. AXPress can return -25204 after
the sheet opens, so the error now tells the caller to observe before repeating.
The separately listed panel has no resolved AXWindow snapshot, while Cancel
read through the parent belongs to another window. Mako now returns a typed
unavailable observation and blocks subsequent input; it retains the driver's
exact-window refusal for Cancel. The earlier dialog-refusal regression passed
through the public CLI with installed +19 and a frozen source runtime, without
activation notifications or repeated opening clicks. This validates failure
handling; it predates the successful +21 file-sheet work below. The same regression passes in signed desktop candidate `33153e3c6176bd87`.
Packaged CLI and cold-start/quit/reopen checks pass too. This remains candidate
acceptance; the default desktop host was not replaced.

The prior idle desktop update aborted at 11:37 UTC when a new dev host appeared
and another conversation started. Installed app `345bfd91c64009c6` was unchanged.
Physical typing attestation and IME coordination remain unanswered; no synthetic
test is counted as physical-input evidence.

## Installed file-sheet improvement

Mac +mako.21 now replaces +19 for new driver launches. It shares exact sheet
discovery between observation and input. The installed-driver CLI passes three
Cancel rounds and an exact file selection/confirmation, with unchanged foreground
and independently checked AppKit responses. Menu, settling and gesture recording
regressions pass. Final full lint passes; 377 Mac unit tests pass, two ignored.

[The file-sheet report](local-control-file-sheet-evidence.md) records incomplete
panel coverage, explicit-reference limits, failed interference runs, package
provenance and the unsuccessful proactive-focus experiment. This does not change
Linux acceptance, the pending desktop rollout or physical typing/IME status.

## Sandboxed dialogs and bounded native reads

[The continuation report](local-control-dialog-depth-evidence.md) adds real
Open/Save proxy workflows, an explicit native traversal limit, long-path socket
startup and cleanup fixes, and sixty current-compositor background jobs. These
source-engine results retain incomplete coverage and do not close physical IME,
general proactive focus protection or raw cross-process/compositor input gates.
