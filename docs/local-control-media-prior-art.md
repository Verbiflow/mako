# Lightweight media: implementation review and encoder probes

September 25, 2026. Evidence for [Wayfinder LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).
Research and small component experiments only; no production encoder, native
binary or installed package changed in this investigation.

## What the other products establish

### Replicas

The [September 17 engineering article](https://replicas.dev/blog/faster-smoother-computer-use)
describes replacing whole-frame FFmpeg capture with a custom Go capture process,
unchanged-region reuse, less idle work, native conversion/encoding, shared encode
work and WebRTC. C, Go and Rust experiments performed similarly; maintainability
drove the language choice. Its published browser-viewer result is 55.7 distinct
fps at 1080p. Absolute encoder CPU/RAM and simultaneous-recording overhead are
not published. This supports removing unnecessary work, not a TypeScript-to-Go
rewrite or an assumption that WebRTC alone lowers encoding cost.

The older July article's rejection of a tested H.264/WebCodecs pipeline is not
their current transport decision. Preserve the newer source's date and scope.

### Capy

[Official machine documentation](https://docs.capy.ai/machines) confirms Ubuntu
VMs, Chrome and a live desktop view; the agent loop runs separately on Capy's
servers. The smallest machine has one vCPU and 4 GB RAM. These allocations are
not measured streaming overhead.

A [founder post](https://x.com/justinsunyt/status/2097146246918234538) claims a
custom Rust remote desktop optimized for 1080p60 on one-vCPU VMs. X returned 403;
the claim was recovered from an indexed mirror, not independently verified.
No public current codec, capture implementation, resource breakdown or matched
recording benchmark was found. The older Scrapybara OSS x11vnc/noVNC sample is
explicitly simplified and must not be substituted for current Capy internals.
Keep efficient CPU-only Linux operation as a requirement; don't infer that Capy
achieves it with a GPU, a particular codec, or a publicly reusable library.

### Tembo

The current [sandbox inventory](https://docs.tembo.io/features/sandbox/built-in-skills-and-tools)
lists Selkies `2.0.0-dev-20260822` and FFmpeg 7.1.1, and documents recording commands
for desktops and selected windows. Its [September announcement](https://www.tembo.io/blog/announcing-tembo-computer)
claims a 60fps desktop. Neither source gives encoder configuration or equivalent
CPU/RSS measurements. The May KasmVNC announcement is historical, not proof of
the current stack. Our Selkies/pixelflux prototype is therefore relevant prior
art; copying all of Tembo's desktop dependencies is not warranted.

### Synara

Reviewed revision `85a1717fada435bd57d45b68bb65f1257ebf454f`. Three paths differ:

- The embedded browser displays a native Chromium view. Its collapsed thumbnail
  is a 640px JPEG, not a 1080p60 stream.
  [Browser source](https://github.com/Emanuele-web04/synara/blob/85a1717fada435bd57d45b68bb65f1257ebf454f/apps/desktop/src/browserManager.ts#L2183-L2206).
- Computer preview uses ScreenCaptureKit with a 960px maximum dimension, 15fps
  and JPEG quality 0.7. This is a different workload from Mako's acceptance target.
  [Frame tap](https://github.com/Emanuele-web04/synara/blob/85a1717fada435bd57d45b68bb65f1257ebf454f/apps/desktop/native/appsnap/ComputerFrameTap.swift#L29-L145).
- The iOS Simulator path is directly useful: framebuffer damage callbacks,
  IOSurface-backed pixel buffers, VideoToolbox H.264, realtime/no frame reordering,
  bounded queues and encoded delivery. It avoids an application-managed RGBA pipe.
  Hardware is not required or verified (`encoderSpecification:nil`). Its simulator
  capture access is not a general Mac window or external Chromium-tab API.
  [Native stream](https://github.com/Emanuele-web04/synara/blob/85a1717fada435bd57d45b68bb65f1257ebf454f/apps/server/native/device-helper/Sources/FrameStream.swift#L245-L423).

It also [stops encoding when the last viewer leaves](https://github.com/Emanuele-web04/synara/blob/85a1717fada435bd57d45b68bb65f1257ebf454f/apps/server/src/device/DeviceManager.ts#L519-L539)
and [resynchronizes slow encoded subscribers at keyframes](https://github.com/Emanuele-web04/synara/blob/85a1717fada435bd57d45b68bb65f1257ebf454f/packages/shared/src/frameTransport.ts#L183-L209).
For Mako, an active recorder must also count as a consumer. No matched simulator
recording CPU/RAM benchmark was found; transcript-animation savings are unrelated.

### T3 Code

Reviewed revision `13d6b30515e9d44bb4cc2d223b8b3179c2ba4c79`. Interactive viewing
uses an embedded Chromium page; PiP separately uses 12fps JPEG screenshots.
Actual recording uses Chromium media capture and MediaRecorder, default 30fps
with 60fps configurable. Optional cursor/key decorations insert a canvas pass;
they are off by default. Hardware use and 1080p60 resource costs are not proven.
[Recorder](https://github.com/pingdotgg/t3code/blob/13d6b30515e9d44bb4cc2d223b8b3179c2ba4c79/apps/web/src/browser/browserRecording.ts),
[compositor](https://github.com/pingdotgg/t3code/blob/13d6b30515e9d44bb4cc2d223b8b3179c2ba4c79/apps/web/src/browser/recordingCompositor.ts).

Its Electron [capture grant](https://github.com/pingdotgg/t3code/blob/13d6b30515e9d44bb4cc2d223b8b3179c2ba4c79/apps/desktop/src/preview/Manager.ts#L3478-L3501)
answers only the armed requesting frame with the owned guest's `mainFrame`.
That mechanism does not give an external browser extension the same authority.
Also don't copy the recorder's growing `Blob[]`/whole-file ArrayBuffer save path:
Mako needs incremental bounded disk writes and crash-safe partial results.

## Immediate findings in Mako

`recording-encoder-process.ts` selects x264 `fast`/CRF18, automatic encoder
threads and no low-delay tuning. `scripts/build-control-media.mjs` explicitly
enables only libx264/PNG encoders; it does not compile VideoToolbox support.
The runtime receives full RGBA frames at a constant output clock even when pixels
repeat. Cursor changes can require another complete image composition. Caching
cursor artwork removes one cost but does not eliminate those full-frame passes.

There are two distinct opportunities: reduce buffering/work in the existing
encoder, and avoid reconstructing/piping full raw frames in the capture design.
Hardware encoding is useful on local Macs; a CPU-only Linux path remains required.

## Short, measured encoder probes

Same 240 rendered 1920×1080 RGBA frames: one real fixture JPEG plus moving cursor
and press ring, four seconds of content. Same existing system FFmpeg binary for
all cases, single conversion thread, fragmented MP4. Software baseline ran before
and after hardware tests. Low-delay software ran separately. No live desktop,
cloud deployment or bundled-binary acceptance is implied.

| Encoder/configuration | Peak encoder-process RSS | Sampled encoder CPU seconds | Video bytes |
| --- | ---: | ---: | ---: |
| x264 fast/CRF18, automatic threads | 826–827 MB | 3.10–3.14 | 640,944 |
| VideoToolbox quality 80, realtime, no reordering, software fallback disabled | 257 MB | 1.08 | 776,072 |
| VideoToolbox quality 90, same constraints | 247 MB | 1.07 | 1,520,791 |
| x264 fast/CRF18, zerolatency, four threads | 102 MB | 2.75 | 703,112 |

All outputs independently decode to 240 frames at 1920×1080 and four seconds.
Six sampled frames are compared with their exact pre-encoder RGBA, including a
fixed text region. Text mean-squared-error ranges: baseline 2.718–4.650; hardware
80: 2.225–2.553; hardware 90: 1.024–1.040; low-delay software 2.280–3.884. There is
no sampled text regression; this does not prove quality for scrolling, animation,
all fonts/colors or every frame. Quality numbers from different encoders are not
equivalent settings. Higher hardware quality uses substantially more bytes.

These are short capacity probes, not sustained 60fps claims. CPU counters sample
process time; OS media-service/GPU costs are excluded. The hardware path still
does CPU JPEG decode, cursor composition, raw piping and pixel conversion. The
software test changes both tuning and thread count, so savings cannot be assigned
to either alone. A prior two-thread real-workload test failed despite a promising
microbenchmark: do not ship these settings from this probe alone.

Evidence and reproduction scripts:
`docs/audits/2026-09-25/media-prior-art/` (ignored, with hashes and fixture image).
Those initial probes made no production changes. The subsequent Mac implementation
is tracked in [hardware recording](local-control-mac-hardware-recording.md).

## Changes to investigate, in order

1. **Implement and validate Mac hardware encoding now (user decision, September 25).**
   Use a reviewed VideoToolbox-enabled package, require hardware admission and
   preserve the shared recording API. Include saved text/cursor quality, sustained
   resources, OS service cost and interruption cleanup. Native buffer capture can
   follow; hardware encoding alone still leaves CPU image decode/composition.
2. **Define the cloud-agent environment before its streaming implementation.**
   Specify Linux display/compositor, CPU/GPU, isolation, network and lifecycle.
   Then choose its backend using the preserved software, Selkies/pixelflux and
   Moonlight evidence. Keep current Linux recording behavior until that decision.
3. **Encode only new visual information.** Damage-driven capture where available;
   otherwise suppress exact repeats early. Preserve presentation timestamps and
   recording duration without resubmitting an unchanged full image 60 times/s.
   Don't treat a quiet desktop as a broken connection. Keep cursor-only updates
   separate for preview; recordings must preserve cursor/action timing.
4. **Use native media buffers when the target permits it.** Electron-owned pages
   can explore T3's model. Native Mac windows can use ScreenCaptureKit/VideoToolbox.
   Isolated Linux desktops can use the measured damage-aware component candidates.
   Regular Aside/Chromium tabs need their own authorized design: Chrome's
   [tabCapture rules](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
   require an extension invocation/activeTab grant. No silent activation, personal-
   profile replacement or switch to whole-window capture.
5. **Share encoding, not authority.** One producer per compatible target/quality
   configuration; recorder and viewers consume its encoded packets. Persist video
   incrementally without a second encode when settings match. Handle codec and
   geometry changes, late subscribers, missing keyframes and slow consumers.
   Cursor/decorations may prevent reuse; don't drop them silently. Exact agent
   screenshots remain independent and lossless. All adapters stay under Mako's
   current typed session/target ownership; no third agent-control system.

Acceptance must include active and idle CPU, encoder and full-process memory,
OS/GPU cost where relevant, distinct frames/gaps, click-to-visible latency, source
text accuracy, bitrate, long recordings and overload. Propose numeric resource
budgets from sustained measurements; the old two-core/1-GB result is not acceptable
merely because it reaches the frame-rate target.
