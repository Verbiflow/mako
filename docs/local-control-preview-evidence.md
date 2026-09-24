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

At that checkpoint capture policy was undecided. The September 24 work below
implements shared temporary emulation for explicit live capture.

The macOS ARM64 candidate **1e3322212fc98974** passed direct and Launch Services
packaged startup, host/preload/composer, client quit/reopen, draft persistence,
664 resolved imports and verification of 1,077 build files. Its signed installed
size is **662,787,567 bytes** (whole app, not just Control). The packager now takes
workspace package filters from the release manifest, fixing an omitted frozen
`control-runtime` mapping and retaining the intended JS/license-only filter.

Candidate: `release/preview-transport-20260923/mac-arm64/Mako.app`. At the initial
readiness check, the default host still served `1f2c6af3acd5149e` with two running
agents. The queued idle-only installer later **aborted without installation** when
the shared host changed; its receipt records that refusal. It is no longer queued.

A subsequent live probe reports installed host **3e3f6a31a7970952**, built
2026-09-24T04:55:11.687Z. The installed ASAR contains Brotli encoding, client
negotiation/decompression and preview-only host routing. Its compiled modules differ
from the earlier candidate. This verifies code presence and the running build ID,
not the full installed capture/CLI workflow. Do not replace it with the older
candidate; run the remaining acceptance against this newer exact artifact.

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

## September 24 capture ownership and long recording

These checks use the installed Aside Work extension 0.3.2 and the updated source
host, through the normal default policy. They do not replace acceptance of the
new installed default Mako host. Earlier no-frame results above describe the old
policy. Live capture now owns temporary focus emulation alongside input actions;
ordinary text observation does not acquire it.

`audit-browser-focus.mjs <exact-browser-id>` checks an independently read page
before/during/after viewing, screenshots and private transport termination plus
reconnect. Those three cases restore `{visibility:"hidden",focus:false}`. A CDP
click is a counterexample: after capture stops the page is hidden but `hasFocus()`
stays true, even after debugger release/reselection. The remaining state is not
an unclosed emulation owner: the browser acknowledges `enabled:false`, ownership
is empty and capture is stopped. The fixture does not force DOM blur or switch
the user's active tab to manufacture a matching state. Chromium's
[focus controller](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/page/focus_controller.cc)
tracks emulation separately from underlying focus; this source supports that
distinction, not a claim that every Chrome version behaves identically.

The longer viewer audit includes one-second working-set/RSS/heap sampling,
separate Node and Electron CPU, actual source pixels and final ownership state.
All results below are from this shared workstation and the offscreen measurement
fixture, not a physical-display or isolated benchmark.

| Run | First source pixels | Animation | Distinct fps | Gap p95 | Wire / expanded MB/s | Electron / Node CPU cores | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before streaming encoder | 1920×1080 | 30 s | 56.89 | 20.37 ms | 11.58 / 17.23 | 0.94 / 0.48 | Recording failed at 512 MiB rendered PNG staging limit. |
| Sustained shared load | 1920×1080 | 60 s | 43.43 | 50.37 ms | 9.07 / 13.49 | 1.25 / 0.49 | Throughput failed; simultaneous media regression work may contribute. |
| Sustained larger capture | 2560×1440 | 60 s | 34.00 | 85.80 ms | 7.48 / 14.76 | 0.91 / 0.37 | Throughput failed. Cleanup test also exposed the click focus-state distinction above. |
| Streaming encoder, two viewers + recording | 1920×1080 | 30 s | **58.03** | **20.08 ms** | **11.87 / 17.67** | **0.93 / 0.48** | Complete job passed. |

The final row passed all 36 input/visible-marker checks. Click/type/scroll p95 was
119.10/110.99/103.83 ms. Both viewers retained all 8,294,400 decoded RGBA bytes,
with zero differences or invalid pixel samples. Every one of 288 foreground
samples remained on Aside. Closing either viewer preserved the other; closing
both preserved recording; final stop released capture/emulation. No physical
keyboard participant was involved.

The recording receipt covers 37,724.53 ms, 2,142 source frames and zero dropped
frames (1,418 intentional sampling events counted separately). FFprobe verifies
1920×1080, 60/1 output rate, 2,264 encoded frames and 37.733333 s. Repeated static
frames in the constant-rate file are not counted as new source frames. Source
input, screenshots and finalization are included beyond the 30-second animation.

During that animation, Electron working set rose from 866,729,984 to
1,204,011,008 bytes (peak 1,339,539,456). Node RSS went from 221,233,152 to
213,975,040 bytes; heap from 32,002,944 to 39,064,464. Electron includes the
instrumented offscreen viewer processes. These CPU numbers exclude installed
Aside and FFmpeg, and memory includes measurement work; neither is a whole-system
budget. The 60-second larger-capture run peaked at 1,431,011,328 Electron bytes.
This is enough evidence to keep sustained high-resolution efficiency open.

The next controlled experiment should remove base64/JSON media copies from the
Electron delivery path while preserving exact compressed image bytes, one shared
capture, bounded latest-frame delivery and independent recording. Compare it
against these source sizes and one/two-viewer workloads before selecting it.
No codec change or lossy resize was accepted to improve these numbers.

## Streaming encoder and fresh-agent checks

The old finalizer rendered every source/action timestamp into another PNG on disk
before starting FFmpeg. A normal 30-second dense recording exhausted its 512 MiB
render budget. The replacement streams RGBA at the requested output cadence,
waits for stdin backpressure and reuses the unchanged rendered state. Rendering,
encoding and child cleanup share a bounded deadline. A rendering failure kills
and reaps the encoder before the final receipt settles.

