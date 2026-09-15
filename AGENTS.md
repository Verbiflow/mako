# Mako

Mako is a meta-harness. Claude Code, Codex, Cursor, Grok, Devin, and OpenCode
are peer providers with provider-owned control and observation transports. No provider
is privileged in public types, bridge names, UI language, continuation, or
session handling.

Mako has no embedded coding-agent runtime. `electron/host.ts` owns only the
workspace and git boundary; every coding agent runs through a provider-owned
process. Never expose Pi as a provider, bridge, IPC namespace, message type,
UI label, or "native" path.

`ignore/` is reference-only and gitignored: DeepSeek Harness, Pierre, T3 Code,
ORCA, Codex, Zed, Superset, OpenCode, macOS Harness, CUA, and Browser Use.
Study material, never imported or edited.

Prior art worth knowing: ORCA's sidebar flattens groups into a `header | item`
row list with a user-selectable group-by, which is what `rail-rows.ts` follows.
Codex's "backtrack" (Esc-Esc) navigates your past prompts to fork from one,
which is what the turn navigator and each prompt's Edit and Fork controls are
for. There is no separate History or Context sidebar: rewind and fork live on
the transcript's exchanges, and token or spend readings appear only where a
provider reports exact numbers (Settings > Usage), never as a per-thread panel.

## Layers

One direction of knowledge, no exceptions:

1. **Host** (`electron/`) owns the agent runtime and git. It speaks one wire
   contract, `electron/shared.ts`, and nothing else crosses the boundary.
2. **State** (`src/state/`) is React-free. `store.ts` is the observable;
   `session.ts` applies host events and owns every mutation the UI can make.
3. **Components** (`src/components/`) are presentation. They read through
   selectors and call domain actions in `src/state/`. Components and desk code
   never import `src/lib/bridge.ts`; ESLint enforces that boundary.

## Provider composition

A provider is installed once from `electron/providers/<id>/index.ts`. That
module contributes independent capabilities to `providerHost`: metadata and
model discovery, native and ACP execution, native session emission, accounts,
MCP discovery/writes, and skill roots.
Consumers query those registries; they never maintain another list of provider
ids or branch on all known providers. Provider-specific wire syntax and paths
belong under that provider's directory. A new provider adds one module to
`electron/providers/index.ts`; it does not add switches to shared consumers.

`@mako/sessions` remains the pure native-store layer. Its `SessionProvider`
contract owns discovery, translation, and following without importing Electron
or any provider host capability.

Exact external activity is also provider-owned. A process probe returns a typed
`available` or `unavailable` snapshot keyed by native session ID or canonical
store path; an error is never interpreted as zero active sessions. The activity
engine polls each provider independently, prevents overlap, bounds stale data,
and emits narrow activity events instead of resending or re-sorting the catalog.

A probe sees a process, not a turn: Cursor's `cursor-agent` and another Mako
host hold their stores open whether or not anything is running, so a reopened
client once showed a streaming session as merely "open" and lost its working
mark. `electron/thread-activity.ts` derives what the probe cannot say: a store
whose bytes or activity stamp moved within `WRITE_ACTIVE_MS` (45 s, long
enough to outlast a tool call that writes nothing) while a probe reports it
`open` or another host's hold names it is `active` with `evidence: "writes"`.
The renderer never treats that evidence settling as a finished answer; only a
process's own word on a turn notifies. `cursor-agent` is a shell wrapper, so
its open files are listed under `node`. Store writes are seeded from
`updatedAt` at boot so the first paint after a restart is right.
`scripts/test-thread-activity.ts` covers the promotion, settle, and identity
rules.

## The hot path

Token streaming must never re-send the session. The host emits `stream` with
only the in-flight message; `messages`, `tree`, and `git` go out only when they
actually change, and every burst is coalesced into one flush per frame. On the
renderer side components subscribe through selectors, so a token wakes the one
turn rendering it — not the rail, the stage strip, or the titlebar's readings.

Three rules hold this together, and each has a specific failure it prevents:

- **Select the narrowest slice.** `useSession((s) => s.meta)` in the transcript
  re-renders the whole list whenever a token count moves. Take `s.meta?.cwd`.
- **Reconcile message identity** (`src/lib/reconcile.ts`). The host rebuilds
  the entire message array whenever a tool returns, so every object arrives
  new; without reconciliation one tool result re-parses the markdown of every
  turn in the session.
- **Long lists are virtualized, long content uses `content-visibility`.** The
  rail is windowed with `@tanstack/react-virtual`; transcript turns and
  surface-panel rows carry `.contain-turn`. Timelines above 200 turns and
  navigators above 100 prompts additionally window measured rows. Preserve
  prompt identity, prepend anchors and complete answer-copy data. Only actual
  user scrolling may release follow mode; virtualizer size adjustments must not.
- **Streamed prose is throttled, not debounced.** `useThrottled` in
  `markdown.tsx` repaints a streaming answer at most once per
  `STREAM_FRAME_MS`, and a pending frame survives further tokens (cancelling
  it per token would never fire under a steady stream). Only unmount clears
  the timer, and clearing must empty the ref: StrictMode's simulated remount
  once ran that cleanup, re-ran the scheduling effect against a ref that
  still looked pending, and every answer sat on its first character until the
  turn ended ("I", then the tool rows). `test-workspace-ui.mjs` streams a
  reply and requires the prose to catch up while the turn is still running.

The rail bounds mounted rows through folder pagination and an explicit search
result cap; it never renders the full catalog. Components that genuinely use
`useVirtualizer` stay isolated because the React Compiler cannot memoize them.

Native JSONL files can contain multi-gigabyte tool output. Readers must cap one
record before retaining it, skip into a tail from the next newline, and collect
bounded chunks before one final concatenation. Never carry `Buffer.concat`
through a loop. Catalog scans use bounded concurrency, and provider metadata
queries select only the native session IDs being peeked rather than hydrating a
whole provider database. A file that grew reuses its cached ref only when that
ref already has a title and a model; a session captured before its first prompt
(Codex writes `session_meta` first) is re-read, and providers with a separate
title store (`refine`: Codex's state database, Claude's appended `ai-title`)
update the reused ref. While watching, followed and recently updated files are
stat-ed every 15 seconds so a missed watcher event cannot leave a row at its
first kilobytes. `test/catalog-growth.mjs` covers these.

A write refreshes one file unless the provider's `rescanRoot(path)` says the
path belongs to a shared database (Devin's `sessions.db`, OpenCode's, Cursor's
desktop `state.vscdb`); Cursor's SDK and `cursor-agent` stores are one SQLite
file per session and refresh alone, with `watchTarget` folding `-wal`, `-shm`
and `meta.json` writes onto their `store.db`, an SDK `index.db` write onto
the store of the agent it moved for, and `stat` reporting a revision that
covers all of them. Logs, shell transcripts and extension storage beside a store
are ignored, never a reason to rescan. Refreshes are throttled with a settle
window (`rescanDebounceMs`, at most four windows of latency under a
continuous stream), a refresh that changes nothing a rail can show emits no
event, and the archive captures a live session when it settles for three
seconds or once a minute while it streams. Cursor's follower reads the root
blob's hash list and re-folds only from the exchange that moved; this once
re-read the whole provider — every store stat-ed, the desktop header table
queried, the followed store folded entirely — on each write of each running
`cursor-agent`, 24 ms after the write, on the host's main thread.

A row's `updatedAt` is when the conversation last moved, which is not
always when the file did. Claude Code appends `last-prompt` and
`cost-state` records when a resident CLI exits, so every host restart and
every install once bumped each idle Claude session to "now"; an open Grok
TUI rewrites `summary.json` every minute. Claude stamps rows from the newest
message's timestamp and declares `activityFromContent`, which keeps the
catalog from re-stamping a grown file until `refine` finds a message in the
appended bytes; Grok stamps from the transcript's mtime and ignores the
sidecar's stamps. `test/activity-stamps.mjs` covers both. Claude Code stamps
messages it composed itself ("API error", "no response requested") with the
model `<synthetic>`; that is never a row's model (`test/claude-title.mjs`).
`ClaudeProvider` honours `CLAUDE_CONFIG_DIR` only for the default home: a
provider built on another home is an isolated world and reads nothing from
the process environment. A shell inside Claude Code or a router sets the
variable for its own store, and `catalog-growth.mjs` once listed the
developer's real sessions among its fixtures and failed on one of their
titles (`test/catalog-growth.mjs` covers both readings).

## The built-in runtime's session tree is not a tree

It is a parent-linked chain: every entry is a child of the previous one, so
nesting depth grows once per *entry*, not once per branch. A real session is
345 entries nested 334 deep, with 7 user turns and 45 model/thinking changes.

This has bitten twice. Rendered as written it is a staircase that runs off the
right edge. **Serialized as written it exceeds Electron's contextBridge clone
depth of 1000** and the window dies with a recursion error. The wire format is
therefore a flat `TreeNode[]` carrying `parentId` and `childIds`; never
reintroduce nesting.

`src/lib/thread.ts` is the translation: it collects user turns from the whole
tree, folds settings into the turn they applied to, and expresses real branch
points as alternate "takes" rather than as indentation. Turns are gathered from
the entire tree and not just the live path, because navigating away leaves
earlier turns on an abandoned branch and those are exactly the ones worth
rewinding to — sessions exist whose live path contains no messages at all.

## Extending the desk

Four registries, all in `src/extend/`. Everything the desk itself ships is
registered through them, so nothing built-in is privileged:

```ts
registerCommand({ id, title, section, keys: "mod+j", run })  // palette + keyboard
registerSlot("my-badge", "composer.controls", Component)      // UI seams
registerToolView("bash", { summary, body, icon })             // transcript rows
registerSurface({ id, label, icon, render, minWidth })        // stage companions
```

The stage's surfaces — Changes, Files, Terminal, Control, Agents —
are all registered through `registerSurface` on exactly the same footing as
anything a plugin would add. One reading surface opens as the right sidebar at
a fixed, draggable width; the independent Terminal dock can remain open below it
at a fixed, draggable height. Neither uses percentage splits. The central workbench
stays mounted under a covering sidebar so transcripts and file tabs keep their state.

Files loaded from the user-data extensions directory are **trusted local UI
extensions**, not sandboxed host plugins. They can read and mutate renderer
state, are bounded by file/contribution limits, and cannot register host
providers. Do not describe them as isolated or safe for third-party code.

Slots are declared in `SlotMap` (`src/extend/slots.ts`) — that table is the
contract for what may render where and with which props. Adding a seam means
adding a key there. Built-in registrations live in `src/desk/builtins.tsx` and
`src/desk/use-desk-commands.ts`.

A command with a `keys` field is automatically live in the palette, in the
keyboard layer, and in any menu that reads the registry. Never add a bare
`keydown` listener for a shortcut.

## The transcript is grouped by exchange

Built-in sessions, native-store threads, and live ACP/app-server sessions all
project into `ChatMessage` and render through `conversation-timeline.tsx`.
Provider-specific headers, permissions, and modes may wrap that timeline; they
must not introduce another transcript renderer.

`src/lib/exchanges.ts` folds messages into one question plus everything the
agent did to answer it. Two things depend on that grouping and both were wrong
before it existed: **copy belongs to the whole answer**, not to each fragment
of a long reply, and the turn navigator needs something meaningful to jump
between. The prompt gets its own surface so it is unmistakably the user's.

An answer's file names are links. `inlineFileTarget` (`src/lib/file-citations.ts`)
turns inline code into one when the whole span reads as a path with a known
extension, alongside the providers' own citation forms. Most of those names
carry no directory, because prose says `use-row-flip.ts`, so
`WorkspaceFiles.locate` resolves a relative request against the workspace root
first and then by *suffix* against the tracked file list: one match is the
answer and `FileContents.path` reports it, so the tab, its refresh, its `@`
mention and Open in your editor all name the file that was read. Several or
none is a sentence naming what was looked for; an absolute request is taken
literally. Before this, clicking `test-notifications.ts` in an answer read
nothing and showed
`Error invoking remote method 'mako:read-live-file': Error: ENOENT … stat
'/Users/you/project/test-notifications.ts'` — a path nobody typed, about a
file that was one directory away. Electron's IPC wrapper is stripped in
`createMakoBridge` so no host error reaches a reader wearing a channel name,
and so the desktop and local-web transports say the same thing; the error
object is never replaced, because `runtime-retry.ts` decides by `instanceof`.
`scripts/test-file-open.ts` covers both halves.

