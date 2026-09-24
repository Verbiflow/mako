# Local Control API

The public agent interface is the task-owned `mako-control` CLI for browser and
computer use. `mako-control --help` works offline; command-specific help includes
arguments, results, exit codes and examples. `api --topic examples` supplies
complete scripts; native schema help connects the driver only when requested.

```sh
printf '%s' 'return await control.browsers()' | mako-control exec --source-file -
```

`exec` takes an async JavaScript body and waits for its result. It never returns a
continuation ticket. Await calls and return only needed evidence. Keep handles in
`state` across commands; ordinary errors preserve it, while cancellation and
timeout reset the worker. Top-level declarations do not persist. Callbacks from
completed programs cannot acquire a later program's authority. Invalid arguments
report `invalid-request` / `not-dispatched` for that operation; earlier steps may
have completed. Correct only the failed step.

## Preferred browser

Choose and connect a profile in Settings → MCP → Browser use. The shared host
saves the preference for all providers. `await control.openTab({url})` opens a
new task tab there; passing `browser` explicitly overrides the preference.
No preference, an unavailable profile or a disconnected browser causes a refusal.
Use `await control.connectBrowser(id)` to connect an exact discovered target;
input never reconnects automatically or switches profiles. Existing handles keep
their exact browser.

For Mako development, match the `desk` browser’s `origin` and `sourceRoot` to the
requested checkout, connect its ID, then open a task tab there. This creates a
hidden view of that dev app without a Chromium extension or remote-debugging
prompt. A dev host launched with `--web` has no visible native window: zero
windows for its PID is expected, not a self-capture restriction. The hidden desk
is a separate view; use the actual browser page/window when the task requires
the user’s current visible state.

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

Image output retains its view token and coordinate metadata. Native
`window.screenshot({format:'jpeg',quality:90,maxSide:1024})` supports PNG/JPEG,
JPEG quality 1–100 and a 256–4096 pixel longest-side cap. The cap never enlarges
the source. Defaults preserve the driver's original image bytes. Unknown options
are rejected. `screenshot_out_file` remains available for an explicit native file.
Native click coordinates use the returned image pixels and its view token; the
engine maps them to the original driver capture. Do not rescale coordinates yourself.
Resizing does not enable an unsupported background input route. Browser captures
supply their own coordinate metadata. New observations, captures, mutations, raw calls and known topology
changes invalidate the relevant prior refs/views. Obtain fresh refs after input.
Oversized output spills to recoverable artifacts under the existing output
budgets. `checkpoint`/`recall` retain bounded JSON facts; use artifacts for trees
and images. `state` is task-local memory, not durable storage.

## Failures and escape hatches

Invalid caller input returns `code:'invalid-request', outcome:'not-dispatched'`
with a bounded field correction and example. Locators report `target-ambiguous`,
`target-not-found`, `incomplete-observation` or `target-not-actionable` before input.
These outcomes describe the failed operation, not earlier steps in a program:
correct that step without replaying prior writes. Backend failures after dispatch
remain unknown even if their cause is a response-schema error. Common examples
are available in `mako-control api --topic examples`; replace example labels
with exact names from your observation.

