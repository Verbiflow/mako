# Local Control API

The public MCP surface is `mako_control_status`, `mako_control_help`, and
`mako_control_exec`. All providers receive this surface. Basic status, help,
and browser execution work without starting the native driver.

Start a program with `mako_control_exec({source: "return await control.browsers()"})`.
If it yields `{cell: 17, status: "running", ...}`, collect that same program with
`mako_control_exec({cell: 17})`. Supply exactly one of `source` or `cell`.
`cell` is the returned numeric continuation ID, never a script name. Do not
resubmit source to collect a running program. Invalid arguments are reported as
`invalid-request` / `not-dispatched`; that call did not start or resume a program.

`source` accepts an async JavaScript body. Await calls and return only the evidence
needed for the next decision. Save handles in `state` to use them in later cells;
ordinary errors preserve it, while cancellation and timeout reset the worker.
Top-level JavaScript declarations do not persist. A callback from a finished
cell cannot acquire a later cell's authority.

## Preferred browser

Choose and connect a profile in Settings → MCP → Browser use. The shared host
saves the preference for all providers. `await control.openTab({url})` opens a
new task tab there; passing `browser` explicitly overrides the preference.
No preference, an unavailable profile or a disconnected browser causes a refusal,
not fallback or automatic connection. Existing handles keep their exact browser.

`control.browsers()` includes `preferred`, `transport`, optional setup `guidance`
and optional `lastInterruption`. Guidance is not a live compatibility test. A last
interruption is historical evidence from that profile’s controlled tab, not proof
that every tab is broken. After uncertain input, inspect the exact page before
repeating an action. Compatibility diagnostics add no browser polling or captures.

## Select a target

```js
const inventory = await control.app({pid: 123}).windows();
const selected = inventory.windows.find(w => w.title === 'My document');
if (!selected) throw new Error('Document window missing');
state.window = control.window({pid: 123, window_id: selected.window_id});
return await state.window.observe();
```

Window selection is explicit. A missing window never falls back to another one.
`control.apps()`, `control.windows(pid)`, `control.browsers()`, and
`control.tabs(browser)` return discovery records. Read their fields before
selecting a target. Known targets can be bound directly without rediscovery.

```js
state.tab = await control.openTab({browser: 'known-browser-id', url: 'https://example.com'});
// For a discovered existing tab: control.claimTab({browser, tab}).
return await state.tab.observe();
```

Tab handles retain exact browser, tab, generation and lease identity. Defaults
retain the task/profile/background behavior of the browser service. Mako never
silently replaces an expired lease or retargets a closed tab.

## Act, then check the intended result

```js
const view = await state.tab.observe();
const email = view.get({role: 'textbox', name: 'Email'});
const receipt = await state.tab.setValue(email.ref, 'alice@example.com');
const proof = await state.tab.expect({
  role: 'textbox', name: 'Email', value: 'alice@example.com'
});
return {receipt, proof};
```

Window handles have the same observation, assertion and input methods. Native
roles omit the `AX` prefix (for example `TextField`); browser roles remain
browser accessibility roles (for example `textbox`).

Inputs include `setValue`, `activate`, `click`, `pressKey`, `scroll` and
`selectOption`. A receipt says `status: 'dispatched'` and
`verification: 'not-requested'`; it records route, delivery and guard evidence.
It does not prove a UI postcondition. Actions do not automatically read the UI
or replay input. `expect` polls observations, defaults to five seconds, and
never reissues the action.

Assertions compare the selected node's exact structured value or states.
Empty strings and false states are meaningful. Duplicate observed names fail;
an unrelated field containing the same text does not count. Absence requires
complete observation coverage. Truncated text cannot prove exact equality.
Positive evidence is scoped to the observed nodes, not global uniqueness across
unobserved UI. Inspect `coverage` when a tree is partial; narrow or use an
explicit backend read when a complete answer is unavailable.

## Choose a control inside a form

Use names and roles from the current observation. A scope is an ordered list of
containers, from outermost to innermost. Each container must have exactly one
match; ambiguity fails before input.

```js
const within = [{role: 'form', name: 'Shipping'}];
const view = await state.tab.observe({within, match: {role: 'textbox', name: 'Email'}});
await state.tab.setValue(view.get({role: 'textbox', name: 'Email'}).ref, 'alice@example.com');
await state.tab.expect({within, role: 'textbox', name: 'Email', value: 'alice@example.com'});
const buttons = await state.tab.observe({within, match: {role: 'button', name: 'Save'}});
await state.tab.click(buttons.get({role: 'button', name: 'Save'}).ref);
```

