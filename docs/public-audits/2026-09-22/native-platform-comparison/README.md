# Mac and Linux control: accuracy, background behavior and performance

2026-09-22. Comparison against the user-supplied
[Layers 3–4 report](../../../../../codex-cu-layers-3-4-deep-dive.md), installed
OpenAI JavaScript/docs, Mako main `82ebe0d`, and the pinned Cua driver source
`fc188250b4ca8549b8e61f937fdb1fb560770e86` plus Mako's release patch.
This audit adds documentation and a protocol-fixture probe. It does not alter
production routing, the installed extension, permissions, or foreground guards.

## Verdict

Mako already has the programmable shared client, persistent task state, batched
execution, explicit observations, strict scoped locators, exact window/tab
handles and uncertain-action protection described as major strengths in the
report. Replacing that architecture again would miss the largest problems.

Mako does **not** have demonstrated Mac/Linux parity with the reference. Mac has
useful tested background routes and a specific earlier Codex Command-A advantage.
Linux has substantial upstream driver code but concrete incompatibilities in
Mako's observation, capability and focus contracts. A Mac passing result does not
validate Linux. A background helper process does not prove background input.

Accuracy is the release constraint. Optimize elapsed time and tokens per
independently verified complete job. Track wrong-target input, false success,
text corruption, user interference, refusals and completion separately. A refusal
preserves safety but still counts against task completion; it must not disappear
from the denominator in a performance comparison.

## Corrections and boundaries of the reference report

- The installed Linux SDK invokes its own `sky_linux_<arch> server` process.
  It is not the macOS SkyComputerUseService under another API shape.
- Installed Linux docs expose window focus/modal/type, structured AT-SPI trees,
  an explicit X11 fallback, stable element IDs, targeted input and partial drags.
  These are API/source facts, not a live Linux reliability result in this audit.
- The installed Linux `ActionSettler` defaults to a deferred **100 ms** post-action
  delay. The report's roughly 1–5 second wait is not a cross-platform guarantee.
  The installed Mac JS delegates capture to the native service; it does not prove
  that precise native timing heuristic. Readiness and an intended outcome also
  remain different things: a quiet screen can contain an unsaved form.
- Linux's SDK keeps IDs stable by window and retains mappings during filtered
  reads. Mako instead resolves fresh semantic locators and scopes refs to an
  observation. Both can be valid; neither makes stale elements safe by itself.
- The broad action-confirmation taxonomy in the report should not be treated as
  proof that native app-approval IPC enforces every category. App access and
  authorization of a particular action are different decisions.
- Passive history, workflow recording and audio capture are separate products.
  They are not prerequisites for accurate background input. No passive recording
  was enabled, and adding it is not part of this proposed milestone.
- The reference extension's `Rh` interception replaces some HTTP(S) `window.open`
  calls with a navigation request and a minimal object containing `closed` and a
  no-op `focus`, or null. It also intercepts some anchor navigation. That can
  reduce foreground popups while changing WindowProxy/opener/named-window
  semantics. Its sophistication does not eliminate this correctness trade-off.

## What exists and what is missing

| Area | Mako today | Required next step |
| --- | --- | --- |
| Programmable agent API | Shared Node package, `state`, batched cells, explicit output, cancellation, bound native/page handles | Preserve; measure model task success and context cost across providers |
| Semantic targeting | Fresh strict locators; incomplete and ambiguous matches refuse | Driver-side scoped completeness and platform role/action normalization |
| Values | Mac lossless-value release and independent Unicode/read-back evidence | Linux raw editable text, empty values, truncation markers and exactness proof |
| Observations | Explicit text/image separation and explicit diffs | Preserve Linux states, actions, source, focused/selected text; incremental capture when supported |
| Capabilities | Native routes inferred mainly from window count, visibility and page binding | Driver-reported platform/backend/operation facts with tested guarantees |
| Mac input | Patched exact-window keyboard preparation; semantic routes and guards | Broader app/key-layout/IME coverage and public-route acceptance before relaxing guards |
| Linux input | Upstream AT-SPI, X11 synthetic events, MPX/uinput and compositor paths | End-to-end Mako Linux contract, packaged agent runtime, actual X11/Wayland test matrix |
| Rich operations | Shared core plus native/page raw escape hatches | Typed named AX action, text selection/paste and cancellable drag when backend supports them |
| Browser tasks | Extension-first, regular profiles, default-browser routing, children/groups/downloads | Broader child attribution, popup compatibility policy, durable recovery |
| Recovery | No uncertain replay; worker journal; idle update gate | Durable minimal ownership plus action outcome records across reload/host loss |
| Readiness | Explicit assertions; browser navigation waits; native guards | Bounded target-specific readiness, independent outcome assertions, no fixed global sleep |
| Distribution | Signed local Mac driver; Apple-silicon release workflow | Versioned Linux amd64/arm64 artifacts, compatibility negotiation and Linux release gates |

### Reproduced Linux integration problems

