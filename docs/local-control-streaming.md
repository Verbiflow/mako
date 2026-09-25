# Local Control interactive streaming

Shared ownership, observability and refactor gates: [architecture contract](local-control-architecture.md).

Design and acceptance notes, 2026-09-23. Current implementation status and priority
live in [wayfinder LC-21](local-control-map.md#lc-21--responsive-capture-recordings-and-cursor).
This document adds experiments and completion checks, not a claim that a new
streaming transport or human-takeover feature is implemented.

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
These are backend choices under the same session engine. No candidate has been
adopted or benchmarked inside Mako by this review.

The [continuous-media investigation](local-control-media-investigation.md) adds
the shared-runtime continuous recorder, packaged FFmpeg crash evidence and the
remaining implementation sequence. Browser recording no longer accumulates
source JPEGs; preview JSON and Linux capture loops remain. The investigation also
corrects the distinction between pixelflux's two recording
paths below. No streaming stack has been adopted.

Fast desktop streaming has mature implementations. Continuous browser encoding
now removes source-image staging. JSON/base64 preview delivery and Linux PNG
capture loops remain implementation debt, not unavoidable properties of computer use. A transport replacement alone still cannot provide
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

Use the selected 1920×1080/60 target and 57 distinct fps sustained floor. Measure
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
- [ControlPreviews](../electron/control-previews.ts) bounds delivery to the newest
  frame, scopes watchers and stops unused subscriptions. Passing full base64 JPEGs
  through preview JSON remains expensive on dense screens.
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
