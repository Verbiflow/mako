# Local Control refactor wayfinder

## Linux implementation and durable browser recovery

2026-09-22: source work is in `/Users/kashyab/mako-control-rollout`; native source
is `/private/tmp/mako-control-driver-platform` on the pinned upstream base.
[Implementation and evidence](audits/2026-09-22/linux-control-implementation/README.md).

Implemented: exact Linux values and walk coverage; passive scope containers;
canonical roles and input state; retained accessibility objects for semantic
click/replacement; modal and destroyed-object refusals; no uncertain insertion or
pixel fallback; X11 focus attestation before host and driver input dispatch.
Linux help no longer advertises unverified background pointer/keyboard routes.
A late raw-driver focus check was caught by a negative test and moved before all
foreground input routes in candidate `0.28.2+mako.3`.

The candidate passed 30 GTK fill → exact read-back → Save jobs through public MCP,
all 400 uniquely tagged keys in the other window (388 during the final job loop), reordered and
destroyed controls, modal parent refusal, bounded walks, oversized value proof
refusal and text-only reads without screenshots. The host and raw driver both
refused foreground input to the background target. Release `+mako.3` packaging and its final
release-binary rerun passed; complete-job median/p95 were 127/139 ms. Linux units: 448 passed/5 ignored; common
contract: 45 passed; Mac native units: 368 passed/2 ignored. These are isolated
ARM64 X11 results; Wayland and x64 are not certified by them.

Extension 0.3.1 passed 12 complete saved workflows on each of macOS and Linux
Chromium, then forced-reload recovery on both. Reload preserved the page and
value, kept durable interruption evidence, rejected the old lease and allowed
fresh inspection without replay. Recovery never treats reused tab IDs as a
browser-incarnation proof. A popup notice makes interruptions visible. Claimed
parents now own their child tabs, and Linux identifies the real browser process.

The previous signed app handoff **failed** on orphaned crashpad processes 76176
and 76183. The installer now verifies and reaps that exact orphaned executable
after authorized host exit. Tests preserve unrelated, parented and changed
processes. Full app packaging/installation remains in progress; the installed
Mac driver is still `+mako.1`. Regular Aside controlled typing, native popup focus,
Wayland and wider app coverage remain open. No ChatGPT parity claim is made.

## Mac/Linux accuracy and background audit

2026-09-22: [comparison and implementation order](audits/2026-09-22/native-platform-comparison/README.md)
checks the supplied Layers 3–4 report against installed reference SDK/docs and
Mako's pinned native source. Keep accuracy as a release constraint and measure
performance per independently verified complete job.

Four source-derived protocol probes reproduced Linux incompatibilities without
sending input: strict locators always refuse the driver's incomplete trees;
exact editable-value proof is missing; the foreground guard requires an app flag
Linux always returns false; native capability help asserts background routes
without backend evidence. These are not Linux GUI test results. Mac acceptance
and the previous native 995/995 typing result do not establish Linux/browser parity.

Priorities: driver-owned platform/focus/value/scope contracts; a reproducible
isolated Linux desktop and packaged runtime; durable ownership/action recovery;
broader child-tab attribution; then measured readiness/API improvements.
For shared Mac/regular-profile browsers, preserve real popup semantics by default.
The reference's popup interception sometimes returns a substitute window object;
copying it universally would trade website correctness for background behavior.
Cloud Linux should isolate desktops per job so popup focus stays within the job.
These are audited next steps, not implemented or deployed changes.

## Extension workflow validation and release

2026-09-22: implementation is in `/Users/kashyab/mako-control-rollout`.
The public API now has strict semantic locators and target-specific capabilities;
help can return one topic. Locators resolve fresh refs and dispatch once. The
public native/page integration test passed a repeated-label form using the new
locators with independent submitted-value checks and unchanged foreground.

Extension 0.3.0 adds action-driven isolated cursor feedback, named task groups,
retained results, exact child-tab attribution, owned audio cleanup, protocol
matching, worker ownership recovery and idle update gating. Real Chromium tests
caught a grouping-window bug (fixed by explicit window ID) and confirmed the old
Page download command is unavailable through the extension. URL downloads now
use the browser's own download IDs and can be checked without restarting. A
popup → download → retained-result workflow passed two browser restart rounds.
Ref-triggered arbitrary page downloads remain unsupported through the extension.
Added permissions are tabGroups and downloads; cursor feedback uses existing
debugger access, without blanket website scripting permission.

Final shared-client, extension, native/page public API and lint checks passed.
Two real Chromium rounds completed popup → download → retained-result jobs,
plus restart, detach, canceled dialogs and no-replay checks. Hidden-tab benchmark
medians were about 3 ms for reads and 8–9 ms for typing. Tail latency varied;
read p95 increased. This is no general speedup claim. Hidden cursor feedback sent
zero commands for 10,000 calls; visible bursts coalesced to six commands.

Implementation is committed as `01360d6` and integrated into main as `df9129b`.
Signed candidate `89c04a9f9814da4b` passed packaged-byte and signature checks and
is queued through the idle installer, replacing the older candidate. Its receipt
is `~/.mako/browser-host-releases/5e421f03704df6b1/workflow-install-handoff.json`.
The installed app/regular Aside extension are still older.
Installation waits for active work to finish. Positive unpacked-reload proof and
controlled browser concurrent typing remain open. See the
[workflow evidence](audits/2026-09-22/extension-workflows/README.md) for the exact
measurements, permission changes and limitations.

