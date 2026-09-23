# Local Control wayfinder

Updated 2026-09-23. This is the current plan for browser and computer control across
all harnesses, desktop Mac and isolated Linux cloud jobs. The goal is accurate,
responsive complete workflows with a composable API and CLI. Full ChatGPT/Codex
parity has not been established.

## Start here

- **What to do next:** [delivery order](#delivery-order) and the workstreams below.
- **Every complaint from the agent:** [issue ledger](local-control-agent-issues.md),
  including findings that were corrected, not reproduced, or remain open.
- **Architecture:** [ownership boundaries, diagnostics and change tests](local-control-architecture.md).
- **CLI refactor:** [shared engine and shell contract](local-control-cli.md).
  Shell verbs and the shared session engine are implemented and locally tested; installation is pending.
- **Interactive streaming:** [reference findings, transport experiments and local/remote scope](local-control-streaming.md).
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
| Browser capture | Local fixes for stream ownership, clipped screenshots, actual pixel metadata and timer drift. Browser recording defaults to 60 fps. Dense hidden Electron test: ~59 distinct recorded frames/s and 59.8 preview updates/s at 1600×1000. | Installed-host presentation/input latency, sustained efficiency and current Aside capture acceptance. Inactive headless tabs may produce no frames. |
| Native capture/input | Patched driver +mako.17; tested exact-value routes, bounded settling, recording and scoped gesture coverage. Mac focus recovery is reactive, with observed 23–99 ms interruptions. | General proactive focus prevention, physical IME/concurrent typing, universal gestures or native 60 fps. Mac/X11 capture requests 30 fps; GNOME window capture polls at ~5 fps. |
| Standalone Linux | Node launcher without Electron; final ARM64 and native Intel x64 packages pass eleven lifecycle scenarios, including crash/cancellation/process-group cleanup. Temporary EC2 resources removed. | Public distribution, AMD, x64 Wayland, all compositor families, or latest CLI acceptance on native x64 hardware. |
| Installed components | +mako.17 selected for new Mac driver launches. Earlier regular-profile Aside extension 0.3.2 passed 80 saved jobs. | Latest shared host/capture fixes have not replaced the running Mako app. Earlier Aside acceptance does not validate these newer changes. |
| Packaging | Retired npm Cua SDK and regular-profile debugging scans removed; target-specific builds, media recipes, licenses, ignores and archive checks exist. | Complete installed-size/performance budgets for every supported release target and a proven smaller native build profile. |

Evidence: [capture and final cloud packages](audits/2026-09-23/local-control-capture21/README.md),
[native Intel jobs](audits/2026-09-23/local-control-native-x64-cloud19/README.md),
[Mac focus and Sway timing](audits/2026-09-23/local-control-focus15/README.md),
[earlier installed Aside](audits/2026-09-22/local-control-packaging/README.md).
Audit media and machine-local artifacts may be ignored or absent in a fresh clone;
retain reproducible scripts and package provenance. A missing artifact is not a pass.

## Decisions to preserve

- One provider-neutral engine under MCP and CLI; composability is required.
  Preserve task ownership across separate shell invocations. Local Mac, remote
  browsers and future Linux cloud jobs use that engine with verified backend
  capabilities. Live streaming is an engine output, not a third automation system.
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

1. **Close correctness and misleading-result gaps** in LC-08 and LC-22, starting
   with raw-action uncertainty, capture geometry and precise recovery messages.
   Keep the full [agent issue ledger](local-control-agent-issues.md) accounted for.
2. **Finish LC-20 release acceptance for the shared engine and CLI.** Carry those
   correctness rules into both adapters; test real pipes and separate commands.
3. **Finish LC-21's interactive capture path and LC-24's native gaps.** Measure
   complete input → visible result and distinct source frames, then optimize.
   Native/transport investigation can proceed independently of the CLI adapter.
4. **Complete LC-25/LC-26 target acceptance and packaging**, then LC-23's installed
   host/extension rollout. Run acceptance on the exact artifacts being deployed.
5. **Close LC-27 with repeated complete jobs through both interfaces and multiple
   harnesses.** Record the remaining unsupported cells explicitly.

The order is a working sequence, not a claim that every platform investigation
blocks every release. Each scoped release must state exactly which gates it closes.
Statuses below distinguish implementation from deployment and broader acceptance.

## LC-20 — Shared engine and composable CLI

**Status: shared engine and CLI implemented; local acceptance passed; installation pending.**
[Commands and lifecycle contract](local-control-cli.md).

`createControlSession` now owns program state, native policy, target evidence,
recovery and recordings. MCP is an adapter. Disposable CLI processes share that
engine over an owner-only Unix socket with exact session/protocol/code identity.
Discovery, connect/open/claim, observe/act, scoped screenshots, recording
start/stop/status, script execution and bounded diagnostics are implemented.
Text calls do not take screenshots; explicit media produces files; scripts retain
state without exposing MCP cells to shell callers.

Evidence: separate-process MCP/CLI fixture checks, full legacy MCP/driver
regressions, real Linux Chromium form/capture/recording job and all eleven existing
Linux lifecycle scenarios. The shell fixture measured roughly 80–155 ms per
command including process startup across local runs, not real-page latency.
Native ARM64 CLI acceptance now covers exact GTK text, an independently counted
Save, 640×420 capture, requested 320×210 capture, JPEG conversion, playable video
and cleanup. Four simultaneous shell programs preserve session state. Cancelled
recording waiters, repeated stop and unrelated-tab work during held shutdown pass
the MCP/CLI fixture; finalization is owned by the session. [Evidence and limits](audits/2026-09-23/local-control-cli-media.md).
Real Linux browser recording finalized at 780×494 while its button screenshot was 65×37;
the clipped capture did not resize the video. See the [CLI evidence](audits/2026-09-23/local-control-session-cli.md).

Next: install the exact host/CLI build after active work ends, run fresh-agent
usability, repeat the new package on native x64 (the workflow now includes both CLI
jobs), and extend sustained-load/encoder-failure coverage beyond these short jobs. Preserve short
verified scripts alongside separate commands. Viewer/network latency and full
backend-stage diagnostics remain distinct measurement work, not claims derived
from CLI startup timings.

## LC-21 — Responsive capture, recordings and cursor

**Status: browser fixes locally tested; efficiency and native rates remain open.**
[Streaming experiment and acceptance plan](local-control-streaming.md),
[Reported capture issues](local-control-agent-issues.md#capture-recording-and-preview).

Next: measure renderer presentation and click-to-visible p50/p95, real scrolling,
CPU, memory and bytes on busy pages. Dense frame JSON currently reaches ~555 KB;
the capture fixture consumed about 1.5 Electron CPU cores. Evaluate a more efficient
transport against that baseline with unchanged text readability. Finish actual
pixel/DPR policy, resize/no-frame reporting, cursor legibility and all gesture routes.
Thread requested fps through native capabilities/capture, replacing GNOME's polling
source where needed. A getUserMedia constraint does not upgrade native recording.

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
or viewing. Remote-browser work does not wait for a managed cloud-agent environment.

## LC-22 — Agent-facing contract and discovery

**Status: partial; each original complaint has its own ledger entry.**
[Discovery/API issues](local-control-agent-issues.md#discovery-targeting-and-api),
[recorded request-shape failure](audits/2026-09-22/background-control-fixes/agent-request-shape.md).

Native screenshots now validate supported options, honor resizing/format requests
and retain exact returned-image coordinate mapping. Native recording capabilities
publish the current 30 fps limit; known startup refusals are `not-dispatched`.
Stale image/reference CLI faults use the recovery exit code. These close scoped
contract bugs, not general discovery/usability acceptance.

Shared input boundaries now return bounded `invalid-request/not-dispatched` faults
for common target, selector, read, action, screenshot and recording mistakes.
Misspelled click options cannot fall through to a default left click. Ambiguous,
missing and incomplete locator results carry explicit pre-dispatch faults. MCP
recovery warns that earlier program steps may already have completed; response
validation after a write still preserves unknown outcomes and the recovery guard.
Public scoped-edit/screenshot help examples pass against duplicate controls in
real Linux Chromium. [Evidence](audits/2026-09-23/local-control-input-contract.md).
This is executable-help acceptance, not a fresh-agent usability pass.

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

**Status: open for new isolation behavior and latest installed acceptance.**

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

Next: proactive Mac focus protection, menus and cross-process dialogs; clipboard
consumption/collision handling; physical Japanese IME and simultaneous human typing.
Broaden Electron/Qt/rich-editor coverage. Finish native observation lineage,
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

Next: extend native Intel X11 evidence to AMD/x64 Wayland and missing compositor
routes. ARM64 Sway has scale/rotation/load and hidden-job evidence; GNOME 46 has
scoped capture/input evidence; Weston/labwc have semantic hidden-job evidence,
not equivalent capture/gesture support. KDE and other versions remain unverified.

Done per supported target with fresh isolated desktops, exact identity/value oracles,
scaled/rotated geometry, modal/popup behavior, covered/hidden capture where promised,
recording, restart and held-input cancellation. Verify whole process-group cleanup,
private profiles/runtime directories and retained artifacts. Keep contributor runs
secretless with pinned actions and read-only permissions; public CI execution is
separate from the locally prepared workflow and completed EC2 acceptance.

## LC-26 — Packaging, dependency size and stale code

**Status: initial cleanup and target packages tested; further reduction open.**
[Architecture, sizes and target matrix](local-control-packaging.md).

Next: measure full installed bytes and cold start per browser/native/mixed cloud
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
session/browser/native/capture implementation and CLI/MCP entrypoints. Desktop,
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

Next: public distribution/versioning and installed desktop/Aside acceptance;
run this package revision on the native x64 contributor runner. These are not
implied by a local source move or ARM64 container run. Physical input and broader
compositor coverage remain in LC-24/25.

## LC-27 — Complete-job accuracy, performance and harness evaluation

**Status: substantial fixture evidence; broad comparative acceptance remains open.**
This is the continuation of LC-12, not another API implementation milestone.

Next: repeated held-out tasks with duplicate controls, virtualized content, rich
editors, popups, multiple windows, downloads, long recordings and interruptions.
Run via MCP and CLI in multiple harnesses; retain fresh-agent mistakes as cases.

Done for a declared matrix when independent outcomes establish completion and false
confirmation rates, focus/input interference, recovery, human interventions, model
round trips/context/image bytes and p50/p95 task latency. Measure displayed frames and p95 frame gaps separately
from capture/output fps; check that instrumentation does not distort a candidate.
Use equal-resolution comparisons alongside ordinary defaults. Compare the same workload
and builds before/after changes. A reference parity claim requires matched reference
runs; symbols, marketing fps and synthetic transport timings are not substitutes.

## Scope decision from the Replicas review

Accepted 2026-09-23: borrow low-latency capture/transport techniques now for local
and remote browser/computer use. Reuse the existing engine with platform/backend
adapters; do not introduce a third control system or wait for a managed Linux cloud
product. The main harness remains the action caller. Full human-control/takeover
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