[probe.mjs](probe.mjs) exercises the compiled shared client and host foreground
check using source-derived Linux response fixtures. [Results](probe-results.json)
reproduce four problems with **zero mutations**. This is a protocol test on Mac,
not an X11/Wayland end-to-end run.

1. Linux `get_window_state` explicitly sets `elements_complete:false`: its bounded
   walker cannot prove exhaustiveness. Mako faithfully preserves that flag, and
   every new strict locator action then refuses, even a single visible Save.
   Do not fix this by asserting completeness or choosing the first match. Add
   an exhaustive scoped query with deadline/budget/omission evidence in the driver.
2. Linux structured elements do not provide `value_exact`; empty values are
   filtered out. The AT-SPI walker puts editable Text-interface content into a
   display name when the accessible name is empty, with a 4,096-character bound.
   Its numeric Value-interface field is a different source. Mako correctly
   refuses exact assertions on values explicitly marked display-only, but Linux
   does not yet provide the lossless editable-value contract those assertions need.
3. Linux `list_apps` always reports `active:false`. Mako's foreground guard
   requires `active:true`, so it refuses Linux foreground input before it can
   check the exact window. Replace that Mac-derived check with a driver-owned
   exact focus attestation and validation at dispatch, not removal of the guard.
4. `windowCapabilities` advertises background accessibility/pointer routes using
   visibility and window count, without a platform or backend argument. A visible
   Wayland window can therefore receive an unsupported capability description.
   Input refusal lower down is useful but does not make this help accurate.

Additional source findings: Linux roles are native strings such as `entry` and
`push button`; Mako removes `AX` and checks a Mac-only editable-role list when
choosing text routes. The driver exports action names, while Mako's normalized
observation currently drops them and much of the state/source information.
The Linux window serializer does not supply the Mac document-kind evidence used
for route decisions. These need a common semantic contract retaining the native
role/source as provenance, not per-app prompt workarounds.

### Mac acceptance is substantial but bounded

The earlier signed-driver suite exercised two windows, Command selection,
replacement, exactly-once Save and modal/minimized/hidden/closed refusals. The
995/995 foreground typing result applies to that native suite. The separate
regular-profile browser typing run failed after 28 tagged keys when Aside became
foreground. Do not combine those results into a claim of uninterrupted browser
background control. See the existing [release evidence](../../../audits/2026-09-22/background-control-release/README.md)
and [wayfinder](../../../local-control-map.md).

The driver source uses targeted SkyLight/CGEvent delivery and prepares the exact
background key window. This describes Mako's source, not an inferred private
implementation of OpenAI's binary. The earlier live Codex Command-A success is
specific evidence worth matching through Mako's public guarded API.

## Better background behavior without hiding correctness losses

### Browser popup ownership and behavior

First improve attribution, which does not require rewriting site behavior.
Mako currently inherits children from task-created parents via `openerTabId`;
claimed user tabs are a separate ownership case. Chrome's
[`webNavigation.onCreatedNavigationTarget`](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onCreatedNavigationTarget)
provides source tab/frame and created tab IDs. Combine corroborated browser events
and exact parent leases to account for child windows and nested frames. It is an
observation event, not a promise that the browser will prevent focus changes.

For ordinary agent navigation to a known URL, explicitly open an inactive task
tab. Keep real popup semantics for authentication, editor popouts, payment flows,
blank-then-written windows, `postMessage`, named-window reuse and downloads.
Do not return a counterfeit window object as the universal policy. Any limited
navigation interception needs its own compatibility contract and adversarial
fixtures before it becomes a default. Refocusing the user after an unwanted
popup is also not uninterrupted background control: intervening keys can already
have gone to the popup.

A fully general, focus-preserving popup guarantee for an arbitrary existing
Chromium profile is not established by the extension APIs inspected here.
Browser-native cooperation or an isolated desktop may be needed for the strongest
contract. Keep the user's regular-profile/default-browser preference; a separate
profile is not a requirement or a proposed replacement for it.

### Durable recovery