## Broader extension design audit

2026-09-22: audited the user-supplied `chrome-chatgpt.md` beyond detachment.
Its normalized background matches installed ChatGPT extension 1.26.901.11451;
the matching installed cursor content script and asset were also inspected.
The [design audit](audits/2026-09-22/chatgpt-extension-design/README.md) covers
cursor motion and visibility, tab grouping/favicons, semantic locators, collection
reads, capability help, action results, child tabs/popups, audio, downloads,
reconnect, mixed versions, idle updates, worker restart and handoff.

The main gaps are visible task ownership, easier semantic targeting and
instance-specific capability/help, plus explicit update/recovery contracts.
Preserve Mako's bound targets, scoped compact observations, exact values and
no uncertain replay. Drive cursor UI from shared host activity for every harness;
do not require extra model calls or animation waits for hidden work. No new cursor
or locator API is claimed as shipped. The audit gives concrete design criteria
and an implementation order.

A disposable localhost-only foreign-frame observer experiment still detached
even after verifying installation. It does not prove the full reference fails,
but it rules out calling a simple observer a demonstrated fix. The new code was
not installed in the user's extension or regular profile.

## Extension rollout checkpoint

2026-09-22: extension 0.2.0 and the versioned Native Messaging helper are live in
the regular Aside Work profile. The helper reconnected automatically after its
idle restart; the stale checkout launch path is gone. Production changes are
integrated in the main checkout through `e15f439`.

The signed full Mako build `5e421f03704df6b1` is queued through the existing
idle-time installer. The running app still reports `1f2c6af3acd5149e`; active
sessions must finish before replacement. No completed installation is claimed.
The old installed updater cannot stop a surviving browser helper; a bounded,
one-time handoff is armed to clean up only the idle registered helper after the
original host exits, then verify the new build. It never stops active work.
Its receipt is linked in the rollout record.

Three regular-profile extension jobs passed 24 saves each (72 total), including
cancelled/accepted confirmations, screenshots and cleanup. The last ran with the
final helper and recorded switches among Aside, Ghostty and Mako. Aside and Chrome
for Testing also passed browser restart, foreign-frame detach cleanup, client
reconnect, stale-handle refusal and task/persistent tab lifetime separation.
Chrome for Testing additionally passed cancellation with no uncertain-action
replay. Default-browser matching uses the actual registered application identity,
not a Chromium-brand allowlist; saved and explicitly cleared choices are respected.
The final signed host passed a first-run RPC check against the actual OS default:
it saved Aside · Work and left the browser disconnected.

The controlled browser typing check FAILED after 28 tagged keys because Aside
became foreground. Its cause is unresolved; the 995/995 native typing result does
not cover this browser test. Action-level focus tracing is ready for a quiet
interval. Installed-host verification and stable Chrome regular-profile coverage
also remain. Manual Aside overlays and foreign privileged frames remain browser
restrictions, with explicit interruption and cleanup handling rather than direct
fallback. See the [extension rollout evidence](audits/2026-09-22/extension-rollout/README.md).


Latest design revision: browser Settings now uses compact rows with actual icons
and readable profile names. The idle connection dot/Disconnect toolbar is gone;
readiness is plain text, access maintenance and direct debugging share one Manage browsers disclosure.
Aside’s own row expands to show its setup instructions; selection and expansion
have separate keyboard-accessible controls within one continuous selected row;
the chevron has no detached button fill. Colors reuse Mako’s warm neutral tokens. The existing
libraries.dev Thinking Orb mounts only while connecting; reduced-motion renders
a static frame. Pointer/keyboard, access enable/disable, idle unmount, reduced
motion, light/dark and narrow checks passed. See
[browser Settings acceptance](audits/2026-09-22/browser-settings/README.md).

Current checkpoint: Aside’s automatic text-selection popup is disabled with user
authorization. Its regular-profile Mako extension passed two complete six-save
jobs afterward, including dialogs, screenshots and cleanup, without direct
remote-debugging sessions. The new Settings browser picker saves one preferred
external profile for all providers. Public `openTab({url})` uses that choice;
explicit browser IDs override it and unavailable profiles never silently fall
back. Setup guidance and event-based interruption reports require no recurring
browser probes. See [browser Settings acceptance](audits/2026-09-22/browser-settings/README.md).

The Aside setting is live. The Settings UI and host changes are implemented and
locally tested, but not installed as a full Mako app update. Native foreground
acceptance passed 995/995 tagged keys; public native Command restrictions remain.
Older pending-user-answer and separate-profile checkpoints below are historical.
The user wants the regular profile; Chrome remains an option if Aside becomes
incompatible, not an automatic fallback or a change to the OS default browser.

Updated 2026-09-22. Status: public API replacement, caller migration and focused
acceptance complete. D1 and D2 are implemented. The existing Electron native
accessibility lane remains intermittently unreliable; see the acceptance record.
The follow-up below records implemented typing, scoped-read and capture fixes,
with remaining driver and broader task-evaluation limits.
No packaged release or comparative Codex performance claim is implied.
The September 22 background comparison reopens native exact-value assurance and
records a native Command-chord gap plus repeated external-browser detachment.
See the [comparison audit](audits/2026-09-22/background-control-comparison/README.md).