The regression represents 531.58 MiB of old PNG staging using 81 full-HD source
frames. It finishes with zero rendered files. A single static source recorded
for 1,377 ms encodes to 1,400 ms at 10 fps instead of duplicating its tail duration.
Geometry, native transparent cursor composition, source budgets and unchanged
encoding quality retain their existing checks. Media recipe 2 adds only explicit
pipe/rawvideo support to the static, network-disabled build. Packaged browser and
native-overlay tests pass with shell/Homebrew encoders unavailable.

Fresh agents separately tested installed build `3e3f6a31a7970952`: CLI/MCP state
continuity, stdin/source files, spaced artifact paths, exact Unicode, refusal of
ambiguous Save, one scoped Shipping save with untouched Billing, and element
capture passed. That old installed build still failed continuous background
recording, which the newer source/candidate checks address. `shot --format` now
allows an explicit PNG/JPEG choice instead of implying encoding from a filename.

The native Terminal job launched a scratch window, typed a marker command through
the driver, used high-level Return, independently read the output and captured it.
All 82 samples stayed on Aside. Only the owned scratch was closed. The capability
fix excludes explicitly off-screen document rows; unknown/on-screen competitors
and fresh driver preflight still block. Recording can add an AX dialog that
blocks typing; this was not bypassed with a title/size exception.

Reproducible checks: `test:control-recording`, `test-browser-service.ts`,
`test-native-keyboard-capabilities.ts`, `test-control-cli.mjs`,
`test-native-terminal-acceptance.mjs`, `audit-browser-focus.mjs`, and
`audit-control-preview.mjs --shared-host --extension=<id> --two-viewers --recording
--seconds=30`. Machine-local detailed evidence is under
`docs/audits/2026-09-23/local-control-installed-next/` and
`docs/audits/2026-09-23/fresh-terminal-acceptance/`; ignored media may be absent in
fresh clones. The measurements and limitations above remain in tracked docs.


## Signed candidate and queued rollout

Candidate `b1d91522d82480b1` contains the final shared-focus, streaming encoder,
native capability and explicit CLI image-format changes. It is locally signed,
662,856,997 bytes, with 1,081 verified input files and 671 resolved imports. Both
packaged startup routes pass. Packaged media tests remove shell/Homebrew encoders
from PATH and pass browser encoding plus native transparent cursor composition.

`test-installed-browser.mjs <browser-id> <candidate.app>`, run under that app's
Electron-as-Node executable, loads the candidate's ASAR engine and host. It passed
**40** independently counted Unicode saves through scoped forms and dialogs,
leaving Billing untouched. Recording finalized after 13,217.85 ms with 90 source
frames, 60 dispatched pointer samples and zero dropped frames. This mostly static
form job is not a high-frame-rate benchmark. The decoded video was visually
inspected for exact target content and the dispatched cursor.

The test then interrupts this client's transport during another recording. Its
old handle refuses, the interrupted receipt retains playable video, reconnect
still rejects that stale handle, and a newly created owned tab can close normally.
All **259** foreground samples remain on Aside. The detailed candidate receipt is
under `docs/audits/2026-09-23/local-control-installed-next/packaged-aside/`.

The default installed app remains `3e3f6a31a7970952`. The queued idle installer at
`release/control-capture-20260924/install-after-idle.mjs` subsequently aborted:
`install-state.json` reports `not-installed` because the shared host changed.
It did not replace the app. A future rollout must validate the exact current
candidate and host, then repeat packaged media and regular Aside acceptance.
Neither the old queued state nor candidate tests establish installation.

## September 24 sustained 1080p failure

The source capture budget is now explicitly 1920×1080; it does not resize the
page or change independent screenshot detail. A 60-second Aside extension run
with two viewers and recording **failed**. This is additional evidence, not a
replacement for earlier successful short runs or failed long runs.

- Live viewer: 3,121 distinct frames in 60.00084 seconds, **52.02 fps**. Frame-gap
  p50 16.84 ms, p95 34.10 ms, maximum 166.93 ms; zero invalid marker samples.
- Transport: 645,518,891 compressed bytes and 960,656,372 expanded bytes, about
  **10.76 MB/s compressed / 16.01 MB/s expanded**.
- Resource measurement: Electron fixture processes averaged 1.05 CPU cores and
  the separate Node host 0.81 cores. Electron working set rose from 958 MB to
  1,182 MB; Node RSS from 232 MB to 249 MB. These exclude installed browser and
  FFmpeg CPU and are not whole-system cost.
- Recording interrupted at **41.33 seconds**, after retaining 2,379 source JPEGs
  totaling **536,971,545 bytes**. The stop reason was the 512 MiB source-frame
  storage limit. The test failed before its final acceptance report, so no complete
  input, foreground or cleanup acceptance is claimed for this run.

The earlier streaming encoder fix removed decoded-PNG staging during finalization.
`ControlRecording.storeFrame` still saves each source JPEG until recording ends.
Continuous encoding during capture, with bounded pending frames and playable
partial output on interruption, remains necessary. Raising the cap would preserve
that accumulation. Keep source timing, cursor alignment, frame geometry and
independent screenshots intact while replacing it.

Reproduction: `node scripts/audit-control-preview.mjs --shared-host
--extension=<connected-browser-id> --two-viewers --recording --seconds=60`.
Machine-local evidence is under `docs/audits/2026-09-24/preview-1080-sustained/`
(`animation.json`, `timeline.json`, `run.log`). Raw fixture media remains in the
private temporary run directory named by that log. These ignored artifacts may
be absent in another checkout; the script and this outcome remain tracked.