For an already-read full tree, `view.get({within, role, name})` selects locally.
Visible browser pages query the named subtree directly, without a full tree,
layout metrics, or screenshot. Hidden pages use a fresh synchronous accessibility
snapshot and filter it before returning: Chromium can stall asynchronous subtree
queries when rendering is throttled. This does not activate the page or capture
an image. `expect` requests at most two matches, enough to
reject duplicate controls. Exact browser text assertions read the matched DOM
control's current value, including empty strings, rather than inferring an
empty value from a missing accessibility property. Values still have an output
budget; truncated values cannot establish equality.

Native scopes currently filter a driver read of up to 1,000 elements. They save
returned context but do not avoid the underlying whole-window read. Incomplete
native reads cannot establish absence. Browser scopes currently address the
selected page's main frame; explicit frame observations remain available through
the browser backend. A scoped observation reports its `scope` and `coverage`.

## Type into web-backed native windows

Electron and browser windows may expose text fields through macOS accessibility,
but the installed driver can report a successful write that the page did not
accept. Native observations mark fields under a web area with `inputRoute: 'page'`
and, when connected, a `pageBrowser` discovery hint. High-level `setValue` refuses
these native refs with `page-input-required` and `outcome: 'not-dispatched'`.

Use `control.tabs(pageBrowser)`, select the exact inspected page, claim it, and
observe its own field before typing. Mako never converts a native ref to a page
ref based on a matching label. If no page connection exists, the operation stays
unsupported; it does not restart the user's app or silently change permissions.
Native Cocoa text fields continue to use accessibility. Raw driver calls remain
explicit diagnostic escape hatches and retain the driver's limitations.

Page replacement selects existing text and inserts the replacement in one edit.
It does not send an intermediate empty input event for nonempty replacements.
This matters for forms that validate or rerender on every input event. Clear-to-
empty remains a deliberate deletion. Always verify the intended result.

## Keep context small

An observation keeps `nodes`, `lines`, identity and coverage locally. Returning
the observation emits compact lines once. Return `.nodes` when structured JSON
is needed, `.select(...)` for a subset, or `.diff(previous)` for changed lines.
Diffs ignore ref churn; removed lines contain no actionable old refs.

```js
const before = await state.window.observe();
state.before = before;
return before.select({roles: ['TextField', 'Button'], max: 20});
```

No observation emits a screenshot automatically. Capture explicitly:

```js
state.shot = await state.window.screenshot();
emitImage(state.shot);
// In a later cell, only if this remains the latest capture:
// await state.window.click({x: 100, y: 80, view: state.shot.view});
```

Image output retains its view token and coordinate metadata. Native coordinates
are window-local capture pixels; browser captures supply their coordinate
metadata. New observations, captures, mutations, raw calls and known topology
changes invalidate the relevant prior refs/views. Obtain fresh refs after input.
Oversized output spills to recoverable artifacts under the existing output
budgets. `checkpoint`/`recall` retain bounded JSON facts; use artifacts for trees
and images. `state` is task-local memory, not durable storage.

## Failures and escape hatches

Control failures preserve a `code` and an `outcome` across worker and MCP
boundaries: `not-dispatched`, `rejected`, or `unknown`. An unknown outcome may
have changed the UI. Observe the affected target before deciding what to do;
do not retry merely because a transport failed. High-level input is blocked
after an uncertain dispatch until fresh evidence is obtained.

`window.events({after, limit})` reads bounded host events; tab events come from
the browser service. Event delivery itself does not verify a postcondition.

`tab.navigate`, `screenshot`, `upload`, `release`, `close`, and `cdp` expose
browser operations. `help({domain, method})` provides pinned CDP schemas.
`window.raw(name,args)`, `tab.raw(name,args)`, and `control.native(name,args)`
are explicit backend calls; `help({tool})` loads a native action's schema on
demand. Raw calls invalidate unified refs. Existing ownership, session,
foreground and backend validation still apply. Native launch with
`page_route: true` registers an Electron/Chromium page route.

`control.command({language,source,cwd?})` supports shell, AppleScript and JXA.
Inspect its result's `exit_code`, `timed_out` and output. Dispatch does not mean
the command succeeded. Control programs remain trusted local code, not an OS
sandbox.

## Migration

The old public `control.act`, `control.observe`, `control.wait`,
`control.advanced`, and `page` object are removed. Use bound handles, explicit
observations and explicit assertions. Internal driver/browser fixture runtimes
remain separate test adapters; they are not an alternative public API.

Implementation and acceptance evidence: [Local Control wayfinder](local-control-map.md).


