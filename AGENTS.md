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
which is what the turn navigator and the History panel are for.

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

The stage's surfaces — Changes, Context, History, Files, Terminal —
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

Browser tools publish input-mode JSON Schemas (defaults optional, every field
described, `$defs` kept) and bound every text result to 200 KB. Input is real:
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

Kiri is the normal Git backend, not an opt-in. `kiri-engine.ts` owns the process-lifetime sidecar and leased repository handles; `host-git.ts` and `git-preview.ts` adapt its typed data to Mako's existing host contract. `kiri-commit.ts` binds Mako's model connections and retains reviewed drafts per client/workspace. Do not restore a second Git or analysis implementation as a fallback. Engine/client mismatches are explicit errors checked against the protocol version and canonical schema digest.

`npm run prepare:kiri` builds the sidecar from the sibling Kiri checkout (or `KIRI_SOURCE_DIR`) when available and installs it under `vendor/kiri/<platform>-<arch>/`. `build:electron` runs this step. The macOS packaging configuration includes the engine under Resources and lists it for signing; development resolves the prepared vendor binary automatically. `MAKO_KIRI_BINARY` is a test/development executable override, not a feature flag. `@kiri/client` comes from a pinned, generated SDK tarball in `vendor/`. Update the SDK and engine together. Vendor an engine built from a committed Kiri revision, most simply a detached worktree passed as `KIRI_SOURCE_DIR`, and pack a new `@kiri/client` whenever the engine's schema hash moves; `prepare:kiri` refuses the mismatch, and `vendor/kiri/<platform>-<arch>/manifest.json` must record the vendored engine's own checksum. `npm run test:kiri-engine` exercises the sidecar through Mako's AI SDK against a local model endpoint in a disposable repository.

`ChangesPanel` stages, commits, and pushes. Commit drafting uses the host-only
AI SDK connections in `utility-models.ts`, configured in Settings > Commit
messages, never a coding-agent session. API keys are encrypted through Electron
safeStorage in the isolated profile; no key is returned in a settings snapshot.
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
an isolated host profile with no existing model connections and prints screenshots.
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
`git-push.ts`; the commit bar is its only primary Push control.
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

## Product surface

Provider sessions, the built-in runtime's session tree, and the current git
diff. No worktree manager. There is no status bar: the always-on facts live
in the titlebar's right cluster, and the context/cost readings sit beside
the composer, next to the send they price. The rail is the vertical thread
list; horizontal tabs inside the central workbench hold the agent session,
files, and diffs for that thread, never more sessions.

The composer groups file attachments, screenshots, references, skills, and MCP
settings under one + popover. `composer.controls` contributions render inside
that menu and may dismiss it before capture. Typing `$` anywhere or `/` at the
start of an empty draft opens one capability menu listing the skills and MCP
servers the *selected* provider will actually have: skills from that provider's
own roots plus the universal `.agents/skills` roots, and servers from the same
reach predicate the host projects into a launch (`electron/contracts/mcp-reach.ts`,
plus the launch-attached conversation tools). Mako's managed servers wear the
fin. A pick inserts plain text in the sigil typed (`$name`, `/name`,
`$mcp:server`); providers receive exactly that text. Skills installed only for
other providers are a count in the footer that opens Settings, never a row.
`scripts/test-composer-capabilities.ts` covers the tokens, reach, and ranking. Terminal remains on Command-J and
in the command palette, not as an extra composer icon. Context usage is shown
only with an exact, usable reading; unsupported providers do not get an empty
ring. Chat activity uses one compact 20px mark and no redundant Responding row
while answer text streams. Thought-process details remain available without a
second animated status.

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

When the host closes for a restart, install or quit it answers every pending
call with `host-restarting` (`electron/contracts/host-connection.ts`) instead of
resetting the connection. The client turns that, and a dropped socket, into
`RuntimeDisconnectedError`; `electron/runtime-retry.ts` repeats read-only
channels once the event stream reattaches and never repeats a mutation. The
renderer treats that error as the reconnect banner, not a toast.

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
mid-turn delivery, idle replies, queueing, native identity, and retained context.
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

Permission modes are saved only after provider acknowledgement, separately for
each provider. New sessions apply that mode before their first prompt. Execution
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
against the installed CLIs: Cursor advertises agent/plan/ask, asks for every
command, and ignores `--force`/`--yolo` under `acp`, so Accept edits and Full
access are host-enforced on top of `agent`. Devin advertises all five tiers
natively. Grok reads `--permission-mode` at launch and, in every mode except
always-approve, denies tool calls over ACP instead of asking, so its tiers are
launch-only. OpenCode reads `OPENCODE_PERMISSION` at launch; its remaining asks
can be host-answered. Claude maps its own modes, with `bypassPermissions`
allowed at launch so a later switch is accepted. Codex sends approval policy,
sandbox, and reviewer with every `turn/start`; a change applies to the next
turn. `test-access-modes.ts` covers the placements and decisions.

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
Rail order holds still while agents work: `stableThreadRanks` in
`src/lib/thread-folders.ts` gives a busy thread its rank when it starts, keeps
it while the thread is working, observed, or externally active, and settles it
once when it finishes, so a file that changes on every token moves nothing.
Every folder shows the same number of lead rows; selecting a project never
resizes one. `test-stage-layout.ts` covers the ranks and the stable order.
A row's controls (pin, stop, actions, detach) live in a pill that appears over
the row's meta on hover or focus; an invisible control must never reserve
width, because at the rail's default width that halves the title. Titles keep
most of a row and folder chips shrink first; folder names keep room and the
branch label shrinks first. The Agents filter lists only providers the desk
names. A thread in a temporary directory is labelled `tmp`, never the random
directory name.

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
marker on its exchange. Recovery details retain failed, uncertain, and otherwise
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
`test-send-discovery.ts` and `test-live-conversations.ts` cover these refusals.
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

Journal text appends remain in the same FULL-synchronous SQLite transaction as
metadata; publish only after commit. Compact bounded append chains and preserve
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
`test-host-idle.ts` and `test-local-update-install.ts` cover these.
