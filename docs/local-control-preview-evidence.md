# Local Control viewer evidence — 2026-09-23

Progress belongs to [LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).
This checkpoint fixes a reproduced viewer failure and reduces preview response bytes
on the shared-host socket. Installed Aside capture has a reproduced hidden-tab
limitation; remote-network performance, native 60 fps and overall parity remain open.

## Failure and change

Both the inspector and chat preview replaced an `<img decoding="async">` source
on every arriving frame. In a busy stream, Chromium repeatedly replaced an image
whose decode had not completed. The host reported a fast stream while the viewer
frequently painted an empty image. In the controlled comparison, 222 updates in
four seconds produced only 10 readable sequence markers and 212 invalid/blank
compositor samples.

[The painter](../src/lib/control-preview-painter.ts) now completes one decode and
paints it on the next animation frame. It retains only the newest waiting frame;
continuous arrivals cannot cancel the completed image. The canvas retains the
last complete pixels during the next decode. Its backing dimensions match the
decoded image; CSS alone fits it into the panel. Invalid or oversized images
cannot replace those pixels. Disposing a target cancels scheduled painting and
prevents late decode completion from painting into the next target.

The existing capture, authorization, input, recording and task owners remain in
place. No codec, resolution or JPEG-quality reduction was introduced. The change
adds no dependency or agent-facing API.

## Reproduce

From the repository root, with Node 24 and installed dependencies:

```sh
npm run test:control-preview
npm run audit:control-preview
npm run audit:control-preview -- --baseline
npm run audit:control-preview -- --two-viewers --recording
npm run audit:control-preview -- --shared-host
npm run audit:control-preview -- --shared-host --identity
```

By default, the audit builds production renderer assets into a fresh temporary directory and
starts its own Electron profile. It creates a synthetic browser target through
the production `BrowserService` and desk adapter. It connects no user profile,
sends no model request, and does not install or replace Mako. Recording requires
the runtime's configured FFmpeg dependency. Each run prints its evidence directory.

The baseline flag substitutes the old async-image component in the audit build
only. It measures the same animation workload but intentionally skips input and
fidelity acceptance because the old viewer can fail to display an acknowledgment.

## Measurement boundary

The tested path is browser capture → `ControlPreviews` → Electron IPC and actual
preload bridge → production preview state and chat component → offscreen compositor
pixels. The inspector uses the same new image component. The source is 1920×1080;
the chat card is 288 CSS pixels wide. This is not a full-screen 1080p viewer test.

The source paints a frame sequence, an input acknowledgment, a fixed signature and
checksum as black/white bars. The observer reads them from the composited bitmap,
not DOM state, an image-load callback or host delivery counts. Distinct fps counts
readable changing sequences across the whole measured interval; a paused source
must produce zero new sequences. Gaps are intervals between readable sequences.

Click, text and wheel commands pass through the shared browser engine. The source
changes the acknowledgment only when its actual input/scroll handler runs. A
separate source-state oracle requires exactly 12 button activations, 12 inserted
characters and positive scroll displacement. Input dispatch and compositor delivery
use the same main-process monotonic clock, avoiding cross-process clock subtraction.