## Never lose a paragraph

A draft is the one thing in the desk the user made and cannot get back. Every
other state — the diff, the tree, the token count — is recoverable by asking
again. So the composer clears optimistically, because typing the next thing
should be instant, and `drafts` in `composer.tsx` keeps the text per session so
switching tabs mid-sentence costs nothing.

Restoring a refused send is where this gets subtle, and the trap is timing.
`session.prompt()` does not resolve when the prompt is *accepted*; it awaits
`_runAgentPrompt` and the whole `continue()` loop, so an awaited `send` settles
minutes later, when the answer is done. Restoring a draft on that promise
overwrites the paragraph the user has since typed — losing work in the name of
saving it — and can paint it into whatever session is on screen by then.
Rejection is a *preflight* fact (no model, no key), so read it from the
built-in runtime's `PromptOptions.preflightResult` and settle in one tick, while the composer is
still provably empty. Anything that repaints the textarea later must first
check that the draft is still empty and the session has not changed; otherwise
leave the text in `drafts` and say so.

The same rule covers the quieter losses: `buildPrompt` silently omits an
attachment that is still `pending`, so sending mid-staging drops a file with no
notice, and `clear()` revokes preview URLs — which is why detaching for a
possible restore is separate from discarding for good.

## MCP

Mako owns a redacted, provider-neutral MCP registry. Use the current
`@modelcontextprotocol/sdk` and its latest negotiated protocol (currently
2025-11-25); do not hand-roll legacy SSE framing. Streamable HTTP is the remote
transport, stdio is the local transport, and tool annotations must accurately
state read-only, destructive, idempotent, and open-world behavior. Provider
OAuth remains provider-owned. Never send secret values over IPC, logs, tests,
or registry snapshots.

## Browser and computer control

Each control server is three tools: `status`, `help` and `exec`
(`mako_browser_*`, `mako_computer_*`). `exec` runs trusted async JavaScript
in a `worker_threads` Worker (`control-program-runtime.ts`,
`control-program-worker.ts`, shared by both servers) with a `browser` or
`computer` object whose methods are the actions; a single action is a
one-line program and a workflow is several awaited calls with plain
JavaScript between them, so an observation the model only needs to decide
from never enters its context. Every action still passes the host's own
checks (session, snapshot, path, foreground, preview), because the worker
only forwards commands to the same `call` the direct tools used. `help`
generates the API reference from the live schema (`BrowserCommandSchema`;
the driver's own tool list) so the catalog costs 4 KB rather than the 177 KB
that 94 per-action tools did; `docs/audits/2026-09-14/control-runtime-baseline.md`
has the measurements against the prior surface and
`scripts/benchmark-control-runtime.ts` re-takes them. The macOS harness
server (`mako-local-tools`) is gone; the driver does everything it did.

Output is never cut. A returned or logged value at or past
`INLINE_TEXT_BUDGET` (200 KB), a run's inline text past
`INLINE_TOTAL_BUDGET`, and every image after the `INLINE_IMAGE_COUNT`th are
written whole under the task's artifact directory
(`control-artifacts.ts`: `MAKO_CONTROL_ARTIFACTS` or the temp directory,
keyed by `MAKO_TASK_ID`) and the result carries a receipt with the path,
size, hash and an outline of the value's shape; `artifacts.save(name,
value)` lets a program keep something on purpose. Before this the prior
program surface failed a run whose output passed 200 KB (`output-limit`,
outcome unknown, every action already taken in it lost) and the direct
computer tools put a 300 KB tree into the model. What a program returns
crosses the port as JSON: an object with an `undefined` member once failed
the host's message schema as "invalid message" and lost the run, so the
worker round-trips every output and names a value JSON cannot carry. A
computer action resolves to the driver's result with the text echo of
`structuredContent` removed, otherwise a window state returned whole cost
twice. `test-browser-runtime.ts`, `test-browser-tools.ts` and
`test-computer-tools.ts` cover the surface, the spill, the receipts and
the preflight checks inside programs.

Keyboard input to a backgrounded Electron or Chromium renderer does not
land. Measured 2026-09-14 with `scripts/test-local-control-e2e.mjs`
against an Electron fixture behind the user's window: a pid-posted click
lands and `set_value` through accessibility writes the field, but
`hotkey`, `press_key` and `type_text` posted to the pid are dropped with
`escalation.reason: "delivery_failed"` and the renderer's value does not
move. The wrapper marks that result `mako_routes.status: "not-delivered"`
and names the routes that work (`set_value`, `invoke_menu`); a combo the
driver merely could not read back is `unverifiable`. `invoke_menu`
activates a menu item by fronting the app for the activation and restoring
the previous frontmost app itself, so it needs a menu bar (the fixture's
`MAKO_FIXTURE_POLICY=regular`) and is refused without one. The ladder in
`BACKGROUND_INPUT_LADDER` and the server instructions say this in order;
`delivery_mode: "foreground"` is the only keyboard route into a renderer and
is refused while the window is not frontmost. The e2e asserts the frontmost
pid before and after every program.

`computer-tools-main.ts` wraps the native driver (`cua-driver`, an external
install under `/Applications/CuaDriver.app`) and repairs what the driver gets
wrong for agents. The driver refuses an output path whose deepest existing
parent is a symlink (`/tmp` on macOS), so `computer-paths.ts` realpaths that
ancestor first. A driver session dies with the MCP transport that created it
and cannot be revived from another, so the wrapper mints a per-connection id
(`mako-<task>-<nonce>`); never reuse a fixed id across reconnects. The wrapper
remembers which pid and window produced each snapshot so an `element_token`
alone is enough, defaults `max_elements` to 300 and drops `tree_markdown`
because Electron trees otherwise exceed a provider's tool-result limit, and
reads a `screenshot_out_file` capture back for the preview. Rust schemas carry
`uint32`/`double` formats that every MCP client warns about; `driver-schema.ts`
rewrites them into ranges before compiling and before republishing.
`VERIFIED_CUA_DRIVER_VERSION` in `cua-driver-version.ts` is the release whose
embedded contract was checked end to end; Settings offers the driver's own
`update --apply`, which stops running daemons, so the host restarts the embedded
driver afterwards and tasks get a new session on their next call. The driver
cannot scroll Electron windows in the background and foreground input contends
with the user, so the desk itself is reached through the browser tools instead.

Browser actions publish input-mode JSON Schemas (defaults optional, every
field described, `$defs` kept) through `help`. Input is real:
click moves, presses with a buttons mask and releases on its own budget; type
checks editability and can clear and submit; press covers the keys insertText
cannot. Observations carry element states, viewport scroll context, paging
(`offset`/`nextOffset`) and short per-observation refs. The navigation waiter
marks its event boundary before dispatching `Page.navigate`: the reply and the
new document's lifecycle events can share one frame. Wheel scrolls settle on the
compositor, so the scroll position is read after it stops moving. A malformed
frame is dropped, never allowed to close the shared socket. An open JavaScript
dialog blocks every action on its tab except `dialog`, `events`, `release` and
`close`; a per-tab `auto` policy answers dialogs as they open and records the
answer as a `mako.dialogAutoHandled` event through the connection's cursor
sequence. Downloads use `Page.setDownloadBehavior` so they work over the
extension transport, which has no `Browser` domain; the desk browser maps
`Page.printToPDF` onto Electron's own printer because its debugger lacks it.
Cookie listings omit values unless `includeValues` is set. `wait` polls inside
the page in slices shorter than the request timeout, and `networkIdle` counts
requests from `Network` events, so only network events the tab really emits
belong in a fixture that tests it.

The browser with id `mako` (`desk-browser.ts`) is Mako itself: hidden 1600×1000
windows of the desk exposed as page targets over a private loopback bridge,
capped at four, reaped after thirty idle minutes, never counted as a client that
keeps a profile host alive, and navigating only to the exact desk document
(`desk-browser-policy.ts`). It exists so an agent can inspect or capture Mako
without touching the window the user is in. Scripts run there inside the
trusted renderer with its host bridge; it is a convenience for the user's own
agents, not an isolation boundary, which is why the URL policy is exact. `test-desk-browser.ts`
covers the bridge with in-memory pages and `test:desk-browser-electron` drives a
real hidden window.

## How a renderer loads

The packaged desk is `mako-app://desk/index.html`, never a `file:` URL
(`desk-scheme.ts`, `desk-protocol.ts`). Chromium keeps no V8 code cache for
`file:` scripts, so every window compiled the whole bundle on every launch;
the scheme is registered `standard` with `codeCache`, and one launch fills
`Code Cache/js`. The handler serves only files under `dist/` through
Electron's file loader, and the desk-browser policy admits only the exact
document path. The scheme is also the storage origin: `renderer-storage.ts`
moves the `file://` origin's localStorage (drafts, preferences, review notes)
across once per profile through the blank `storage-bridge.html`, records a
marker only on success, and deletes nothing. In development the desk stays on
Vite's origin.

Every renderer runs with `sandbox: true`. A sandboxed preload is loaded by
Chromium, not Node, so it cannot `import`: `scripts/build-preload.mjs` bundles
`electron/preload.ts` into `dist-electron/preload.cjs` (`build:electron` runs
it; the dev launcher watches it). The preload imports
`contracts/renderer-bridge.ts` directly, not the `shared.ts` barrel, because
the contract schemas are values and the barrel would put all of zod into every
renderer. `test-preload.mjs` loads the bundle sandboxed.

The host's own modules are compiled once per build: `compile-cache.ts`
enables Node's module compile cache under `<data root>/compile-cache` before
`entry.ts` imports anything (about 20 ms of a 220 ms import phase;
`MAKO_COMPILE_CACHE=0` disables it for a measurement). Client windows are
created with the shell colour as `backgroundColor` and shown on
`ready-to-show`, so neither the first frame nor a maximize flashes white.

`dependencies` in `package.json` is what the host imports at runtime and
nothing else: electron-builder ships that tree in `app.asar`, and the
renderer's libraries (bundled by Vite), the CSS toolchain and the test tooling
belong in `devDependencies`. React, `react-dom` and `esbuild` stay runtime
dependencies because Cursor canvas previews bundle a canvas in the host.

## Remote control plane

`@mako/relay` is the pure provider-neutral protocol and headless worker core.
It owns remote jobs, canonical events, event cursors, controls, the worker loop,
and the storage contract. It must not import Electron, Next, Azure, Slack, or a
provider implementation. Desktop and headless hosts supply an executor and
transport; gateways register backend delivery adapters.

Relay workers authenticate with short-lived tenant/device tokens. The shared
MCP token is registration bootstrap only unless an operator explicitly enables
the temporary legacy migration flag. Keep event persistence idempotent, validate
batch and lease ownership before writes, reconcile queue/table partial failures,
and stream attachment bodies through measured limits rather than buffering them.

The desktop worker (`electron/relay-worker.ts`) is gateway-neutral; nothing in
it names Slack. A remote request never runs in `process.cwd()`: the packaged
app starts in `/`, and the first real relay job died there with
`ENOENT: mkdir '/.mako-relay-…'`. `relay-workspace.ts` resolves the workspace
in order — the thread's pinned project (`selection.cwd`), the thread's session
directory, the most recently worked-in project, then home — and treats scratch
paths (`/`, temp roots, fixture directories) as never eligible. A pinned project
that is missing fails the job with a message that asks for `projects`; it never
falls back silently. Attachments stage under the profile's `remote-assets`
directory; only `.mako-relay/<job>/outbound-files.json` touches the workspace,
because a sandboxed agent may write nowhere else, and it is removed afterwards.

Only the default profile serves remote work. `MAKO_PROFILE`, `--sandbox`, and
`MAKO_DATA_ROOT` hosts leave the relay off unless `MAKO_RELAY=1`, and
`MAKO_RELAY=0` turns it off anywhere; before this gate every review and test
profile registered as a worker in the production tenant and could lease the
installed app's requests. Opted-in profiles register as `<host> (<profile>)`.