## Destination

Refactor Mako Local Control into a coherent browser and native-app programming
API with persistent target handles, deliberate observation/output, accurate
execution evidence, and less repeated context. Preserve one provider-neutral
`mako-control` server, exact ownership, foreground controls, and recoverable
oversized output.

This map owns Local Control progress. The [meta-harness map](meta-harness-map.md)
owns provider/runtime work; the [remote-control map](remote-control-map.md) owns
remote channels. Neither is a Local Control implementation ledger.

Writer: current Local Control refactor conversation, working in
`/Users/kashyab/makomono/mako`. Existing unrelated changes are present. Keep
changes scoped and inspect overlapping edits before migrating consumers.

## Evidence and its limits

The supplied comparison bundle contains one historical turn, newest first,
with thirteen sidecars. Some original tool outputs themselves contain
truncation notices or explicit source slices; the bundle's lossless packaging
does not recover that missing content. Historical requests are context.

The historical comparison inspected Codex's bound App/Tab API, explicit
observations, emission suppression, diffs and persistent JavaScript. It did
not run a matched Mako-versus-Codex benchmark. These are design references,
not proof of comparative speed or reliability.

Current source inspected:

- [Host control implementation](../electron/computer-tools-main.ts): routing,
  ref validation, observations, receipts and MCP help/catalogue.
- [Control contract](../packages/control/src/control/contract.ts) and
  [receipt contract](../packages/control/src/computer/control-contract.ts).
- [Worker](../packages/control/src/program/worker.ts) and
  [runtime](../packages/control/src/program/runtime.ts): per-cell APIs, output,
  cancellation, persistent state and cell resumption.
- [Bound client](../packages/control/src/control/client.ts),
  [structured selection](../packages/control/src/browser/observation.ts),
  [browser observation](../electron/browser-observation.ts) and
  [browser service](../electron/browser-service.ts).
- Historical measurements: [runtime baseline](audits/2026-09-14/control-runtime-baseline.md)
  and [background audit](audits/2026-09-14/background-control-audit.md).

## Baseline findings (before refactor)

1. `control.act()` combines routing, dispatch, post-action observation, polling,
   verification, delta construction and topology guards in the host. Returning
   the whole result duplicates changed content in the observation and delta.
2. Verification searches rendered lines for expected text, or treats a changed
   observation as confirmation. Another field can contain the expected value;
   a Save error is also a screen change. Compact values are abbreviated at 80
   characters, so those strings cannot prove exact long-value equality. Empty
   values are omitted by the compact projection. Assertions need structured,
   target-specific evidence and must distinguish absence from incomplete reads.
3. `state` survives ordinary cell errors, but top-level local declarations do
   not persist. API closures capture a cell's `active` flag and `runId`;
   persisting a bound object made from those closures would address an ended
   cell. Persistent handles require a runtime change, not method aliases alone.
4. Page helpers observe through `advanced`, whereas unified observations also
   populate host `controlViews`/`controlRefs`. These paths need one authoritative
   observation/ref lifecycle before callers can freely compose them.
5. `exec` embeds `controlHelp()` in its catalogue description, including native
   tool names. Tool enumeration and runtime creation also request driver tools.
   Separate browser-only readiness from native startup, and measure a smaller
   bootstrap with help disclosed when needed.
6. Exact page leases/generations, cancellation uncertainty, native snapshot
   refs, action-scoped browser focus emulation, artifact spill and bounded
   polling are existing mechanisms to preserve. Documentation still contains
   contradictory historical token-carrying prose; reconcile it with the tested
   final contract during migration.

## Grilling decisions

| ID | Choice | Recommendation and trade-off | Status |
| --- | --- | --- | --- |
| LC-D1 | Replace the public `control.act`/`page` API or keep both? | Replace after migrating callers. One documented object API costs less context and maintenance; old scripts require migration. Host intent/routing contracts can remain internal. | Accepted 2026-09-22 |
| LC-D2 | Explicit observation or automatic post-action observation? | Actions return small execution receipts; programs explicitly observe/assert. This permits batching and avoids redundant trees, but verification must be explicit. | Accepted 2026-09-22 |

User decision: “Yes replace the old public API, no stale shit please. Yes sure
we can make observations explicit, as long as this is better design.”

Implementation choices within that direction: persistent bound handles in
`state`, retaining the existing async-body execution contract; explicit app
windows rather than implicit first-window selection; compact observations by
default and structured nodes available locally. Lexical REPL persistence,
annotations, managed browser profiles and platform expansion are outside this
API refactor. No additional user decision is currently blocking implementation.

## Delivery and completion gates