[Electron's offscreen bitmap output](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)
includes GPU readback overhead. These measurements include that observer, source
animation and local transport. They exclude physical display scanout, model/CLI
startup and network delay. The initial runs below do not use the shared-host socket;
the separate-host extension is measured later in this report. Instrumentation-
on/off, stage-by-stage profiling and independent timing of the second viewer remain
to be measured. CPU totals include all fixture Electron processes, not FFmpeg's
later finalization work. They are not an idle-resource or sustained-memory budget.

## Results

Mac ARM64, Electron 43.4.0, four-second animation intervals. These short local runs
are regression evidence, not a matched competitor benchmark. The first two fixed
runs predated the whole-interval fps calculation; the table consistently divides
their recorded frame count by elapsed time.

| Renderer / consumers | Distinct frames / fps | Frame gap p95 | Blank/invalid samples | Electron CPU cores |
| --- | --- | --- | --- | --- |
| Original image, one viewer | 10 / 2.50 | 1146.1 ms | 212 of 222 | 1.97 |
| Bounded painter, one viewer | 237 / 59.26 | 19.6 ms | 0 | 2.04 |
| Bounded painter, two viewers | 240 / 60.01 | 18.8 ms | 0 | 2.09 |
| Bounded painter, two viewers + recording | 239 / 59.75 | 19.4 ms | 0 | 2.14 |

A final single-viewer repeat after the complete host build measured 239 frames /
59.76 fps, 18.2 ms p95 gap, zero invalid samples and 2.08 Electron CPU cores. It
also passed all 36 input checks, full pixel fidelity and final-consumer cleanup.

With two viewers and recording, input-to-visible p50/p95 was:

| Operation | Samples | p50 | p95 |
| --- | --- | --- | --- |
| Click | 12 | 78.8 ms | 90.9 ms |
| Type | 12 | 75.8 ms | 80.4 ms |
| Scroll | 12 | 72.5 ms | 109.4 ms |

The no-recording two-viewer run measured 61.9/74.7 ms for click, 57.2/70.6 ms for
typing and 67.2/97.8 ms for scrolling. Host load and scheduling vary; neither run
sets a universal latency guarantee.

Each of the two canvases retained 1920×1080 pixels: all 8,294,400 RGBA bytes matched
an independent decode of the retained JPEG. This proves no extra loss in the
viewer; it does not make the original JPEG lossless or establish Retina capture.
The first viewer supplies the fps/latency samples; both canvases receive the
fidelity check. Two viewers share one renderer subscription and one source capture.

The combined run started capture once. Closing one viewer preserved the other;
closing both preserved recording; ending recording stopped capture exactly once.
The recording finalized at 1920×1080 with 564 retained source frames, no reported
queue drops and an 11.11-second capture duration. Independent `ffprobe` inspection
reported a playable 1920×1080, 60-fps MP4 with 677 encoded frames and 11.28-second
duration; a full FFmpeg decode completed without errors. Encoded duplicates/timing padding are not counted as distinct source
frames. Finalization exceeded the audit's first 10-second wait; the audit now
allows 60 seconds and still fails on an unfinished/failed recording.

## Shared-host transport — September 23 follow-up

`--shared-host` starts a separate Node process running production `BrowserService`,
`ControlPreviews` and `startWebHost`. The renderer reads through the production
Unix-socket client, preload and viewer. `--identity` keeps the same path and disables
compression only through a private fixture channel. Neither fixture channel is
registered in the application. Child disconnect releases capture and owned targets.

Preview responses now negotiate Brotli quality 1 using Node’s built-in encoder.
They retain the exact JSON and JPEG bytes. Compression has two concurrent slots
and no waiting queue; saturation returns the original response. Small and ordinary
RPCs, old clients and explicit refusal of Brotli retain identity responses. The
reader bounds both compressed and expanded bodies to 32 MiB. Invalid/truncated
replies fail without replay. Tests cover these conditions and exact Unicode, null,
false, zero and empty values. No new dependency or page mutation is involved.

A sequential four-second comparison passed all 36 input checks, every decoded
pixel and one-start/one-stop capture cleanup:

| Shared socket mode | Response body MB/s | Distinct fps | Frame gap p95 | Electron CPU cores |
| --- | --- | --- | --- | --- |
| Identity | 17.62 | 58.50 | 18.79 ms | 2.21 |
| Brotli | 11.98 | 58.74 | 18.74 ms | 2.32 |

The compressed run transferred 47,920,125 bytes from 71,378,176 original bytes
(32.86% fewer). These are HTTP response body counts, excluding headers/framing.
Electron IPC still carries the expanded image. Compression does not eliminate
base64 allocation, JSON parsing or full-frame delivery. The CPU column excludes
the separate Node host; it must not be read as the complete transport cost.

A later pair added Node CPU measurements. Brotli measured 49.75 fps, 47.45 ms p95
gap, 10.26 MB/s, 2.23 Electron cores and 0.40 Node cores. Identity measured 56.35
fps, 20.46 ms p95 gap, 17.12 MB/s, 2.16 Electron cores and 0.35 Node cores. Both
passed input, exact pixels and cleanup. This was a busy shared workstation, not
an isolated crossover benchmark; the slower compressed run remains evidence.
Sustained tail latency and total resource cost need further measurement.

PNG screencast capture increased this workload to about 20.75 MB/s, so the
production capture format remains JPEG. A prefix/suffix frame-delta experiment
retained 88% of source bytes and would add receiver state; it was not adopted.

## Installed Aside and release acceptance

The regular Aside Work profile used installed extension **0.3.2**, with no
remote-debugging fallback or automatic tab activation. Reproduce the capture
check with the exact locally registered ID:

```sh
node scripts/audit-control-preview.mjs --shared-host --extension=<browser-id>
```

The fixture loaded at 1920×1080 but reported `visibilityState: hidden`. Capture
subscribed successfully and produced no first frame. A screenshot request did not
repair the stream. The existing complete-job test passed **20** form edits/saves
with exact Unicode/whitespace values before recording refused startup after its
five-second no-frame deadline. All **188** foreground samples matched the initial
app. The recording phase, reconnect and interruption phases did not pass in that
run and must not be inferred from the 20 completed jobs.

The diagnostic `--lease-focus` uses the engine’s existing continuous emulated-focus
policy instead of its normal action-only policy. The hidden page then reports
visible and supplies frames; one run measured 44.75 distinct fps and
failed the audit’s >45 fps threshold. That isolates a painting/focus dependency,
not a successful default-policy acceptance. An explicit `--background-window`
experiment also supplied frames but failed the pixel-marker check; its first frame
was 2560×915 despite the requested 1920×1080 viewport. Neither experiment changes
production policy.

A subsequent lease-focus run passed: **52.24 distinct fps**, 35.79 ms p95 frame gap,
36 exact input checks, zero invalid pixel samples and zero differences across
**14,745,600 RGBA bytes at 2560×1440**. Click/type/scroll input-to-visible p95 was
140.6/117.3/130.4 ms. All **73** foreground samples matched the initial app. Its
response bodies compressed from 88,658,431 to 44,772,065 bytes over four seconds.
The audit originally assumed capture pixels must equal the emulated CSS viewport;
that was incorrect for this installed browser. It now independently requires the
canvas dimensions to equal the decoded source, every byte to match, at least
1920×1080 pixels and the requested aspect ratio. Higher source resolution passes;
downscaling, cropping and viewer pixel loss do not. Source CSS and captured pixels
are reported separately. This passed **diagnostic policy**, not normal production
capture, and did not test concurrent recording or physical human typing.

The decision whether preview/recording may temporarily change page focus/visibility
has been presented to the user; action-only production behavior is unchanged.

The macOS ARM64 candidate **1e3322212fc98974** passed direct and Launch Services
packaged startup, host/preload/composer, client quit/reopen, draft persistence,
664 resolved imports and verification of 1,077 build files. Its signed installed
size is **662,787,567 bytes** (whole app, not just Control). The packager now takes
workspace package filters from the release manifest, fixing an omitted frozen
`control-runtime` mapping and retaining the intended JS/license-only filter.

Candidate: `release/preview-transport-20260923/mac-arm64/Mako.app`. The default host
still served older build `1f2c6af3acd5149e` with two running agents at readiness
check. An idle-only installer is queued; it never stops those agents, refuses a
changed/cancelled lifecycle operation, retains the previous app and verifies the
new host’s build ID after launch. Its bounded wait expires after 30 minutes.
Read `release/preview-transport-20260923/install-state.json` for the actual result;
**queued is not installed**. No installed-host acceptance is claimed yet.

## Remaining cost and acceptance

The combined animation still transferred 72.28 MB of preview JSON in four seconds
(about 18.1 MB/s). Fixing presentation alone did not reduce those bytes. Negotiated compression now
reduces the shared-socket response bodies as measured above. Continue comparing
lower-overhead local delivery against this verified viewer, preserving source
pixels, bounded queues, task scope and independent recording. The earlier
~555 KB/frame/~1.5-core capture-only fixture used a different source and measurement
boundary; its CPU result cannot be subtracted from these results.

Installed shared-host and regular-browser runs, remote streaming, high-DPR and
full-size viewers, sustained memory/resource cost, instrumentation overhead and
native capture remain open. Unit/state checks additionally cover one in-flight
decode plus one pending frame, supersession, resize, malformed/oversized pixels,
target disposal, hidden polling suppression and shared-consumer cleanup.

Verification: `test:control-preview`, the production audits above, complete host
build and application TypeScript checking passed. Full `npm run lint` passed with
zero errors and five existing React/TanStack warnings; anti-slop reported zero
warnings/errors.
