# Extension workflows and agent API

Implementation follows the [reference audit](../chatgpt-extension-design/README.md).
The reference inspired behavior and boundaries; no OpenAI runtime dependency was
introduced. All changes live in the shared control client, host and extension.
Default-browser discovery, regular profiles and explicit browser selection are
unchanged. No direct-debugging fallback was added.

## Implemented

- Semantic locators retain `{role,name,within}` rather than stale element refs.
  Each action performs one bounded scoped read, requires complete coverage and
  exactly one match, then dispatches once. `locator.read({max})` reads the selected
  subtree. Ambiguity reports at most five candidate descriptions. Failed input
  never retries. Public native/page tests independently verify submitted values.
- `handle.capabilities()` describes the selected native window's routes or page
  transport's workflows. Help accepts a single topic. In the MCP integration test,
  target-only help was 919 bytes versus 4,569 bytes for the full reference.
- A separate warm neutral cursor acknowledges actual debugger input. Its isolated
  world and closed shadow root protect it from ordinary page script/style access;
  it is aria-hidden and cannot intercept clicks. CSS motion respects reduced
  motion. No animation frames run continuously. Clearing hides it immediately,
  so screenshots never wait for a fade. Hidden/unfocused tabs issue no cursor
  commands; visible bursts coalesce. No typed text is passed to cursor rendering.
- `openTab({name})` labels task groups; `retain(name)` keeps a result after task
  cleanup. Grouping names the exact window, protecting against Chrome's default
  of grouping in another window. Group presentation runs outside the action's
  wait path. Mako does not rename groups containing unrelated tabs or a title the
  user changed. New background task tabs are muted until viewed or released;
  cleanup only restores a mute still owned by this extension.
- Page-created children of task-created tabs inherit ownership and appear in
  `children()`. An agent explicitly claims a child; retained children survive
  parent-task cleanup. Native popup semantics remain intact.
- URL downloads use `chrome.downloads` IDs, not URL/filename guesses. Completion,
  interruption and a still-running download are distinct results. A completed
  file is copied into a unique subdirectory under the requested destination;
  `browserPath` retains the original browser download. `downloadStatus(id)` waits
  on that same ID and completes the requested export without restarting it.
- Host and extension negotiate an explicit wire protocol before exposing control.
  Old/mismatched peers fail before dispatch. Lost connections invalidate handles,
  preserve an interruption explanation and never replay an action. A worker
  ownership journal detaches old sessions and restores owned mutes, preserving
  pages for inspection. Updates wait for actions and task-owned resources to end.
  Unpacked installations also check their own local manifest asynchronously; they
  do not depend on a store update event that local file replacement never emits.
- Electron-only builds now rebuild referenced packages. Previously a changed
  shared client could leave the runtime executing stale emitted JavaScript.

New extension permissions: `tabGroups` and `downloads`. Cursor rendering uses
existing debugger access; no blanket website scripting permission was added.

## Evidence

- `test:browser-extension`: native bridge, router ownership, protocol mismatch,
  owned audio cleanup, retained groups, worker recovery, idle update gating,
  exact download ownership/completion, cancellation and no repeated starts.
- `@mako/control` tests: fresh locator refs, scope, bounded ambiguity, incomplete
  coverage refusal and missing actionable refs; existing contracts still pass.
- Public MCP integration: native and page exact assertions, repeated labels,
  lossless Unicode/whitespace/long values, independent submitted values,
  persistent handles and explicit screenshots; foreground unchanged. Evidence:
  [public API evidence](public-api-evidence.json).
- Real Chromium extension: two browser restarts, six confirmed saves per round,
  canceled confirmations, foreign-frame detach cleanup, cross-client exclusion,
  stale handles and cancellation without replay. Popup → download → retain passed
  in both rounds, with exact downloaded Unicode bytes checked on disk.
- Cursor rendered in an isolated Electron fixture. See `cursor.png` and
  `cleared.png`; the latter is captured immediately after clearing. Page JavaScript
  cannot see its control function and the button under it remains clickable.
- The cursor boundary test sends 10,000 hidden feedback calls with zero debugger
  commands; a 10,000-call visible burst coalesces to six. This is a boundedness
  test, not an end-to-end latency benchmark.

## Performance and limits

Initial measurements exposed a tab-creation regression. Group presentation was
removed from dispatch waits and cursor work restricted to a focused window's
active tab. The final benchmark used 60 measured hidden-tab observations and
inputs per round, after five warmup pairs, across two browser restarts:

| Milliseconds | Before round 1 / 2 | After round 1 / 2 |
| --- | --- | --- |
| Read median | 3.12 / 2.49 | 3.17 / 2.71 |
| Read p95 | 9.17 / 4.30 | 15.60 / 9.80 |
| Type median | 13.95 / 7.79 | 9.39 / 8.13 |
| Type p95 | 99.56 / 20.31 | 54.22 / 46.86 |

Typical latency stayed similar; tails varied and read p95 increased in both
rounds. These sequential runs on a working laptop do not establish a general
speedup or isolate the cause of tail differences. Final tab creation median was
54.87 ms (16 samples), versus 50.17 ms in the earlier short baseline. See
[before](baseline-benchmark.log) and [after](after-benchmark.log) for exact runs.
Cursor feedback sent zero commands for 10,000 hidden actions and uses no animation
wait in input dispatch. Lint passed with five existing React warnings.

The extension deliberately refuses ref-triggered download routing before clicking:
Chromium's extension debugger rejects `Page.setDownloadBehavior`, and the downloads
API supplies no reliable tab-to-download mapping for arbitrary page-triggered
files. It accepts explicit HTTP(S) URLs. It does not infer which concurrent user
file belongs to a task.

Native page-created popups may activate a browser window. The work preserves
`window.opener`, named-window behavior and script semantics; it does not claim
background focus parity for every popup. Foreground browser typing, regular Aside
coverage of this iteration, and the first 0.2 → 0.3 installed-extension reload
still require deployment evidence. The worker journal uses `storage.session`;
it covers worker restarts, not a forced extension reload during an active task.
Chrome clears that store on reload/update/browser restart. Idle update gating
prevents the extension's own updater from causing that loss during a task.

Source validation and installed delivery are separate checkpoints. The old queued
app candidate must not be mistaken for this iteration.

The real unpacked-reload test detected an update, but Chrome disabled the reloaded
extension because Developer mode was off. The manual `--local-update --windowed`
fixture has not passed; do not count it as deployment proof. Unit tests cover
numeric version comparisons, same-version/downgrade refusal and active-task
update gating. Chrome documents that [session storage clears on extension reload](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Release checkpoint

Implementation commit `01360d6` is integrated into main as `df9129b`; unrelated
terminal/Git work remains untouched. Signed candidate `89c04a9f9814da4b` contains
extension 0.3.0. The [packaged verification](packaged-release.json) compares its
shared client, host and extension bytes with the tested output; deep signature
verification passed. The build began before the commit, hence its dirty build
stamp. It is the validated implementation, not the older queued candidate.

The installed host accepted the new candidate through its idle installer and
reports `{kind: "waiting", action: "install"}`. It still runs build
`1f2c6af3acd5149e` while this session is active. The old handoff disarmed; the new
bounded handoff watches only the authorized installation and cleans up the exact
idle registered helper after the old host exits. Its live receipt is
`~/.mako/browser-host-releases/5e421f03704df6b1/workflow-install-handoff.json`.
This is queued delivery, not installed or regular-profile validation. The first
0.2 → 0.3 extension reload remains necessary; old 0.2 does not implement the new
local-update check. Future idle updates use that check.