The worker never swallows a failure: `HeadlessRelayWorker` reports each lease,
renew, control, event, execute, and complete failure with its phase, backs off
lease failures exponentially to 60s, and publishes a `RelayWorkerStatus`
snapshot. `relay-status.ts` turns that into the Mako Backend detail in Settings
(`Relay listening as … · checked 3s ago · new requests run in …`,
`Relay failing: lease — …`); three consecutive failures mark the integration
unavailable even while `/api/health` answers. Polling is one second for two
minutes after any work and decays to fifteen seconds when idle. A thread's
mapping may name only a project and tuning with no session yet; `new` keeps the
project and drops the session. The backend's per-lease reconcile selects only
pending and delivered rows. `scripts/test-relay-workspace.ts` and
`packages/relay/test/relay.mjs` cover the resolution order, staging locations,
presence text, idle polling, and reported lease failures.

Presence is the worker's own word, not the gateway's inference. Every lease
request and every renewal carries a `WorkerHeartbeat` with `kind` (`desktop` or
`cloud`), a `generation` minted per worker start, `activity` (`idle`, `busy`,
`failing`), the current job, and the project a new request would run in. A
worker busy with a long job sends no lease requests, so renewals run every 20
seconds and the renew route heartbeats too; before that the desk looked offline
whenever it was working. The host supplies the moving parts of the heartbeat as
a function; the worker adds generation and activity. Slack `status` renders
that row and nothing from a transcript, and `activeWorker` prefers an idle
worker over a busy or failing one. `scripts/prune-relay-workers.ts` in the
backend removes workers unseen for a window together with their registrations,
never one a thread is pinned to, dry-run by default and bounded per pass.

The detached host ignores its stdio, so the relay keeps its own log at
`<userData>/logs/relay.log` (`relay-log.ts`, 1 MiB then one rotation): worker
start and stop, each lease and completion with its job id, and de-duplicated
failures. Every user-facing relay failure ends in `(job <first 8 of the id>)`
so a Slack reply can be traced to that log and to the gateway's job row.

The cloud option is the same worker in a container: `HeadlessRelayWorker`
already takes an executor and transport and never imports Electron, and a cloud
worker registers with `kind: "cloud"` so the gateway can say where a run lives.
What remains for a run to carry on in the cloud is a headless executor that
launches a provider CLI against a checked-out workspace, and event-cursor
resumption (`RelayEventSequencer` epochs already make a restarted worker's
events distinguishable). Do not build a second worker loop for it.

## Zero lint debt

Every source change must leave both ESLint and Oxlint clean. Run `npm run lint`
before handoff; `npm run lint:anti-slop` must report zero warnings and zero
errors. Do not disable, downgrade, or bypass anti-slop rules. A narrowly scoped
exception is allowed only when the owning external API makes a typed boundary
impossible, and it must include a precise safety invariant plus a regression
test. Existing debt is never a reason to add new debt.

## Git

Kiri is the normal Git backend, not an opt-in. `kiri-engine.ts` owns the process-lifetime sidecar and leased repository handles; `host-git.ts` and `git-preview.ts` adapt its typed data to Mako's existing host contract. `kiri-commit.ts` binds Mako's model connections, retains reviewed drafts per client/workspace, and exposes typed commit-plan generation and application for exact staged or working-tree path selections. Every engine model call goes through `completeUtilityText` with the AI SDK's native structured output (`Output.object`, so Gemini gets `responseSchema`, OpenAI a non-strict `json_schema`, Anthropic `output_format` or a JSON tool, OpenAI-compatible `json_schema`) plus `extractJsonMiddleware`; a prompt-only "return JSON" request fails because Gemini wraps plain-text replies in ```json fences. Structured failures name the offending field in the error and in `host.log` under `commit-model`, never the model's text. Do not restore a second Git or analysis implementation as a fallback. Engine/client mismatches are explicit errors checked against the protocol version and canonical schema digest.

`npm run prepare:kiri` builds the sidecar from the sibling Kiri checkout (or `KIRI_SOURCE_DIR`) when available and installs it under `vendor/kiri/<platform>-<arch>/`. `build:electron` runs this step. The macOS packaging configuration includes the engine under Resources and lists it for signing; development resolves the prepared vendor binary automatically. `MAKO_KIRI_BINARY` is a test/development executable override, not a feature flag. `@kiri/client` comes from a pinned, generated SDK tarball in `vendor/`. Update the SDK and engine together. Vendor an engine built from a committed Kiri revision, most simply a detached worktree passed as `KIRI_SOURCE_DIR`, and pack a new `@kiri/client` whenever the engine's schema hash moves; `prepare:kiri` refuses the mismatch, and `vendor/kiri/<platform>-<arch>/manifest.json` must record the vendored engine's own checksum. `npm run test:kiri-engine` exercises the sidecar through Mako's AI SDK against a local model endpoint in a disposable repository.

`ChangesPanel` stages, commits, and pushes. Commit drafting uses the host-only
AI SDK connections in `utility-models.ts`, configured in Settings > Commit
messages, never a coding-agent session. API keys are encrypted through Electron
safeStorage; no key is returned in a settings snapshot. Connections are per
user, not per profile: they live in `~/.mako/utility-models` beside the other
per-user state, so the installed app, `npm run dev`, and every review or
sandbox profile read the same files (`utility-model-location.ts`; the keychain
key `safeStorage` wraps them with was always shared). A host whose data root
lies outside the platform's application-data directory (a temporary fixture
root) keeps them inside that root so a test never reads or disconnects the
user's real connections. The rule is the root's location, never whether
`MAKO_DATA_ROOT` is set: the launcher hands every host, the installed app's
included, its directory in that variable, and while the store keyed on the
variable no real host ever reached `~/.mako` and the one-time move was a
no-op onto itself. A profile's older `<data root>/utility-models` copies
move into the user store on its first start, newest copy per provider
winning whichever host starts first. `test-utility-model-location.ts` covers
the location and the move. The commit box resolves its drafting model from
the connections, not the `commitModel` preference alone
(`src/state/commit-model.ts`): the preference is one renderer's storage
while connections are per user, so a window that never chose reads the first
usable connection, a preference naming a model no connection covers turns
Generate into Reconnect model, and only a preference that names a connected
model is honoured as a choice. The button is Commit, or Commit all when
nothing is staged; the count is the Changes header's to show.
`test-commit-model-status.ts` covers the resolution.
On macOS with a local certificate, every new build is a new keychain partition
(`cdhash:`, since only Apple-issued certificates carry a Team ID), so the first
keychain access after an install asks once for Always Allow; that is macOS,
not a lost connection.
Changing a custom endpoint requires re-entering its key. Non-sensitive text diffs,
including lockfiles and generated files, are captured completely. Working-tree
captures use private Git objects and a private index without modifying the real
index or object database. Reviewed worktree commits verify file fingerprints,
HEAD, branch, and index state before staging. Model request size bounds do not
truncate captured evidence. Small captures use one synthesis call; larger captures
use parallel chunks and recursive reduction with original-source inspection.
Provider token counters validate candidate requests where available. A typed
context rejection re-chunks the same immutable capture under one shared call
budget; authentication errors do not trigger that recovery. Every part must finish
before final synthesis. Request, time, or output limits fail the draft instead of dropping parts.
Sensitive-file exclusions remain explicit; filename filtering is not a secret scanner.
Git index writes are queued per repository across workspace instances, and commit
diff collection waits for admitted writes. Git uses `--no-optional-locks` so background
status refreshes cannot contend with staging; mandatory write locks remain intact.
The UI projects pending checkbox intent
immediately and clears it only after all writes and the latest reconciliation finish.
Superseded Git pushes and explicit refresh results are discarded.
Staging controls keep a stationary 24px hit target around their 14px mark.
`test-git-staging.ts` covers rapid toggles, parallel clients, reader cancellation,
root capture, literal filenames, failed writes, and commits queued after staging.
Commit generation has explicit Fast/Deep modes in the shared input contract and per-workspace draft state. Fast uses complete evidence with direct synthesis and low requested reasoning; Deep adds bounded inspections and higher requested reasoning. Changing this policy must not truncate source or alter Git safeguards. Commit errors must not offer automatic mutation replay; refresh the observed Git state instead.