| Ticket | Work | Dependencies | Completion evidence | Status |
| --- | --- | --- | --- | --- |
| LC-01 | Baseline and caller inventory | None | Current contract, runtime and MCP regression results; retained context/latency baseline; migration consumers identified | Complete |
| LC-02 | Public API and module boundaries | D1, D2 | One typed contract with examples for browser, native window, screenshots, events and failures; explicit unsupported capabilities and exact-window selection | Complete — [API reference](local-control-api.md) |
| LC-03 | Persistent handles and cell lifecycle | LC-02 | Handle works across successful cells and ordinary errors; cancellation/reset invalidates it; late calls cannot borrow a newer run's authority | Complete — evidence below |
| LC-04 | Observation, refs and output | LC-02 | Structured reads and selection; deliberate text/image emission; full/diff recovery and completeness metadata; no duplicate output or action-capable stale refs | Complete — evidence below |
| LC-05 | Dispatch and assertions | LC-02, LC-04 | Separate dispatch/unknown/not-dispatched evidence from postconditions; wrong-field, duplicate-name, long/empty-value, validation-error and incomplete-read cases cannot falsely confirm | Complete — evidence below |
| LC-06 | Migration and help | LC-03, LC-04, LC-05 | Runtime, host, current scripts, fixtures, benchmarks and instructions use the selected API; old paths retired according to D1; browser-only startup works without native driver | Complete — evidence below |
| LC-07 | Real workflows and measured acceptance | LC-06 | Native and page fixtures pass independently; foreground unchanged where promised; matched before/after measurements and provider transport checks retained | Complete — evidence below |

The internal split should put typed handles, observation selection, output
projection and assertion composition in `@mako/control`. The host retains
ownership, dispatch validation, routing, driver sessions and uncertainty.
MCP registration exposes the same contract to every provider. Keep one owner
for each fact; avoid a second planner or a second cache with different ref rules.

The initial caller search found executable programs in
`scripts/test-local-control-e2e.mjs`, `scripts/test-computer-tools.ts`,
`scripts/benchmark-control-agents.ts`, `scripts/benchmark-control-runtime.ts`,
`scripts/provider-e2e-browser.mjs`, `scripts/test-desktop-continuity.mjs` and
`scripts/test-rewind-e2e.mjs`. MCP name/config consumers include
`electron/live-actions.ts`, `electron/live-conversations.ts`,
`electron/live-transfers.ts`, `scripts/test-mcp-entry.ts` and
`scripts/test-devin-permissions.ts`. Name-only references may need no change.
Repeat the caller search before retirement; this list is an initial inventory.

Acceptance measures completion and false confirmations before context savings.
Record catalogue/instruction bytes, returned text/image bytes, host reads and
mutations, tool time and wall time separately. Model runs additionally record
total input tokens, peak context, cached input when reported, turns and repeated
actions. Compare the same tasks with independent final-state oracles; synthetic
serialization timings do not certify native speed. A Codex comparison requires
matched model/tasks/budgets and remains separate from Mako before/after tests.

## Progress log

- 2026-09-21: read supplied comparison and sidecars; checked current ownership,
  observation, receipt, worker and help implementations. Located existing
  wayfinders; created this dedicated Local Control ledger.
- 2026-09-21: `npm test --prefix packages/control` passed all nine suites.
- 2026-09-21: `tsx scripts/test-computer-tools.ts` passed current native-adapter
  and unified-control fixtures. This does not establish live native behavior.
- 2026-09-21: `tsx scripts/test-browser-runtime.ts` passed state, cancellation,
  resumable-cell, output and artifact regressions.
- 2026-09-21: first interview round asks D1 and D2. Answers are pending;
  recommendations are not recorded as accepted decisions.
- 2026-09-21: twenty-run transport microbenchmark completed. Retained
  [raw baseline](audits/2026-09-21/local-control-refactor/runtime-baseline.json).
  Unified fixture catalogue/instructions: 5,198/3,472 bytes (native fixture),
  5,141/3,472 bytes (page fixture). Structured page selection: 32,248 → 208
  returned bytes. Oversized output spilled successfully in every lane.
  Timings are fixture serialization/transport readings; no model or live UI
  ran. Artifact paths inside the JSON are the original temporary locations.

- 2026-09-22: recorded D1/D2 acceptance. Added bound app/window/tab clients,
  explicit structured observations, compact serialization, multiset diffs and
  exact-value assertions. Replaced host act/read-back logic with dispatch
  receipts; no screen-change confirmation or automatic retry remains there.
- 2026-09-22: worker uses async-local cell ownership so handles survive ordinary
  cell boundaries but callbacks from finished cells cannot borrow a newer run.
  Removed the public page helper and migrated unified MCP/e2e/benchmark callers.
- 2026-09-22: coordinate actions require the latest capture token. High-level
  mutations retire refs before dispatch, and uncertain outcomes require a new
  observation. Raw calls invalidate unified refs; browser-only programs and
  basic help no longer initialize the native tool catalogue.
- 2026-09-22: pure package including new assertion/ambiguity/empty/long-value,
  partial-observation and diff cases passes. Host/runtime/browser regressions
  and live fixture acceptance are still being run.

## Acceptance record

The replacement is implemented and the current source callers have migrated.
The old public worker methods and page helper export are absent; the legacy
browser helper module is deleted. Private native/browser regression adapters
remain intentionally separate from the managed provider API. Historical audit
transcripts retain their original API calls as evidence, not current guidance.

- `npm test --prefix packages/control`: all ten suites pass, including exact
  empty/long values, wrong-field and duplicate matches, incomplete reads,
  no assertion replay, compact observations/selections and ref-independent diffs.
