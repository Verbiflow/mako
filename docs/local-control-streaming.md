# Local Control interactive streaming

Shared ownership, observability and refactor gates: [architecture contract](local-control-architecture.md).

Design and acceptance notes, 2026-09-23. Current implementation status and priority
live in [wayfinder LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).
This document adds experiments and completion checks, not a claim that a new
streaming transport or human-takeover feature is implemented.

The [September 25 lightweight-media review](local-control-media-prior-art.md) adds
current Capy/Tembo evidence, source-reviewed Synara/T3 implementations and measured
hardware/low-delay software encoder probes. These are not adopted backends.

## Reference and what it establishes

Saai Arora's [September 18 X post](https://x.com/SaaiArora/status/2101017068724457569)
links an article also published on the [Replicas site, September 17](https://replicas.dev/blog/faster-smoother-computer-use).
X's public syndication metadata confirmed the article identity; the publisher's
full text and the benchmark image were inspected. The publisher is the source
for the claims below, not an independent benchmark.

Replicas reports WebRTC audio/video, shared encoding, bounded queues, unchanged-
region reuse and reduced idle work. Its published viewer results are 55.7 distinct
frames/s, 29.3 ms p95 frame gap and 127.4 ms median click-to-visible at 1920×1080.
Competitor resolutions differed, and instrumentation initially affected a viewer.
C/Go/Rust variants reached roughly 60 updates/s; maintainability motivated Go.
A browser-task example reduced calls from 45 to 22, with unequal provisioning waits.

This supersedes using the [July article](https://replicas.dev/blog/making-the-agents-computer-feel-local)
as a description of their current transport. Its rejected WebCodecs experiment
was a result for that tested pipeline, not a general rejection of WebRTC.
Neither article proves Mako needs Go, a particular codec, or a new agent runtime.

## September 24 selection: browser streaming, Moonlight and VNC

Recommendation: prototype **Selkies/pixelflux for the isolated Linux desktop**,
compare its WebRTC and binary WebSocket modes, and use **Sunshine/Moonlight as the
native-client performance reference**. For the local Mac, retain ScreenCaptureKit
and evaluate VideoToolbox encoding; for exact Linux windows, retain the portal
window-grant boundary described in the [capture backend review](local-control-capture-backends.md).
These are backend choices under the same session engine. No candidate has been adopted. The September 24 isolated prototype below now
measures capture and a browser viewer, using Mako’s SDK to drive the test browser.

The [continuous-media investigation](local-control-media-investigation.md) adds
the shared-runtime continuous recorder, packaged FFmpeg crash evidence and the
remaining implementation sequence. Browser recording no longer accumulates
source JPEGs. [Binary preview delivery](local-control-preview-binary.md) is now local; Linux capture loops remain. The investigation also
corrects the distinction between pixelflux's two recording
paths below. No streaming stack has been adopted.

Fast desktop streaming has mature implementations. Continuous browser encoding
now removes source-image staging. Local preview packets preserve exact binary image bytes; installed delivery and Linux PNG capture loops remain work. A transport replacement alone still cannot provide
frames from a stalled source, identify the correct window, or make unknown input
safe to repeat.

| Candidate | Evidence and fit | Decision |
| --- | --- | --- |
| [Moonlight Qt](https://github.com/moonlight-stream/moonlight-qt/tree/032529d782242e3833e0b3b147dbbf96e878e3ca) + [Sunshine](https://github.com/LizardByte/Sunshine/tree/c48e50e418b27cba2b387c3a1ae9605da8a96341) | Moonlight is the native GameStream client; Sunshine is the capture/encoding host. Hardware decoding, multiple video codecs and 4:4:4 are documented. The reviewed Qt pacer bounds its render/pacing queues and drops excess decoded frames. | Strong native-viewer benchmark and implementation reference. Qt/GameStream is not an embeddable web viewer, WebRTC implementation or VNC endpoint. Measure before claiming it is the fastest. |
| [Selkies](https://github.com/selkies-project/selkies/tree/3a46db7d58e4bddf2dd1f031ee9577720545e8ab) | Browser viewer and Linux session streaming; native capture/encoding through pixelflux. The reviewed WebRTC pipeline keeps monotonic media timestamps across capture restarts and starts only requested media. Current default is WebSocket/WebCodecs, with WebRTC opt-in. | First complete browser-viewer prototype. Compare both transports on the same source, codec, quality and network. Do not call WebSockets inherently slow or WebRTC automatically faster. |
| [pixelflux](https://github.com/linuxserver/pixelflux/tree/40a9d46ba9b8c137b9812825041c68977ddf615f) | Rust/PyO3 capture/encode component with damage-aware paths, software/hardware encoding and encoded recording output. Its `recording_sink.rs` uses shared encoded buffers and bounded nonblocking per-recorder queues. | First component-reuse investigation. Its published crate is a Python `cdylib`, not a ready Node/Rust library dependency. Compare a supervised helper with a maintained native library boundary; include runtime/package cost. Its portal code requests **monitors**, not exact windows. Do not substitute that route on the user's desktop. |
| [KasmVNC](https://github.com/kasmtech/KasmVNC/tree/e9d297b4defd50d6a46d4ef1d04d443125350b72) | Web desktop stack; current source includes software/hardware video encoding alongside rectangle encoders. Upstream explicitly says it is not standard RFB-compatible. | Second integrated cloud candidate if Selkies fails the measured quality, cost or lifecycle gates. Do not claim ordinary VNC clients work because VNC is in its name. |
| [TigerVNC](https://github.com/TigerVNC/tigervnc/tree/dd416cbfa2023ffcdd3bd23d90ce8254b3faf627) + [noVNC](https://github.com/novnc/noVNC/tree/acca57b997f206683d27796829ee1f72da37002a) | Standard VNC server/client family and browser RFB client. noVNC needs a WebSocket endpoint or a WebSocket-to-TCP proxy. | Compatibility route if ordinary VNC access is required. Benchmark separately; neither universal 60 fps nor poor performance follows from the VNC label alone. |

Pixelflux demonstrates continuous encoded recording, but its two sinks have
different limits. The Unix socket tap disconnects slow recorders; the built-in
H.264 MP4 recorder counts queue drops and continues without a post-loss keyframe
gate. The latter uses delivery timestamps, writes one initial codec configuration
and starts a separate X11 capture. Add explicit readiness, discontinuity handling,
geometry/configuration boundaries and interruption status before reuse.
[Pinned findings and required tests](local-control-media-investigation.md#corrections-from-the-upstream-review).
Reuse an encode only when dimensions, quality, timestamps and cursor composition
match. After encoded-frame loss, recover at a decodable boundary/keyframe; dropping
arbitrary dependent video packets is not equivalent to dropping independent JPEGs.
A slow recorder must receive an explicit interruption and playable partial artifact,
not quietly corrupt video or block interactive input.

The Replicas article identifies a custom Go capture process plus native pixel
conversion/encoding, WebRTC, shared encoding, unchanged-region reuse, bounded
queues and independent recovery. It does **not** identify Moonlight, Selkies or a
specific publicly reusable implementation. Its 55.7 displayed fps, 29.3 ms p95 gap
and 127.4 ms median click-to-visible are publisher measurements with network and
different competitor resolutions; they cannot rank Mako without a matched test.

### September 24 isolated prototype measurements

The pinned Selkies/pixelflux experiment reuses an existing ARM64 container image,
private Xvfb desktop and headless Chromium. Software H.264, 1920×1080, CRF 18,
60 requested fps, four-CPU/2 GiB limits; one measured minute per viewer. The
independent marker reader examines decoded pixels, not server callback counts.
No new image was built/pulled, and no upstream dependency entered Mako's package.
[Fixture and contributor setup](../scripts/linux-control/README.md#isolated-streaming-comparison).

| Viewer | Distinct fps | p95 / maximum frame gap | Approx. whole-container cores | Peak cgroup memory |
| --- | ---: | ---: | ---: | ---: |
| Binary WebSocket | 54.60 | 33.1 / 65.2 ms | 1.34 | 1.68 GB |
| WebRTC | 53.30 | 33.5 / 149.8 ms | 1.23 | 1.54 GB |

Both have zero invalid marker samples and no sampler errors. Cgroup memory
includes file/page cache and all fixture processes, not just resident encoder
memory. CPU includes GTK, capture, encoding, server, Chromium and instrumentation;
resource reads can include up to one extra polling interval. These are separate
single runs on a shared Mac VM, not statistical superiority or a remote-network
comparison. Neither reaches the ordinary 55 fps floor. The results support further
component evaluation; they do not justify replacing Mako's transport wholesale.

The capture/encoder component reached **58.41 distinct fps (4:2:0)** and
**58.34 (4:4:4)** after independently decoding the saved H.264 streams. Both had
zero invalid markers. Raw callback counts exceeded 60 because they include extra
paint-over output; those counts are not distinct motion. Capture plus GTK used
0.45 / 0.55 CPU cores, with 181 / 216 MB peak process RSS. Encoded output averaged
221 / 301 kB/s on this deliberately small changing-region fixture.

Colored 14px text is materially clearer in 4:4:4: sampled RGB mean absolute error
fell from 4.66 to 0.60 levels out of 255, and PSNR rose from 29.07 to 47.30 dB
against GTK's source screenshot. Neither is lossless. The extra chroma accuracy
cost about 36% more encoded bytes and 23% more component CPU in these single runs.
Do not select 4:2:0 solely for its rate or cost. Preserve exact screenshots for
agent observations, and validate browser/hardware 4:4:4 decoding before choosing
that stream format. The three-second post-animation tail still emitted roughly
19–23 fps, so this experiment does not establish negligible idle cost.

The first WebRTC run negotiated H.264 but delivered no frames with `network=none`.
A private internal bridge supplied a non-loopback ICE interface; the corrected
run connected and had zero reported RTP packet loss. No external route or host
port was published. Retain the failed setup as evidence, not a transport result.

Upstream integration issues are concrete:

- The view-only WebSocket gate rejects `CLIENT_FRAME_ACK`, although the upstream
  viewer sends it. The one-minute run logs those denials repeatedly. Flow-control
  telemetry needs a permitted read-only message path before reuse.
- Startup reports missing realized display/backpressure state. Video starts, but
  this is not evidence that reconnect/backpressure behavior is correct.
- Even with gamepads, clipboard, file transfer, audio and commands disabled, the
  server initializes virtual gamepad sockets and attempts an upload directory.
  Keep input authority in Mako; evaluate a media-only helper instead of importing
  an entire second desktop-control system.

The staged pixelflux wheel is 24.03 MB / 52.47 MB unpacked; the full Selkies Python
stack adds about 87 MiB. Its official wheel includes GPL-enabled codec libraries.
Dependency selection, notices, size and lifecycle remain adoption gates, not new
production requirements. Browser decoder compatibility and text quality also
need to govern 4:4:4 selection; capture support alone is insufficient.

Sunshine/Moonlight remains the native-viewer comparison, not a measured winner.
This CPU-only headless browser fixture cannot establish GPU/native-client latency.
Still required: a matched native-viewer host, hardware encoding, network latency/
loss/reconnect, multi-viewer sharing, Mako ownership integration and exact-window
Wayland grants. Preserve the standard VNC compatibility boundary below.

Evidence: `docs/audits/2026-09-24/streaming-prototype/` (ignored media/results),
including `selkies-ws-final`, `selkies-webrtc-final` (failed no-interface setup),
`selkies-webrtc-internal` and each independent `analysis.json`.

### Transport and cloud compatibility contract

- Preferred experiment: full-frame H.264 over WebRTC for remote browser viewing,
  with hardware encoding/decoding where verified and an explicit software path.
  Compare full-frame H.264 over binary WebSocket/WebCodecs on the same fixture.
  The first codec is a compatibility baseline, not a permanent codec restriction.
- Local viewers should avoid network signaling/relay work where a direct local
  media path works. Remote tests cover direct UDP, relay, TCP-only networks,
  latency/jitter/loss and reconnect. A deployment may need STUN/TURN; account for
  relay bandwidth and do not advertise an unreachable media endpoint.
- VNC is an optional compatibility adapter to the **same isolated job desktop**,
  not the required internal media format. Whether ordinary VNC clients are a
  release requirement is awaiting user clarification. Until resolved, design for
  the adapter but do not bundle or start it by default.
- Viewing grants do not grant input. If interactive VNC/human control is enabled,
  its input path must join the same target ownership/takeover policy. A server
  injecting events beside the engine would bypass that policy. Read-only viewing
  can be evaluated now; full human takeover remains deferred.
- Agent browser commands, native semantic input and exact screenshots still use
  Mako's engine near the target. Agent calls and frame bytes do not route through
  one another. A cloud stream must not become a second automation API.

### Prototype decision gate

First run the existing moving/text/input fixture on an isolated Linux desktop
with Selkies/pixelflux, using pinned builds and no replacement of the user's local
browser or desktop. Compare WebRTC and binary WebSocket on CPU-only x64 and ARM64,
then available GPU hardware. Include a Sunshine/Moonlight native-viewer comparison
where the hardware supports it; record that its viewer differs.

Use the selected 1920×1080/60 target. The user accepts roughly 56 distinct fps; the current audit uses 55 fps as a minimum and separately rejects half-second freezes. Report actual rates and tails. Measure
at least 60 seconds plus a longer recording soak, source-to-viewer frame age,
frame-gap and input-to-visible p50/p95, missed/duplicate input, small colored text,
cursor accuracy, bandwidth, idle/active CPU, memory, startup and installed bytes.
Run one/two viewers with recording, bounded slow consumers, encoder failure and
reconnect. Test 4:2:0 text quality against 4:4:4/lossless references; do not reduce
explicit screenshot fidelity to improve video numbers. Publish actual performance
and all failures. Adopt the smallest integration that passes, not every project.

Source review copies and revision metadata are in ignored
`docs/audits/2026-09-24/streaming-selection/`. Repository licenses differ:
Moonlight/Sunshine GPL-3.0, KasmVNC/TigerVNC GPL-2.0, Selkies/pixelflux MPL-2.0,
noVNC primarily MPL-2.0 with exceptions. Codec/build dependencies need their own
inventory: for example pixelflux defaults to its GPL encoder feature. No project
or codec dependency was added to the shipped package during this review.

## What the Mako inspection shows

- [BrowserCapture](../packages/control-runtime/src/browser-capture.ts) already shares one CDP stream
  per attachment and ACKs independently of consumers. It receives complete JPEG
  frames; this is not an unchanged-region capture/encode implementation.
- [ControlPreviews](../packages/host/src/control/previews.ts) bounds delivery to the newest
  frame, scopes watchers and stops unused subscriptions. Passing full base64 JPEGs
  now uses bounded binary packets locally; installation and sustained resource accounting remain open.
- [Renderer preview state](../src/state/control-preview.ts) shares native video
  capture between viewers. The [native component](../src/components/inspector/native-control-preview.tsx)
  consumes a local MediaStream; that is not a remote WebRTC service.
- [Recording](../packages/control-runtime/src/control-recording.ts) retains source frames and finalizes
  files separately. Preview presentation and recorded evidence have different
  lifetimes and quality requirements.
- The [local compositor audit](local-control-preview-evidence.md) now reads independent
  sequence/input markers from the production viewer's composited pixels. It exposed
  an async-image replacement failure, fixed with a bounded decoder that retains
  completed pixels. Local 1080p capture reaches ~59–60 distinct viewer frames/s;
  a separate-host socket comparison cuts response bodies by 32.86% with unchanged
  decoded pixels. Later CPU-instrumented results include a slower run; see the report.
  Installed Aside capture exposed a hidden-tab no-frame limitation. Installed
  runtime/MCP acceptance now passes; sustained installed-media, physical display
  and remote-network acceptance remain open.

Keep those existing ownership and bounded-work mechanisms. The experiments below
must show an improvement over them, not replace them with a second session engine.

## Accepted scope: one engine, multiple backends

User clarification, 2026-09-23: apply low-latency work to Local Control now,
including remote browsers. Do not wait for a managed cloud-agent environment or
build a separate third automation system. A full human-takeover product is deferred.

The harness continues to call the shared browser/computer API. Target/session
ownership, input validation, observation, screenshots, recording and cancellation
remain engine responsibilities. Live media is another output of that engine, with
backend-specific capture/encoding and a viewer transport. It does not own a second
set of targets, input commands or recovery rules.

| Execution case | Reuse | Backend-specific work |
| --- | --- | --- |
| Local Mac/browser | Main harness and existing bound app/window/tab API; current authorization and background policy. | Native Mac or extension/desk capture, efficient local delivery, exact-window boundaries. |
| Remote browser without a cloud-agent product | Same tab/session contract and explicit connection ownership. | Capture near the browser; send media to the viewer over the measured transport. Authenticate access; do not route frame bytes through model/tool responses or expose debugging publicly. |
| Future managed Linux cloud job | Same engine and harness-facing commands, using the existing standalone runtime as a building block. | Isolated desktop/profile, Linux capture/encode/input adapters and supervised worker lifecycle. Advertise additional verified capabilities rather than inventing a cloud-only public API. |

A remote browser is not necessarily a whole remote desktop. Its renderer, viewport
and attachment lifecycle remain browser-specific. Private Linux desktops can offer
broader capture/input than a regular Mac profile, but only through explicit target
capabilities. Faster transport never relaxes identity, foreground or outcome checks.
Capture/encoder workers may be separate processes for performance and fault cleanup;
they remain owned components of Local Control, not another automation service.

## Experiments in order

### 1. Measure the viewer before selecting a transport

Local browser baseline and regression command: `npm run audit:control-preview`.
Use `-- --baseline` to rebuild the old image renderer as a controlled comparison,
or `-- --two-viewers --recording` for concurrent consumers. The benchmark uses
isolated fixture windows and production capture/state/renderer code; it never
connects to a regular browser profile. [Results and scope](local-control-preview-evidence.md).

Build a synthetic page/app with an independently checkable animation sequence and
input-response marker. Observe the displayed sequence at the viewer, not only a
capture callback. A repeated image, hidden viewer or stalled source must not
inflate the displayed-frame count. Distinguish source, encoder, delivery, decode
and presentation timing; record clock domains rather than subtracting unsynchronized
machine clocks. Measure input-to-visible from a single observer clock where possible.

Retain at least these dimensions:

| Case | Measurements and correctness checks |
| --- | --- |
| Local Mac browser and native app | Displayed unique fps, frame-gap p50/p95/max, click/typing/scroll-to-visible p50/p95, exact received input and source/display dimensions. |
| Linux cloud viewed remotely | Same results plus RTT, jitter/loss, bandwidth and reconnect history. Record region and CPU/GPU/software-rendering setup. |
| Static, animated and dense scrolling content | Idle CPU/bandwidth, first update after input, sustained throughput, text/icon readability and memory growth. |
| One viewer, two viewers, recording, and combinations | Capture/encoder counts, incremental CPU/bytes, independent close/reconnect and unchanged artifact quality. |
| Hidden viewer versus hidden/minimized target | Explicit source availability, authorized capture scope, correct wakeup and no focus theft or invented frames. |
| Instrumentation enabled/disabled | Viewer-native counters and sampling overhead; reject a benchmark that materially slows one candidate. |

Use both a controlled equal-resolution run and each product/backend's ordinary
configuration. Warm and fresh sessions are separate. Separate provisioning/model
waits from input/rendering time. Start with the 1080p moving-content workload and
a 60-fps goal; then test higher-density text and real scrolling. Set supported
latency/resource budgets from measured baselines before claiming acceptance.
The external numbers above are comparison references, not universal SLA thresholds.

### 2. Compare transport and capture changes separately

Keep the current JPEG route as the measured baseline. Prototype a lower-overhead transport for an existing remote browser or isolated
Linux fixture, with WebRTC as a candidate, and evaluate efficient local delivery
separately. This needs a test endpoint, not a managed cloud-agent product.
Compare native/software encoding under constrained CPU; record dependency size,
cold start, encode/decode cost and text quality. Reuse existing Rust/native code
where practical. A new language or service needs an independently demonstrated
benefit and a maintained build story for every supported target.

A successful candidate must bound queues at capture, encode, transport and viewer,
drop superseded preview work and let input proceed without waiting for frame
encoding. A shorter input path must still pass the shared engine's authorization,
exact-target/lease checks, foreground policy and unknown-outcome handling. Neither
video metadata nor a browser data channel is permission to control a target.

For regular Chromium profiles, retain the extension transport. For native capture,
retain exact-window isolation. A whole-desktop streaming technique valid inside a
private cloud job cannot silently replace either boundary on the user's Mac.
Do not introduce remote debugging on the regular profile to make a prototype pass.

### 3. Reduce unchanged work without losing state

Investigate backend-supported damage/dirty-region information before hashing or
re-encoding every pixel at full rate. Preserve unchanged pixels only within the
same target generation and geometry. Navigation, resize, scale/rotation, target
change and loss of trust require a verified fresh base frame. Never retain regions
from another app/window or claim that old pixels describe a new target.

When content is idle, reduce capture/conversion/encode work while preserving an
independent liveness signal and prompt first-frame response after input. Reconcile
cursor motion and overlays with region reuse. Distinguish intentional preview
sampling from source/transport/storage loss in diagnostics.

Share capture and compatible encoding across authorized viewers of the same
target/generation. Closing a slow viewer must not stop another viewer or recording.
Different quality requirements may require separate encodes; count and report them.
A recording can retain a faithful source even when the live preview adapts to a
weak network. Do not silently reduce explicit screenshot or saved-evidence fidelity.

### 4. Recover only the failed component

Model at least idle, viewer-hidden, source-not-painting, source-unavailable,
transport-disconnected and target-ended separately. These are proposed states;
they must be supported by actual backend evidence, not guessed from absent frames.
A still desktop does not by itself justify tearing down a healthy connection.
A live connection does not establish that source pixels are current.

Test sleep/wake, hide/show, network interruption, joining/leaving viewers, worker
restart, extension reload, resize and target closure. Media reconnection must not
restore an expired input lease, silently retarget a window or replay input.
Preserve healthy consumers and recording where the backend permits it. On genuine
source loss, keep explicit interruption/partial-artifact reporting. The existing
no-first-frame refusal remains until a better supported readiness contract exists.

## Human takeover: deferred

The user clarified that low-latency agent use and viewing come first, including
remote browsers; full human-control features need not be enabled now. The earlier
question about explicit takeover versus automatic pause or interleaving is therefore
deferred, not answered in favor of one policy. It blocks none of the work above.

If interactive human control is later scheduled, resolve same-target input ownership
before implementation. Then define in-flight/queued actions, held-key/button cleanup,
viewer disconnect, lease expiry and recording attribution. Explicit target-scoped
takeover remains a recommendation, not an accepted decision. Physical input in
another local app must remain distinct from taking over the agent's target.

## Audio scope

The reference carries audio; Mako recording currently does not. Treat streamed
output audio and recorded audio as distinct optional capabilities with explicit
source scope, mute state, synchronization and cleanup. A future output-audio path
must not implicitly capture the microphone or unrelated applications. Audio is
a deferred capability expansion, not a prerequisite for the current low-latency
video work or inferred permission to start capture now.

## Agent API and CLI implications

Short scripts, scoped semantic locators and explicit verification already match
the accepted design. Add a complete CLI script example and benchmark it against
separate commands through the same persistent engine. Report model/tool calls,
observations, retries, context bytes, exact outcomes and provisioning time separately.
Do not add automatic post-action trees or unverified bulk clicking merely to reduce
call count. A later batch failure must retain which earlier actions were dispatched;
no batch-wide retry after unknown input.

## How findings enter the wayfinder

LC-21 owns viewer measurements, media experiments, source efficiency and recovery.
LC-20/22 own script ergonomics and existing target/input ownership contracts. Human-takeover ownership remains
deferred. LC-25 supplies
isolated Linux acceptance, LC-26 owns package/dependency impact, and LC-27 owns
matched complete-job measurements. The [issue ledger](local-control-agent-issues.md)
tracks new gaps as R11–R14 and A12. No implementation or deployment status changes
merely because this plan or an external performance claim exists.

## September 25 delivery decision

Implement and validate Mac hardware encoding now, through the existing shared
session engine. Cloud Linux can use a different capture/encoder/transport backend.
Define the cloud-agent environment, including display, GPU availability, isolation,
network and lifecycle, before further cloud streaming implementation or adoption.
The Selkies/pixelflux and Moonlight findings remain evidence, not a selected dependency.
See [current delivery order](local-control-map.md#delivery-order).

## October 19: encode only the pixels a viewer draws

The browser preview spent 1.6 cores on one 288×162 card. Chrome encoded every
frame at 1920×1080, and the host decoded, scaled and re-encoded each one. The
screencast is now asked for the largest size any viewer draws, so Chrome's
compositor scales on the GPU and the host passes frames through. A recording or
full-detail read still takes full size. Measured with `audit-control-preview.mjs`:
55 → 60 fps, 1.62 → 0.72 cores in total, 0.63 → 0.12 on the host, capture to
publish 11 → 2 ms, click to visible 78 → 57 ms (median of five runs), at the same image quality
([V15](local-control-agent-issues.md#october-19-usage-audit)).

What Moonlight and Sunshine do, and where it applies to Mako:

| Moonlight/Sunshine practice | Local preview (same machine) | Cloud viewer (over a network) |
| --- | --- | --- |
| Stream at the client's resolution, never encode pixels it discards. | Done for browser previews. Native windows need nothing: their live preview is ScreenCaptureKit's zero-copy track, about 0.05 cores at any size, and a snapshot's thumbnail takes 54 ms at the viewer's size against 62 ms at full size (V19). | Done: the viewers' box sets the screencast size, which sets the encode size (below). |
| Hardware encode from GPU memory without a CPU copy. | Chrome's compositor already encodes the screencast; Mac recordings use VideoToolbox. | Use the GPU encoder where the job's machine has one; keep libx264 as the explicit software path. |
| No B-frames, no lookahead, small rate-control buffer; recover from loss with intra refresh or a requested keyframe rather than retransmitting. | Recordings use libx264 `zerolatency` (about one frame held instead of 47). | Done: `zerolatency`, no B-frames, and a key frame only when a viewer needs one, made by restarting the encoder on the newest frame. Over a reliable transport nothing is lost, so there is no intra refresh. |
| RTP over UDP with forward error correction; the client never waits on a lost packet. | Nothing to gain: there is no loss on a local socket, and the binary IPC path already delivers the newest frame only. | WebRTC is the browser's version of this: SRTP over UDP, NACK, FEC and keyframe requests, with congestion control. It needs TURN for networks that block UDP. |
| A frame pacer that drops late frames and keeps at most one queued. | The host already publishes the newest frame and drops the rest. | Done: the encoder takes the newest frame, at most two inside it; a viewer whose socket backs up skips to a fresh key frame instead of queueing. Lowering bitrate under congestion is not built. |

Cloud scaling follows from one rule: one encode per target, shared by every
viewer and the recording, running only while someone watches. A viewer then costs
packet fan-out, not an encoder, and each job's capture and encode run on the
job's own machine, so capacity grows with machines rather than with a central
transcoder. None of this changes the agent API: screenshots and observations stay
exact and never come from the video stream.

## October 19: live H.264 for remote viewers, measured on a cloud machine

A remote viewer of a cloud Thread's browser now has an engine: H.264 at 1–2% of
the JPEG bandwidth, at the same frame rate, first paint and click-to-visible
latency. It is measured on the machine cloud Threads run on. Its transport
through the gateway and the machine's own browser followed on October 20
(below).

**The engine.** [`BrowserVideo`](../packages/control-runtime/src/browser-video.ts)
subscribes to the tab's shared screencast, sized to the largest remote viewer
like every other preview, and runs one FFmpeg per target. The screencast's
JPEGs go in as streaming MOV (the recording's
[`MovVideoInput`](../packages/control-runtime/src/mov-video-input.ts), now with a
JPEG sample type), so there is no decode or pixel copy in Node. FLV comes out:
each tag carries its unit's length, its key flag and the `avcC` configuration,
so a unit is complete the moment it arrives. Each unit reaches every viewer as a
[`ControlVideoPacket`](../packages/control-runtime/src/contracts/control-video.ts):
a 24-byte header, then length-prefixed NAL units, which is what WebCodecs takes.
The renderer's [`ControlVideoPlayer`](../src/lib/control-video-player.ts) decodes
them.

- **Joining.** The viewer paints the newest frame at once, sent as it is (a
  poster). Then the encoder restarts on that frame, so the viewer's first key
  frame shows the current picture even while the page is still.
- **Falling behind.** A viewer whose socket holds more than 512 KB skips units
  until it drains. It then gets a key frame from the newest frame, at most one
  a second, since each costs a whole picture. Other viewers never wait for it.
- **Resizing and failure.** A new screencast size starts a new encoder.
  Three encoder failures in a row end the stream for its viewers.
- **Nothing held.** Each frame leaves the encoder 2–8 ms after it goes in, and
  21 ms for the first, including FFmpeg's start-up. One trap on the way:
  `-fflags nobuffer` makes FFmpeg discard the frame it reads while probing a
  pipe. That looked like every frame being held until the next one arrived,
  in every container and with every codec tried.

**Measured** from a Mac through the machine provider's port proxy to a cloud
machine of the size cloud Threads run on: 2 vCPU, no GPU, Debian
FFmpeg 5.1, libx264 `veryfast` `zerolatency` at CRF 23 with a bitrate cap. The
fixture is a 1920×1080 tab with 12 lines of text and blocks animating every
frame. The viewer is a hidden Electron window running `ControlVideoPlayer`, or
for JPEG, `createImageBitmap`. Both send the newest frame only, under the same
512 KB limit. Click to visible is timed on the viewer's clock, from sending a
click through the product `click` command to the clicked marker's pixel
flipping on the viewer's canvas, 12 clicks per run. Machine CPU is taken from
`/proc`, by process tree, over 8 s.

| Viewer box, cap | Format | Shown fps | Bandwidth | Encoding (cores) | Chromium (cores) | First paint | Click to visible p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 640×360, 30 | JPEG | 30.3 | 6.3 Mbit/s | — | 0.61 | 252 ms | 166 / 169 ms |
| 640×360, 30 | H.264 | 30.1 | 0.11 Mbit/s | 0.08 | 0.60 | 166 ms | 132 / 134 ms |
| 1280×720, 30 | JPEG | 30.1 | 17.2 Mbit/s | — | 1.10 | 199 ms | 133 / 146 ms |
| 1280×720, 30 | H.264 | 30.1 | 0.13 Mbit/s | 0.20 | 1.02 | 219 ms | 132 / 162 ms |
| 1280×720, 30, two viewers | H.264 | 30.3 | 0.13 Mbit/s each | 0.21 | 1.04 | 279 ms | 133 / 137 ms |
| 1280×720, 60 | H.264 | 59.8 | 0.17 Mbit/s | 0.38 | 1.03 | 199 ms | 132 / 135 ms |
| 1280×720, 60 | JPEG | 59.8 | 34.2 Mbit/s | — | 1.05 | 195 ms | 118 / 130 ms |

H.264's first decoded frame follows its poster by 50–110 ms. Text is as legible
as in the JPEG at 1280×720, with faint ghosting around the moving blocks.
Across two full runs, click-to-visible varied by about 30 ms between runs of the
same format, so the formats are equal within this method. Most of the ~130 ms
is the network round trip and Chromium, not encoding. A second viewer adds
fan-out (0.03 cores), not an encoder.

**What it means for the machine.** At these sizes, Chromium's software
rendering of the tab costs five to ten times what the encoder does, so the
encoder needs no GPU. The two-core machine has room for a 720p60 viewer beside
the agent's work. Recordings on the same machine are another matter (V18).

## October 20: the transport, and the machine's own browser

**The transport.** Video rides the link a runtime already has to its gateway
and its clients, from link version 3
([`media.ts`](../packages/protocol/src/media.ts)):

1. **Watching.** A client names a stream with `media-watch`, carrying the
   viewer's box, and the gateway passes it to the runtime unread. Sent again,
   it changes the box. The host joins the target's `BrowserVideo` with a
   viewer whose packets go to that stream.
2. **Media.** Each `ControlVideoPacket` is one binary message: `m`, a format
   byte, the stream's name, then the packet. The gateway forwards it to the
   connection watching that stream without reading it. Nothing records,
   numbers, acknowledges or replays it, and watching doesn't wake the
   Thread's machine.
3. **Backpressure.** A gateway in the middle can't see how much waits in the
   viewer's socket, so the client acknowledges the bytes it has taken
   (`media-ack`) within 50 ms, or at once past 128 KB. The machine takes a
   viewer's backlog as bytes sent past the last acknowledgement, so
   `BrowserVideoViewer.backlog()` and the engine are unchanged, through any
   number of hops.
4. **Ending.** The client stops with `media-unwatch` or by closing its
   connection. The runtime ends a stream with `media-end` and why: its turn
   paused, the tab is gone, or encoding failed. The gateway sends
   `media-ended` when the runtime leaves.
5. **On the Mac.** The app keeps one watch per conversation however many
   windows show it, sized to the largest. Each window reads its packets in
   batches and decodes them with `ControlVideoPlayer`. Local previews keep the
   JPEG path, which measured best on one machine.

**The machine's browser.** A cloud machine has no person's browser, so the
host starts its own: [`MachineBrowser`](../packages/control-runtime/src/machine-browser.ts),
headless Chromium, preferred by default, started when an agent first connects
and again after it exits, so a Thread that never browses pays nothing. It is
registered with the host's child processes and stops with the host. Its
sandbox stays on. That needs user namespaces, which a VM gives and Docker's
default seccomp profile refuses; Chromium's setuid helper fails there the
same way. So a refused sandbox is an error that says so, not a quiet
`--no-sandbox`.
The Linux proof runs its container without the seccomp filter, as a machine
runs. Only a host running as root turns the sandbox off, since Chromium's
sandbox refuses root.

**FFmpeg.** The Mac and the machine image build FFmpeg from one recipe
([`build-control-media.mjs`](../scripts/build-control-media.mjs)): static,
with x264, and only the protocols, formats, codecs and filters recordings and
live video use. The build checks each is there. On Linux the binary is
6.3 MB where Debian's package and its libraries added 439 MB to the image.
The Mac's build gains the FLV muxer that live video needs, and `crop`.

**Measured on a cloud machine** of the size cloud Threads run on (2 vCPU,
4 GB), as the host's user:

- **The browser.** An agent's first connect on a fresh machine takes
  2.4–2.8 s, all of it reading Chromium from the machine's disk for the first
  time: with its files already read, the same launch takes 195 ms. Later
  launches take 150–255 ms. A joining viewer gets its poster 84–141 ms after
  joining and its key frame at 148–269 ms, then 31 fps, through the image's
  FFmpeg.
- **The image.** Chromium and its fonts add 671 MB to the machine's disk,
  FFmpeg 25 MB with its sources and licenses.
- **Starting a machine.** The new image was built on the current one inside a
  running machine. A control was built the same way with the old code, so
  the method's own cost shows. Medians of 20 machines each:

| | Before | Control | After |
| --- | --- | --- | --- |
| Create to host ready | 1,189 ms | 1,218 ms | 1,252 ms |
| Boot, on a fresh machine | 524 ms | 525 ms | 610 ms |
| Wake a paused machine | 268 ms | 269 ms | 262 ms |
| Claim a parked machine (resume, boot) | 443 ms | 401 ms | 413 ms |
| Pause | 545 ms | 511 ms | 465 ms |
| Memory in use, fresh machine | 546 MB | 547 MB | 546 MB |

Waking, claiming and memory are unchanged. Only the boot of a freshly
created machine is slower, by 85 ms (significant), within a create-to-ready
difference that isn't. A second build of the same image booted 111 ms
slower than the first, so how a build lays out the machine's snapshot
matters as much as its contents. Boot is one request the agent answers from
memory, so no Mako code on it got slower.