`commit-drafts.ts` keeps per-workspace edits and offers late results as suggestions
rather than overwriting a message. `npm run test:commit-generation` exercises real
Git repositories, AI SDK calls, context recovery, cancellation, and encrypted storage.
`node scripts/test-commit-ui.mjs <isolated-dev-url>` runs the real-host connection
and drafting flow with trusted UI input and a local model endpoint. It requires
a host started with a temporary `MAKO_DATA_ROOT` (a `MAKO_PROFILE` host shares
the user's connections) and no existing model connections, and prints screenshots.
It also checks commit-footer geometry and the computed Shadow DOM colors of sidebar
diffs, center diffs, and source files across light, dark, and system-theme changes.
Pierre's `diffs-container` inherits Mako's color scheme and token bindings from
`src/index.css`; component-level dark/light overrides are unnecessary.

Git browsing is metadata-first. Status attempts rename enrichment only when a
small inventory contains staged addition/deletion candidates, with a one-second
budget. Line totals are deferred; unknown totals are `null`, never fabricated zeros. Concurrent readers share
status work, and index-only events do not reload open file contents. History lists
read commit metadata without `--shortstat`; per-commit files are paged in the UI.
`ChangeList` windows fixed 24px rows instead of mounting an entire changeset.
`git-preview.ts` limits interactive full-text comparison to 64 KiB/2,000 lines;
larger files use Git-generated previews capped at 128 KiB/1,000 lines, with a clear
notice. Files above the 32 MiB interactive source budget stay available for staging
and external-editor review. None of these display limits alter staged content or
commit generation. Project transitions clear Git views immediately and history
requests are scoped by project/HEAD. Push feedback is branch/project-owned in
`git-push.ts`; the Commits header (`Commits on <branch>`) carries the only Push
control, and only while there is something to say — commits waiting, a branch
without an upstream, a push in flight, its receipt or its failure. An
up-to-date branch shows no button: the old "Up to date" row under the commit
box was a status bar in disguise.
`npm run test:git-ui` checks 13,000 rows, staging, project loading, Push feedback,
and reduced motion using production components and a delayed fixture transport.
`test:host` includes real temporary-repository preview checks and publishing to a
local bare remote, never a network remote.

Commit model names and limits come from models.dev or an explicit provider API
lookup, not a version list in the renderer. Only the public catalog is cached;
account lists stay scoped to the submitted or saved key and endpoint. Discovery
bounds response bytes, pages, and rows, and never sends keys to models.dev.
`npx tsx scripts/test-utility-model-catalog.ts --live` checks the current public
catalogs without credentials. The UI check covers current model selection, custom
IDs, keyboard navigation, and ignoring responses after credentials change.

Two things to preserve: a repository with **no commits has no HEAD**, so
`diff HEAD` fails in exactly the state where a first commit message is most
wanted — `gitPatch` falls back to the index and then to a file listing. And
push publishes work off the machine, so it stays a separately-labelled
deliberate action and never rides along with a commit.

## Design rules

- Tokens live in `src/index.css` and nowhere else. No literal colors in
  components. Chrome (`--shell`) carries no shadow, ever. Structural workspace
  panes tile edge-to-edge with square edges and 1px dividers; rounded `.card`
  surfaces are reserved for content within a pane. Real shadows exist only on
  floating surfaces (`.overlay-panel`: menus, palette, dialogs).
- **The ramp is warm ember neutrals — red-shifted near-blacks, warm
  off-white text — and stays that quiet.** Ember (`--ember`) is punctuation,
  not brand: the live/working dot, the composer caret, at most one badge.
  Never on links, borders, focus, selection, hover fills, icons at rest, or
  any fill larger than a badge; if two ember moments are visible in one
  pane, one is wrong. Selection and hover are tints of the text colour
  (`--fill-hover` / `--fill-selected`), never the accent. Beyond ember, hue
  appears only where it carries meaning: diff add/remove, error, warning.
- **Three UI type sizes only** — `text-label` (12), `text-ui` (14),
  `text-title` (16) — plus prose (16) and code (12). Weights come off
  Geist's variable axis as 440/530/640 through the standard `font-normal`/
  `font-medium`/`font-semibold` classes. No literal `text-[Npx]` in
  components; eslint enforces both this and the raw-hue ban. Keep semantic size
  names registered as font sizes in `cn`'s Tailwind merge configuration; otherwise
  a text-color utility can silently erase the size and fall back to body text.
- **No uppercase micro-labels.** Section labels are sentence case with no
  letterspacing. Uppercase + tracking at 10px is the most recognisable tell of
  a generated interface and it costs legibility for nothing.
- **Every number carries its noun.** A bare `33%` next to a bare `$6.62` is
  decoration that looks like information. Write `context 141K/400K` and
  `$6.62 spent`.
- Geist for UI, the platform monospace for code. Do not ship a code webfont.
- Two curves: `--ease-out` for everything that arrives, `--ease-swift` for
  everything that leaves — exits faster than entrances. Entrances stay under
  250ms and nothing animates from `scale(0)`. Anything triggered by keyboard
  many times a day (the palette) does not animate at all.
- Pressable surfaces carry the `pressable` class.
- The browser icons in `public/icons` are generated by
  `npm run icons:browser`, never exported from the icon kit. A dock tile can
  carry the fin at 46% of its canvas; a 16px favicon downscaled from that
  artwork is a dark square with a smudge in it, which is what shipped until
  the set was redrawn. `scripts/build-favicons.mjs` holds the fin as two
  cubics traced from the desktop master and fills the tile with it. The
  development set, which a Vite plugin serves on `serve`, is the kit's light
  treatment — aluminium ground, graphite fin — so `npm run web` and the
  installed app are never the same six pixels in a tab strip. No hue enters
  the mark: the kit has a light and a dark treatment and that is the
  difference.

## Product surface

Provider sessions, the built-in runtime's session tree, and the current git
diff. No worktree manager. There is no status bar, and the titlebar is not
one either: its right cluster carries only what has something to say — a
lost host, a downloaded update — and the context/cost readings sit beside
the composer, next to the send they price.
The project, the branch and the changed-file count are not chrome; they are
the Changes surface, which shows the same count with the files under it, and
a second permanently-lit readout in the title strip was clutter that repeated
the workspace name centred two inches away. Identity is the rail's footer and
only there, and Settings is a row in the menu it opens. No glyph in the strip
duplicates a doorway that already exists: the palette is Cmd+K and search is
the one control there with no other way in. The rail is the vertical thread
list; horizontal tabs inside the central workbench hold the agent session,
files, and diffs for that thread, never more sessions.

The composer groups file attachments, screenshots, references, skills, and MCP
settings under one + popover. `composer.controls` contributions render inside
that menu and may dismiss it before capture. Typing `$` anywhere or `/` at the
start of an empty draft opens one capability menu listing every installed
skill and the MCP servers the *selected* provider will have: servers from the
same reach predicate the host projects into a launch
(`electron/contracts/mcp-reach.ts`, plus the launch-attached conversation
tools). Mako's managed servers wear the fin. A pick inserts plain text in the
sigil typed (`$name`, `/name`, `$mcp:server`); sentence punctuation after a
token stays prose. `scripts/test-composer-capabilities.ts` covers the tokens,
reach, and ranking.

A `$skill` reaches whichever provider answers. `electron/contracts/skill-reach.ts`
is the one rule: a skill under the provider's own roots is `native` (the
message points at it), one found only under another provider's roots or the
universal `.agents/skills` is a `handover` (the host reads SKILL.md and the
message carries its body under a `[Skill name from source]` marker, or a
pointer above `SKILL_HANDOVER_LIMIT`), and an unknown name is `missing` and
goes out as typed. Every provider declares `readsUniversalRoot` on its skill
source, `false` until a live check shows the CLI loading a skill that exists
in `.agents/skills` alone; none is verified yet, so a universal skill is
handed over everywhere. `disable-model-invocation: true` marks a skill
`manual`; a typed reference is that invocation and carries it like any other.
A body is carried once per conversation (`skills.attach` in
`src/state/skills.ts`), later mentions point back; the key is the
conversation the send continues on the same harness, and a handoff, a move
or a fresh start begins with nothing handed. Names are read from the user's
words alone (never a referenced thread's title), need a letter (`$5` is
prose), and a host that cannot resolve them keeps the draft with the reason
rather than sending the bare token. Before this, `$wait-what` typed for
Cursor went out as five characters and the menu listed a skill the provider
could not load. The draft's chip says the route without taking width (a
dotted underline for a handover, a dashed edge for a missing name), the
transcript chip adds the source's mark, the menu row names the source, and
Settings > Skills is a matrix of skills by place — a filled dot is a copy the
provider loads itself, an outline is a provider that is handed the skill, a
caution dot is a copy that drifted from the listed one (`SkillOrigin.hash`),
and a dot opens the install, replace or remove for that one cell, previewed
first. `scripts/test-skill-references.ts` covers the rule, the read, the
appendix and the round trip; `test-skill-ui.tsx` covers the matrix and both
chips. Terminal remains on Command-J and
in the command palette, not as an extra composer icon. Context usage is shown
only with an exact, usable reading; unsupported providers do not get an empty
ring. Chat activity uses one compact 20px mark and no redundant Responding row
while answer text streams. Thought-process details remain available without a
second animated status. The composer carries no Queue/Steer control, not in
the footer and not in the conversation menu: the placeholder and the send
button's icon say what Enter does, Cmd+Enter does the other, and the
preference is a row in Settings > Conversation. The
routing row gives way in a fixed order as the pane narrows (the centre can be
450px), found by measuring rather than a width breakpoint
(`use-compact-row.ts`): the access chip drops to its glyph first, the harness
chip second, and what still overflows scrolls behind a faded edge instead of
being cut off silently. The model and its reasoning are what people read
there and are never shortened.

## Notifications

Three outcomes and no more: an answer is `ready`, the agent must `ask` you
(a question is an ask with `questions`, not a fourth kind), or the run
`failed`. Starting, tool calls, and attach/detach never notify. The attention
centre (`src/state/notifications.ts`, React-free; `docs/notifications.md`
has the full design and the remote-channel plan) decides per outcome from
four facts: kind, thread on screen, window in front, replay. Watching the
thread means seen with one cue; another thread in front means an in-app card
(`src/components/notifications/notification-toast.tsx`, one attention row as
a `toast.custom`, clickable anywhere, gone after `ACTION_TOAST_MS`; the rail's
mark and the badge keep the fact); window not in front means a desktop
banner. Toasts sit top-right below the 38px titlebar drag region, receipts
leave in three seconds, and no toast is ever permanent
(`scripts/check-actionable-toasts.mjs`). Outcomes are transitions
keyed by a marker (permission id, turn), never states; hydration and
reconnect replays are recorded for the badge but never announced; a thread
that starts working again retires its unseen items; four or more banners in
600 ms become one summary. The app icon's badge counts distinct threads,
never events, and it is the only standing count: the titlebar carried a pill
reading "3 threads need you" over a list, which mirrored into the chrome what
the rail's own marks and the Status view already say. The list is the Status
view, the announcement is the toast, and Cmd+Shift+U opens the next thread
that needs you. Banners and the badge are
answered by the client that owns the window (`electron/client-main.ts`, the
standalone host, or `src/dev/web-notifications.ts`), never by the shared
host; one banner per thread is retained until it reports, and a click sends
`notification-activated`. Preview windows record but never announce.
External `needs-input` activity asks the same way; working-then-open is a
finished turn; a vanished process is not an answer.

Verified on macOS 26: the checkout's ad-hoc `Electron.app` cannot notify
(`failed`, `UNErrorDomain error 1`, no prompt), so the notifier answers
`unsigned` before touching the platform and only the packaged app banners.
Electron has no authorization API; the packaged app carries
`mako-notification-status` (Swift, `native/notification-status-macos`,
built by `scripts/build-notification-status.mjs` with the bundle id embedded
as `__info_plist`) beside its executable in `Contents/MacOS`, which is the
only place `UNUserNotificationCenter` answers from; it is listed for signing.
`notify` resolves on `show`, `failed`, or a 1.5 s grace, never before.
`scripts/test-notifications.ts` covers the policy, bursts, retirement,
replays, live and external transitions, the readout, and the platform side.

## Working on the UI

`npm run dev` (or `npm run web`) attaches a local web UI to the `dev` profile's
persistent host, starting it if absent; `npm run desktop` attaches a desktop
client to that same host. The installed app runs its own host on the default
profile, so a development restart never drops the desk you work in and an
in-app install never closes a development session. Pass `--shared` to attach
development clients to the installed app's host on purpose. The host owns
provider processes and journals; closing every client or stopping Vite does not
terminate agents. Open Vite's URL without `?mock` for normal UI verification.
Opening a thread does not start an agent; sending a prompt does. `MAKO_PROFILE`
or `--sandbox` explicitly selects another separate host. Never silently create a
second host when attachment fails.

The host keeps its own log at `<data root>/logs/host.log` (`electron/host-log.ts`,
rotated to `.1` at 4 MiB) because it is spawned detached with its stdio ignored.
Every provider spawn, startup step, refused setting, failed prompt and exit is one
line; `console.warn`/`console.error` are mirrored; crash reports add a summary
line; Settings > Diagnostics reveals the file. Fields are explicit and stderr
tails are scrubbed of bearer tokens: never log an environment, a header list or
a request body. ACP startup is bounded by silence, not a fixed budget
(`electron/acp-startup.ts`): a step fails after 20 s without any stdout or
stderr from the process, after 120 s regardless, or at once when the process
exits, and the error names the step, what had already finished and whether the
process is alive. Grok once answered `initialize` in 150 ms and then sat silent
for 19 s inside `session/new`; the old fixed 20 s budget killed it while a
provider still connecting MCP servers one notification at a time would have
been killed too. A failed request offers Send again in its recovery details and
keeps the failed record. JSON-RPC error `data` reaches user-facing messages
through `errorMessage`; "Invalid params" alone once hid "Unknown model config
option: effort". In a running ACP session only the current model's unreported
options are fixed; another model's catalog options stay editable because
choosing it switches the session. Every provider process the host spawns (ACP
agents, the Codex app-server, the Claude SDK CLI) is recorded in
`runtime/provider-children.json` under the data root and removed on exit; the
next host reaps what an earlier host left, but only a pid that still runs the
recorded executable and started when the record says (`provider-children.ts`),
because a killed or replaced host never reaches `stopAcp()` and four idle
cursor-agent processes from three earlier hosts were once found a day later.
`test-acp-startup.ts`, `test-host-log.ts`, `test-provider-children.ts` and
`test-composer-settings.ts` cover these.

When the host closes for a restart, install or quit it answers every pending
call with `host-restarting` (`electron/contracts/host-connection.ts`) instead of
resetting the connection. The client turns that, and a dropped socket, into
`RuntimeDisconnectedError`; `electron/runtime-retry.ts` repeats a call once
the event stream reattaches according to one table,
`electron/contracts/host-call-policy.ts`: `read` channels change nothing;
`replay` channels are mutations the host settles by a caller-minted id (a
request, conversation, transfer, action or fork id) or whose repeat reaches
the same end state (cancel, close, set a mode), so the host answers a repeat
with the first acceptance and never starts the work twice; everything else
is `never` (a commit, a push, shell input) and only the user decides. A
replay travels as `attempt: 2` in `RuntimeCallSchema` and the host logs it
under `rpc`. Add a channel to `replay` only after reading its handler: it
must return the first acceptance for a repeated id and refuse a repeated id
whose content differs. A send the outage swallowed is kept staged as
`unconfirmed` and re-issued from `reconnect()` under the same id
(`replayUnconfirmedPrompts`), so "Delivery unconfirmed" is reserved for a
host that died with the turn, never for a dropped socket. The renderer
treats the disconnect as the reconnect banner (`HOST_OUTAGE_MESSAGE`), not a
toast. `test-runtime-recovery.ts` covers the table and the second attempt.