Control failures preserve a `code` and an `outcome` across worker and CLI
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
one section with `mako-control api --topic actions` (see help's topic enum).

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

Browser previews and recordings share a temporary CDP focus-emulation hold.
The first consumer enables it so an inactive tab can paint; the last consumer
disables it. Input actions share that hold, so finishing a click cannot freeze
an ongoing recording. No browser tab/window activation is requested. Text reads
remain unchanged. Embedders can choose `focusPolicy: "off"` when page focus or
visibility events must remain untouched; hidden capture may then refuse for lack
of frames. `"lease"` retains its explicit whole-lease behavior.

Aside acceptance restores both `document.hasFocus()` and visibility after viewing
or a screenshot, including transport loss/reconnect. After a CDP click, Chromium
can keep `hasFocus()` true while the tab is hidden, even after detachment. Mako
does not force a DOM blur or activate another user tab to conceal that difference.
The physical foreground samples and page focus are separate evidence.

Use the same method on `state.window`. Actions continue through the ordinary
handle. Recording does not add screenshots or video frames to observations or
model context. It draws a separate cursor from known mouse dispatch positions;
semantic actions without a dispatched pointer do not invent cursor movement.
The human's pointer is excluded from exact-window recording. The updated native
driver also records dispatched drag, move and scroll positions. Mac background
left/right/middle/double clicks and scroll have live event-count and recording
acceptance. Linux XTest foreground drag/scroll also passed. GNOME helper v9
provides exact-window screenshots and video while covered; minimizing the target
ends capture explicitly and retains playable partial video. Its capture source is
limited to five frames per second; the encoded video may repeat frames. Mac
foreground drag, MPX and Wayland gesture cursors still need separate evidence. Recording
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
minutes. `maxSide` defaults to 1600 pixels and accepts 320–2560. Source-frame disk usage is bounded; dropped browser frames are counted. Final
rendering streams RGBA frames to FFmpeg with backpressure rather than staging
another full set of PNGs. Static output lasts the recording duration rounded up
to one output frame; encoded 60 fps does not imply 60 distinct source frames. Recording currently
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

Mac action results may also include `focus_change` with `previous_pid`,
`current_pid` (nullable), `restoration_attempted` and `input_activity_observed`.
This reports an observed interruption, including one that was restored before
return. Input-state activity is a conservative signal to stop restoration; it
contains no key contents and does not prove a physical keypress. Restoration is
reactive and can race a later user switch. An absent report does not guarantee
uninterrupted focus.

After `focus_change`, the shared host requires a new observation of the target
before another unified mutation. Read the actual result before choosing what to
do next; never repeat the previous input simply because focus changed. `guard`
reports the bounded window-topology watcher, not focus isolation.

## Capture and composable commands update (2026-09-23)

`view.select({role,name})` uses the same exact semantic fields as `get` and
`locator`. `text` still searches accessibility role/name/value, not arbitrary
visible DOM text. Selectors use strings, not regular expressions.

```js
emitImage(await state.tab.locator({role:'button',name:'Save'}).screenshot({maxSide:2048}))
state.recording = await state.tab.record({name:'Save workflow',fps:60,maxSide:1920})
return await state.recording.stop()
```

Recording start requires a real persisted frame. No-frame startup refuses without
activating or moving the tab. `stop()` begins finalization; poll `status()` until
finished/interrupted/failed, then use its file paths and encoded `dimensions`.
`sampledFrames` counts intentional fps sampling separately from `droppedFrames`.
Timeline v2 records actual pixel dimensions separately from viewport geometry.
`maxSide` is a cap, not a source-resolution or devicePixelRatio override. Browser
sampling/output supports 1–60 fps and defaults to 60; native recording negotiates the installed driver/backend ceiling (up to 60), with older drivers fixed at 30. GNOME PNG capture remains limited to 5 until continuous capture is implemented. The shared browser video source fits within 1920×1080; this changes neither the page viewport nor explicit screenshot detail. Preview delivery also targets 60 fps. Actual source cadence and renderer presentation can be lower; output fps alone does not prove distinct captured frames.

Opening an unsupported external URL in a desk browser refuses before creating a
window. When creation succeeds but navigation fails, `TabNavigationError.target`
retains the exact owned target for `control.tab(error.target)`. Do not repeat
`openTab` to recover it. A hidden desk remains a live client of the real app;
it is not a sandbox for stubbing side-effecting modules.

The [composable CLI design](local-control-cli.md) shares this engine. Both desktop and Linux task supervisors expose the same command interface.

## Recovery after interrupted actions

An unknown outcome means input may already have reached the app. Mako does not
replay it. Observe or capture that exact target successfully before continuing;
a failed screenshot or a reconnected native driver does not count as evidence.
If a raw native call did not identify a window, observe the intended window and
continue through `control.window({pid, window_id})`. Reading one window cannot
clear uncertainty for other windows or authorize another unspecified destination.

Read-only helpers such as `tab.children()`, download status and dialog inspection
preserve existing refs. Mutations invalidate the affected target's refs. An
observation overlapping an explicit concurrent CDP mutation is rejected; wait for
the mutation, then observe again. Dialog replies and event reads can run while
navigation is waiting. Answering a currently open dialog does not verify or retry
the preceding action.

Cancelling exec stops its script worker; any dispatched action still needs
observation before further input. A cancelled recording finalization waiter does
not discard the recording; inspect its exact receipt through record status.

## Shared shell session and browser-wide ownership

[Composable CLI commands](local-control-cli.md) use `createControlSession` through
a private Unix socket. The desktop supervisor supplies the exact CLI/session to
the provider at task launch; Linux session start returns its descriptor.
Shell commands preserve the same target generations, refs, recordings and script
state. `diagnostics` returns bounded command/request metadata without arguments
or page contents. A normal shell command exiting does not close the engine.

Cookie mutations affect the browser profile. They refuse while another task owns
tabs or target acquisition/actions are pending; reads never silently grant a
profile write. A pending cookie write blocks concurrent browser work. An unknown
write invalidates evidence for every affected tab, including later claims, until
each exact tab is observed. Raw `Browser` administration, `Storage`, profile cookie/
cache mutation and unmanaged `Target` lifecycle commands are refused through a
tab CDP handle. Use managed cookies and open/claim/release/close instead.

Dynamically attached app browsers belong to the attaching task. Other tasks
cannot connect to, claim through or detach them; aliases for an already registered
endpoint are refused. Task teardown releases those connections. Discovered regular
browsers remain shared, and website-side profile state is not a security boundary.