- Electron TypeScript build passes. Focused ESLint and oxlint checks pass.
- `npm run test:mcp`: all fifteen scripts pass. This includes provider transport
  registration, runtime lifecycle, lease/generation ownership, cancellation,
  native and page routing, previews and foreground guards. New host tests prove
  one explicit read with no automatic post-action read, expired refs/views,
  preserved fault codes/outcomes, uncertain-write recovery without replay, and
  browser execution/status/help with an unusable native driver executable.
- `node scripts/test-control-api-e2e.mjs`: live Cocoa native and Electron page
  workflows pass. Independent fixture files confirm input and submitted values;
  screenshots retain view tokens; handles work across cells; the frontmost app
  remains unchanged. [Retained live evidence](audits/2026-09-21/local-control-refactor/public-api-live.json).
  This uses the installed driver and checkout host, not a signed packaged release.
- The older `test-local-control-e2e.mjs` initially passed, then two reruns failed
  on Electron accessibility writes in its private driver-helper lane, before
  reaching public API assertions. Those failures were not converted into passes
  or hidden behind retries. [Retained legacy outcomes](audits/2026-09-21/local-control-refactor/legacy-live-results.json).
  Prefer the available page route for Electron forms; native Cocoa acceptance
  passed. Consistent Electron AX write delivery remains a driver/backend issue.

Twenty-run fixture measurements are retained in
[runtime-after.json](audits/2026-09-21/local-control-refactor/runtime-after.json)
alongside the baseline:

| Measure | Before | After |
| --- | ---: | ---: |
| Unified native catalogue | 5,198 B | 2,111 B |
| Unified page catalogue | 5,141 B | 2,111 B |
| Bootstrap instructions | 3,472 B | 1,609 B |
| Native catalogue + instructions | 8,670 B | 3,720 B (57.1% less) |
| Page catalogue + instructions | 8,613 B | 3,720 B (56.8% less) |
| Native explicit workflow response | 78 B | 78 B |
| Page explicit workflow response | 204 B | 208 B |
| Native workflow median | 10.304 ms | 12.314 ms |
| Page workflow median | 2.397 ms | 16.918 ms |

The revised workflow deliberately includes a read after input to keep the
before/after host-action count at three. The dispatch-only regression separately
proves that callers can omit that read. Structured evidence now crosses the
worker boundary; the page fixture transport is slower. These results establish
smaller bootstrap context, not faster execution. Single-observation returned
bytes are essentially unchanged; compact trees were already present before
this refactor. Output spill remains lossless in all benchmark lanes. No new
paid model run, token-cache comparison or matched Codex comparison was made.

Original acceptance boundaries (updated by the follow-up below): truncated browser text cannot establish exact
assertions; incomplete native trees cannot establish absence. Handles persist
in `state`, not as lexical REPL bindings. This work does not add platforms,
annotations, managed profiles or new permissions. Packaging/release validation
and resolution of intermittent Electron AX writes are outside this completed
API change.

## Follow-up review: reliability and agent effectiveness

Requested after the API replacement: identify what remains before claiming
world-class Local Control. The completed refactor establishes a cleaner public
contract. It does not establish broad task reliability or competitive agent
performance. The table tracks both remaining work and the implementation authorized in the
follow-up. See the follow-up acceptance record below for new evidence.

| Ticket | Priority | Improvement | Evidence and acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LC-08 | P0 | Complete uncertainty handling across every execution path | Code review: `controlRaw` checks existing uncertainty but does not record a new uncertain native failure; topology bookkeeping after dispatch is outside the dispatch catch. Reproduce each case with fault injection, then require consistent outcomes and no further affected-target mutation until fresh evidence. Preserve unrelated-target usability and avoid automatic replay. | Pending |
| LC-09 | P0 | Diagnose native Electron writes | Existing legacy live evidence contains one pass and two failures. Trace dispatch through the driver to renderer state, distinguish unsupported/background delivery from transient failures, and select an available page route before dispatch where appropriate. Run repeated cold/warm workflows with independent final-state checks and unchanged foreground. No blind fallback after an uncertain write. | Mitigated in public API; raw driver still fails numeric text. Page and Cocoa acceptance pass. Intermittent legacy driver failures remain unresolved. |
| LC-10 | P1 | Make observation and assertion reads narrowly scoped | Review finding: `expect` requested up to 1,000 nodes every poll with role/name-only selection. Add explicit container/frame scope, targeted exact-value reads and scoped completeness. Test duplicate labels in different forms, long values, virtualized lists and truncated unrelated content. Never recover an expired action ref by guessing a matching label. | Implemented exact container scopes, targeted browser reads and exact values; native reads still fetch up to 1,000 nodes. Virtualized lists and broader frame coverage remain open. |
| LC-11 | P1 | Remove unnecessary capture and transport work | Review finding: native `observe` did not explicitly pass `include_screenshot:false`; verify driver behavior and ensure a semantic read performs no image capture. Profile the page fixture regression (2.397 → 16.918 ms median) by driver, encoding, IPC and validation cost. Measure host reads, capture count, bytes and latency separately. Preserve boundary validation and exact evidence. | Implemented explicit no-image native reads and removed per-node schema construction; final measured evidence below. |
| LC-12 | P1 | Measure real agent task success and release behavior | The new live test covers two short fixture workflows and is not wired into the existing `test:local-control-e2e` package command. Add it to the appropriate acceptance entry point, then add held-out multi-step tasks, dialogs, uploads/downloads, multiple windows, reconnects, cancellation and long sessions. Use repeated runs, independent oracles, completion/false-success rates, foreground changes, tokens, images, latency and human interventions. Test the signed packaged app too. | Partial: repeated live two-form workflows and native/page fixtures; prior Conductor long-task evidence recovered. Packaged and broad cross-provider task evaluation still pending. |
| LC-13 | P2 | Finish the typed public contract and progressive help | Discovery and screenshot methods still return generic JSON; native/browser roles and discovery envelope fields differ. Provide explicit result types, concise examples and target capability information, with unsupported operations discoverable before dispatch. Generate help from the contract where practical and test examples against it. Prefer one coherent API over additional aliases. | Partial: scoped signatures and observed web-field input routes exposed. Generic discovery/result types and broader capability contract remain open. |
| LC-14 | P2 | Scope scheduling and invalidation to actual ownership | `controlTail` currently serializes most calls for one server, while raw calls invalidate every unified view. Establish which read operations and independent tabs can safely overlap, then use target/session ownership to limit invalidation and blocking. Native session/global effects must remain coordinated. Prove no cross-target retargeting, stale reuse or cancellation leaks. | Pending |

