# Continuous media investigation

2026-09-24. [LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor)
owns this work. Continuous encoding is now implemented in the shared runtime and
locally tested. The installed app has not received these media changes. No
Selkies, pixelflux or Moonlight dependency was installed or adopted.

## Implementation and acceptance — September 24

Browser recording now feeds the existing encoder during capture. It keeps bounded
timestamped source history (at most two seconds of frame slots and 32 MiB of
compressed bytes), writes fragmented MP4 and an incremental `timeline.jsonl`,
and no longer stores each source JPEG. A dedicated worker decodes the source,
draws the cursor and owns the encoder pipe. The [binary-preview follow-up](local-control-preview-binary.md#encoder-follow-up) tested and rejected an RGB pipe optimization after comparing full-path throughput; the encoder retains RGBA. Only compressed source bytes and
coordinates cross into it; unchanged output sends a repeat command. Native
postprocessing uses the same pixel composition function. Worker
startup finishes before capture subscribes. The first recording acknowledgment
requires a real frame admitted to the encoder, not merely a received JPEG.

The output canvas is fixed from validated viewport geometry. Source pixel sizes
remain separate metadata; no page resize or devicePixelRatio override is used.
An explicit output clock holds the last available image through source gaps.
Timeline v3 records which source samples reached output, and receipts distinguish
capture duration from retained encoded frames/duration. The browser/CLI/MCP APIs
still use the same recording owner and handles.

Native H.264 with `cursor:false`, matching fps and an already acceptable size is
retained byte-for-byte. Native cursor/resize transforms still use postprocessing.
Preview frames now retain source `capturedAt` separately from `publishedAt`;
[binary preview delivery is now implemented locally](local-control-preview-binary.md), with shared source bytes and JPEG decoding. Its final acceptance and installation are tracked separately.

| Check | Result and scope |
| --- | --- |
| Dense 1080p source for one minute | 6,156,111,068 accepted source bytes, zero source/render image files, 3,610 encoded frames over 60.167 s, finalization 381 ms. Recorder-process RSS 143→261 MB peak, including its worker but excluding FFmpeg. Repeated synthetic pixels; **not distinct-fps acceptance**. This run preceded the startup prewarm change. |
| Kill the real encoder | Explicit interrupted receipt; 120 decoded frames / 2 s retained from 3.77 s capture. The encoder was reaped. A file's existence alone does not qualify it as playable. |
| Kill the host | The encoder exited when its input pipe disappeared; 183 decoded frames / 3.05 s retained in the covered run. The incremental journal remains open-ended, with no fabricated finished receipt. This is process-death evidence, not machine power-loss durability or automatic post-restart handle recovery. |
| Short encoder stall | Pausing the real FFmpeg process while red, green and blue source states arrive, then resuming it, preserves all three states at their source times in independently decoded output. A latest-only recording buffer had discarded those intermediate states; the bounded timestamped queue fixes that without adopting an unbounded backlog. |
| Ten-minute storage soak | 35,912 accepted source samples / 9.82 GB of source bytes produced zero staged images and a 165.7 MB live video. Finalization took 102 ms; recorder/worker RSS peaked at 254 MB. Encoder-kill and native byte-identity checks also passed. This repeated-pixel run preceded the timestamped queue change; it proves the continuous encoder/storage path, not the final queue or distinct-motion rate. |
| Stalled input pipe | A child that reads part of a frame then stalls is killed/reaped after the five-second progress timeout. The recording reports failure without publishing an invalid video. |
| Cursor and geometry | Independent decoding checks cursor position before/after dispatch, movement, source color timing and native background pixels. An initially 480×300 JPEG in a 1600×1000 viewport cannot lock the video to 480×300. |
| Screenshot interference | A real disposable Electron page passed five interleaved clipped screenshots and retained 1600×1000 source/video geometry. The moving marker is measured in decoded video, rather than counting encoded frames or compression-noise hashes. |
| Package ownership | Isolated npm consumer runs recording through the public typed SDK using its installed worker. The Linux release graph explicitly includes that worker and still rejects Electron imports and private dependencies. No encoder binary or runtime dependency was added. |
| Shared host + installed Aside extension, two viewers, one minute | The worker implementation completed a 68.64 s recording and all 36 exact input checks; both viewer pixel comparisons had zero differences. Preview reached only **48.00 distinct fps**, with 40.56 ms p95 gap and 283.95 ms max gap. This run preceded startup prewarming. Foreground samples contained two PIDs, so it is not a clean no-focus-change acceptance; the samples alone do not identify the cause. Updated desktop installation remains pending. |
| Worker-owned rendering, same Aside fixture, one minute | Video completed at 68.57 s; all 36 edits and both exact pixel comparisons passed, with 329 unchanged foreground samples. Preview **53.76 distinct fps**, p95 gap 32.11 ms, max 140.16 ms: still below the 57 fps acceptance floor. Click/type/scroll p95 were 111/171/339 ms. This is an observed run, not a matched statistical performance improvement claim. |
| Independently decoded video from that run | Over the first 60 s, 3,600 encoded frames contained **2,915 distinct marker frames (48.58 fps)**, zero invalid markers and a longest repeated marker of **1,166.7 ms**. Recording smoothness also fails; the 60 fps container rate is not substituted for distinct motion. |
| Timestamped queue, same Aside fixture, one minute | Completed 67.00 s of 1920×1080 video. Preview **56.53 distinct fps**; independently decoded video **56.82 distinct fps**, zero invalid markers, longest hold **116.7 ms**. Both remain below 57 fps. All 36 edits, both exact pixel checks and 345 unchanged foreground samples passed. Click/type/scroll p95: 89/79/112 ms. Queue high-water: 18 samples / 4.06 MB. Observational comparison under uncontrolled machine load, not a statistical speedup claim. |
| Final source queue regression | One-minute dense repeated-pixel test accepted 6.16 GB, staged no images and finalized in 386 ms; 3,611 frames / 60.183 s. RSS peaked at 266 MB including worker, excluding FFmpeg. The real encoder-stall test preserves intermediate colors; byte-overflow stops explicitly below 32 MiB and reaps FFmpeg. Full recording suite, isolated packaged SDK and lint pass (five existing React compiler warnings, zero errors). |
| Linux ARM64 | The same compiled worker completed 38 frames / 1.267 s in an existing offline container using Node 24.21.0 and `/usr/bin/ffmpeg`. Synthetic image/cursor only; no compositor or native x64 claim. No image was pulled/built. This exposed a public-SDK startup failure under `node --input-type=module`; compiled workers now omit parent-only Node flags, covered by isolated package and Linux checks. |

The first main-thread encoder implementation failed after roughly seven seconds
under the browser/viewer workload. Its two-second lag guard interrupted capture
and retained three seconds of playable video. Moving pipe handling into a worker
removed that interruption in the covered minute-long run. A later decoded-marker
test caught an initial freeze while the worker loaded; prewarming corrected it.
Both failed experiments are retained, rather than replaced by the successful ones.

A later 30-second diagnostic run recorded a 2.77-second repeated marker despite
only 549 ms maximum encoder scheduling lag. The recorder had discarded source
history while catching up: its newest pixels were still in the future relative
to the output clock. Recording now keeps a bounded timestamped queue and consumes
frames against output time. Preview remains latest-only. Byte/frame overflow
interrupts explicitly instead of silently losing recording history.

The final timeline also records encoder scheduling, worker wait, rendering and
pipe-write maxima, queue high-water marks and waits exceeding one output-frame budget. These are bounded
aggregate diagnostics, not per-frame logs in model context. They distinguish
remaining host delivery delays from rendering and encoder backpressure before
the next transport change.

Scoped reports, fixture videos, interrupted prefixes, timelines and hashes are
in ignored `docs/audits/2026-09-24/continuous-recording/`. The full dense-source
and ten-minute videos are not duplicated there; reproducible scripts and reports
are retained to avoid unnecessary evidence storage.

Reproduce the focused checks with:

```sh
npm run test:control-recording
npm run test:control-recording-continuous
npm run test:control-recording-continuous -- --soak
node --import tsx scripts/test-control-package-consumer.mjs --offline
```

The ten-minute rerun completed including its fault/native checks. The first
ten-minute capture completed, but a concurrent rebuild changed its subsequent
fault-test worker protocol. That entire earlier command failed; it is not a
passing full suite. Source tests now select the source worker instead of silently
loading whatever compiled worker happens to exist.

These final source results close the continuous-recorder implementation gate;
they do not close the speed or installed-delivery gate. Task-scoped binary preview transport is now implemented locally, retaining exact image bytes and bounding slow viewers. [Current delivery evidence](local-control-preview-binary.md) records its verification separately. Both preview and decoded video motion now
have explicit rate assertions in the sustained audit.

Remaining recording gates: real ENOSPC/partial filesystem writes, power loss,
broader media-player compatibility and installed rollout. Remaining performance
work: final binary-preview acceptance, complete process accounting and matched Linux streaming comparisons. The user now accepts roughly 56 distinct fps; 60 remains the target. Sustained 1080p60 is **not** established.

## Baseline findings before this implementation

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Browser encoding starts after capture stops. | `ControlRecording.storeFrame` writes each JPEG; `stop` writes the timeline, then calls `encode`. [Implementation](../packages/control-runtime/src/control-recording.ts). | The 41.33-second / 512 MiB failure remains reproducible by construction. The existing one-pending-frame bound limits pending work, not accumulated files. Replace the file staging, not its cap. |
| Native recordings are encoded twice, including `cursor:false`. | `attachVideo` renames the native MP4, creates a transparent cursor background and enters the same `encode` path regardless of the cursor option. [Implementation](../packages/control-runtime/src/control-recording.ts). | A verified source with matching output size/format and no cursor transformation should be retained directly. Cursor-enabled native recording needs composition before its final encode, or a measured explicit postprocessing path. |
| Browser output geometry is chosen using future frames. | `encode` selects the largest stored source image after stop. | A continuous encoder cannot preserve this algorithm. Establish a fixed output canvas from verified target geometry before encoding; report actual source detail separately. Test an initially small frame followed by full-resolution frames and resize. Never resize the page to satisfy video dimensions. |
| Full RGBA frames cross the encoder pipe. | `renderFrames` decodes/resizes/composites through sharp and yields RGBA to FFmpeg. | At 1920×1080/60 that is 497,664,000 raw bytes/s (arithmetic, not measured throughput). Moving this work into capture time fixes storage but may contend with input. Measure the entire decode/composite/encode path in a supervised worker before calling it fast. |
| The packaged FFmpeg has no hardware video encoder. | Reviewed recipe/provenance and `ffmpeg -encoders`: `libx264` and PNG only; network support disabled. [Recipe](../scripts/build-control-media.mjs). | `h264_videotoolbox` cannot be enabled by a runtime flag alone. The current two executables total 11,137,552 bytes; hardware support needs a target-specific build/acceptance change. This describes the postprocessor, not the Mac driver's ScreenCaptureKit encoder. |
| Preview capture time is overwritten. | `BrowserCapture` retains CDP `capturedAt`, but `ControlPreviews.frame` writes `Date.now()`. [Capture](../packages/control-runtime/src/browser-capture.ts), [preview](../electron/control-previews.ts). | The preview's timestamp measures host publication, not source age. Preserve both clocks before measuring source-to-viewer latency. Existing independent visual-marker results remain valid. |
| Capture is shared; media delivery still crosses the generic RPC path. | BrowserCapture owns one screencast per attachment. Each renderer's watcher receives activity, requests preview JSON, decompresses/parses it, transfers it through Electron IPC and decodes a base64 data URL. [Response](../electron/runtime-response.ts), [state](../src/state/control-preview.ts), [painter](../src/lib/control-preview-painter.ts). | Keep shared capture, ownership and the bounded painter. Replace media delivery without moving frames through MCP or agent context. Native preview already uses an Electron MediaStream but native recording is a separate driver capture. |

The baseline sustained browser result was **52.02 distinct fps**, with two
viewers and recording. Its recording stopped after 41.33 seconds.
[Original run and limitations](local-control-preview-evidence.md#september-24-sustained-1080p-failure).

## New measured result: interrupted video containers

Run from the repo root:

```sh
node scripts/audit-control-media-continuity.mjs
# Optional positional argument: absolute directory containing ffmpeg and ffprobe.
```

The script feeds 180 synthetic 1920×1080 YUV frames at a declared 60 fps to the
bundled ARM64 FFmpeg 8.0.1. It matches codec, quality and GOP settings across arms,
checks files while stdin remains open, then either closes stdin or kills that
encoder with SIGKILL. FFprobe decodes/counts frames. It also checks MP4 boxes to
confirm hybrid output changes from fragments to ordinary MP4 on clean close.
This is a container-recovery experiment, **not real-time capture or text-quality
acceptance**. No UI, browser or input engine participates.

| Container flags | Readable before stop | Frames after clean stop | Frames after encoder kill |
| --- | --- | --- | --- |
| `+faststart` | No | 180 | Unreadable; missing final metadata |
| `+frag_keyframe+empty_moov+default_base_moof` | Yes | 180 | 120 |
| Above plus `+hybrid_fragmented` | Yes | 180, ordinary MP4 | 120 |

The retained prefix is not the whole recording: buffered encoder frames and the
unfinished fragment can be lost. The tests do not establish power-loss durability,
ENOSPC behavior, player compatibility or cleanup when the supervising host dies.
At the time of this experiment the browser recorder used `+faststart`. The new
continuous path uses the tested fragmented output; native postprocessing still
uses ordinary MP4.

FFmpeg documents fragment recovery and the hybrid finalization option in its
[MP4 muxer documentation](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv).
The exact shipped binary also reports `hybrid_fragmented` in its muxer help.
The implementation deliberately retains fragments on clean close too, avoiding
an in-place hybrid conversion that could damage the prefix during finalization.
It verifies the output before renaming the working file. Hybrid conversion remains
an unadopted option, not a new dependency or a required second encode.

The existing `test-control-recording-stream.ts` also passes: static duration is
correct within one output frame, 81 dense frames avoid rendered-PNG staging, and
a failed encoder is reaped. Those checks protect the prior fix; they do not cover
continuous capture-time encoding.

Evidence: ignored `docs/audits/2026-09-24/media-continuity/`, including the result,
videos, source hashes and upstream review. The tracked script allows reproduction
without those machine-local artifacts. Encoder SHA-256:
`68546ffbbdcc5489706336e3b6038f7815c61ccae487a0912eea5193df519f7b`.

## Corrections from the upstream review

Continue with **Selkies as a complete isolated-Linux comparison** and **pixelflux
as a component experiment**, not a ready replacement recorder. The canonical
repository is now `selkies-project/pixelflux`; the reviewed commit remains
`40a9d46ba9b8c137b9812825041c68977ddf615f`.

The two pixelflux recording paths behave differently:

- The [Unix socket tap](https://github.com/selkies-project/pixelflux/blob/40a9d46ba9b8c137b9812825041c68977ddf615f/pixelflux/src/recording_sink.rs#L35)
  shares encoded bytes and disconnects a slow recorder after its 256-frame queue
  fills. That is a frame-count bound, not a byte/age budget. It strips source
  timing, can end mid-write, and logs a socket-bind failure without a readiness
  acknowledgment. A Mako adapter needs structured startup/termination results and
  timestamped packets, not an unqualified elementary stream.
- The [built-in MP4 recorder](https://github.com/selkies-project/pixelflux/blob/40a9d46ba9b8c137b9812825041c68977ddf615f/pixelflux/src/recorder/mod.rs#L290)
  counts queue drops and continues writing dependent H.264 frames. Its IDR gate
  runs only at initialization. It assigns delivery-time timestamps, writes codec
  configuration once and starts a separate X11 capture/encode. Later capture
  failure does not reliably become recording failure. These are source findings;
  corruption has not been reproduced dynamically here.
- The [MP4 writer](https://github.com/selkies-project/pixelflux/blob/40a9d46ba9b8c137b9812825041c68977ddf615f/pixelflux/src/recorder/mp4.rs#L534)
  retains every sample duration and sorts a copy at stop. That metadata cost is
  small compared with Mako's JPEG staging, but its buffering is not entirely
  constant-size. Its parser accepts changed SPS/PPS without updating the file's
  initial sample description; resize/reconfiguration needs a segment boundary
  or a verified fixed-geometry policy.

Selkies has useful dependency-aware viewer recovery, but its native callback
schedules frames onto asyncio **before** the bounded viewer relay handles them.
Test an event-loop stall at that handoff; a downstream queue bound alone is not
proof of bounded memory. [Pinned callback](https://github.com/selkies-project/selkies/blob/3a46db7d58e4bddf2dd1f031ee9577720545e8ab/src/selkies/websockets_mode.py#L5526).

For the component prototype use a supervised Python process calling the existing
PyO3 API. Extracting a maintained Rust library is a later choice if the experiment
justifies it. Pixelflux's import hooks can start its own computer-use HTTP server
or recording from environment variables. Give the helper an explicit environment;
leave `PIXELFLUX_CU` and `PIXELFLUX_RECORD*` unset. It receives media authority only.
[Import hooks](https://github.com/selkies-project/pixelflux/blob/40a9d46ba9b8c137b9812825041c68977ddf615f/pixelflux/src/lib.rs#L8223).

Full Selkies also brings audio, Python/WebRTC and web-client dependencies.
Pixelflux's default wheels include GPL codec libraries; a non-GPL build flag does
not change an already built wheel or a GPL-enabled system FFmpeg. Record actual
artifacts, linked libraries and notices before adoption. Source-tree size and
crate counts are not installed-size measurements. [Upstream inventory](https://github.com/selkies-project/pixelflux/blob/40a9d46ba9b8c137b9812825041c68977ddf615f/LICENSES.md).

Moonlight stays the native-viewer comparison. Its [pacer](https://github.com/moonlight-stream/moonlight-qt/blob/032529d782242e3833e0b3b147dbbf96e878e3ca/app/streaming/video/ffmpeg-renderers/pacer/pacer.cpp#L332)
bounds decoded frames and retains GPU resources until presentation work can finish.
Sunshine's [PipeWire path](https://github.com/LizardByte/Sunshine/blob/c48e50e418b27cba2b387c3a1ae9605da8a96341/src/platform/linux/pipewire.cpp#L617)
also shows why GPU availability alone is insufficient: source and encoder devices
may not share DMA-BUFs. Preserve a measured memory/software fallback. Neither
project supplies Mako's browser viewer or establishes a performance ranking here.

## Implementation order

1. **Continuous browser recording, R18/R21.** Keep `ControlRecording` and existing
   handles/ownership. Replace JPEG files with a supervised encoder worker, one
   in-flight frame and one newest pending frame. Start on verified source geometry;
   do not wait until stop. Write a recoverable video and append bounded metadata
   batches during capture. Preserve the current timeline contract or explicitly
   version/migrate its consumers. Stop must be idempotent, bounded and produce a
   verified prefix plus a precise interruption reason after failure.
2. **Timing and cursor correctness.** Carry source time, host receipt time,
   clock domain, sequence and target generation separately. Preserve dispatch
   timing for the cursor, not action completion timing. Do not feed irregular
   arrivals into a fixed-rate raw pipe and thereby shorten gaps. Use an explicit
   output clock or timestamped muxing; count source samples, deliberate repeats,
   sampling and loss separately. Test paused sources, late cursor events,
   clipped screenshots, resize and a clock reset. Static content is not a dead
   source; repeated output frames are not distinct captured frames.
3. **Remove native redundant work, R19.** Directly retain a validated native video
   when cursor/size/format require no transform. Then compare source-side cursor
   composition and hardware encoding with today's postprocessor. Keep event-post
   coordinates and independent screenshots unchanged. Browser JPEG capture and
   native encoded capture need different internal inputs to the same recording
   owner, not separate agent APIs.
4. **Binary preview delivery, R20.** First preserve exact JPEG bytes while removing
   base64 JSON/compression and repeated generic RPC from the viewer path. Use a
   task-authorized subscription with a bounded latest-frame slot and teardown on
   generation/lease loss. Keep activity metadata separate. Compare decoded pixels,
   frame age, input latency and one/two-viewer CPU/bytes before changing codecs.
   Share one encode only when size, quality, timing and cursor composition match.
5. **Isolated Linux prototype.** Lock source revisions, build dependencies and
   base images. Reuse existing ARM64 fixtures; do not create an image for every
   trial. Start one full-frame H.264 CPU encode at 1080p/60, no audio, then compare
   Selkies WebSocket/WebCodecs and WebRTC at equal quality/network conditions.
   Establish server-enforced viewing-only access first; hiding input controls is
   insufficient. Route actions through Mako. Run pixelflux separately to measure
   the helper's package/startup/lifecycle cost. Native x64 and GPU measurements
   require matching hardware; emulation cannot certify them.
6. **Matched Sunshine/Moonlight run.** Use the same isolated desktop, workload,
   codec/chroma and network with the native viewer. Measure visible markers and
   input-to-visible latency from one observer clock. Label the different viewer;
   separate capture, encode, transport and presentation costs before selecting
   what to reuse. Standard VNC remains an optional adapter, not an internal format.

No public API needs codec, thread, packet or queue tuning knobs for this work.
The TypeScript engine owns lifecycle and receipts; capture/encode helpers own
platform mechanics. MCP, SDK and CLI keep the same target and recording handles.

## Gates before shipping

Run the existing installed Aside workflow again, then at least 60 seconds of
moving/text/input content and a ten-minute recording soak. The user accepts roughly **56 distinct fps at 1920×1080**, with 60 as the target. The shared audit uses a 55 fps minimum and separately rejects half-second freezes; publish actual gaps and never substitute encoded fps for motion. Exact screenshots remain independent.

Include one viewer, two viewers plus recording, idle content, delayed consumers,
source/encoder/host exits, reconnect, cancellation during start/stop, ENOSPC,
target closure, changed geometry and small colored text. After encoded loss,
either stop the recorder with a verified prefix or resume at a fresh decodable
boundary and record the gap. Never quietly append dependent frames after loss.

Measure each process, including browser, encoder and viewer; prior Node/Electron
figures excluded some of those costs. Report memory growth, source/queue age,
input-to-visible p50/p95, copied/wire bytes, startup and installed bytes per target.
Do not choose a faster preset by sacrificing text/cursor accuracy without a
matched quality comparison. CPU-only Linux remains a required case.

The full Selkies viewer-only configuration, dependency lock, native x64 test host
and GPU matrix are still unprepared. No cloud resource, new container image,
desktop takeover or remote debugging connection was created in this review.
