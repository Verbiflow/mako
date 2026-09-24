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
coverage, KDE capture/gestures and newer compositor versions remain open. The
physical English result applies to this fixture and driver. The reference Linux
executable is still unavailable.

The safe desktop update expired without replacing `/Applications/Mako.app`, which
still reports build `345bfd91c64009c6`. Candidate `7b0a2c623f935da0` remains separately
validated; installed-host/extension rollout is not closed by these cloud tests.