Remaining priorities: close LC-08, retain visibility into unresolved native-driver
behavior, and expand LC-12 beyond deterministic fixtures. Broader LC-10 coverage,
LC-13 and LC-14 follow measured caller friction and contention.

Screenshots with annotations, additional platforms, managed browser profiles
and lexical REPL persistence remain possible later work. The current evidence
does not justify prioritizing them over delivery reliability, targeted reads
and measured agent task success. A comparative Codex claim still requires a
matched evaluation; the bootstrap byte reduction alone cannot establish it.

## Follow-up acceptance: typing, scoped reads and capture cost

The user authorized these changes after asking for concrete explanations and
provider-neutral behavior. No further interview decision blocked the work.

- A live six-input audit reproduced numeric text corruption in the installed
  `cua-driver 0.28.0`: `00123` became empty through native AX, with or without
  explicitly focusing the field. The registered page route preserved all six
  inputs. The reference driver source attempts numeric coercion before string
  writes; it also documents renderer/AX disagreement. This does not establish
  the cause of every earlier intermittent alphanumeric failure.
- Public native observations identify web text fields by `AXWebArea` ancestry,
  independent of application name. Their native `setValue` is refused before
  dispatch, with the connected page browser exposed when available. The agent
  must claim and observe the correct page. Native refs never become page refs
  by label matching. Cocoa fields retain native input. Raw native writes remain
  diagnostic and are not claimed reliable.
- Page replacement no longer emits an intermediate empty input event. Browser
  exact-value reads use the matched control's backend identity, preserving
  actual empty and long values. Live forms reject intermediate emptiness and
  have duplicate Email/Save labels; repeated edits verify submitted state and
  the untouched second form through a separate fixture file.
- `within` and `match` are shared contract fields. Visible browser scoped reads use
  `Accessibility.queryAXTree`, skip layout metrics, and retrieve no screenshot.
  Hidden pages use a synchronous snapshot filtered before output; the combined
  live test exposed a rendering-dependent query timeout after a page handoff.
  Native scoped reads filter at most 1,000 driver elements, with incomplete
  coverage retained. Browser main-frame scope and native completeness limits
  are documented rather than hidden behind guessed targets.
- The profiler exposed repeated Zod schema construction for every returned
  page node. Schemas now validate at the boundary and are reused. Native
  semantic reads explicitly pass `include_screenshot:false`; a driver-spy
  regression checks zero image requests and no automatic post-action read.
- `npm run test:control-api-e2e` now runs the public acceptance fixture.
  `npm run audit:control-typing` deliberately exercises raw native writes too.
  The existing legacy e2e's final public Electron operation now uses an exact
  claimed page; its private native-driver diagnostics remain visible.

Codex reference: the installed browser plugin documents nested role/label
locators, strict targeting, fill, and explicit observations. Its behavior guide
asks for the cheapest relevant observation. The installed Computer Use API
exposes native setValue and explicit AX/screenshot reads. These API contracts
inform Mako's design; they do not reveal Codex's proprietary native typing
implementation or prove comparative reliability. Mako's methods run through
one shared server for all providers.

Prior complex sessions do exist: the September 14 Conductor audit traversed
nine settings sections and restored the main screen. Two final recorded passes
took 45.8 and 62.6 seconds, with unchanged foreground. Earlier variants include
failures. This is retained task evidence, not a new release or model comparison.
See [Conductor tasks](audits/2026-09-14/conductor-long-audit-tasks.json) and
[recorded runs](audits/2026-09-14/conductor-long-audit-final.jsonl).

The follow-up does not claim world-class reliability from fixture passes.
LC-08 uncertainty handling, held-out interrupted jobs, packaged release checks,
and broader capability/result typing remain visible above.