Native exact-value evidence requires a lossless driver. The host marks older
normalized values `valueExact:false` and renders them as display-only. `expect`
refuses equality against those values immediately, including `states.value`;
it never trims expectations or rewrites a field to make an assertion pass.
The candidate driver contract emits `value_exact:true` only for raw AXValue.
Empty strings remain values, and placeholders never substitute for missing data.

An extension debugger can detach when another extension embeds a restricted
frame. The tab may still exist. An in-flight command then has an unknown outcome;
observe after deliberately re-establishing a connection, never replay the input
automatically. Mako retains ownership for cleanup until the tab actually closes.

## Scoped semantic locators and workflow helpers

```js
const form = state.tab.locator({role: 'form', name: 'Shipping'});
await form.locator({role: 'textbox', name: 'Address'}).setValue('42 Lake Street');
await form.locator({role: 'button', name: 'Save'}).click();
return await form.read({max: 40});
```

Locators store selectors, resolve a fresh exact match before each action and
refuse ambiguity or incomplete coverage before dispatch. They never retry input.
`read()` observes the selected subtree. Continue checking intended outcomes with
`expect()`; successful dispatch alone does not establish that a form saved.

`handle.capabilities()` describes the bound window or browser transport. Request
one section with `mako_control_help({topic: 'target'})` (see help's topic enum).

Name work with `control.openTab({url, name: 'Quarterly report'})`. Extension task
children appear in `tab.children()`; select an exact returned descriptor with
`control.claimTab(child)`. Page-created popups may activate a browser window.
`tab.retain('Quarterly report')` keeps a task result after cleanup and marks its
group Saved. Isolation contexts do not support retention.

`tab.download({url, directory, timeoutMs})` starts an HTTP(S) URL download and
returns its browser-issued ID and state. If still in progress, call
`tab.downloadStatus(id, {timeoutMs})`; do not start it again. Completed files are
copied into a unique subdirectory of `directory`; `browserPath` identifies the
original. Extension ref-triggered downloads are unsupported because arbitrary
page downloads cannot be safely attributed to a task tab.

## Record a tab or window

Recording is explicit and stays bound to the selected target and task:

```js
state.recording = await state.tab.record({
  name: 'Checkout verification',
  directory: '/absolute/path/to/evidence',
  cursor: true,
  maxDurationMs: 120000,
  maxSide: 1600
});
return state.recording;
```

Use the same method on `state.window`. Actions continue through the ordinary
handle. Recording does not add screenshots or video frames to observations or
model context. It draws a separate cursor from known mouse dispatch positions;
semantic actions without a dispatched pointer do not invent cursor movement.
The human's pointer is excluded from exact-window recording. The updated native
driver also records dispatched drag, move and scroll positions. Mac background
scroll and Linux XTest foreground drag/scroll have live acceptance; Mac foreground
drag, MPX and Wayland gesture recording still need separate evidence. Recording
does not relax an operation's foreground requirement.

```js
return await state.recording.stop();
// In a later cell, inspect completion without repeating stop or input:
return await state.recording.status();
```

`stop()` begins finalization. Receipts report `recording`, `finalizing`,
`finished`, `interrupted`, or `failed`. A finished receipt includes local MP4 and
JSON timeline paths. An interrupted recording can retain valid video plus its
reason. A failed receipt can leave partial source files in `directory` without
claiming they form a usable video. Task end and target loss stop capture.

The default duration limit is two minutes, configurable from one second to ten
minutes. `maxSide` defaults to 1600 pixels and accepts 320–2560. Frames and disk
usage are bounded; dropped browser frames are counted. Recording currently
uses bundled `ffmpeg` and `ffprobe` in the new macOS arm64 package;
development and Linux hosts require their runtime encoder dependencies. Native capture requires the updated
shared driver; macOS uses ScreenCaptureKit and requires macOS 15 or later for
video, and Linux X11 uses XComposite. Unsupported exact-window capture refuses
before recording a desktop. A native window resize ends capture with an explicit
interruption, retaining playable video when the encoder finalized it. Audio is
not recorded by this API.

`view.diff(previous)` only emits a delta for matching targets, document lineage,
scope and complete coverage. It returns the full current view when those cannot
be established, when order changes, or when the change budget is exceeded.
Native drivers without a document lineage therefore return full views.

The updated native driver adds optional `settling` to raw action results and
bound-action receipts on macOS. Its
`status` is `events_quiet`, `deadline`, or `unavailable`, with a
`process_notifications` scope and elapsed milliseconds/event counts. It observes
a 75 ms quiet interval, bounded to one second after the inner action returns.
An observer that has not serviced its event queue cannot establish quiet.
An app can omit
notifications or schedule later work: use `expect()` or another explicit
observation to verify a postcondition. Settling never upgrades `effect`.