Every `live-batch` and `LiveSummary` carries the host's `epoch`, minted per
`LiveConversations` instance. Revisions climb within one epoch and a
restarted host continues from the journal, but a recovering host rewrites
what it reopens at the same revision and two hosts never share a counter, so
`live-recovery.ts` merges a batch onto held state only within the epoch;
across epochs it buffers and takes a snapshot, and a snapshot from another
epoch replaces the state outright. An unstamped batch (an older host) still
applies by revision. `test-prompt-delivery.tsx` covers both.

A health probe has three answers, not two. `probeRuntime` returns `absent`
(nothing listens; a host may start), `ready`, or `closing`: a host that still
owns the socket answered a reused keep-alive connection with a reset or a
503 while its `close()` swept connections. `runtimeInfo` throws the typed
disconnect for `closing` rather than passing it off as `null`, because a
launcher that read `null` would start a second host into the old one's lock.
Anything that polls the socket while a host leaves or arrives —
`ensureRuntime`, the local installer's `localRuntime`, its quit wait and
startup verification — goes through `settleRuntime`, which waits out
`closing` for ten seconds and then reports it so the caller refuses
explicitly. The install once died here: a probe during the quit it had asked
for surfaced a raw `socket hang up`, the installer treated it as fatal, failed
to cancel the quit for the same reason, and left Mako quitting with nothing
to reinstall it. `test-runtime-transport.ts` covers all three states, both
disconnect shapes, settling through a farewell, and the race against the real
web host's `close()`.

`npm run dev:fixtures` plus `?mock` is an explicit fixture mode for deterministic
edge cases, not the default UI verification path. Changes to host handler
arguments require `npm run generate:host-inputs`; `npm run test:web` checks drift
and rejects invalid requests before dispatch. The web gateway stays loopback-only
and same-origin; the host endpoint is a private local socket.

Dev launches default to manual renderer updates. Reload UI loads current renderer
code without restarting provider processes; Open shared-host preview opens a separate
preview with independently persisted drafts. Host changes still require an explicit
Restart Mako while the shared host is idle. `npm run dev:hot` opts into automatic
hot updates. Dev UI storage is checkout-specific; agent runtime storage is shared
by default. Client versions negotiate the runtime protocol and supported methods.
An incompatible or unreachable host never authorizes an isolated replacement.

`npm run test:workspace-ui` exercises production components with isolated fixtures
and trusted CDP input, retaining screenshots in its printed temporary directory.
`node scripts/test-composer-ui.mjs <dev-url>` checks attachment editing with trusted
input, then compares real provider model controls with discovery without sending a
prompt. `npx tsx scripts/check-harness-models.ts --live` requires fresh defaults
from every registered provider; a timeout or missing value fails the check.
`npm run test:tuning` rebuilds the shared session library and checks discovery
lifecycle failures, defaults, and probe cleanup.
`npx tsx scripts/test-prompt-clipboard.ts` checks attachment clipboard metadata,
selection boundaries, and filename collisions. `node scripts/test-clipboard-ui.mjs
<dev-url>` tests native clipboard copy/cut/paste, transcript copy, undo/redo,
preview recovery, and real-host screenshot pixels without sending a provider prompt.
Omit the URL to run only the isolated fixture checks; screenshots stay in the
printed temporary directory.
`npx tsx scripts/test-devin-settings.ts --live` repeats native discovery and checks
for retained probe sessions;
`npx tsx scripts/test-opencode-settings.ts --live` compares discovery with a fresh
ACP session and deletes that verification session. Neither sends an agent prompt.
`npm run test:dev-updates` checks deferred update delivery. After building Electron,
`node scripts/test-provider-e2e.mjs <provider> --steer --continuation` checks real
mid-turn delivery, idle replies, queueing, native identity, and retained context;
`--restart` stops the host mid-conversation and reopens the same native session
through the provider's own resume (Cursor's SDK `Agent.resume`, Grok's
`session/load`, Codex's thread resume) with no portable history, on the first named provider that can.
The installed OpenCode v2 ACP server rejects concurrent prompts. Its free
`opencode/muse-spark-1.3-contributor-free` model passes normal replies and queueing;
verify it with `--continuation`, not by advertising unsupported steering.
Provider checks run against the user's real provider stores, so every session
they create is a real entry in Codex, Cursor, Claude, or Grok history. The e2e
deletes the sessions it created through `SessionCatalog.remove` before it ends
(`--keep-native` retains them); each `SessionProvider.remove` deletes only its
own session under its own roots and never a Cursor Desktop chat.
`npm run clean:fixture-sessions` lists sessions left in fixture-named temporary
directories by earlier runs and removes them with `--delete`. A probe that
opens a real provider session must run it in a directory with one of those
fixture prefixes so it can be cleaned up.

Normal desktop Quit closes the client, leaving the shared host and provider
processes running. Standalone compatibility hosts still background on Quit while
work is active. Force Quit of the host and system shutdown are different: journals
recover history, not a running process. Host restart and update installation wait
for active work to finish. The `--background` launch switch keeps test windows
hidden until explicitly activated.
`npm run test:desktop-continuity` exercises actual Mako with an installed Devin
process through Quit/reopen, a retained question, and a second native window.

A live session's permission switch is saved only after provider acknowledgement,
separately for each provider. Before a session exists, every live driver declares
the ladder a new session will offer (`modes` on `LiveCapability`; ACP sources record
their verified `nativeModes`), the composer offers it for the selected provider, and
the saved choice travels with the first prompt. The host validates it against the
session's own list at start. Execution
preferences sync between windows; draft text and preview layout remain separate.

## Access tiers and steering

`electron/contracts/access.ts` is the one ladder: plan, chat, ask, edits, auto,
full, deny. A provider mode carries the tier it implements (`access`) and who
makes it true (`enforcement`): the provider itself, the host answering the
provider's permission requests, or a launch flag the running process already
read. The picker orders by tier and shows the provider's own name beside it.
Never show a tier nobody enforces. Host approval (`hostAccessDecision`) answers
only allow/reject choices, never a question, and prefers once-scoped grants so
a stricter tier chosen later is honoured by the agent's next ask. A mode id of
the form `access:<tier>` is host-defined; anything else is the provider's own.

Each ACP provider declares its placement in `access` on its `ProviderAcpSource`
(`native`, `host`, `launch`, `base`); `electron/acp-access.ts` builds the mode
list and resolves a selection, and `acp.ts` applies it. Verified on 2026-09-11
against the installed CLIs: Devin advertises all five tiers
natively. Grok reads `--permission-mode` at launch and, in every mode except
always-approve, denies tool calls over ACP instead of asking, so its tiers are
launch-only. OpenCode reads `OPENCODE_PERMISSION` at launch; its remaining asks
can be host-answered. Claude maps its own modes, with `bypassPermissions`
allowed at launch so a later switch is accepted. Codex sends approval policy,
sandbox, and reviewer with every `turn/start`; a change applies to the next
turn. Cursor is not an ACP provider: its ladder is the SDK's own and is
enforced by the SDK (below). `test-access-modes.ts` covers the placements
and decisions.

How a catalogued thread is continued is the host's decision, not the
renderer's. `electron/contracts/thread-continuation.ts` turns one ref plus
what only the host knows — the live driver, the installed CLI, a run that
owns the path, another process in the store — into a `ContinuationPlan`:
`live` with the id to load, `native`, `handoff` with a reason, or `refused`
with a reason. The renderer asks `continuationPlan(path)` and follows it;
`live-start` with a resume id and `native-submit` each assert the host's own
plan first (`electron/continuation.ts`), so stale renderer state fails with
the reason instead of running on another transport. Before this the renderer
chose from provider flags served once at startup, and a wrong `canResume`
sent every Cursor reply to `cursor-agent -p --resume` without a word.
`test-continuation-plan.ts` covers the rules and both refusals. Verified
2026-09-12 with `test-provider-e2e.mjs <provider> --restart` on Grok: it
reopens a stopped session through `session/load` in place. Cursor reopens
through the SDK's own resume (below); `test-cursor-resume.ts` covers its
verdicts.

