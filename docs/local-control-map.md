# Local Control wayfinder

Updated 2026-09-25. This is the current plan for browser and computer control across
all harnesses, desktop Mac and isolated Linux cloud jobs. The goal is accurate,
responsive complete workflows through a typed engine, agent MCP and composable CLI. Full ChatGPT/Codex
parity has not been established.

## Start here

- **What to do next:** [delivery order](#delivery-order) and the workstreams below.
- **Every complaint from the agent:** [issue ledger](local-control-agent-issues.md),
  including findings that were corrected, not reproduced, or remain open.
- **Architecture:** [ownership boundaries, diagnostics and change tests](local-control-architecture.md).
- **Agent discovery and MCP integration:** [LC-29](#lc-29--agent-discovery-and-mcp-integration) records passing installed Mac/Aside + Codex acceptance and remaining provider/platform coverage.
- **CLI refactor:** [shared engine and shell contract](local-control-cli.md).
  Prior CLI-only acceptance is historical; MCP-first integration supersedes that delivery choice.
- **Native capture reuse:** [source-reviewed open-source candidates and backend acceptance](local-control-capture-backends.md).
- **Interactive streaming:** [reference findings, transport experiments and local/remote scope](local-control-streaming.md).
- **Lightweight media:** [Capy, Replicas, Tembo, Synara and T3 review; hardware and low-delay software probes](local-control-media-prior-art.md).
- **Current media investigation:** [continuous recording, encoder-crash evidence and ordered implementation gates](local-control-media-investigation.md).
- **Streaming choice and VNC:** [Selkies/pixelflux prototype, Moonlight comparison and compatibility boundary](local-control-streaming.md#september-24-selection-browser-streaming-moonlight-and-vnc).
- **Using the existing API:** [API reference](local-control-api.md).
- **Reusable packages:** [Node package ownership and consumer checks](package-boundaries.md); [LC-28](#lc-28--reusable-packages-and-public-entrypoints).
- **Build, cloud and contributors:** [runtime](local-control-runtime.md),
  [packaging](local-control-packaging.md), [CI](local-control-ci.md).
- **Earlier decisions, experiments and failures:** [history](local-control-history.md).
  Historical “pending” and “installed” statements are scoped to their checkpoint.

This file owns current workstream status. The issue ledger owns individual agent
complaints. Other documents hold contracts, recipes or evidence; they should link
here for progress rather than maintain another backlog. Provider execution belongs
to the [meta-harness map](meta-harness-map.md); remote channels belong to the
[remote-control map](remote-control-map.md).

## Current state and release boundary

| Area | What is established | What is not established |
| --- | --- | --- |
| Shared agent API | Bound handles, explicit reads, strict scoped targeting, lossless values, deliberate images and structured action outcomes; old public API replaced. | Uniform discovery/result typing, all error paths, broad fresh-agent usability and matched comparative task performance. |
| Browser capture | Local fixes for stream ownership, clipped screenshots, actual pixel metadata and timer drift. Browser recording defaults to 60 fps. A reproduced viewer decode failure is fixed: local compositor tests reach ~59–60 distinct frames/s from 1920×1080 capture, including two viewers plus recording, with unchanged decoded pixels. | Installed-host presentation/input latency, remote delivery, sustained 1080p efficiency and native rates. Source-host Aside acceptance is scoped below; focus-off hidden tabs may produce no frames. |
| Native capture/input | Mac +mako.21 selected for new launches; tested exact AppKit file selection/cancellation; exact-value routes, bounded settling, recording and scoped gestures. A 60-second 1080p trial reached 57.35 distinct fps with unchanged foreground samples. English keyboard trial retained exact text during eight background saves with no observed focus interruption; human attestation is pending. Focus recovery remains reactive (23–99 ms in deliberate activation tests). | General proactive prevention, physical IME, universal gestures and exact 60 fps remain unproven. Sandboxed AppKit Open/Save semantic workflows pass with the separate panel service confirmed. Incomplete panel trees, raw cross-process input and broader dialog families remain gaps. Linux +19 accepts 60 fps, but its native CLI clip is only 0.62 seconds; GNOME capture polls at ~5 fps. |
| Standalone Linux | Current CLI/+mako.19 passes native AMD X11 jobs, three Sway scale/rotation configurations, both CLI workflows and eleven lifecycle cases. Earlier ARM64/Intel evidence is retained. Temporary EC2 resources removed. | Public distribution, remaining compositor versions, real GPU/display coverage or sustained capture-rate parity. |
| Installed components | Build `3c1d563e25a9bd78` is installed; +mako.21 is selected for new Mac driver launches. Installed package/host identity, SDK/CLI/MCP state, Aside exact-save/dialog/images, native exact values, reset/worker-fault recovery and MCP/browser reconnect checks pass. Default-host Codex compaction and task interruption/resume pass with 1,006 foreground samples without fixture activation. ASAR metadata cache failure is fixed in deployment tooling. [Installed evidence](local-control-agent-repl.md#september-24-installed-acceptance-and-recovery); [receipt](local-control-mcp-deployment.json). | Model compaction/interruption acceptance is scoped to Codex/macOS. Other providers, Linux and broader whole-job/streaming acceptance remain separate. Browser reconnect may remove temporary tabs; no automatic replacement or replay. |
| Packaging | Retired npm Cua SDK and regular-profile debugging scans removed; target-specific builds, media recipes, licenses, ignores and archive checks exist. | Complete installed-size/performance budgets for every supported release target and a proven smaller native build profile. |

Evidence: [capture and final cloud packages](audits/2026-09-23/local-control-capture21/README.md),
[native Intel jobs](audits/2026-09-23/local-control-native-x64-cloud19/README.md),
[current AMD and physical typing validation](local-control-native-validation.md),
[Mac focus and Sway timing](audits/2026-09-23/local-control-focus15/README.md),
[earlier installed Aside](audits/2026-09-22/local-control-packaging/README.md).
Audit media and machine-local artifacts may be ignored or absent in a fresh clone;
retain reproducible scripts and package provenance. A missing artifact is not a pass.

## Decisions to preserve

- One provider-neutral TypeScript engine behind MCP, SDK and CLI; composability is required.
  Preserve task ownership across separate shell invocations. Local Mac, remote
  browsers and future Linux cloud jobs use that engine with verified backend
  capabilities. Live streaming is an engine output, not a third automation system.
- MCP is the primary Mako agent integration: persistent JavaScript calls the typed
  session directly. The optional CLI borrows that engine independently of MCP.
  Never create a second task owner, target cache or input/recording implementation
  per interface. The old status/help/exec tools stay retired; other Mako MCP
  integrations and the native driver's private protocol remain separate.
- Live preview/recording performance target: 1920×1080 at 60 distinct fps.
  1440p/4K is optional, not a release gate. Preserve full-detail explicit screenshots
  and exact coordinate geometry. Do not resize user pages to satisfy a video target.
- Accuracy comes before throughput. Dispatch and UI quiet are not task success;
  verify exact target state. Never replay an action with an uncertain outcome.
- Observation and images are explicit. Scoped reads must preserve completeness,
  exact values and ref/lineage validity; text reads must not capture screenshots.
- Regular Chromium profiles use the extension and the user's saved browser choice.
  Prefer the OS-default supported Chromium browser where no choice exists; do not
  silently substitute Chrome, another profile, or direct debugging after failure.
  Keep explicit CDP routes for desk/Electron and owned cloud/test browsers.
- Preserve popup/opener/named-window semantics. An isolated cloud desktop contains
  focus effects; a regular desktop cannot claim universal background popup behavior.
- Retain the patched Cua native executable. Browser control is Mako-owned. Remove
  proven unused dependencies, not verified native functionality or license files.
- A live Mako desk is a real app client. Artificial loading states belong in an
  isolated fixture until a properly enforced preview mode exists.

## Delivery order

**Current milestone:** Mac hardware recording is implemented and packaged. Signed candidate `b5ec839840ea7ab0` uses recipe-3 VideoToolbox and quality 85, selected after quality 80 failed the broader sampled colored-text gate. Final ordinary and two-worker loaded Aside jobs pass at **58.72/58.79 preview fps** and **58.85/58.63 recorded fps**, with exact inputs and unchanged screenshot pixels. The loaded recording finishes 127 seconds at **460 MB peak summed RSS / 1.28 CPU cores** for host plus encoder; the visible OS encoder service adds about 22 MB / 0.018 cores. Exact-repeat coalescing also passes the minute-long static stress, crash recovery and unchanged native pass-through checks. [Hardware implementation and full evidence](local-control-mac-hardware-recording.md). Earlier software and quality-80 failures remain recorded; this is scoped acceptance, not proof under arbitrary load or a whole-machine resource budget.

**Next:** rebuild/sign with the LC-26 streaming cleanup, then validate installed media. The existing signed candidate passes bundled browser/native recording, package/import/signature/size/startup checks, but predates the cleanup and recipe 4. **Not installed:** readiness reported running Mako/shared-host processes. Preserve the current installed MCP acceptance; do not interrupt active work to replace it. Further Mac native-buffer/idle/shared-encoding optimization remains separate from this passing workload. The cleanup's latest full lint and typecheck pass (five existing React warnings); earlier provider lint failures remain historical evidence. [Hardware validation](local-control-mac-hardware-recording.md#acceptance), [cleanup validation](local-control-streaming-cleanup.md).

**Cloud ordering:** define the Linux cloud-agent environment first (display/compositor, CPU/GPU availability, isolation, network and lifecycle), then choose and validate its capture/encoding/transport backend. Preserve the current Linux implementation and prototype evidence; defer further cloud streaming implementation and Moonlight/Selkies adoption until that prerequisite. Mac and cloud retain the same typed session, ownership and recording API.

**Preserved integration decision (September 24): SDK + composable CLI + persistent JS MCP.**
After reviewing the current unified cua_repl evidence, the user explicitly replaced
the CLI-only Mako integration decision. Mako agents should discover browser and
computer use through one persistent JavaScript MCP adapter, calling the shared
SDK/session directly, never spawning CLI commands. The basic CLI remains available
for external users and file pipelines. Streaming work follows this integration’s scoped correctness, discovery, lifecycle
and packaging acceptance, now passed for installed Mac/Aside + Codex. Preserve the existing browser/native functionality, lossless values,
exact target checks, background policy and recording cleanup. Agent discovery, focused runtime documentation and minimal startup/context cost
are primary acceptance criteria. Keep the CLI’s existing file/stdin composition.


1. **Close correctness and misleading-result gaps** in LC-08 and LC-22, starting
   with raw-action uncertainty, capture geometry and precise recovery messages.
   Keep the full [agent issue ledger](local-control-agent-issues.md) accounted for.
2. **Finish LC-29 MCP discovery and LC-20 shared-engine release acceptance.**
   Run browser and native jobs through normal provider startup; preserve the basic
   CLI as a thin consumer of that same engine.
3. **Finish LC-21's interactive capture path and LC-24's native gaps.** Measure
   complete input → visible result and distinct source frames, then optimize.
   Native/transport investigation can proceed independently of the agent adapter.
4. **Complete LC-25/LC-26 target acceptance and packaging**, then LC-23's installed
   host/extension rollout. Run acceptance on the exact artifacts being deployed.
5. **Close LC-27 with repeated complete jobs through MCP and multiple
   harnesses.** Record the remaining unsupported cells explicitly.

The order is a working sequence, not a claim that every platform investigation
blocks every release. Each scoped release must state exactly which gates it closes.
Statuses below distinguish implementation from deployment and broader acceptance.

## LC-20 — Shared engine and composable CLI

**Status: revised signed candidate and fresh-agent jobs pass; idle deployment timed out without replacing the app.**
[Commands and lifecycle contract](local-control-cli.md),
[September 24 evidence](local-control-cli-evidence.md),
[fresh-agent CLI and reference review](local-control-cli-review.md),
[modal fix and packaged acceptance](local-control-cli-modal.md),
[live deployment receipt](local-control-cli-deployment.json).

`createControlSession` owns program state, native policy, target evidence,
recovery and recordings. Desktop task supervisors start one worker and supply an
exact CLI shim/session descriptor through every provider launch path. Browser
credentials stay in worker IPC. The old status/help/exec MCP adapter and launcher
were deleted. The September 24 revised decision adds a persistent-JS MCP adapter
that borrows this same engine; LC-29 owns its implementation and acceptance.
Private Cua protocol and unrelated MCPs remain.

CLI command/group help works offline, with signatures, outputs, examples and
structured `--json` help. `api` loads focused runtime reference. Separate CLI
processes share state through an owner-only Unix socket with exact session/code
identity. Text reads take no screenshots; media is written to files. No source,
continuation ticket or uncertain action is automatically replayed.

September 24 acceptance:

- Fresh Codex, Claude and Cursor browser jobs used the CLI, completed verified
  forms with trusted input, read screenshots and closed their task tabs. Codex
  also completed a native AppKit form. Cursor's earlier private-socket workaround
  is a rejected run; the repeat used a frozen runtime and passed through the CLI.
- A native Terminal CLI job independently verified its command output with 67
  unchanged foreground samples. This is separate from physical IME/human typing.
- Real Linux ARM64 Chromium and GTK CLI workflows passed exact values, scoped or
  resized captures, recording finalization and cleanup. All eleven isolated
  Linux lifecycle scenarios passed. The current CLI also passes native AMD x64
  browser/native jobs and all eleven lifecycle scenarios; see the native validation.
- Desktop tests cover explicit stop, worker/parent SIGKILL, private-file cleanup,
  lost-worker browser ownership cleanup and stripping inherited control secrets.
- Packed Node imports/types, relocation, code identity, worker/artifact lifecycle,
  package bounds and secret canaries passed for the CLI-only candidate. The new
  `/mcp` export now passes the revised package acceptance in LC-29.
- The final shell fixture took 3.50 s; command p50 was 100 ms and p90 114 ms
  including process startup. These are fixture timings, not real-page or viewer
  latency. Four concurrent programs also preserved shared state.

Help efficiency remains an LC-22 acceptance item: Cursor completed correctly but
made eight help calls. Preserve that evidence; do not call the learning overhead
solved solely because the task passed. Fresh ACP-provider workflows also remain
unmeasured; their launch paths share the CLI environment/instructions.

Signed candidate `15ebe10a1502342e` passed actual ASAR worker/CLI tests, both
packaged startup routes and 40 regular-profile Aside jobs. The run verified exact
values, duplicate Save refusal, dialog handling, recording, interrupted-video
retention, reconnect and stale-handle refusal; all 326 foreground samples stayed
on the initial app. This tests the candidate against the installed extension,
not the default installed shared host. The full app is 662,882,436 bytes.

The revised candidate `7b0a2c623f935da0` includes result-publication and startup
cancellation corrections, event-driven modal interruption, mouse/key cleanup and
focus restoration after dialogs. Two fresh agents passed against its immutable
ASAR, including media and browser close verification. Browser help needed two
calls; native needed three including a logging repeat. The older generated
candidate was removed after shutdown; its historical acceptance remains above.

Next: complete installation and installed acceptance after active work ends. The
September 24 idle wait expired after 30 minutes; nothing was replaced. Read the
[deployment receipt](local-control-cli-deployment.json) for actual state. The updater refuses host/build replacement and never force-stops
work. Native AMD CLI acceptance now passes; repeat remaining provider launch
paths. Streaming stays paused until the release gate closes. LC-22 also tracks
bounded partial output from failed exec programs.

September 24 source continuation: the shared runtime now allocates private Unix
endpoints by UTF-8 byte length, including long state/TMPDIR paths. Desktop/cloud
runtime roots preserve crash cleanup ownership. Startup failure, dead-owner
cleanup, active-session preservation and packed relocation pass; no dependency
was added. [Socket and native-read evidence](local-control-dialog-depth-evidence.md).
These source changes still require desktop rollout.

## LC-21 — Responsive capture, recordings and cursor

**Status: final Mac hardware candidate passes ordinary and two-worker loaded source-host Aside jobs at roughly 58.6–58.9 fps, exact inputs/pixels and lower resources. See [current evidence](local-control-mac-hardware-recording.md). Installed media rollout/acceptance remains open; existing installed MCP acceptance is separate. The user accepts roughly 56 fps; 60 remains the target.**
[Streaming experiment and acceptance plan](local-control-streaming.md),
[Reported capture issues](local-control-agent-issues.md#capture-recording-and-preview).

The [current investigation](local-control-media-investigation.md) records the
implementation, failed experiments and acceptance gates. Continuous encoding
removes source-JPEG staging; clocks/cursor timing and native no-transform output
have focused tests. [Binary delivery and shared JPEG decoding](local-control-preview-binary.md) now keep preview pixels out of JSON. The final source runs complete with exact pixels; the revised recorder also finishes the covered two-minute loaded job. Linux component/viewer measurements are documented; native Sunshine/Moonlight and installed media acceptance remain. Packaged
FFmpeg's fragmented and hybrid modes retain 120 decoded frames after a synthetic
encoder kill, whereas `+faststart` output is unreadable; clean runs retain all
180. This is container evidence, not a new capture-rate result. Hybrid needs no
new encoder dependency. Upstream pixelflux's built-in recorder requires changes
for encoded loss, timing and resize; its socket tap is a different implementation.

The production image renderer repeatedly replaced an unfinished async decode.
The new pixel-reading audit reproduced only 10 readable frames in four seconds
despite 222 host updates. A bounded decoder now keeps the last complete image and
one newest waiting frame. Corrected runs reached ~59–60 composited frames/s;
two viewers plus recording passed 36 exact input/visible-marker checks, zero
decoded-pixel differences at 1920×1080, and independent viewer/recording cleanup.
[Reproduction, measurements and limits](local-control-preview-evidence.md).

A separate-host comparison reduced socket response bodies from 17.62 to 11.98 MB/s
with identical decoded pixels and ~59 distinct fps. A later CPU-instrumented pair
was slower (49.75 vs 56.35 fps); tail latency and total resource cost remain open.
That earlier implementation used negotiated Brotli compression and expanded preview JSON across Electron IPC. Binary preview delivery supersedes that media path. September 25's LC-26 cleanup also removes the unused ordinary-RPC Brotli decoder after checking both source and installed host producers; ordinary RPC uses bounded identity JSON. Default input and capture now share a per-tab emulation hold.
The first live consumer enables painting; the last disables emulation. Text reads
stay unchanged, and no tab/window activation is requested. Focus-off embedders keep
no-frame refusal. Unit checks cover overlapping consumers/actions, screenshot
pause, startup/reset failure and interrupted acquisition.

The installed Aside extension with the source host passed a 30-second two-viewer
run at **58.03 distinct fps**, with 36 exact input checks, unchanged 1920×1080 decoded
pixels, 288 unchanged foreground samples and a finalized 37.73-second recording.
Streaming rendering removed the reproduced 512 MiB PNG staging failure. The
rebuilt minimal encoder passed browser/native cursor tests and failure cleanup.
Viewing/screenshot/transport-loss tests restore page focus and hidden visibility;
a click can leave Chromium's `hasFocus()` true after detachment while the tab stays
hidden. This limitation is recorded, not replaced by forced blur or tab activation.
[Measurements and limits](local-control-preview-evidence.md#september-24-capture-ownership-and-long-recording).

The current signed build's runtime acceptance is complete; sustained media checks
remain separate. An earlier sustained 1080p run sent **11.87 MB/s** compressed /
**17.67 MB/s** expanded preview data.
Electron working set rose from 867 MB to 1.20 GB; Node RSS stayed around 214–221 MB.
Those include the offscreen fixture and exclude installed browser/encoder CPU.
The 60-second runs at mixed capture sizes were slower and remain in the evidence.
The pre-continuous-encoding 60-second run with the explicit 1920×1080 source budget reached
**52.02 distinct fps** and stopped recording after **41.33 seconds** when retained
source JPEGs reached 512 MiB. The earlier fix removed decoded-PNG staging during
finalization; it did not remove source-JPEG accumulation during capture.
[Failure and measurements](local-control-preview-evidence.md#september-24-sustained-1080p-failure).
Continuous encoding now removes that source accumulation without raising the cap.
A later worker-rendered two-viewer Aside run completed 68.57 seconds with
53.76 distinct viewer fps and unchanged foreground samples. Its decoded video
reached only 48.58 distinct fps; it does not close the smoothness gate. Startup
prewarming fixes the initial encoder freeze. A bounded timestamped source queue
now preserves intermediate states during encoder catch-up, verified by pausing
and resuming real FFmpeg; decoded-marker tests also cover screenshot interference.
The subsequent timestamped-queue run completed 67 seconds: preview 56.53 fps,
recorded motion 56.82 fps, longest recorded hold 116.7 ms, all 36 exact input
checks and both pixel comparisons passing with unchanged foreground samples.
That run missed the former 57 fps floor. The user subsequently accepted roughly 56 fps; this does not waive exact pixels, input correctness, bounded resources or freeze checks. Recorder-only stress (including a ten-minute
run), bounded-backlog and encoder/host-death tests are separate from viewer-rate
acceptance. [Current implementation and limits](local-control-media-investigation.md#implementation-and-acceptance--september-24).
Binary media delivery now preserves the exact encoded bytes outside preview JSON. JPEG ImageDecoder output matched the HTML image oracle in the covered fixtures; the two viewers share one decode. [Implementation and evidence](local-control-preview-binary.md) separate failed decoders, production checks and installed acceptance. Keep the 1080p budget and report actual pixels; do not degrade explicit screenshots or silently reduce the requested size.
Finish actual pixel/DPR policy, resize/no-frame reporting, cursor legibility and
all gesture routes. Requested fps is now threaded through native capabilities/capture
in the +19 candidate: Mac/X11 advertise 60 and GNOME advertises 5, with source-rate
acknowledgment and refusal before unsupported starts. Replace GNOME PNG
polling with a continuous PipeWire source; compare XComposite texture import and
ext-image-copy-capture/DMA-BUF for Linux. These are explicit LC-21 work items, not
optional polish. [Source-reviewed projects and implementation gates](local-control-capture-backends.md)
cover OBS, wl-screenrec, Selkies, Sunshine and rejected alternatives. A getUserMedia
constraint does not upgrade native recording.

The next isolated Linux streaming prototype is **Selkies/pixelflux**, comparing
WebRTC with binary WebSocket delivery; **Sunshine/Moonlight** supplies the native
viewer comparison. pixelflux's encoded socket tap is a reuse candidate, but its
built-in recorder continues after encoded queue loss, uses delivery timestamps
and starts a second X11 encode. Both require explicit readiness/recovery checks.
Its Python extension and monitor-scoped portal capture are not a drop-in Node
dependency or exact-window backend. KasmVNC is a second cloud
candidate, not standard VNC compatibility. Ordinary VNC would use a separate
adapter (for example TigerVNC/noVNC) to the same job desktop, with input ownership
enforced and no second automation API. The need for standard-client interoperability
awaits clarification; no VNC service is enabled by this plan.
[Source review, prototype selection and gates](local-control-streaming.md#september-24-selection-browser-streaming-moonlight-and-vnc).

The source-rate candidate also fixes first-operation Mac recording: a fresh
ScreenCaptureKit filter could abort until an earlier observation had initialized
CoreGraphics. Capture now establishes the display connection and checks geometry
itself. A 10-second first-operation run retained 577 distinct 1920×1080 frames
(57.53 fps) with unchanged foreground samples. Linux's 5 ms sleep on every full
encoder-pipe write limited the test to 13.94 source fps. Waiting for writability
raised the same covered-window workflow to 56.70 source fps, preserving exact
values, blue target pixels and playable interrupted video. These are preliminary
candidate results; the Linux fixture is 640×420, not sustained 1080p acceptance.
The longer Mac run retained 3,400 distinct frames over 60.05 seconds (**56.62 fps**),
below the 57 fps acceptance floor. Foreground samples changed from Aside to Mako;
the sampler cannot establish who caused that change. The run did not pass.
Subsequent +19 trials passed the existing 57 fps floor: **57.44** distinct fps
for 30 seconds and **57.35** for 60 seconds at 1920×1080, with all 331/613
foreground samples unchanged. The signed driver is now selected for new launches.
Existing daemons were left running. This does not establish exact 60 fps, real
human input or proactive focus prevention; the failed longer trial remains above.
[Candidate provenance, failures and reproduction](local-control-native-capture-evidence.md).

Done per backend when moving content supplies approximately 60 distinct source
frames/s at the declared size under the accepted workload, controls stay responsive,
clips cannot corrupt video, cursor coordinates match dispatched actions, and output
reports its real geometry/rate/interruption. Static screens need no invented frames.
Compare screenshot/text fidelity and resource cost before accepting an optimization.
The September Replicas review adds viewer-side unique-frame and p95 frame-gap
checks, an instrumented input-to-visible loop, a WebRTC candidate, damage/idle-aware
capture, compatible shared encoding and component-specific recovery. Test one/two
viewers plus recording; idle or hidden content must not trigger false reconnects.
Do not select a language/codec from a product claim or compare host fps with viewer
fps. [Detailed criteria and source](local-control-streaming.md).
Audio streaming and recording are distinct open capabilities; neither implies
microphone capture. Full human takeover is deferred; it is not a dependency of low-latency agent use
or viewing. Mac work continues now; the September 25 decision defers cloud-specific
streaming implementation until its Linux environment is defined.

## LC-22 — Agent-facing contract and discovery

**Status: partial; each original complaint has its own ledger entry.**
[Discovery/API issues](local-control-agent-issues.md#discovery-targeting-and-api),
[recorded request-shape failure](audits/2026-09-22/background-control-fixes/agent-request-shape.md).

Native screenshots now validate supported options, honor resizing/format requests
and retain exact returned-image coordinate mapping. Native recording capabilities
derive their source-rate ceiling from the driver (new Mac/X11 candidates allow
60; the GNOME PNG source declares 5; older drivers stay fixed at 30). Unsupported
rates refuse before starting capture. Known startup refusals are `not-dispatched`.
Stale image/reference CLI faults use the recovery exit code. These close scoped
contract bugs, not general discovery/usability acceptance.

Shared input boundaries now return bounded `invalid-request/not-dispatched` faults
for common target, selector, read, action, screenshot and recording mistakes.
Misspelled click options cannot fall through to a default left click. Ambiguous,
missing and incomplete locator results carry explicit pre-dispatch faults. CLI
recovery warns that earlier program steps may already have completed; response
validation after a write still preserves unknown outcomes and the recovery guard.
Public scoped-edit/screenshot help examples pass against duplicate controls in
real Linux Chromium. [Evidence](audits/2026-09-23/local-control-input-contract.md).
This is executable-help acceptance, not a fresh-agent usability pass.

The first blind review needed 18 browser help/API calls and 16 logged native
help/API calls plus initial help. Revised packaged trials used two browser help
calls and three native calls (two distinct views) while completing exact edits,
modal recovery and media. The five-second click delay and modal focus-reset
attachment loss are fixed and regression-tested. Six result-publication failure
cases and both Linux startup signals preserve post-dispatch uncertainty.
[Modal and learning-cost evidence](local-control-cli-modal.md).

New recovery gap: a later exec failure hides earlier console/image output. Keep
outcome uncertainty and no-replay behavior; design bounded partial-result receipts
so agents can recover useful evidence without repeating completed actions.

Next: finish capability/result typing, understandable validation and recovery,
consistent role/name/text semantics, and consolidated executable help examples.
Distinguish a disconnected browser, unsupported operation, no native windows and
Mako's own live desk before mutation. Exercise long-running start/resume/cancel
without requiring agents to guess a ticket shape. Track accessibility names and
visible labels separately rather than silently changing selector semantics.

Done when a fresh agent can discover/connect, scope duplicate controls, capture an
element, handle an invalid request and finish/recover a recording from public help,
without raw CDP workarounds, private settings calls or an operator explaining shapes.
Use the [ledger](local-control-agent-issues.md) for exact bug closure criteria.

## LC-08 / LC-14 — Uncertainty, ownership and independent targets

**Status: target recovery and cancellation gates implemented and fault-tested locally.**
The shared host and BrowserService now classify browser commands by effect.
Read-only helpers preserve refs; raw mutations retire only their target's refs.
Lost raw browser replies block that target until a successful observation/capture.
Native preflight failures remain `not-dispatched`; post-dispatch failures remain
unknown. A failed unscoped native action blocks even previously unseen windows:
observe an exact window and continue through its handle. Another unscoped input
cannot be authorized by that window's observation.

Native driver reconnect preserves unresolved outcomes and browser evidence.
Missing screenshot data does not clear uncertainty. Initial and later topology
monitoring failures report `guard-unavailable`; the successful action receipt is
retained and continuation requires fresh target evidence. A read overlapping a
concurrent browser mutation cannot clear uncertainty or return current refs.
Dialog replies and event reads can run while navigation waits; ordinary mutations
remain ordered. An explicit answer to an open dialog can unblock recovery without
automatically replaying the interrupted action.

Cancelling a program preserves unknown outcomes even if the backend later returns
success. Cancelling only a cell wait leaves its eventual result collectable and
continues to prohibit resubmitting source before collection. It does not trigger
the cloud supervisor's program-cancellation teardown hook.

Evidence and commands: [recovery audit](audits/2026-09-23/local-control-recovery.md).
The MCP/shared-host fixtures, real WebSocket protocol fixture, program-runtime
checks, control package tests, host/UI typechecks and full lint pass. These are
controlled failure tests, not installed Aside or physical-input acceptance.

Browser-wide ownership is now implemented and tested: profile cookie writes
refuse other task owners and pending target acquisition; an in-flight profile
write blocks browser work. Lost replies invalidate peer evidence and require
observation on existing and later claims. Raw browser/profile administration
cannot bypass managed operations. App attachments belong to one task, reject
endpoint aliases and are released at teardown. This is cooperative ownership,
not security isolation between websites sharing a regular profile.

Next within this gate: real transport/process loss during native input and
capture/recovery across installed extension replacement. The shared session
extraction preserves the tested exact-target and profile-wide rules.

Done when injected failures across public/raw paths retain the same truthful
outcome, require fresh evidence for the affected target and never replay input.
Unrelated targets remain usable; concurrent reads/actions cannot borrow a lease,
reuse stale refs or escape cancellation. Preserve coordination for native global
state. This also closes the older LC-14 contention/invalidation work.

## LC-23 — Preview isolation and installed browser rollout

September 24 media check: the installed app is now `5bfc1df4acea215e` (revision
`1d142af383e73b0539913c289664cdac03e9ec8f`). Its ASAR does not contain the binary
preview reader. The accepted `3c1d563e25a9bd78` evidence below refers to the earlier
build; this media task did not revalidate the intervening installation.

**Status: build `3c1d563e25a9bd78` passed installed package/host identity and
CLI/MCP browser/native acceptance.** The post-install JSON failure
was cached ASAR metadata after bundle replacement, fixed in the shared deployment
metadata reader with a regression test. Reconnect, cancellation, exact-value,
image and cleanup checks pass. Real Codex compaction through the default installed
host passes, including task interruption/resume and 1,006 foreground samples without fixture activation.
[Installed evidence](local-control-agent-repl.md#september-24-installed-acceptance-and-recovery).
The [live receipt](local-control-mcp-deployment.json) is `installed-validated`. This closes the scoped Mac/Aside + Codex installed milestone. Earlier rollout attempts below are historical.

Candidate `1e3322212fc98974` passed both packaged startup routes. Its idle-only
installer subsequently aborted because the shared host changed, without replacing
the app. The receipt is `release/preview-transport-20260923/install-state.json`.
A fresh probe now reports installed host `3e3f6a31a7970952` (built
2026-09-24T04:55:11.687Z); its packaged host/client modules contain negotiated
preview compression. The modules differ from the earlier candidate, so prior
measurements do not certify this exact build. Do not reinstall the older candidate. Aside
extension 0.3.2 passed 20 exact form jobs and 188 unchanged foreground samples,
then recording refused because the hidden tab supplied no frames. This does not
pass the recording/reconnect phases. [Evidence](local-control-preview-evidence.md#installed-aside-and-release-acceptance).

Candidate **`b1d91522d82480b1`** now passes both packaged startup routes, bundled
browser/native cursor encoding and **40** regular Aside form jobs with dialogs,
recording, interruption retention, reconnect and stale-handle refusal. All 259
foreground samples remain on Aside. This test loads the candidate's actual ASAR
modules and bundled encoders; it does not certify the old installed host.
The attempted installer verified host identity and never force-stopped work. Its
post-install packaged-media/Aside checks did not run. Read
`release/control-capture-20260924/install-state.json`; the attempt ended `not-installed` at 06:29 UTC after the shared host changed.
That attempt replaced no app. A later readiness check found installed app
`345bfd91c64009c6` on disk and an active shared host; the earlier installed build
identifiers above describe those earlier runs. Restart/rollout must be revalidated
against the current host, not silently resumed.
Only `installed-and-accepted` closes that deployment gate. A host replacement,
cancelled quit or deadline aborts without replacing the app.

The newer CLI-only candidate `15ebe10a1502342e` also passes 40 Aside jobs,
recording, interrupted artifact retention, reconnect and stale-handle refusal,
with 326 unchanged foreground samples. Its actual packaged CLI and worker pass
state/cleanup checks. See [CLI candidate evidence](local-control-cli-evidence.md).
It has not replaced the default installed host.

Next: define the supported fixture/preview boundary and enforce it at the host
bridge before offering side-effect-free previews. Merely describing a live desk
as read-only, hiding controls or stubbing renderer modules is insufficient. Then
verify/install the latest exact host/extension builds after active work safely ends.
Keep ordinary regular profiles and saved-browser routing; explicitly exercise
worker restart, extension reload, detach, foreign frames and unavailable profiles.

Done when fixture preview attempts cannot invoke providers, writes or other real
app mutations; ordinary live targets remain clearly identified. Installed Aside
and Chrome must pass long saved workflows with screenshots, recording, dialogs,
reconnect and no silent debugging fallback. Verify real opener/named-window flows,
retained child tabs/results, audio cleanup and download completion. Arbitrary
page-triggered extension downloads still need attribution/completion support.

## LC-24 — Native accuracy and background behavior

**Status: partial; safe refusals remain part of the contract.**

Current continuation: fixed modified native keys dropping their addressed field.
The previous frozen engine selected a decoy field; source and signed candidate
`0d02dc53d0a315ff` each pass three exact-field rounds with unchanged decoy/focus.
The public API now supports a single native middle-click when the driver advertises
it. A resized-screenshot gesture run passes real AppKit events and cursor recording
(671 frames, 19 pointer events, 148 unchanged foreground samples). Old drivers and
stale refs refuse before dispatch. The candidate also passes sandboxed Save As,
three cancellations and one independently confirmed write. No native-driver update
or installed-desktop replacement occurred. [Evidence](local-control-input-target-evidence.md).

**User scope decision:** defer the Japanese physical test as overkill. Do not ask
the user to repeat the completed English trial merely to unblock other work.
This does not establish IME correctness or waive other physical-input questions.
Proactive focus prevention, cross-process raw input, broader gesture/compositor
coverage and installed rollout remain active. CLI discovery/adherence is now an
additional priority in LC-29.


September 24 physical-input continuation: ordinary English typing and IME are now
separate modes of `scripts/test-native-human-input.mjs`. The English trial retained
the exact two-line text during eight background edit/save jobs, with 78 keydowns
overlapping those jobs and no foreground change during the test interval. It ran
the installed +mako.17 driver through the CLI. Human attestation is pending; this
does not establish IME composition or proactive prevention of deliberate activation.

September 24 continuation: shared observation filtering now preserves in-window
popup/context menus. Three real AppKit popup selections passed through scoped CLI
locators without activation notifications. General menus/dialogs remain unproven.

September 24 capture/dialog continuation: +19 passed bounded settling, background
click/right/middle/double-click/scroll and cursor recording (862 frames, 19 pointer
events, no sampled foreground change). Background drag still refuses. A real file
sheet can open despite AXPress acknowledgment error -25204. Shared-engine errors
now explicitly preserve that uncertainty. Unavailable sheet observations produce
`observation-unavailable`, block further input and never become empty successful
reads; malformed snapshots produce `invalid-driver-response`. The CLI regression
passes against the installed +19 driver and frozen source runtime. Parent-tree
Cancel remains refused because exact sheet ownership is unresolved; this is a
failure-handling pass, not completed dialog control. These engine fixes pass source and packaged CLI acceptance in signed candidate
`33153e3c6176bd87`; the desktop app replacement remains pending.

September 24 file-sheet continuation: **+mako.21 is signed and installed for new
Mac driver launches**. Shared bounded discovery resolves the panel's own native
window ID for observation and input. The installed-driver CLI passes three
cancellations and one exact file selection, independent AppKit confirmation,
unchanged foreground, untouched decoy/parent controls and stale/cross-window
refusal. Ordinary settling, menu selections and cursor recording also pass;
377 Mac unit tests and final full lint pass. Existing daemons were not restarted.

Panel coverage remains honestly incomplete because AppKit returns attribute
errors. This validates explicit refs, not strict whole-panel locator uniqueness,
raw sheet keys, Save As or cross-process ViewBridge dialogs. Proactive window-tag
experiments did not establish prevention and shipped no change. Physical typing
coordination remains unanswered. Broader compositor gestures remain open.
[Full evidence and retained failures](local-control-file-sheet-evidence.md).

September 24 bounded-read continuation: sandboxed Open and Save As each pass
three cancellations and a confirmed file operation, with Apple's separate panel
service identified, unchanged foreground, untouched decoy/parent and stale-ref
refusals. A real expanded Save panel exhausted the 1,000-node budget before its
buttons. Native `observe({maxDepth:5})` now bounds traversal; it returned 83–84
lines with a 244 ms median in the final run. Coverage remains incomplete, and
unsupported drivers/browser targets refuse the option. This is source-engine
acceptance with installed +21, not a new desktop rollout.

The same depth contract passes labwc, Weston and KWin with twenty background
form jobs each on Linux +19. Long UTF-8 socket paths now use private short
endpoints, with startup/crash cleanup and conservative orphan reaping tested.
The existing Docker image was reused; test containers were removed. Core/engine,
packed-consumer checks and full lint pass.
[Evidence, failures and exact limits](local-control-dialog-depth-evidence.md).

Next: proactive Mac focus protection, raw cross-process key/pointer delivery and other dialog families; clipboard
consumption/collision handling; remaining physical-input confirmation. Japanese testing is deferred by user choice; do not treat it as a prerequisite for the other work.
Broaden Electron/Qt/rich-editor coverage. The explicit Terminal GUI job now passes:
background launch, native command typing, high-level Return, independent output
read, screenshot and owned-window cleanup. All 82 foreground samples stayed on
Aside. A capability-only fix ignores explicitly off-screen document rows while
unknown/on-screen competitors and the driver's final guard still refuse. Recording
can introduce an AX dialog that blocks keyboard delivery; no title/size exception
was added. Keep direct shell execution as a separate exact-output route.
Finish native observation lineage,
invalidation, bounded scoped reads and busy/progress readiness without interpreting
quiet as completion. Carry forward LC-09/10/13/15/16 where evidence remains narrow.

Done per route with independently saved exact values, correct window/PID, physical
input retained, observed focus history and complete interruption reporting. Match
cursor traces to actual gestures, including untested touch/pinch/drag routes.
Physical-input tests require a participant; generated Unicode is not IME evidence.
The actual reference Linux executable remains unavailable and is a comparison gap,
not a reason to stop testing Mako's own implementation.

## LC-25 — Linux backend and cloud coverage

**Status: standalone lifecycle implemented; platform coverage is incomplete.**
[Runtime](local-control-runtime.md) and [contributor CI](local-control-ci.md).

September 24: +mako.19/current CLI passes on native AMD EC2. The portable runner's
X11 jobs/recordings and Sway normal, 150%, and 150% plus 90-degree rotation all pass.
Both standalone CLI workflows and eleven lifecycle scenarios pass, with retained
media decoded and selected images inspected. The VM and temporary network/key
were removed. [Evidence and limits](local-control-native-validation.md).

Current-version continuation: KWin 6.3.6, labwc 0.8.3 and Weston 14.0.2 pass
twenty ARM64 background jobs each after fixing current AT-SPI `button` role
normalization. Capture/gesture support is not established by these form jobs.

September 24 bounded-read checks: current shared engine + Linux +19 passes
`maxDepth:1` on all three compositors, keeps omitted descendants incomplete and
then completes all sixty background form jobs. This adds read-contract coverage;
it does not enable unverified gestures or capture.

Next: extend compositor/version and real display/GPU coverage. AMD x64 Sway now
has scale/rotation and hidden-job evidence. ARM64 Sway additionally has load
evidence; GNOME 46 has
scoped capture/input evidence; Weston/labwc have semantic hidden-job evidence,
not equivalent capture/gesture support. KWin 5.27.11 ARM64 now passes twenty exact
background form jobs, independent Save counts, unchanged duplicate-name cover
and focus history, plus unsupported raw-input/capture refusals. KDE capture,
gestures, Plasma 6 and other versions remain unverified.

Done per supported target with fresh isolated desktops, exact identity/value oracles,
scaled/rotated geometry, modal/popup behavior, covered/hidden capture where promised,
recording, restart and held-input cancellation. Verify whole process-group cleanup,
private profiles/runtime directories and retained artifacts. Keep contributor runs
secretless with pinned actions and read-only permissions; public CI execution is
separate from the locally prepared workflow and completed EC2 acceptance.

## LC-26 — Packaging, dependency size and stale code

**Status: initial cleanup and target packages tested; further reduction open.**
[Architecture, sizes and target matrix](local-control-packaging.md).

**September 25 streaming cleanup — source/build validation passed; rollout pending.**
Traced LC-21's current callers and removed unnegotiated Brotli response decoding, staged-browser post-stop
encoding branches, an obsolete Electron media-resolver test and FFmpeg's unused
concat demuxer (recipe 4). The container-recovery audit now uses the shared encoder
policy. Native overlay/pass-through, Linux software encoding and PNG/viewer decoder
fallbacks have live callers and remain. Preview/recording/recovery suites, build,
typecheck and full lint pass (five existing React warnings). Recipe 4 is validated
and promoted to the standard local media directory; 71.16 MB of obsolete temporary
build copies were pruned with provenance preserved. This cleanup postdates signed
candidate `b5ec839840ea7ab0`; a fresh signed build and installed checks remain.
[Caller inventory, retained paths and evidence](local-control-streaming-cleanup.md).

September 23: the signed ARM64 candidate is 662,787,567 installed bytes; 1,077
frozen build files and 664 imports verified. Packaging now derives workspace
FileSets from the canonical release manifest, fixing the omitted `control-runtime`
mapping and preserving JS/license-only Control payloads. Both packaged startup
routes passed. Other target and actual default-host rollout claims remain separate.

The latest signed ARM64 candidate `a0c8c955359372bb` is **662,922,799 bytes**,
with 684 resolved imports. Media recipe 2 passes packaged browser/native
cursor encoding without Homebrew; the packager rejects a stale recipe/source
manifest even when its old binary hashes still match.

September 24 Docker audit: normal runs reuse images, but 72 stopped Mako test
containers retain 7.49 GB of writable data; seventeen Mako image tags remain.
Cargo/target/media volumes retain ~6.39 GB for rebuild speed. The global builder
reports 25.85 GB private cache across projects. Its full disk report fails on a
missing snapshot; no reliable total or global prune is claimed. The new compositor
runner saves evidence and removes each test container, reusing one dependency
image. [Evidence and remaining cleanup](local-control-native-validation.md#local-docker-retention).

Next: align the Rust build image with the pinned driver toolchain to avoid repeat
downloads; bound image/build-cache retention, retain unique historical evidence before
removing stopped test containers, and diagnose the missing Docker snapshot.
Measure full installed bytes and cold start per browser/native/mixed cloud
image and desktop target, not just source payload or driver size. Audit a reduced
native build profile by dependency/section size before removing upstream code.
Keep exact public dependencies, target-specific media, source/licenses and provenance.
Verify `.pyc`, caches, generated media binaries and unrelated providers stay outside
source/payloads; prune orphaned compiled modules and retired callers.

Done when each supported artifact has reproducible build inputs, correct architecture,
size breakdown, no private credentials or wrong-target dependencies, and runtime
capture/input/lifecycle acceptance. Any reduction must preserve those results.
Generic build declarations do not certify Intel Mac, Windows or Linux desktop releases.

## LC-28 — Reusable packages and public entrypoints

**Status: Node runtime extraction implemented; clean packed-consumer and ARM64 jobs validated locally.**
[Ownership and imports](package-boundaries.md). Session search is explicitly out
of scope; the user approved Node packages plus composable CLIs.

`@mako/control` remains lightweight. `@mako/control-runtime` now owns the shared
session/browser/native/capture implementation and CLI entrypoint. Desktop,
extension, build and deployment callers use the new package; old source and
compiled entrypoints are removed. Standalone configuration is explicit, worker
paths resolve within packages, and engine identity survives relocation. Strict
external TypeScript checks also exposed and fixed invalid inferred observation
declarations. A pending native connection is disposed when its owner closes.

`npm run test:control-packages` verifies real archives without workspace links,
public types, separate CLI processes sharing worker state, capture, correction
errors, artifact spill, lifecycle and release boundaries. Real ARM64 Chromium and
GTK jobs preserve targeting, media and cleanup. See
[extraction evidence](local-control-package-evidence.md) for exact scope,
measurements and limitations; LC-26 owns full installed size per target.

Next: public distribution/versioning, installed desktop/Aside acceptance and
publishing/running the contributor workflow. Current native AMD package/CLI
acceptance passes; that is separate from a GitHub workflow run. Physical input and broader
compositor coverage remain in LC-24/25.

## LC-27 — Complete-job accuracy, performance and harness evaluation

**Status: substantial fixture evidence; broad comparative acceptance remains open.**
This is the continuation of LC-12, not another API implementation milestone.

Next: repeated held-out tasks with duplicate controls, virtualized content, rich
editors, popups, multiple windows, downloads, long recordings and interruptions.
Run via MCP in multiple harnesses; retain fresh-agent mistakes as cases.

Done for a declared matrix when independent outcomes establish completion and false
confirmation rates, focus/input interference, recovery, human interventions, model
round trips/context/image bytes and p50/p95 task latency. Measure displayed frames and p95 frame gaps separately
from capture/output fps; check that instrumentation does not distort a candidate.
Use equal-resolution comparisons alongside ordinary defaults. Compare the same workload
and builds before/after changes. A reference parity claim requires matched reference
runs; symbols, marketing fps and synthetic transport timings are not substitutes.

## LC-29 — Agent discovery and MCP integration

**Status: Mac/Aside installed acceptance is complete, including MCP/browser reconnect, cancellation, and default-host Codex compaction/interruption/resume. Broader provider/platform and comparative usability coverage remains open.**
[Discovery audit and accepted design](local-control-cli-discovery.md).
[Implementation, retired-MCP comparison and test evidence](local-control-agent-repl.md).
This supplements LC-20 and LC-27. MCP is the primary Mako agent interface; the CLI
is a thin optional consumer for external users. All control logic stays in the
shared TypeScript SDK/engine. The user superseded the CLI-only decision: add
a new persistent-JS MCP adapter over the shared session, not the retired
status/help/exec tool collection. [Accepted design](local-control-cli-discovery.md#accepted-design-sdk-cli-and-persistent-js-mcp).

Local implementation now exposes `js` and `js_reset`, with persistent bindings,
first-use/focused docs, explicit images and shared ownership. Tests pass for real
MCP-over-HTTP cancellation, revoked grants, package consumers, stale refs across
interfaces and reset without target cleanup. No new dependency or CLI subprocess
was added. Candidate `3c1d563e25a9bd78` includes the re-review fixes and passes packaged HTTP MCP acceptance; it is installed, with installed browser/native MCP and default-host Codex compaction verified. See the installed acceptance section for scope and remaining cells.

Separate whether the agent discovers the available tool from whether it follows
its targeting, observation, verification and recovery rules. Current startup
injection now advertises the unified MCP `js` tool, with the CLI as an optional
file-pipeline interface. The earlier CLI-only injection linked to `--help`. Prior fresh trials received the CLI explicitly,
so their success does not establish discovery during an ordinary user task.

The new trials give only the outcome and target; actual endpoint requests prove
MCP use. Codex/Claude browser runs used 9/7 calls; Cursor used 13. Native two-turn
runs preserved exact Unicode/whitespace and never sampled the fixture foreground.
Cursor completed with three recovered JavaScript mistakes, so native zero-error
usability remains open. The review caught and fixed ACP dropping the control
endpoint after negotiation and an idle worker error killing the entire session.
The latter is reproduced against superseded candidate `1226a367de0c1b11` and
passes the new candidate while retaining its tab. Failed runs and test-runner
limitations are preserved in the [review](local-control-agent-repl.md#september-24-re-review-and-fresh-agent-acceptance).
The Japanese physical IME test remains deferred at the user's request.

Direct review of default/dev Mako session databases found concrete old-MCP
connection guessing, `code`/`source` mismatch, inconsistent query keys and target
recall confusion. [Session evidence](local-control-cli-discovery.md#session-evidence-checked-directly-on-september-24)
records the session/block IDs, current mitigations and limits. Add disconnected
browser recovery, obsolete API history and reset/compaction recovery to ordinary
agent trials. Inspect result envelopes rather than trusting `completed` labels;
measure inventory/help output cost. Do not attribute these old-MCP failures to CLI
migration or count source-search keyword matches as control use.

Next:

Current LC-21 evidence: [Mac hardware recording](local-control-mac-hardware-recording.md)
contains the final quality/resource/loaded acceptance and signed candidate. Earlier
[recording efficiency](local-control-recording-efficiency.md) retains the software
runs and failures. [Linux streaming](local-control-streaming.md#september-24-isolated-prototype-measurements)
retains prototype results pending the cloud-environment definition. No installed
media rollout or Linux dependency adoption is implied.

1. Complete installed Mac hardware media acceptance under LC-21; the reviewed
   VideoToolbox-enabled package, explicit hardware admission, exact dimensions,
   text/cursor quality, bounded recovery and sustained source-host measurements
   pass. Retain failed and successful runs; do not raise queues or silently lower
   image quality. Measure native-buffer/idle work as further optimization. Define the
   cloud-agent environment before resuming Linux streaming backend adoption,
   Selkies/Moonlight comparisons and remote-network tests.
2. Extend the completed matrix with Grok browser and Linux MCP, plus provider
   interruption/resume, compaction, fresh bindings and child-agent discovery.
   Preserve exact source/candidate/installed identities for every result.
3. Improve the remaining observed usability costs, including Cursor's recovered
   JavaScript mistakes and unnecessary help. Use held-out jobs and matched baseline
   runs to measure invalid calls, help bytes, first correct action, total context,
   exact completion, latency and unintended input. The few successful runs above
   are not a statistical comparison with the retired MCP or ChatGPT.
4. Preserve shared SDK/engine invariants during rollout: target leases, exact refs,
   explicit images, cancellation, unknown outcomes and no automatic input replay.
   The regression suite now covers idle worker failure without losing the task.

Done for a declared provider/build matrix when complete tasks improve discovery
and rule adherence without sacrificing exact outcomes, latency or context cost.
Keep matched baseline/candidate failures; passing subprocess tests or better prose
alone does not close this item. No general MCP-versus-CLI regression or superiority
claim has yet been established.

## Scope decision from the Replicas review

Accepted 2026-09-23: borrow low-latency capture/transport techniques now for local
and remote browser/computer use. Reuse the existing engine with platform/backend
adapters; do not introduce a third control system. Updated September 25: implement
Mac hardware encoding now, and define the Linux cloud-agent environment before
selecting or implementing its streaming backend. The main harness remains the action caller. Full human-control/takeover
features and their ownership-policy interview are deferred, not prerequisites.
[Architecture and experiment scope](local-control-streaming.md#accepted-scope-one-engine-multiple-backends).

## Maintaining this plan

Update the relevant workstream and issue entry in place. Record code/test evidence
and separately record the exact deployed host, extension, driver, OS/backend and
browser. Only move an issue to accepted for its stated scope after its closure
check passes; a diagnosis or documentation change alone may leave UX work open.
Preserve failed runs. Put detailed chronology in [history](local-control-history.md)
and measurements in audit artifacts, keeping the current map readable.

Original LC-01–07 are the completed API replacement. LC-11's no-image-read/schema
cost fixes are tested. LC-18's explicit connect and LC-19's request-shape fixes are
implemented; installed/fresh-agent proof belongs to LC-22/23/27. Other original IDs
remain in history and are carried into the workstreams above, not silently deleted.
The user explicitly prioritizes maintainable abstraction, debuggability and fast
feature iteration. The architecture contract therefore requires one owner per
resource, correlated bounded diagnostics, fault injection at shared seams and
backend/transport change tests. Interface count alone is not progress.
LC-28's Node-package/CLI decision is settled; session search is out of scope. Physical
input participation, safe installed-app handoff and unavailable comparison hardware
or binaries are specific acceptance dependencies, not blanket project blockers.