Follow-up evidence: [record and limits](audits/2026-09-21/local-control-refactor/follow-up/README.md),
[raw typing audit](audits/2026-09-21/local-control-refactor/follow-up/typing-audit.json),
[workflow run 1](audits/2026-09-21/local-control-refactor/follow-up/public-workflow-1.json),
[workflow run 2](audits/2026-09-21/local-control-refactor/follow-up/public-workflow-2.json).
Final transport medians: page 17.466 → 4.309 ms; native 9.889 → 8.148 ms.
The original pre-refactor page median was 2.397 ms, so this is a measured
improvement over the regression, not a claim that all overhead disappeared.

Final follow-up validation also passed the existing combined live workflow after
fixing hidden-page query stalls: 16 driver programs plus public page input and
assertion across a client handoff (180 ms), Cocoa keyboard checks, and unchanged
foreground. A third public workflow run passed on the final implementation.
See [combined workflow](audits/2026-09-21/local-control-refactor/follow-up/combined-workflow-final.json)
and [final public run](audits/2026-09-21/local-control-refactor/follow-up/public-workflow-final.json).
Control package tests, MCP suite, final host/browser tests, Electron compilation,
scoped ESLint and anti-slop checks passed. No signed build was installed.

## Background parity audit, 2026-09-22

Used the callable Codex browser/native APIs and Mako's public MCP API against
isolated local fixtures, with an independent desktop monitor. This is a macOS
capability comparison, not a matched performance benchmark (Codex Chrome versus
Mako Aside for external browsers). Production routing was not changed.

| Ticket | Finding | Status and acceptance gate |
| --- | --- | --- |
| LC-15 | Native exact-value evidence loses whitespace | **Confirmed correctness failure.** `expect(value:'東京 🐟')` matched while the real Cocoa field held `'  東京 🐟  '`. Reopens native exactness under LC-05. Preserve raw driver values; require both positive and negative exact-value tests. Do not normalize expectations to make them pass. |
| LC-16 | Native background keyboard parity | Codex Command-A selected all text and replacement landed without sampled desktop interference. Mako refused the command before dispatch. Improve and prove the exact-window native driver path before relaxing the refusal. |
| LC-17 | External-browser target detaches during replacement | Two fresh Aside runs completed two submissions and detached on the third `Input.insertText`. Cause unresolved; retain debugger/target lifecycle traces and require a complete passing repeat. Existing Electron page fixtures still pass. |
| LC-18 | Browser connection prerequisite in the public API | Standalone audit required host connection setup before `control.openTab`; public client has no connect method. Clarify the user-connected prerequisite or implement a typed agent connection operation without private escape hatches. |

Evidence: [comparison and limits](audits/2026-09-22/background-control-comparison/README.md),
[native false-positive](audits/2026-09-22/background-control-comparison/native-exactness-results.json),
[desktop monitoring](audits/2026-09-22/background-control-comparison/desktop-summary.json).
Browser-service and computer-host regression suites and the existing public
Cocoa/Electron-page live test passed again. These narrower passes do not establish
parity or override the new failures. Codex native Electron control was not scored:
the fresh intended fixture could not be bound through the available native API.

Native/background parity remains open. Prioritize LC-15 and LC-17 alongside
LC-08, then LC-16 with controlled foreground typing, multi-window, popup, hidden
window and clipboard tests. No focus guard was weakened to claim more support.


## Background fixes in progress, 2026-09-22

Work stays below the provider layer. Chromium discovery remains profile-based;
all external-browser reproductions used the registered Aside profile. The current
public API requires an explicit browser ID. Default-browser preference has **not**
been established by this audit; do not equate registration order with OS default.
The old Chrome-only live-test assumption is removed.

- **LC-15:** Shared driver candidate preserves raw AXValue, including empty and
  whitespace-only strings, without falling back to placeholder/display text.
  `value_exact:true` identifies that contract. Mako exposes `valueExact` and
  refuses exact assertions against older normalized values. Candidate passed
  342 Rust library tests (one ignored) and live public MCP positive/negative assertions for
  empty, spaces, padded Unicode, leading-zero numbers and tab/newline strings;
  an independent Cocoa state file agreed. Installed 0.28.0 remains unchanged.
- **LC-17:** A lifecycle trace caught another extension injecting its own iframe
  after text selection, immediately before detach. A controlled iframe-only
  reproduction caused the same detach without typing. Chromium's extension
  debugger permission boundary is the trigger; this is not a demonstrated Aside
  engine or Unicode defect. Router fixes retain tab ownership until `tabs.onRemoved`
  and preserve detach reason. In-flight detach now means unknown outcome, never
  rejected input or permission to replay. Browser restrictions remain intact.
- **LC-16:** An isolated driver candidate posts activation/key-window records only
  to the exact validated target. It never posts a defocus record to the user's
  process or calls SetFrontProcess. A freshly launched inactive Cocoa fixture
  selected 21 characters with Command-A, then a real `x` key replaced them.
  Desktop monitoring now includes WindowServer front PSN and AX focused-element
  identity in addition to app/window, pointer and clipboard counter. Public
  Command restrictions remain until broader acceptance; candidate is not installed.