The current session journal is a real limitation, not an unavoidable one.
[Chrome clears `storage.session` on reload/update/browser restart](https://developer.chrome.com/docs/extensions/reference/api/storage#storage_areas);
`storage.local` persists until removal. Add a versioned minimal durable journal
(or equivalent shared-host journal), restricted to trusted extension contexts.
Store ownership, browser incarnation, exact tab/target IDs, retained state, owned
mute and pending-action outcome metadata; do not store page text or credentials.

On reconnect, negotiate protocol and a new connection generation, reconcile
identities, restore only extension-owned presentation state, and require a fresh
claim/observation before input. Never recover ownership from URL/title equality:
a restored tab after a browser restart is not automatically the original target.
Uncertain ownership means preserve and report, not close or actuate.

Persist action intent/completion where needed to distinguish not dispatched,
acknowledged, independently verified and unknown. A Save interrupted after
execution but before reply must stay unknown until its effect can be read; durable
state is not permission to replay it. Benchmark the write cost. Keep cursor frames
and repeated reads out of the durable journal; maintain idle update gating.

### Linux cloud jobs and shared desktops are different targets

For cloud jobs, provision a desktop/display and session bus per job or explicitly
cooperating job group, with a pinned browser/driver and application set. Then
native focus and popups remain inside that job. Use semantic controls and the
browser extension there too; isolation does not excuse wrong-target input or
incorrect saves. This is a proposed deployment architecture, not something Mako
currently ships as validated Linux control.

Bind control credentials and target identity to that execution environment as
well as process/window incarnation. A recycled PID/window number in another job
must never inherit authority. Cleanup must release held keys/buttons, owned
processes and recordings without affecting a neighboring job. Measure environment
startup and steady-state resource cost separately; a warm environment pool may
reduce startup cost only if per-job state and credentials are reset correctly.

On a shared Linux desktop, distinguish X11, XWayland and native Wayland. The pinned
upstream has X11/AT-SPI and MPX/uinput paths; it also explicitly refuses several
unfocused Chromium/WebKit/focus-only routes. Native Wayland is opt-in in that
source, with compositor-specific support. Do not flatten these into “Linux supports
background input.” Report the actual session/backend and operation guarantee.
Do not fix rejection by silently injecting into the globally focused widget.

## Accuracy and performance acceptance

Use the same fixtures, installed build, workload and output limits for the two
systems where accessible. Record unmatched transports/app versions as such.
Alternate A/B ordering, warm up, and separate driver time, observation time,
model round trips and whole-job time. The earlier Mako before/after hidden-tab
benchmark is not a Codex performance benchmark.

Required correctness evidence:

- Independent saved application/file/server state, including leading/trailing
  whitespace, empty strings, long text, combining characters and emoji.
- Repeated labels and scoping; dynamic replacement, stale refs, virtualized trees,
  disabled/offscreen controls, sibling windows, sheets and nested frames.
- Native and web input events where the application requires them. A matching
  field value is not sufficient if the application's save state never updated.
- Continuous tagged foreground typing with exact count/order/destination,
  pointer/clipboard and foreground-window monitoring; distinguish automation-only
  focus tests from genuine simultaneous user input.
- Reload/crash/disconnect before and after a side effect, cancellation mid-input,
  denied permissions, stale IDs and browser restore. No duplicate Save/replay.
- Linux GTK/Qt/Electron/browser apps on a controlled X11 desktop first; separate
  XWayland and compositor-specific Wayland suites, plus amd64/arm64 release checks.

Proposed initial release gates: zero observed wrong-target mutations, false
successes, data corruption or silent foreground escalation in the scored suite;
all deterministic supported fixtures pass. Count refusal/timeout as failed task
completion and investigate every reproducible failure. Zero observed failures
is not proof of zero failure probability: 300 independent zero-failure jobs give
only an approximate 95% upper bound of 1% by the rule of three; correlated tests
provide weaker evidence. Report sample sizes and repeat under different apps/load.

Measure p50/p95/p99 complete verified jobs, latency by operation, token bytes,
CPU/memory and hidden-tab rendering work. Propose a 10% p95 regression review
threshold on matched repeated workloads, not a correctness waiver or an absolute
microsecond target. A slower but demonstrably more correct route can win; document
why. Optimize scoped reads and event-driven invalidation before removing checks.
Keep full evidence accessible when output is compacted.

## Implementation order

1. Make driver facts honest and cross-platform: exact target/focus/backend,
   semantic roles/actions, raw values and scoped completeness. Fix the four
   reproduced incompatibilities; preserve refusal until the new evidence exists.
2. Ship a reproducible isolated Linux X11 environment and run full Mako MCP jobs
   through it. Build Linux release artifacts and a CI gate; add supported Wayland
   backends as separately proven capabilities. Continue Mac public-route keyboard
   and browser foreground-typing acceptance.
3. Add durable recovery and expanded browser child attribution. Inject failures
   at each ownership/action transition and prove cleanup without repeated input.
4. Add bounded readiness waits and richer typed operations where they remove
   repeated model work. Evaluate popup interception only for narrowly established
   semantics; keep native popups as the correctness baseline.
5. Run matched whole-job accuracy/performance comparisons. Claim parity per
   platform and supported workflow only after the corresponding installed suite
   passes. Record known exceptions rather than declaring universal parity.

## Reproduction and provenance

Run `npm run build:electron` then
`node docs/public-audits/2026-09-22/native-platform-comparison/probe.mjs`.
`MAKO_AUDIT_BUILD_ROOT` may name an already-built equivalent checkout. This audit
used `/Users/kashyab/mako-control-rollout`, whose tested implementation is integrated
in main. The probe deliberately supplies Linux-shaped fixtures; it does not
pretend that a Docker engine or a Mac-hosted unit test is a Linux GUI result.

[source manifest](sources.json) records exact local files and hashes. Installed
reference docs/source were read, not modified. No proprietary source is copied
into this report. Browser API claims use the linked Chrome primary docs.