What a session ran under is remembered per user, not per host.
`electron/session-memory.ts` keeps `~/.mako/session-memory.sqlite`, keyed by
provider plus native session id, with the settings and access mode the live
session last reported and a hold naming the host that has it open. It exists
because the installed app and the `dev` profile share every provider store
but each kept those facts only in its own journal, so a thread that ran in
one host read "Model not recorded" with no access picker in the other, and
a `cursor-agent` `store.db` records neither a model nor a tier to fall back
on (Codex, Claude, Grok and OpenCode record their model and options, Devin
the model alone, Cursor's SDK `index.db` the model; no provider records
Mako's tier). `LiveConversations` writes the
ledger from its flush hook for every driver, a native reply writes the
settings it prepared, and the catalog's `annotate` overlays `settings`,
`accessMode` and `heldBy` onto each `ThreadRef`. `rememberedSettings` lets
the store win when it names a model, fills what it left out, and prefers the
ledger only when its observation is newer than the store's write. A hold is
a lease: taken before a resume spawns anything, kept alive every 30 s,
released on close and on `stop`, stale after three minutes or when its pid is
gone, and another host's hold refuses the continuation plan by name and shows
as `external-open` in the rail. The journal's `modes` keep `access` and
`enforcement`, so Restart Mako no longer strips the tiers from the picker.
Choosing a tier while viewing a thread that is not live is the thread's
choice (`chooseThreadMode`, `mako:thread-remember-mode`), and the host applies
its own memory of the tier when a reply arrives without one. A host started
after the ledger existed offers its own journals to it once (`backfill`,
stamped with the journal's write time, never over a newer observation), so
sessions from before the ledger are not "Model not recorded" forever.

A saved binding's fate is a `ResumeVerdict`
(`electron/contracts/conversation-control.ts`), not a boolean: `resumable`
with the record `same` or `moved`, `held` by a named owner, or `unavailable`
with a reason. Ownership and content are separate questions because they
were once one, and a host that died mid-turn could never reconnect: the
agent wrote its last blocks on exit, the store's head moved past the
binding's checkpoint, and "cannot be resumed safely" was the answer forever.
A reconnect accepts `moved`, holds the ledger before spawning, and says the
transcript may be missing that part; only a provider switch reusing an old
binding insists on `same`, because it sends context from that point. Devin
answers `held` from its own lock file and the generic policy from the
provider's process probe; Cursor never does, because an SDK agent is Mako's
own (another host's hold is the ledger's refusal) and a `cursor-agent` store
is only ever read, so a CLI that still has it open loses nothing when the
SDK continues from a copy. A refusal quotes the verdict's own reason.
`scripts/test-session-memory.ts` covers the merge rule, holds across two
hosts, the overlay, the refused plan, the journal round trip, a live
conversation round trip, a reconnect past a moved record and the backfill;
`test-cursor-resume.ts`, `test-devin-resume.ts` and
`test-native-continuation.ts` cover each policy's verdicts.

One selection means the same thing on both of a provider's transports. A
native runner declares the option ids its command line `carries`, settles
the rest in `prepare` (dropped ids are reported to the user, never silently
left behind; `withCatalogDefaults` supplies the provider's defaults a
command line has no session to fall back on), and reads a built command back
with `describe`; a command's `env` carries what a CLI reads from its
environment rather than its arguments (Claude's agent teams). `scripts/test-transport-agreement.ts` feeds every model and
option value of each provider's catalog through the runner and compares the
read-back with the settings the ACP transport applies; a mangled flag or a
composed id that the CLI would reject fails there.

Cursor runs through `@cursor/sdk` (`electron/providers/cursor/sdk/`) and
nothing else. `cursor-agent acp` was the transport before: it ended a turn
on the first reset frame of its backend stream (`RetriableError: http/2
stream closed … CANCEL`), asked before every command, and answered "Session
not found" for the CLI's own `chats/` stores, so those rows continued
through `cursor-agent -p --resume`, which forked each new turn into a second
store. The SDK retries its stream itself, enforces the access ladder itself,
and imports any `cursor-agent` store it is asked to continue; there is no
ACP source, native runner or CLI model list for Cursor, and a new Cursor
thread never waits on sign-in state to choose a transport.

The SDK runs in a child (`child.ts`, spawned from the host's own executable
with `ELECTRON_RUN_AS_NODE`) over an NDJSON wire (`wire.ts`) so a backend
stall or an SDK crash cannot take the host with it; `CursorSdkClient` bounds
every request except `login`. Its store is `SqliteLocalAgentStore` under
Mako's state root (`~/.mako/cursor-sdk`, per user like the session-memory
ledger, because every launched host receives `MAKO_DATA_ROOT` and a root
keyed on it would hide each host's agents from the others; a fixture sets
`MAKO_CURSOR_SDK_ROOT`): one `agents/agent-<sha256(agentId)>/store.db` plus a
shared `index.db` holding each agent's cwd, model, title and root blob.
`CursorProvider` reads both (`cursor-sdk-index.ts`) and folds `index.db`'s
mtime into each store's revision because that is where a finished run lands;
an `index.db` write is watched as the store of the agent it moved for. The
store's own meta row leaves `latestRootBlobId` empty, so an SDK agent's
resume checkpoint (`cursorSdkCheckpoint`) takes its root from `index.db` and
only the blob count from the store; read as an ACP store it judged every
agent "unreadable" after a host restart. Removing an SDK thread also deletes
the agent's index rows.

A `cursor-agent` store goes on in place through the SDK (`import.ts`).
Verified 2026-09-13 (SDK 1.0.31): `acp`, `-p` and the SDK write the same blob
store — content-addressed encrypted blobs whose `meta` row names the agent,
the newest root and the blob key — and differ only in where the head is
kept, so a legacy store copied under the SDK's layout with `VACUUM INTO`
(reads through the CLI's WAL, opens the source read-only) and registered in
`index.db` with its root and key resumes with its whole history. The copy is
made once, the legacy store is never written, the import records the
legacy path and identity in the agent's metadata, and the catalog folds the
two rows onto one `threadIdentity`. The store's own id is kept when it is
free or already names this import; when the ACP store and its `chats/` fork
share one id the fork gets a fresh one and later opens find it through the
import record (`resolveImportAgentId`). Every Cursor CLI row therefore
resumes live; `liveResume: false` is gone. `cursorStoreOrigin` tells an
`acp-sessions`, `chats` or SDK path apart, `cursorLegacyCheckpoint` reads the
CLI's meta row, and a resume verdict is `resumable` (`same` or `moved`) or
`unavailable`, never `held`. `test-cursor-resume.ts` and
`packages/sessions/test/cursor-fork.mjs` cover the checkpoints, the import
and the collapse; `test-provider-e2e.mjs cursor --restart` (verified
2026-09-13) stops the host mid-conversation and reopens the SDK agent with
its history, judging the binding by the driver's own checkpoint and
verdict exactly as the host does, because a file hash of `store.db` taken
at bind time never matches again once the SDK has written to the store.

Who the SDK runs as is `CursorSdkAuth` (`auth.ts`), one object per host.
Keys are tried in order: `CURSOR_API_KEY` in the host's environment, the key
Mako holds (`credentials.ts`: browser-minted or pasted, encrypted with
`safeStorage` under the state root, never in a snapshot or log), the key
`cursor-agent login` left in the keychain (`cli-keychain.ts`, read once), and
last the SDK's own `~/.cursor/sdk/auth.json`, which the SDK reads itself.
A child's environment is resolved without the network; the verified state
comes from a short-lived child answering `me`, so a key is judged by Cursor,
not by its shape, cached ten minutes and re-asked after thirty seconds when
it failed. A pasted key is verified before it is saved and the row names the
key Cursor reports; a browser sign-in is the SDK's own `login`, unbounded
and cancellable, stored with its expiry. A live session that Cursor rejects
(`AuthenticationError`, `unauthorized`) calls `reportRejected`, which flips
the state to signed-out with the offending source named
(`rejectionText`), and every listener hears it: `provider-connections` goes
out to every window, the composer shows the sign-in notice above the draft
(`connection-notice.tsx`), Settings > Agents > Connections shows the row
(`provider-connections.tsx`: status, source, account, expiry, inline key
field with immediate failure text, refresh, sign out only for a key Mako
owns) and discovery and `liveCapabilities` run again, because the model
list follows the account. A thread sent while signed out asks in the thread
itself (`ensureSignedIn`: one `Sign in in the browser` choice) and continues
once the mint lands. `scripts/test-cursor-auth.ts` covers the order, the
store, pasted and browser sign-in, rejections and the connection snapshot.

Text and thinking reach the child twice, as `onDelta` chunks and again as
`assistant`/`thinking` messages echoing the same chunk; `projection.ts` feeds
both into one accumulator per block and appends only what the other source
has not already delivered, so either stream alone is a whole reply and
neither doubles it (verified against SDK 1.0.31; a resumed run once arrived
with its first chunk only as a message). `updateTodos` streams its arguments
while the call is written, so each growth repaints the plan, an MCP
result's `content[].text.text` entries are the row's output, and `grep` and
`glob` results are written as `rg` would print them. The child validates a
message as the wire carries it, after a JSON round trip (`sdkMessageForWire`):
the SDK's live objects hold `undefined` fields (a `grep` hit without its
`line`), which `z.json()` refuses and serialization drops, and checking the
live object once dropped every completed grep and left its row running for
good; a drop is logged with the failing path. Cursor has one
mode, `full-access` ("Agent", the full tier), and the child always opens
the SDK's `agent` mode with the full toolset (`modes.ts`); the composer's
access chip shows it, there is no ladder. The SDK has no permission
prompt — a tool exists for the model or it does not. This was
tested, not read (SDK 1.0.31, 2026-09-13): a `beforeShellExecution` hook
answering `"ask"` ran the command as `"allow"` would, `"deny"` refused it,
and under the SDK's `autoReview` classifier the model's own attempt to run
`git push --force` "with approval" was refused with "Local SDK runs cannot
request interactive approval for this shell command"; the classifier also
refused `curl … | sh` while letting `curl` and an `rm -rf` inside the
workspace run. So no asking tier is offered, and neither is `autoReview`:
it refuses instead of asking, the reason reaches the model only, and nobody
at the desk can overrule it, so a blocked call is a turn lost to a decision
the user never saw. Cursor's planning mode and a read-only tool allowlist
would work and are deliberately not offered either: Cursor in Mako is Agent
and nothing else. The id is not `agent` (Cursor's old ACP mode of that id)
and an id the ladder does not know falls back to the one mode. A call a
hook refuses emits one `running` event and no terminal one, so `finishTurn`
closes every row a turn left open (`projection.finish`) with the reason the
SDK cannot report: rejected before it ran, stopped, or the turn's error. The child
passes `settingSources: ["project", "user"]`; without it the SDK loads no
on-disk config at all — no `.cursor/hooks.json` (the one policy hook the
SDK honours), none of Cursor's own `mcp.json` servers (which the reach
predicate never projects because a provider is expected to load its own),
no project rules. `Run.steer` cuts the current step short (a `sleep 6` shell
step completed after 1.7 s when the steer landed) and the model continues
with the message, so the driver advertises `interrupt`. `@cursor/sdk-*` is
`asarUnpack`ed for its `cursorsandbox`, `rg` and tree-sitter binaries.
`scripts/test-cursor-sdk.ts` covers the projection, modes and wire; a live
check is `node` against `dist-electron/providers/cursor/sdk/client.js` in a
fixture-prefixed directory.

Steering is a capability with a kind, not a command. `step` folds the message
into the running turn at the agent's next step (Claude, Codex, Devin);
`interrupt` cancels the current step and continues with the message (Cursor).
Grok queues a concurrent prompt behind the whole turn, so it advertises no
steering and messages queue honestly. Enter steers a steerable running turn and
Cmd/Ctrl+Enter queues; the `steerOnEnter` preference swaps them. Re-verify a
provider's kind with a real multi-step tool task before changing it: a single
long generation cannot distinguish step delivery from turn-end delivery.
Each renderer and web document owns its workspace pool and git target, selected
through async request context. Provider conversations remain shared. A preview
must never change another window's cwd, file target, or active workspace tab.
The rail's Projects view keeps active sessions under their project; Recent is a
bounded chronological list. Never gate provider names or the rail on model discovery.
Position in the rail never carries status. `stableThreadRanks` in
`src/lib/thread-folders.ts` gives a busy thread its rank when it starts, keeps
it while the thread is working, observed, or externally active, and settles it
once when it finishes, so a file that changes on every token moves nothing.
`stableFolderRanks` holds every folder's place from the moment it is first
seen; only `noteFolderUse` (a prompt sent or a thread started, called from
every send path) lifts one, never an agent's reply or a finished turn. Status
is the row's mark and the folder's chip, and a folder with a working,
waiting, or unread thread stays visible past the folder page limit instead of
climbing. An unread answer is a 7px sphere in the text colour
(`.review-dot`: one static radial gradient between `--mark-highlight`,
`--foreground` and `--mark-shade`, a spread-only hairline ring, no blur), the
brightest mark a row carries, with no weight change to the title; it is not
a hue, because ember, caution and negative already share that column. It
animates in only when the answer is newer than the row's own paint, so a row
scrolling back into view is still. A row's attention is an outcome you
acknowledge by opening the thread, and that covers a failure exactly as it
covers an unread answer: `threadStatus` reads `failed` from the attention
record `syncThreadStatus` writes once on the transition (never from the live
session's own status, which stays `failed` until the next prompt), a failure
on the conversation you are watching is already seen, `markThreadReviewed`
clears both kinds, and a session that failed before it had a store stands
down through `failureSeen` on its presence. Ready batches clear an answered
ask or a recovered failure but never an unread answer; a finished session
keeps sending them (a reported mode, an acknowledged setting), and the mark
once lasted one batch. A turn that ends while a renderer is disconnected is
read from the reconnect summary as a replay. Archiving is a dismissal too:
`acknowledgeThread` (`thread-lifecycle.ts`) resolves the target to its paths
and live key, clears the row's mark and marks its notification subjects
seen, so the pill and badge stop counting a thread you have put away. Before
this, a session that failed once wore the red mark and its folder's "1
failed" chip for as long as it existed, whatever you clicked or archived,
and the pill kept the count after an archive. `test-stage-layout.ts` and
`test-rail-ui.mjs` cover both marks. The Status view (`src/lib/thread-board.ts`) is the one place
threads regroup by state, in a fixed section order; Archived is reached from
the filter glyph. While the pointer is inside the rail the order caught at
entry holds, so a click cannot land on a row that moved, and rows that do
move glide there through `use-row-flip.ts` (transform only; nothing on first
fill, view changes, offscreen, or under reduced motion). Every folder shows
the same number of lead rows; selecting a project never resizes one.
`test-stage-layout.ts` covers the ranks, held folders, and the board;
`node scripts/test-rail-ui.mjs` drives the production rail.
A row's controls (pin, stop, actions, detach) live in a pill that appears over
the row's meta on hover or focus; an invisible control must never reserve
width, because at the rail's default width that halves the title. Titles keep
most of a row and folder chips shrink first; folder names keep room and the
branch label shrinks first. The Agents filter lists only providers the desk
names. A thread in a temporary directory is labelled `tmp`, never the random
directory name. A row's full text on hover is the rail's own tip
(`rail-tip.tsx`: one delegated listener reading `data-tip`, one portaled
element, a 400 ms wait and instant handoff between rows), never a native
`title`: since Electron 38 a `title` on macOS shows late, once, or not at all
(electron/electron#49843, open at Electron 43), and the rail's nested rename
hint changed the text under the pointer so the wait restarted mid-row.
`data-tip-quiet` on the controls pill keeps the tip away from their labels.
`test-rail-ui.mjs` checks the wait, the handoff, and that no row carries
`title`.

Native session ownership is provider plus native session ID, not a catalog path.
Account roots can expose one Claude session through multiple paths. Capture and
reply must reuse that owner; external activity must never silently turn a reply
into a handoff. `scripts/test-session-identity.ts` covers these aliases.

`electron/entry.ts` separates desktop clients from the persistent Electron host.
A private, user-owned socket identifies each data profile. Only the host takes the
profile's single-instance lock. Clients own separate Chromium storage and workspace
contexts. Workspace events are targeted; conversation events fan out. On reconnect,
clients reload authoritative state and never resend uncertain commands automatically.
Desktop RPC arguments must undergo JSON serialization before `RuntimeCallSchema`
validation: channel schemas can retain explicitly undefined optional object fields.
Keep positional undefined arguments tagged as `absent`; do not turn optional object
properties into null or loosen the wire schema. `test-runtime-transport.ts` covers
new-thread options, nested attachments/settings and invalid requests over a real
socket. After building, `node scripts/test-shared-runtime.mjs --transport-only`
checks both Electron client modes without starting a provider.
`npm run test:provider-launch-options` exercises the production launch actions for
all registered drivers and tests authentication refusal/cancellation. After building,
`node scripts/test-provider-e2e.mjs --launch-only` initializes installed providers
in disposable workspaces without prompts; it approves only the single advertised
Devin browser sign-in method. Other authentication choices require user action.
ACP session creation retries once only on `auth_required`, after explicit sign-in
consent and successful provider-owned `authenticate` on the same connection.
Never substitute CLI credentials or change the selected binary to bypass that gate.
Interactive sign-in is cancellable and is not capped by the 20-second RPC deadline.
Older installed binaries must finish their work before a one-time upgrade; do not
merge their active journals or run a new host against an occupied profile.

`test:shared-runtime` runs independent Electron client processes with a real Devin
session, then verifies reload, all clients closed, offline completion, reopening,
archive/restore synchronization, and sidebar Stop with a paused queue. It uses a
private test profile and the actual Electron binary, not the npm CLI wrapper.
`test:thread-lifecycle` covers idempotent archive receipts, stale Stop targets,
unrelated runs, and targeted workspace events. Archive is a reversible host-owned
filter, never native history deletion. Active archived threads remain visible until
they finish; Restore and explicit queue Resume remain available.

An interrupted request already represented in the transcript needs only a stopped
marker on its exchange, and the marker says who stopped it. A request's
`interruption` (`electron/contracts/live-conversations.ts`) carries a reason
and the moment: `stopped` is the user's Stop; `host-quit` is written by
`LiveConversations.stop()` for every turn still dispatching when the host
closes for a quit, restart or install; `host-crashed` is what the next host
writes when it finds a turn still dispatching in a journal no host is
writing, and that request is `uncertain` because the provider may have
finished it. The exchange footer reads "Interrupted when Mako quit" or
"closed unexpectedly", and on the newest such turn while the session is idle
offers Continue turn (`turnStops`, `continueTurn`), which sends one plain
prompt through the ordinary send path; a user's Stop offers nothing. A
delegated child cut short by a host exit settles as `failed` in its parent,
never `canceled`, so the parent may delegate again; `stop()` flushes every
resident before it closes any journal because a child's verdict lands in
its parent's. `test-live-conversations.ts` covers the reasons,
`test-live-controls.tsx` the footer and the recovery rows.

The fourth reason, `connection-lost`, is a turn the agent ended on its own
dropped backend connection. It was found on `cursor-agent acp`, which ran
its agent loop without the transport retries its TUI and SDK paths use, so
the first `[canceled] http/2 stream closed with error code CANCEL (0x8)`
from Cursor's backend (common a quarter-hour into a tool-heavy turn) was
written into the transcript as `Error: RetriableError: …` and the turn
still answered `end_turn`; Mako recorded that as a completed answer. Now
the SDK driver settles the session `failed` with `lastStop:
CONNECTION_LOST_STOP` when its run ends on an error the SDK codes as a
dropped connection or words as one (`connectionLost`), and `LiveConversations` records
that request as `interrupted` with reason `connection-lost` and
`failure: "network"` rather than `failed`, because the turn's work is in
place and the right offer is Continue turn, not Send again; the footer
reads "The connection to Cursor dropped" and the Continue prompt says the
connection dropped. The ACP path has no provider-specific reading of a
turn's final text any more: the hooks that lifted Cursor's error prose out
of the transcript and re-asked `cursor-agent` for the option set its failed
backend fetch had left empty went with the transport, and an ACP turn's
verdict is its stop reason or its prompt error (`acp-turn-verdict.ts`).

A dropped turn is continued by the host itself, once. The turn's work is on
the provider's side, so when the settled request is the newest one and
nothing is queued behind it, `LiveConversations` stamps its interruption
with `autoContinue: { at }` and, `AUTO_CONTINUE_DELAY_MS` (2 s) later, admits
a request carrying `continueTurnPrompt("connection-lost")` under the
interrupted turn's own `tuning`, marked `continues: { requestId, reason,
auto: true }` (`electron/contracts/turn-continuation.ts` holds the prompt,
the delay and `autoContinueCandidate`). One attempt per turn: a continuation
that drops again is never a candidate, nor is a turn something already
continues, so the second drop leaves the manual offer. The timer re-checks
eligibility when it fires; the user's own prompt, Stop, `close`, a pending
transfer, a rewind, an open permission and a host that is leaving all
decline it and clear the stamp, and a journal reopened by the next host
loses the stamp with the host that made the promise. The renderer reads the
stamp: the footer says "continuing automatically" with the live mark and
offers no button, presence and the rail keep the row working, and no
`failed` outcome is announced or marked for a drop Mako is about to pick up.
Mako's continuation renders as Mako's line where the prompt would be ("Mako
continued the turn after the connection to Cursor dropped"), never as the
user's bubble; a continuation the user pressed the button for is their
prompt and stays one. `test-live-conversations.ts` (`autoContinuedTurn`),
`test-prompt-delivery.tsx`, `test-live-controls.tsx` and
`test-notifications.ts` cover the send, the bound, the declines, the journal
and the quiet.

A failed turn carries a `failure` kind decided once on the host
(`electron/contracts/provider-failure.ts`, no imports, shared with the
renderer): `transcript-rejected` (the model API refused the session's saved
history, OpenCode's null `encrypted_content` reasoning replay), `context-exhausted`,
`auth`, `rate-limited`, `provider-unavailable`, `network`, `resume-failed`,
`rejected-input`, `unknown`. Rule order matters: specific faults precede the
HTTP families they could also trip. The renderer never pattern-matches error
text; it describes the kind with the provider's name, keeps the provider's
own text readable beneath, and offers Send again only when the kind is
retriable, so a rejected transcript says to start a new thread instead of
inviting a round trip that cannot work. A failed transfer carries the same
kind, and a start that fails for no classifiable reason while reopening a
session is `resume-failed`. The banner for a failed thread uses the same
description. `test-provider-failure.ts` covers the texts, priority,
retriability and start failures.

Every `ChatMessage` projected from a native store carries a `MessageAnchor`
(`electron/contracts/message-anchor.ts`): the entry's index plus the
provider's own id and timestamp when the store records them. Fork and
transcript bundling name the answer by its anchor, and `resolveAnchor` finds
it in a page by id, else by timestamp and kind (nearest the remembered index
when two share a second), else by position while the same kind still sits
there; a store that moved since the transcript was read therefore forks at
the chosen answer, and only an answer that is gone is refused, by name. A
native fork point without an anchor still refuses a moved store as before.
`reconcile.ts` compares anchors too, so a message keeps its identity when a
page loads earlier entries in front of it. `test-message-anchor.ts` covers
the resolution rules and the host fork against a moved store.

Recovery details retain failed, uncertain, and otherwise
unrepresented input without repeating it in a permanent panel. An auxiliary ACP
steering cancellation cannot override a successful turn; explicit Stop remains distinct.
The main activity indicator uses the tuned 64px thinking-orbs states. Running
project headers and rows use the separately tuned 20px preset; terminal states
remain static. Motion must stop offscreen and under reduced motion. Keyboard jump
hints cover the provider glyph, never the status indicator.

Devin supports ACP session/load. Its native locator is a SQLite row, not a file;
its resume policy validates native identity and session locks, and uses the native
main-chain revision for checkpoints. Legacy records without a checkpoint may
load the existing unlocked native session. Same-provider reconnect preserves the
observed model and mode and never replays the saved transcript into itself.
A failed resume must not silently create a replacement native session.
`test:desktop-continuity` covers warm preview sync, full idle shutdown, and legacy
journal recovery. `test-devin-resume.ts` checks native revisions and lock handling.

New checkpoint payloads use self-contained private Git packs, not the user's
object database. Captures must not add objects or refs to that database. Restore
imports the selected pack before publishing the saved index, so later checkpoint
expiration cannot strand staged blobs. Legacy repository-backed checkpoints remain
readable; their refs are removed only after ownership checks and a Git compare-and-swap.
Never run Git GC against a user's repository to enforce Mako's storage policy.

Retained checkpoint payloads are limited to 1 GiB per profile/workspace, with a
512 MiB per-capture limit, a 30-day/1,000-record retention target, and at most 64
removals per pass. This payload budget excludes the SQLite catalog, provider-native
history, and bounded temporary capture files. Active baselines, persisted 30-minute
preview leases, and unfinished restore inputs/backups are protected. If they fill
the budget, refuse a new retained capture rather than delete recovery data.
Rewind reuses the preview as its durable backup; current-state and compensation
captures are temporary and cleaned up, including after a process crash. Only an
unfinished capture with a dead owner may be reclaimed without a catalog row;
completed or live uncatalogued payloads remain protected and count against admission.
Completed restore receipts remain valid after their checkpoint expires.
`npm run test:workspace-snapshots` checks these rules in disposable repositories.
`npm run benchmark:snapshots` records capture/preview/restore timings and retained
bytes for 100-file and 5,000-file fixtures.

`npm run test:packaged-lifecycle -- /path/to/Mako.app --renderer-only` checks
packaged launch and draft reload without starting a provider. Provider lifecycle
checks still require valid provider authentication. Until a workspace or existing
conversation supplies a draft target, the composer is inert and read-only; otherwise
startup input is saved under `project:/` and disappears when workspace metadata arrives.
The test waits for the editable composer and verifies trusted input delivery before
reloading. `MAKO_PACKAGE_SOAK_MS=600000` runs a ten-minute reload workload. The sampler
records whole-tree RSS and per-process physical footprint, with 4 GiB stop limits
and a 10% system-memory-free floor. It checks steady-state footprint growth after
warmup. macOS's setuid-root `ps` can deny physical readings; the approved unprivileged
mode records that coverage gap explicitly, never as a successful zero-byte reading.
Other measurement failures still fail the check. The native sampler is test tooling,
compiled with the installed Command Line Tools, not an application dependency.

Send must not await display-only discovery. Native defaults need no catalogue;
a provider's `nativeModelIds` capability permits unchanged model-only selections.
Option-bearing settings still require the provider's launch catalogue, and legacy
preferences still need their authoritative option-name migration. Full default
probes run behind that catalogue without mutating it. Account and real workspace
paths key the caches. Discovery keeps at most four CLI processes, with no more than
three background jobs so launch validation retains capacity. A failed launch
catalogue must reject an explicit model selection with its actual discovery
error; never forward an unresolved family ID and its options to ACP. Failed
provider startup disconnects its resident and ignores late transport events.
A display discovery that fails after the account has listed its models once
(Cursor's model listing once timed out under load) answers with the last
discovered profile and a `configurationError` naming the failure, never
`available: false`; the failure is held `FAILED_DISCOVERY_TTL_MS` (5 s), not the
30 s display TTL, is never persisted, and the renderer asks again on a
10 s–2 min backoff (`discoveryRetry` in `src/state/providers.ts`) instead of
waiting for a window focus. A finished thread whose store records no model
(a `cursor-agent` store never does; the SDK's `index.db` does) resolves to
the provider's default with source `provider`, because that is what a
continuation runs under until the session reports. `test-send-discovery.ts`, `test-profile-refresh.ts` and
`test-composer-settings.ts` cover these.
A starting conversation has no session settings; the composer resolves it
through the target the send used, so the model control never reads
"unavailable" while a provider starts. Only a failed profile is unavailable;
a session that has not reported its model yet is loading.
`test-composer-settings.ts` covers this.
A provider login is verified by a fresh `auth status` and model discovery,
not by the browser or login command's success message. Never borrow IDE
credentials or switch binaries to evade an authentication boundary.

`test:message-queue` covers these boundaries with held discovery promises and real
fixture subprocesses. ACP and app-server startup must consume the host-provided
MCP snapshot, including its local-control readiness gate. `test:background-lifecycle`
checks that no provider process starts before that gate. `test:mcp` verifies provider
discovery and managed diagnostics overlap without omitting either result.

`MAKO_STARTUP_TRACE=1 MAKO_STARTUP_BUDGET_MS=5000 npm run test:packaged-lifecycle --
/path/to/Mako.app claude --ui-start --warm` checks the real composer, warm startup,
and full host restart/recall. `--model=<native-id>` checks a cold explicit model.
`npm run test:packaged-startup -- /path/to/Mako.app` separately exercises the
normal packaged desktop client cold-starting its own shared host, then client
Quit/reopen and draft persistence. Every macOS package runs this check before
being reported ready. Never use `app.getAppPath()` as a subprocess cwd: packaged
apps return an `app.asar` file, not an OS directory. Preserve the real process cwd.

The lifecycle test always uses a temporary `MAKO_DATA_ROOT` and standalone host;
closing a shared-host client alone would not test host restart. Keep acknowledgement,
provider dispatch, first content, and completion measurements distinct. Archive checks
reject missing local named/default exports as well as missing import paths; frozen
files can still contain an incomplete concurrent compiler emission.

For the normal terminal workflow, run `npm run update:local`. It resolves the
verified installed signer, or an unambiguous signer from existing local release
artifacts during the first transition; builds to a unique output; asks before
installation; waits for safe shutdown; installs and reopens Mako. It never
force-stops agents. Older standalone apps must be quit manually after their work
finishes. `npm run update:local -- --check` is read-only, and
`npm run test:update-local` exercises orchestration and signer selection without
building or replacing the user's app.

Local installed builds use `npm run package:mac:local`, with
`MAKO_LOCAL_SIGNING_IDENTITY=<certificate SHA-1>` for the first build. Later
builds recover the signer from the signature-verified installed local app.
The certificate must stay in Keychain; never generate a new one per build or
fall back to ad-hoc signing. Local metadata must not enable public updates.
`npm run test:local-signing -- --identity=<SHA-1>` checks changed native binaries,
identity reuse, and rejection of ad-hoc, tampered, and wrong-signer builds.
`node scripts/test-local-package.mjs <Mako.app> [previous-Mako.app]` checks the
actual package metadata and cross-build signing requirements. Install with
`npm run install:mac:local -- <Mako.app> --install`; omit `--install` for a
read-only readiness check. Installation refuses running Mako processes or a
running default shared host and retains the previous app. Open the installed
app before starting a development host after the one-time signing transition.

A TCC grant is bound to the designated requirement the app had when the row
was written, so a build whose requirement differs (an ad-hoc cdhash, a new
certificate) is denied while System Settings still shows the toggle on and
macOS never prompts again. Both installers compare the retained app's
requirement with the new one and reset Mako's Accessibility and Screen
Recording rows when they differ; the receipt says to grant again. Settings'
Grant resets its own row before prompting for the same reason. Read tccd's
verdict with `/usr/bin/log show --predicate 'process == "tccd"' --info`;
zsh's `log` builtin shadows the command and prints nothing.

Performance audit tooling is isolated from application entry points. Run
`npx tsx --tsconfig tsconfig.app.json scripts/audit-runtime-performance.ts` for
projection, journal, selector and catalogue scaling, and
`npx tsx --tsconfig tsconfig.app.json scripts/audit-provider-payloads.ts` for
SDK/app-server payload amplification and long-answer fidelity. These use synthetic
fixtures, never real provider prompts. `node scripts/audit-render-performance.mjs
--production` builds production components into a private temporary directory and
measures real Electron rendering and trusted input. `--file` checks production
file-URL loading and its worker assets. `--local-markdown` disables parser offload
only in the audit build; `--baseline-markdown` additionally restores per-update
Markdown subtree work. Compare rendered HTML hashes, not just speed. Omit
`--production` for development Profiler counts, never production frame timings.
`audit-concurrent-streams.ts` combines real reduction, JSON validation, journaling
and projection for 1/4/8 synthetic streams; it is not provider-network throughput.
Record machine load and swap pressure before interpreting its tails. Reports
retain ResizeObserver delivery warnings rather than treating them as clean rendering.
React Compiler lint diagnostics do not establish that the build enables React
Compiler; check the actual Vite plugins before relying on automatic memoization.

`npm run test:performance` covers tail-only projection against a full-rebuild
oracle, equal-length replacements, tool-derived Context identity, journal
append/reopen/rollback/compaction/Unicode, lazy background hydration, closed-leaf
cache eviction, and the exact worker Markdown pipeline. The parser worker uses
the same GFM/citation transformations and React Markdown postprocessing; cached
trees must be cloned before that postprocessing mutates them. Resolve the entity
decoder's DOM-free entry in Vite: its browser export needs `document` and fails
inside a worker. The browser audit must assert worker use, not accept a silent
fallback as an offload success.

Journal text appends remain in the same SQLite transaction as metadata;
publish only after commit. The journal and the requests store run WAL with
`synchronous=NORMAL`: a committed transaction survives a host crash either
way, only a power loss in the same instant can lose the last commits, and
`FULL` fsynced the WAL on the host's main thread at every streamed flush.
Snapshots and the archive stores keep `FULL`. Compact bounded append chains and preserve
authoritative replacements, truncation and split UTF-16 characters. Dirty-range
metadata uses weak references so it cannot retain every prior block array.
Closed leaf journals have an 8-entry/64 MiB estimated warm-cache budget; active,
transferring, checkpointing, rewinding and parent conversations remain protected,
and the currently accessed oversized entry may exceed the estimate. Eviction
closes the resident journal, never deletes persisted history.

## Application updates and exit

`application-lifecycle.ts` owns pending install/restart operations and admission
while the host is stopping. Count native runs, live requests, queued work,
permission waits, startup, workspace operations, and background builds. A stale
Stop confirmation must never stop a newer turn. Ordinary Quit detaches the
client; explicit Stop closes managed agents and holds queued prompts.
`window-shutdown.ts` requires every affected window to acknowledge draft saving.
Do not close a window with failed draft persistence or interpret a missing
acknowledgement as consent.

Settings > Updates and the command palette share the same state actions.
Local builds use an explicitly selected trusted checkout and a private copy with
internal workspace links. Physical copies and cleanup must use Electron's
`original-fs`, not its ASAR-aware filesystem: dependency archives must remain
ordinary files. Exclude nested generated caches and local environment files;
do not relax dependency-link isolation to make copying pass.
`npm run test:checkout-copy` exercises the real Electron filesystem with an ASAR
fixture; pass the checkout path to verify real dependencies, or `-- --app <app>`
to check signed-bundle staging. `npm run test:settings-build -- <checkout>` runs
the complete Settings build service against a private profile without installing.
They preserve npm security configuration, run build,
lint and regression checks, and verify the existing signing identity. Public
release updates remain separate from local builds. `package-mac.mjs` stamps the
actual packaged inputs with a build ID, timestamp and source revision.
The local installer prepares outside the running bundle, waits for its processes
to exit, retains the previous app, and rolls back failed replacement verification.
Never install over a running app or turn Stop into an automatic prompt replay.
CLI and in-app replacement share `replacePreparedApplication`: it takes an
exclusive per-target install lock, rechecks target identity and live processes,
and restores the previous app when post-replacement verification fails. A lock
left by a crashed installer requires an operator to verify the owner stopped;
never delete it automatically. Process checks include the OS executable name,
not just the mutable process title. Desktop relaunch strips host/profile/Node
launch flags. Installation success and relaunch failure are distinct receipts.
The CLI verifies the new host's build ID before reporting startup success.
Packaged tests must check full host shutdown as well as client Quit/reopen;
`BrowserWindow.close()` is asynchronous, so final client exit belongs to the
last window's `closed` event.

`npm run test:application` covers the lifecycle state machine, draft-close
acknowledgements, source-copy isolation, replacement rollback, real Electron
private-socket clients, and the production Settings/dialog/palette components.
Providers and installations are fixtures; these checks do not replace the user's
app or send provider prompts. `npm run test:application-ui` retains light/dark
screenshots and checks trusted input, safe focus, cancellation and reduced motion.
`test-draft-persistence.ts` also checks failed-save exit refusal and retry routing.

## Detached daemons and profile hosts

Two processes outlive the host on purpose: the terminal daemon
(`terminal-daemon.ts`, one per profile) and the session sync daemon
(`@mako/sessions` `daemon-main.ts`, one per user, optionally a LaunchAgent).
Both set a process title (`mako-terminal-daemon`, `mako-syncd`) and an
installer's running-process check excludes exactly those titles; the title is
trusted only to exclude, never to detect, so nothing that renames itself can
evade the executable-name check. Every daemon answers with the build that
spawned it: the terminal daemon echoes `--build`, the LaunchAgent carries
`MAKO_DAEMON_VERSION`. Both come from `buildTag()` in `build-identity.ts`,
which includes the packaged build ID because every local build reports the
same version. A host from another build retires the daemon on first contact
and respawns it from its own executable, so an update never keeps serving from
the bundle it replaced. Terminal scrollback is persisted first; live shells
are reported interrupted.

When the sync daemon is not enabled, the host still never reads a store on
its main thread: `electron/catalog-worker.ts` runs the catalog on a
`worker_threads` Worker that serves the daemon's own frame protocol
(`serveCatalogOnPort`) over a `MessageChannel` port transferred in with the
worker data, and `threads.ts` adopts it exactly as it adopts the daemon
(`adoptClient`, `connectDaemonPort`). The protocol is transport-neutral
(`DaemonLink`): the detached daemon speaks it over its Unix socket, the
worker over the port. The port matters: a Unix socket delivered a 7 MB
thread to Electron's Chromium-integrated loop as some nine hundred 8 KiB
reads and the host spent 200 ms draining it, while the port posts the frame
whole. Every NDJSON reader (`LineAssembler` in `daemon-wire.ts`: the daemon,
the Codex app-server, the runtime event stream, the web bridge) assembles a
line from chunks without rescanning what it already holds; the old
`buffer += chunk` loops were quadratic in the line's size. The worker's
heap is bounded by `resourceLimits` rather than the daemon's RSS guard
(which would read the host's RSS), a lost worker is restarted once before
the host falls back to reading in-process, `daemonStatus` reports only the
detached daemon, and an `open` through the worker is never raced against a
read on the host thread. Before this a 38 MB Cursor store or a locked
SQLite database stalled every RPC while it was read.

`SessionCatalog.open` keeps the last four translated threads warm, and a
write invalidates only what it can have changed: a per-file store drops its
own path, a shared database (`rescanRoot`) drops that provider's threads and
no other's. Before this the cache was one entry that any rescan cleared, so
Cursor Desktop writing `state.vscdb` on every keystroke made every open of
the Codex thread on screen re-read a 3.7 GB tail (135 ms, on every reopen and
every preview). `packages/sessions/test/streaming-correctness.mjs` covers the
scoping and the bound; `test/daemon.mjs` covers the port transport, including
a port transferred into a real worker.

launchd is consulted through `launchctl print`, never through the exit code
of `bootstrap` or `bootout`: a bootstrap that loads the job has returned an
I/O error, and deleting the plist on that verdict once left a job running for
three days with no definition and no host able to see it. A loaded job with no
plist is booted out by the installed app.

A profile host (dev, sandbox, test) stops itself after twenty minutes with no
client, no lifecycle work and no launcher lease (`host-idle.ts`; the dev
launcher holds a pid-keyed lease beside the host socket). The installed
app's default-profile host never does. Every host removes its runtime
directory on exit, and a new host removes driver sockets whose owner is dead.
Retained previous applications are pruned after a verified, launched install:
only the newest backup survives, and only staging directories holding nothing
but a backup and its installer script are removed, under the install lock.
`updates/build-*` directories are removed when `LocalUpdates` loads: the
prepared build is copied into `/Applications` before the host quits and its
state lives only in that host, so every one an earlier host left is dead
weight (four held 3.4 GB). `test-host-idle.ts`, `test-local-update-install.ts`
and `test-local-build-source.ts` cover these.