Evidence and reproducible driver patches are recorded under
[`background-control-fixes`](audits/2026-09-22/background-control-fixes/README.md)
and [`vendor/cua-driver`](../vendor/cua-driver/README.md).


## Agent request failures, 2026-09-22

**LC-19: execution request contract.** Mako's own registered conversation databases
located the reported failure in the dev host journal. Its linked native transcript
records `source` together with `cell:"claude-timeout-hosts"`, then `source` together
with `cell:1`. The agent treated the continuation ID as a script label, then fixed
only its type. This was not evidence of an older string-cell API. A separate
recorded call used `code` instead of `source`.

The shared schema now publishes the exclusive source/cell alternatives, help and
errors show literal start/resume examples, and yielded receipts include their
actual numeric ID in a copyable call. Pre-execution validation errors report
`invalid-request` / `not-dispatched`, not unknown input delivery. Regression tests
include the recorded calls and prove that a malformed resume neither loses nor
replays the running program. The agent benchmark now offers the full tool catalog
and forwards/records actual arguments instead of replacing malformed calls with
an empty source. Live model reliability after these changes remains unmeasured.

See [session evidence and fixes](audits/2026-09-22/background-control-fixes/agent-request-shape.md).


## Background parity re-review, 2026-09-22

**Not ready to claim Codex parity or world-class background reliability.**
[Re-review](audits/2026-09-22/background-control-fixes/parity-review.md) distinguishes
source fixes, candidate-driver results and installed behavior.

- LC-17's cause and cleanup are fixed/understood; completing the original job
  under extension interference remains open. The regression expects interruption.
- LC-16 remains open: public Command shortcuts still refuse; signed integration,
  concurrent foreground typing and multi-window/hidden/popup acceptance are pending.
- LC-15 is corrected in the candidate and fails safely in the updated host with
  the old driver; installed lossless-value support remains pending.
- External Aside screenshot acceptance, OS-default Chromium selection, LC-18
  connection setup and repeated cross-harness job acceptance remain open.

Current installed driver version was rechecked as 0.28.0. This re-review introduced
no routing changes and did not rerun or claim a fresh matched live benchmark.


## Release integration and complete-job acceptance in progress

The user authorized shipping and acceptance on 2026-09-22. Driver fixes are now
rebased on upstream `cua-driver-rs-v0.28.2` (`fc188250`), with a distinct
`0.28.2+mako.1` local version. `vendor/cua-driver/release.json` pins the active
candidate. The initial rebase passed 368 macOS tests (two ignored); the new
exact-window key route also passed the shared core tests. Signed packaging is in
progress; the installed upstream application has not been replaced.

The new two-window job test caught `same_pid_keyboard_ambiguity` before dispatch.
The candidate now distinguishes keys delivered after exact native key-window
preparation from old process-scoped input, retaining visibility, identity and
per-process ownership checks. Live sibling-window acceptance is still pending.
A separate foreground fixture counts only its own tagged synthetic keys; it reads
no user keystrokes or other app text. A controlled foreground run is still needed.
External Aside screenshot diagnostics remain open; do not skip them and claim
complete acceptance.


### Signed candidate and job findings

The signed `0.28.2+mako.1` package passed six two-window native jobs plus popup,
minimized, hidden and closed-target refusal. Independent state confirmed one Save
per job and no sibling or popup field changes. Final libraries: 628 core and 368
macOS tests passed, two ignored. The public Command guard remains enabled; a
controlled foreground typing run is still pending. No installed app was replaced.

The normal Aside profile passed a background screenshot and three complete saves
in the longer browser job, then detached during Input.insertText. The job stopped
without replay. The running old extension still lost one task's cleanup ownership.
Fresh isolated screenshots fail in both headless and windowed profiles; normal
profile success does not close this gap.

Current evidence and release gates: [background-control-release](audits/2026-09-22/background-control-release/README.md).

### Native driver installed; browser boundary identified

Local `0.28.2+mako.1` is installed as `/Applications/CuaDriverLocal.app`, selected
by `~/.local/bin/cua-driver` for new launches. The actual installed selection
passed six native jobs with lossless edge values and all four refusal scenarios.
The upstream app and active daemons were preserved. Native Command restrictions
and the foreground-typing acceptance gate remain. See the release audit for
provenance, rollback and the distinction between installed files and active hosts.

The interfering frame belongs to Aside's bundled **Aside Browsing Agent**,
confirmed by its manifest key and the isolated trace. Expanded browser jobs fail
even in a fresh profile; do not label this a user-installed extension or claim
that ownership cleanup prevents detachment. A separate automation profile using
direct CDP is a pending user choice because sign-in/cookies would be separate.

The maintained direct-CDP test now also passes six saved jobs with a foreign
extension iframe deliberately loaded in the target tab. It verifies the frame's
DOM owner, continues editing that same tab, captures screenshots and cleans up.
This supports the proposed route without changing the user's profile policy.
The running existing-profile extension still hits Chromium's restriction; its
failed cleanup left one named local fixture tab, recorded in the release audit.

Pending user answers at this checkpoint: permission/timing for the bounded
foreground typing test, and whether to add the separate direct-CDP automation
profile alongside existing-profile control. The proposed route has now passed
its disposable-profile job test with explicit foreign-frame interference.
