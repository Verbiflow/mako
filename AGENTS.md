# Mako

Mako is a meta-harness. Claude Code, Codex, Cursor, Grok, Devin, and OpenCode
are peer providers with provider-owned control and observation transports. No provider
is privileged in public types, bridge names, UI language, continuation, or
session handling.

Mako has no embedded coding-agent runtime. A tab (`workspaces/agent-host.ts`)
owns only the workspace and git boundary; every coding agent runs through a provider-owned
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
the transcript's exchanges, and token or spend readings appear only in the
composer meter's popover and Settings › Usage, never as a per-thread panel.

## Layers

One direction of knowledge, no exceptions:

1. **Host** (`@mako/host` in `packages/host/`, and the parts of `electron/`
   that haven't moved there yet) owns the agent runtime and git. It speaks
   one wire contract, the modules in `packages/host/src/contracts/`
   (`@mako/host/contracts/<name>`), and nothing else crosses the boundary.
   Import the contract module that declares a name; there is no barrel.
2. **State** (`src/state/`) is React-free. `store.ts` is the observable;
   `session.ts` applies host events and owns every mutation the UI can make.
3. **Components** (`src/components/`) are presentation. They read through
   selectors and call domain actions in `src/state/`. Components and desk code
   never import `src/lib/bridge.ts`; ESLint enforces that boundary.

Outside `packages/host`, code imports the host by name (`@mako/host/…`),
never through a relative path into it. What runs TypeScript reads it from
source: tsx, Vite and the renderer's and scripts' typechecks, through the
`paths` in `tsconfig.json`, `tsconfig.app.json` and `tsconfig.scripts.json`
and Vite's alias, so a test or the desk sees an edit without a build.
Compiled JavaScript (`dist-electron/`, the packaged app) reads its `dist/`
through the package's `exports`, as `tsconfig.electron.json` does through its
project reference. The renderer reaches only `@mako/host/contracts/*`. The
package imports nothing from Electron, not even a type:
`scripts/check-host-electron.mjs` and ESLint fail on it.

Inside the package, `contracts/` is the wire and imports only itself;
`base/` is what every domain stands on (the environment, the log, crash
reports, the platform, secrets, the lifecycle, the scheduler, the lock, heavy
packages) and imports only itself and the contracts. Each domain is a folder
that reaches another domain only through its entry, `<domain>/index.ts`, and
files directly in `src/` compose the host. `transport/` is how a host is
reached: the socket server and the method table, and the wire's client end
(`connection.ts`, and `service.ts` for where a host lives and how it starts),
which the desktop imports by file and another host through the entry.
`application/` is the host's own life: its lifecycle (quit, restart, install
and what each waits for), its updates and local builds, and the installer that
replaces the app after the host quits. `control/` is browser and computer use:
the browsers agents drive, the computer-use driver, the previews of both, and
the host's end of `/desktop` (`desktop-channel.ts`), on which it asks the
desktop app for what only Electron can do. `git/` is the Git of each tab:
status, staging, commits and their drafts by a utility model, and pull
requests; `GitTab` names what it needs of the tab Workspaces holds, and its
utility language models load through `git/heavy.ts`. `tools/` is what agents
and people call besides the harness's own tools: every harness's MCP servers,
skills, hooks and commands, copied between harnesses, the plugins, and the
`mako` and `mako-computer` servers each agent is handed. Each harness declares
where it keeps its MCP servers and skills in the shapes `tools/` names
(`ProviderMcpSource`, `ProviderSkillSource`); `ToolHarnesses` is what Tools
reads of them, and `openTools` builds the registries from it. `usage/` is what
the harnesses spent and what Mako reports: the usage ledger, its pricing and
the scan of each harness's own store (`ProviderUsageHistory`), telemetry, and
the Mako cloud account. The ledger is read off the host, in a worker whose
script composition names (`packages/host/src/usage-worker.ts`, which supplies the
harnesses). `threads/` is every session on this Mac and the Threads
they belong to: the Thread store, the catalog over every harness's native
store (`catalog.ts`, on the sessions daemon or a worker), the session
ledger, archives and stops, titles, groups and chat folders. Each harness
says how it sees its sessions open in other apps (`ProviderProcessProbe`);
`ThreadHarnesses` is what Threads reads of them. `workspaces/` is the folders
agents work in: each window's tabs and their files, search and watches (one
watcher child serves every watch), Thread worktrees and their spares,
recipes and each Thread's apps, their processes, traces and checks,
checkpoints, moves between checkouts, automations and the harnesses'
artifact previews. It reads the live conversations through
`WorkspaceConversations`; composition makes what its tabs share
(`TabServices`). The package declares
every package it imports (`scripts/check-host-dependencies.mjs`). The package reaches its own files
by relative path. `scripts/check-host-boundaries.mjs`, in `npm run lint`,
holds all of it, type imports included.

## How the host is put together

`packages/host/src/host-main.ts` is the program: what belongs to the process. It reads
the configuration (`processHostConfig` in `host-config.ts`; no socket exits
64), opens the log, takes the data root's lock, and owns signals and the exit.
`createHost(config, owner)` in `create-host.ts` is the host. Its `start()` opens
each domain in `electron/domains/` in dependency order, declares every method,
then listens on the socket; its `stop()` releases everything in one fixed
order. A host that can't start says why on stderr and in `host.log`, stops
through its lifecycle and exits 1.

Each domain file has an `open…` factory that takes its dependencies and
returns its services, and a `declare…Methods(methods, deps)` that declares the
methods those services answer, next to their code. Methods are declared only
once every service exists, so no handler sees a half-built host. Where two
domains need each other, `createHost` passes a getter (`live: () =>
conversations?.live`) rather than a domain importing another's files.

- **Methods.** `HostMethods` (`packages/host/src/transport/methods.ts`) is
  the one table every transport calls. `methods.handle("mako:…", (…args) => …)` parses the
  arguments with the generated schema, refuses outside a fixture desk's
  allowlist, routes a call about another host's conversation there, and pages
  history. Declaring a method twice throws. A contract method no domain
  declares stops the host before it listens (`methods.undeclared()`). After
  adding or changing a handler, run `npm run generate:host-inputs`.
- **Recurring work** goes through `HostJobs.every(name, everyMs, run)`, never
  `setInterval`: each job is named, runs on an unreferenced timer that varies
  by a tenth either way, skips a run while the last is still going, logs a
  failure as `jobs <name> failed`, and stops with the host.
- **Two file readers** (`workspaces/file-readers.ts`). `readSignedFile` serves
  only a `mako-file://asset/…` URL this host signed; it is the one thing the
  gateway's link (`PortRelay`: phones, other devices, cloud machines) reads
  files through, and the relay itself passes on nothing but `/file/asset/…`.
  `readWindowFile` also opens any path in a workspace, absolute ones included,
  so it is for a window on this Mac alone; handing it to the link lets anyone
  on the account read the Mac's files.
- **No module-level state.** What the host holds lives in what `createHost`
  builds, so a test makes the one domain it needs. `check-host-module-state.mjs`
  (in `npm run lint`) fails on any module-level `let` and any empty
  collection or instance at module scope in a file the host loads, its
  packages included. A cache lives in the instance whose users own it
  (`InstalledBrowsers`, `ProtocolReference`, `RecordingRenderer`), and a
  worker or child process is told what it must know (`strictStores`). What
  the process resolves once (its environment, machine, secret store, crash
  reports, log) is made where it starts and handed down. What
  any module reports without a handle on its owner (log lines, unknown native
  records, provider spawns and exits) is published on a `topic` (a Node
  diagnostics channel, `base/topic.ts`) and kept by whoever subscribes:
  the process keeps the log, the host keeps `NativeUnknown` and
  `ProviderChildren` from `start` to `stop`. Anything can watch one by name
  (`diagnostics_channel.subscribe("mako:host-log", …)`).

## Provider composition

A provider is installed once from `packages/host/src/harnesses/<id>/index.ts`. That
module contributes independent capabilities to `providerHost`: metadata and
model discovery, native and ACP execution, accounts,
MCP discovery/writes, and skill roots.
Consumers query those registries; they never maintain another list of provider
ids or branch on all known providers. Provider-specific wire syntax and paths
belong under that provider's directory. A new provider adds one module to
`packages/host/src/harnesses/harness-host.ts`; it does not add switches to shared consumers.

Whether a harness is installed is what its driver's `available` says:
`npx tsx scripts/harnesses-installed.ts`. Never `which`: Devin's CLI ships
inside `Devin.app` and isn't on PATH, and Cursor runs through its SDK package.
Live tests take the executable from the same resolvers (`devinExecutable()`).

What a session runs besides its turn is one roster for every harness
(`NativeAgentRoster` in `contracts/native-agents.ts`): subagents and
workflows, and the commands and monitors the agent left running, each with
its `work` kind, `background`, `ambient`, `stoppable`, its command line or
prompt (`detail`), the end of its output once it settles, and the native
messages it was read from (`source`); the host stamps `startedAt` and
`settledAt`. A turn that ended while that work runs is its own state,
`backgroundWork` in `contracts/background-work.ts`: neither running nor done,
counted as the larger of the roster's active non-ambient entries and the
provider's own level (`backgroundTasks`), which can't wedge on a missed end.
The window shows it as an hourglass on the row and tab, a quiet line at the
transcript's end and the Agents panel; ambient watchers are listed and never
counted. Claude's roster reads the SDK's task events and its
`background_tasks_changed` level (a Monitor reports as `local_bash`, so its
kind comes from the `tool_use` that started it), Codex's the terminal list,
Grok's its `background_tasks` list, Devin's its backgrounded exec calls and
OpenCode's its shells. A driver that can stop one entry alone declares
`stopNativeAgent` (`mako:live-stop-agent`); Stop ends all of it as each
`backgroundStop` says. A roster entry's progress shares the frame's flush;
its start and end flush at once. `npm run test:background-work` replays
Claude's captured messages and covers the state, the ranking and the
conflation; Settings > Diagnostics lists each session's background work with
its sources.

A turn a provider starts itself (`provider-turn`) carries what settled
(`TurnCause`: name, outcome, exit code, duration, a monitor's output, a
goal's objective) and what the work left to read as its `body` (an agent's
report, the end of a command's output, a monitor's event, a goal's spend),
from the harness's own record, never invented; the line words itself from
the cause and opens onto the body, never onto the provider's sentence. The
live engine stamps `at` where the host receives it (`stamped` in
`live-engine.ts`) and dispatch stamps each prompt, so the reducer and the
window only carry the time. Claude's SDK notification leaves out an
agent's report and a monitor's event (it sends nothing for a monitor's
event), so its driver reads the lines Claude writes for them, the same
lines saved history reads: the `<task-notification>` a turn it starts
runs on (waiting up to 1.5 s for it to be flushed), and, while background
work runs, the `queued_command` line it writes for one it takes into a
running turn, read as each model request starts (`requesting`) and drawn
there, citing its line. `ClaudeTranscriptTail` reads only what was appended
since its last read and parses only lines that name the queue or a
notification; reads are recorded in the capture (`{ transcript }`) for
`ClaudeDecoder.transcript`. A foreground command's own task notification
is never an event. An ACP agent that announces a turn while another runs
either says it `wakes` on it (Grok's `will_wake`: the turn opens after the
running one) or declares `midTurn: "marker"` (Devin writes it into the
running turn). A command's output is read only from the task's own
file under the harness's own folder (`claudeTaskOutput`,
`cursorTerminalEnd`), at most its last 8 KB, and what was read is kept in
`~/.mako/archive/outputs.sqlite` (`KeptOutputs`: keyed by harness, session
and task, the body's tail only, 4,096 copies or 16 MB, oldest first) and
read from there once the file is gone. Each marker's `source` says which
record it cites, `via: "wire"` when no record could be read, and `body`
when the body came from that file or its copy; `npm run decode -- --events`
lists them for a capture, a store or a pair.

Live native messages are decoded by a pure decoder per harness, declared as
the `decoder` family of its `HarnessDefinition` (or `absent` with a reason).
A decoder turns one native message into the shared `Decoded` events in
`packages/host/src/contracts/native-decoding.ts` and touches no process, clock or host,
so recorded messages always decode the same way. An empty list means "known,
deliberately silent"; `unknown` carries the raw record, which the engine
keeps (first of each kind and harness version per host life, with the version
the launch's handshake reported and the stream line it came in) in
`native-unknown.jsonl` beside the host log. Every harness is on this contract, and `test-harness-definitions.ts`
requires a decoder and fixtures of each, so a new harness ships with both
(build order: `docs/meta-harness/harness-integration.md`). A driver keeps
what is not the message's own meaning: binding turns, answering requests,
reading native state back, ordering content behind an async lookup. What it
must act on comes out of the decoder as an `effect` (OpenCode's `turn`,
`request`, `catalog`, `mcp`, `model` and `agent-call`; Cursor's `agent`).
ACP harnesses share `AcpDecoder` (`packages/host/src/harnesses/acp-decoder.ts`), which the live
client and the fixtures both run. What differs per harness is declared on
`ProviderAcpSource`: `plans()` (plan cards and which permission approves
them), `requests` (extension requests the agent sends the client; any other
gets "method not found") and `permissionTitle`. `acpDecoderSource(source)`
registers the recorded-message decoder from the same hooks. Every launch
keeps its stream, each frame the driver received from its harness, under
`~/.mako/records/streams/<harness>/<native id>@<launch>.jsonl`
(`packages/host/src/harnesses/native-stream.ts`), and the record store
captures it with the session (`tsx scripts/records.ts streams` shows each
beside what the store holds). `npm run test:session-flows` ends with
`scripts/check-streams.ts`: each session's streams took the id the catalog
reads, are held whole and restorable, and replay what Mako showed (a call
field past the wire's 64,000-character preview compared whole, from the
attachment its preview names); where the store draws otherwise it notes the
lines. Then it removes the run's sessions from their harnesses (`--keep`
keeps them). `npm run bench:streams` measures
what streams cost the drivers and the store. To change a decoder, inspect a stream with
`npm run decode -- <stream>`, turn the case into a fixture with `--fixture`,
then run `npm run test:decoders`. Streams hold conversation content whole; a
fixture is scrubbed of bearer tokens and `token=` values, but read it before
committing it. A fixture written from wire strings rather than
captured says so in its `source`, until a capture confirms it, as Devin's
captured `plan-approved.json` corrected the request shape `plan-mode.json` had
assumed.

Everything Mako keeps per user (the record store and the streams its
drivers write, decoded views, session memory, the Thread store, kept
outputs, model catalogs, installed readings, transcripts, staged
attachments, saved keys, the accounts Mako keeps with their selection,
leases and removals, and Cursor's SDK agents) is in the host's user root (`HostEnvironment.userRoot`):
`~/.mako` for the installed app, every profile and a cloud machine, and the
data root itself for a host isolated outside the application-data folder (a
test's, a proof's). An isolated host (`HostEnvironment.isolated`) reads its
catalog in its own worker, takes into its record store only sessions
written while it runs (never a backfill of the person's rail), and never
installs or changes the login sync. Nothing sets it but the root's place: a
cloud machine's agent starts its host on its user's `~/.mako`, so a machine
is never isolated, and `test:host-linux` starts its host the same way; a
proof that wants the shared reader with a private `HOME` puts its profile in
that home's application-data folder (`test-packaged-reader-recovery.mjs`).
What it would still share with the person is
what it runs as: their harness logins and stores (the Keychain items and
`~/.claude`, `~/.codex` and the like), so a test's or a proof's host runs as
a home of its own (`scratchHostHome`, below), never the person's. Accounts are `AccountRoot`
(`<user root>/accounts`), which `createProviderHost` makes from the
context's user root and every harness's account capability is handed; no
path to them is built from the home folder. So an isolated host starts with
no account chosen and runs each harness on its default login, the one a
terminal uses, and its launch lease never waits on the person's Mako. It
never reads the person's selections: they name folders under their root
that hold credentials, which a proof would refresh into and which the
person's Mako could remove under it, since holds are per root too. A proof
that needs a Mako-kept account signs one in on its own host. A script
acting for the person (`export-cloud-sign-ins.ts`) passes `makoUserRoot()`
to `detachedHarnessContext`. `node scripts/test-isolated-host.mjs` (in
`test:application`, after `npx tsgo -b packages/host`) starts a built host
on a scratch home holding an account layout and root and a Cursor SDK store,
with a Cursor agent of its own in its data root; it chooses an account,
reads its catalog, a Cursor thread and usage, and checks that its catalog
lists its own agent and not the person's, and that nothing at all in the
home's `.mako` changed, `cursor-sdk` included (SQLite's `-shm` and `-wal`
too, which any non-strict reader of a WAL store leaves);
`scripts/test-account-root.ts` (in `test:accounts`) checks that the
installed app and a profile read an existing `~/.mako/accounts` as earlier
builds wrote it, and that the lease is per root.

The record store (`~/.mako/records`) holds every session in the rail, not
only those written since Mako started. Each capture keeps the session's
stamp (the catalog's bytes, mtime and revision of its records, plus its
streams' names and sizes) in its last transaction. The catalog worker's
backfill (`record-backfill.ts`; never in the daemon's 128 MB heap, never in
a read-only catalog) walks the rail newest first, one session at a time. It
passes a session held at its stamp by a stat, waits while a live capture or
a decode runs, and refuses a session the disk can't take with 2 GiB to
spare. A pass cut short goes on where it stopped. It runs at start, then
every ten minutes, under a kernel-held lock (`record-locks.ts`), and logs
each pass under `records`. On Linux that lock is an abstract socket, which
is per network namespace: `npm run test:linux-locks` (also in the Linux x64
workflow) runs the lock-touching tests in `node:24` containers, as they are,
with no /proc, and with no `AF_UNIX`, where a lock is refused
(`LockUnavailableError`) and the backfill says so once and doesn't run. Two
containers sharing one store through a mount don't exclude each other; that
is left so, since each container keeps its own `~/.mako`. A stream file goes once the store holds it whole
(`record-stream-prune.ts`) and its launch is over: its last line is `ended`,
which each driver writes when its launch's process or SDK stream ends
(`NativeStream.ended`), or else its writer's process is gone. Pruning
restamps the session, so no capture follows (a removed stream file is no
write to the catalog's watch, which on Linux heard the prune's own removals),
and `readStreamOriginal` reads
pruned lines from the store. A session the person deletes
(`SessionCatalog.remove`) goes with the agents it started (a child is never
a row, so nothing would list or remove it once its parent is gone; Grok and
Codex keep their subagents' sessions apart, Codex its reviews too, Claude
Code beside the transcript) and with every path the catalog folds onto it (a
Cursor agent imported from a `cursor-agent` chat, a Claude session under two
account roots), and leaves the store too; one its harness deletes stays, and
the person's delete of that one forgets it with its children (below). The pass
ends with a repack (`record-repack.ts`): it drops the chunks no version
names and overwrites them in place with zeros (`record-orphans.ts`): those
only deleted sessions named, those a capture stored and never named because
it failed or its process died, and, at most daily, any other found unnamed
and left so for an hour (an older build's carry no intent). A capture's
first chunk registers an intent in the same transaction
(`record-intents.ts`); every chunk it stores carries it, its last
transaction deletes it with the stamp, a failure or a close marks it ended,
and its owner (one open store) holds a kernel lock from its first intent
until it closes. An intent's chunks go once it ended or its owner is
provably gone: its lock is free and, on Linux, its pid is no longer the
process that started then. A capture still running, in this process or
another, keeps its chunks; one that finds a held chunk such an intent
stored, or a sweep found unnamed, claims it in the transaction that finds
it, so the drop, which reads the versions without the lock and judges under
it, never takes a chunk named meanwhile, and what a capture found held
earlier meets the drop generation (`RecordStore.slice`). `tsx
scripts/records.ts orphans` shows, read only, each unnamed chunk's bytes,
intent and why the next repack drops it or not, each intent's owner, and
the packs' dead space; `records.ts repack` says what it dropped (`--sweep`
sweeps now). Then it trims the newest pack, which compaction never
reaches, to the end of its last indexed entry: a write killed before its
commit leaves bytes past it. Only under the store's write lock and while no
intent runs or can't be judged (another namespace's); the length goes into
`trim.json`, synced, before the truncate, and a repack killed between
finishes it the next time. `test/record-orphans.mjs` kills captures (SIGKILL, in
processes of their own) at each step of their writes and repacks at each
of theirs (the trim included), and `npm run bench:orphans -- --store <a bench:backfill --keep
store>` measures it: on 380,000 chunks (840 MiB of packs) a sweep reads
every version in 1.2 s without the lock, and dropping 3,300 chunks a killed
capture and deleted sessions left held the store's turn 42 ms. It lays out quiet sessions that live capture scattered, several to a pack. It
compacts packs under half live. Copies go to temporary files and the index
switches in short turns, so a crash at any step loses nothing. `tsx
scripts/records.ts backfill` compares the rail with the store's stamps and
prints the last pass, and `records.ts repack` runs one by hand. `npm run
bench:backfill` measures it all on this Mac's newest sessions in a scratch
store (`--no-writers` leaves out the version rules below, to see what they cost).

Every version the store captures says which build of its harness wrote it
(`@mako/sessions/record-writers`; the `writer` and `writer_source` columns,
and a per-session `writers` mark the store reads in one query). It comes
from one of two places and says which, and is never guessed. `record`: the
harness's records state it, where each provider declares (`SessionRecords.writer`):
Claude Code's `version` on every transcript line, Codex's `cli_version` in
`session_meta` and its `threads` row, OpenCode's session row. `observed`:
the records say nothing (Grok, Devin, Cursor), so it's what ran the session
as it was captured: the `runtime` line each driver writes into its launch's
stream once its handshake reports a version (`NativeStream.runtime`), or,
for a write heard as it lands (never the backfill), the version the host
read off the installed binary (`observedInstall` over
`~/.mako/runtime-updates.json`), only while every installation of that
harness agrees and the binary is unchanged since it was read. A provider
opts in with `writer.installed`; Cursor doesn't, because Mako's Cursor
sessions are written by the SDK it bundles, not by `cursor-agent`. Capture
finds versions by searching the bytes it takes (`fieldScan`, about as fast
as the chunk hash beside it), never by parsing them. A session updated
mid-conversation keeps every version. `tsx scripts/records.ts writers
<harness> <native id>` lists them with their source and any range;
`sessions`, `versions` and `capture` show them too.

A session written outside Mako whose records state no version (Devin CLI,
Devin.app, `cursor-agent`, Cursor's editor, Grok run in its own TUI) gets
what its harness leaves beside its store (`WriterEvidence`,
`record-evidence.ts`, declared per store as `SessionProvider.writerEvidence`),
read by the backfill's pass once every session is taken (`fillWriters`),
never guessed: `log`, a log line naming the session and the version of its
process (Devin CLI's per-launch `cli/logs/devin_*.log[.gz]`, whose gzipped
files are indexed once into `records/evidence/devin-logs.json`; Grok's
`logs/unified.jsonl`, a short rolling window); `install`, when every install
of the harness, on PATH and in its own folders (Grok's `bin/grok-<v>` and its
npm package, `cursor-agent`'s `versions/<v>/`, Devin.app's CLI by the host's
reading), is known over the whole time the session was written and all held
one version, or when every launch over the writes names one build (Cursor's
editor's `logs/<launch>/main.log`; Devin.app's `Devin ACP.log`, which names
the CLI it spawned); a `range` whose `bound` says what sets it: `build-day`
(`cursor-agent` names builds by their day), `releases` (the newest release
npm had published by a day after the last write, from
`records/evidence/releases.json`, which `ReleaseTimelines` reads at most
daily for each harness declaring `HarnessVersions.releases`, through the same
bounded fetch as the public version, `registry-fetch.ts`), or `pins` (Mako's
own SDK agents: the newest `@cursor/sdk` the repository pinned by then,
`record-pins.ts`, which `test-restore-versions.ts` holds to `git log --all`;
history, not proof); else `unknown`. Cursor publishes no dated list of its
editor's versions, so editor chats from before the oldest launch log stay
`unknown`; none resumes natively. The same pass reads versions a session's
records state from what the store holds (`rescanWriters`), for captures
taken before a harness's rule, and looks again at evidence from older rules
(`EVIDENCE_RULES`) and at `unknown` once newer release dates land. Records
of another program of the harness (`WriterEvidence.line`) are compared in
that program's numbering with what reads them here (`RestoreRuntime.lines`):
the Cursor SDK imports `cursor-agent`'s stores, so a store is weighed
against the day npm published the SDK Mako ships (`bundled.released`,
`imports`), while `cursor-agent` still holds it too (`restoringResume`,
`restorePlan`), with the reader named ("Mako's @cursor/sdk 1.0.31, published
2026.09.03, may not read it") and no Update. That "newer" is a build made
after the SDK's publication day is evidence, not assumption:
`scripts/cursor-store-fields.ts` compares the fields of the store's messages
in each build's and each SDK release's generated code, and no build made by
an SDK's day writes a field that SDK lacks (but ones later builds dropped);
`test/fixtures/cursor-store-fields.json` keeps the comparison for
`record-evidence.mjs`. The gate's policy (`restoreGate`): a known writer, the
install must be at least as new; a range, at least its upper bound; nothing
known, only the only install there is, put there before the session's first
write and unchanged since (`InstalledReading.since`, `sole`); anything else
is `unproven` and gated, and the offer says so ("Mako can't tell which Devin
version wrote this session…"), with Update only where it could settle it.
On this Mac (2026-10-17, 1,183 sessions in the rail): Claude Code 59, Codex
178 and OpenCode 80 `record`; Devin 80 `log`, 4 `install` (Devin.app); Grok
27 `install`, 26 `releases`; Cursor 207 `build-day`, 64 `pins`, 458
`unknown` (457 editor chats, 1 SDK agent from before the first pin). `npx
tsx scripts/writer-evidence.ts` counts them read-only (`--list` names each,
`--store <dir>` fills a scratch store); `packages/sessions/test/record-evidence.mjs`
covers every path on recorded shapes. Devin's log index costs 4.1 s cold
and 0.3 s warm; a pass over 72 sessions took 8.1 s cold, one with nothing
left 3 ms, and a release timeline 153 ms to read (Grok's, 610 releases).

The store's own format is two numbers in `meta`, as SQLite keeps its own:
`schema`, the format a build must know to write it, and `reads`, the oldest
format whose builds can still read it. A change older builds can live with
(a column or table they never read, such as the writers) bumps neither and
is named in `additions`. A build older than `schema` but not `reads` opens
the store read-only (`RecordStore.access`): it lists and restores, captures
nothing; older still, it leaves the store and serves without it. The
archive reads a newer format's rows it knows and shows an entry it doesn't
as an unread one, raw, never refusing.

Every store more than one build opens follows that rule, through
`@mako/sessions/store-format`, because the installed app, the `dev`
profile and every sandbox and review profile share `~/.mako`: when a
development build migrated the Thread store, the installed app refused it
and lost its Threads, Sessions and remembered settings. `schema` is
`writableBy`, `reads` is `readableBy`, and the build that raises either
stamps its version beside it (`schema_by`, `reads_by`, `storeWriter`;
a checkout's reads `0.0.1+development`), which is how an older build names
it. At or above `writableBy` a build reads and writes; between the two it
reads everything it knows and writes nothing (`storeAccess`), saying so in
one line: "A newer Mako (0.163.0) updated your Threads; this one can show
them but not change them. Update Mako to edit." (`NewerStoreReadOnlyError`,
still a `ReadOnlyStoreError`); below `readableBy` it refuses with
`NewerStoreError`, naming the Mako that reads the store. Each writing
connection declares its format to SQLite (`declareStoreFormat`), and a
build that raises `writableBy` leaves `guardStoreWrites` triggers in the
same transaction, so an older build that opened the store before the raise,
or one from before this rule, is stopped inside SQLite. Inserts name their
columns and nothing writes with `INSERT OR REPLACE`, so a column a newer
build added keeps its values through an older build's writes. Every
SQLite store rereads its format after any other build's commit (`PRAGMA
data_version`), so one raised under a running host turns read-only there:
the Thread store and the session ledger; the record store's `access`, so
capture and the backfill stop, said once (`RecordCapture.declined`); the
unread index (still counted by diagnostics) and the kept outputs
(`outputs.sqlite`, its own `meta` now), which note and keep nothing more.
`followOtherHosts` reads every store's standing and sends `store-formats`
to the windows when one changes. The catalog worker, the in-process
catalog and the sync daemon (`MAKO_STORE_WRITER`) stamp formats with the
host's `storeWriter`. A view in a newer format is neither removed nor
written over, and this build keeps its own in memory; JSON files keep
`version` (and `reads` once a newer build sets it, `jsonStoreAccess`):
`runtime-updates.json` and `provider-profiles.json` aren't written by an
older build, and every rewrite of `runtime-updates.json`,
`worktree-origins.json` and `utility-work.json` writes back the fields and
entries it doesn't name (`unknownFields`); an account lease whose accounts
an older build can't read holds them. `mako:store-formats` reports every
store's standing; the rail shows the Thread store's line above its footer
and Settings › Diagnostics one per store, each with Update, which installs
a ready update, checks on a release build and otherwise opens Updates
(`store-format-line.tsx`). `packages/sessions/test/store-formats.mjs`,
`scripts/test-store-formats.ts` and `test-store-formats-hosts.ts` (a
newer build in a process of its own migrating both stores under a running
host) cover it, `test-store-formats-ui.mjs` the lines, and `npm run
bench:store-formats` measures the check: about 13 µs on an open
connection, against 300 µs to open the Thread store.

The archive (`~/.mako/archive/archive.sqlite`, `archive.ts`) holds Mako's
translations of sessions as earlier builds read them, with no decoder stamp,
and takes no new ones. A pass that took every session ends by migrating it
(`archive-migration.ts`), one row at a time, newest first: a row goes once
its session's harness still has it (by path or by its own id), a capture of
it finished in the record store and this build decodes it; or once its
harness deleted it and this build decodes it back from the record store,
whose kept row (`RecordStore.keepListing`) lists it in the rail from then
on. A failure keeps the row; each drop and its reason commit together in
`archive_migration`, and the row is marked deleted for older builds, which
never capture it again. What nothing else holds stays, served with
`ThreadRef.copyOnly` (the rail tip, the history's first line and the
composer say "Mako's copy"; a reply continues from the transcript). Copies
stay in the archive, not the view store, because views are a cache that
evicts. Child agents' copies stay: a child is read through its parent. The
pass then gives the space back with a `VACUUM` in a thread of its own, once
32 MiB or more is free and the disk has room (incremental vacuuming held the
worker 566 ms a step and made each drop 20 times slower). Every capture keeps the
rail's row of its session (`CaptureInput.listing`, as the catalog lists it when
the capture commits), so a session its harness deletes stays listed, read back
from the store. A path its harness stops listing is matched to that row by the
session, not by the path a capture last read: unless a harness lists the
session elsewhere (a move), the catalog first makes the kept row the one it
last listed (`SessionCatalog.unlist`), so a session moved before a capture
followed it (Codex archiving a rollout, Claude Code entering a worktree) and
then deleted stays where it was, reads back from wherever its records hold it,
and restores there. A capture that finds the session's own file gone takes
nothing: its harness deleted or moved it. `test/native-archive.mjs` and
`test/record-capture.mjs` set those orders up. Every resume verdict goes
through `restoringResume` (`conversations/kept-resume.ts`), so a reply to
such a session, a reconnect or a wake first writes it back into the
harness's own store (`SessionCatalog.restoreKept`; only when nothing holds
it; idempotent; a copy that went on without Mako gets the fork rule), and
the harness resumes the same session. `scripts/test-kept-resume.ts` covers
it, and `scripts/prove-kept-resume.ts` runs it against the real CLIs in a
scratch home. Records go only into the version of their harness that wrote
them or a newer one: every restore takes the version installed where it
goes (`RestoreInput.installed`) and writes nothing when that's older than
the newest writer (`restoreGate`, the one rule; an install whose version
can't be read blocks nothing, and a writer nothing names is gated unless the
install is provably newer, below). `restoringResume` passes it the version the
host reads (`RuntimeUpdates.restoreRuntime`: the session runtime's reading,
or for Claude Code and Cursor, whose sessions run the SDK build Mako ships,
that build), and an `outdated` restore becomes a `closed` verdict carrying
the update offer (Mako's npm, bun, pnpm, Homebrew or self update; the
owning app, Mako itself for a bundled SDK; or the command for a manual
install), so a reply goes on from the transcript and its "Continued from"
line says why (`ContextManifest.outdated`). Before any reply the composer
asks the same rule (`mako:thread-restore-plan`, `restorePlan` in
`kept-resume.ts`) and shows the offer above itself
(`restore-version-notice.tsx`); Update runs the runtime's update and the
plan turns native once the reading lands. `scripts/test-restore-versions.ts`
covers the readings, the gate and the words, `test-versions-ui.mjs` the
offer, and `scripts/prove-restore-versions.ts` installs an older and a
newer Codex, OpenCode, Grok and Claude Code into scratch npm prefixes:
the newer writes a session, the older refuses it and offers the update,
and after the update the session resumes natively. A proof installs only
through `scratchInstall` (`scripts/scratch-harness-home.ts`), which refuses,
before spawning, an environment whose `HOME`, or any folder a harness or npm
writes under, is the person's own: run with their home, Grok's npm
postinstall once put a build in their `~/.grok/bin`, repointed their `grok`
and rewrote their `config.toml`. `scripts/test-scratch-home.ts` covers the
refusals and holds every `prove-*.ts` to it. Devin (one CLI, inside
Devin.app) and Cursor (the bundled SDK) are proven on recorded stores
(`packages/sessions/test/restore-gate-fixtures.mjs`). Cloud machines never
install a laptop's versions: every machine starts from one image, whose
harnesses are exactly the `tested` of the Mako revision it was built from,
and the cloud says which (`GET /v1/cloud/harnesses`,
`CloudAccount.cloudHarnesses`). Before a Thread moves either way, the Mac
weighs its Sessions against that record with the same gate
(`HarnessCheck`, `mako:thread-harness-check`): a Session whose writer here
is newer than the cloud's version is refused before anything is made, not
as it arrives; a harness here older than the cloud's is said in the Local
chip's popover with "Update Codex, then move" (or "Move anyway", the way
back then waiting for the update), and in the Cloud chip's with "Update
Codex and bring it back". Mako's update installs this Mako's `tested`, so
when that's older than the cloud's, the offer is a newer Mako. An offer
Mako can't run (another app's install, a command) says what to do and is
weighed again when the window is focused or on "Check again". Every weighing
takes the harnesses' installed readings again first (`RuntimeUpdates.reread`:
a `stat`, a spawn only for a binary that changed, no registry), so one
updated a moment ago, in Mako or a terminal, counts. `scripts/test-harness-check.ts`
covers the weighing, `scripts/test-harness-update-flow.ts` the one step
(update then move or bring back) over the host's own readings, and
`test:moves-ui` the window. `tsx scripts/records.ts
archive` shows migrated, kept and pending (`--migrate` runs a pass), and
`npm run bench:archive-migration` measures it on a clone of this Mac's
archive.

A session's child agents are part of its records. Each harness's `records()`
takes their files and rows with the session (Claude Code's `subagents/`;
Codex's spawned threads, and its reviews, threads of their own that only their
meta's `parent_thread_id` names; Grok's subagent sessions, whether
`subagents/` or only the updates name them; a Cursor Task's store and an SDK
agent's plain transcripts; OpenCode's sessions under it by `parent_id`;
Devin's chains and journal) and names the path each child is read at
(`SessionRecords.children`). The store keeps those paths with the session
(`child_paths`, `RecordStore.parentAt`). Once its harness deletes the
session, its children are read as it is: `SessionCatalog.children` lists
them with the same reader over the records read back (`keptChildren`), at
the paths they had, and a child's path opens from its parent's records
(`restored`). So a child's transcript, a bundle (`ChildSidecars` stamps a
child it can't stat by what its records hold) and Show original draw as they
did live, and a link to a child resolves. A home a session is read back
into (`RecordReads`) takes its children's transcripts last: each is there
by its first line, which is what a listing reads (a rollout's meta), and is
written whole the first time it's read (`RestoreInput.files`,
`writeChild`), so the parent and its list never wait on dozens of
subagents. Captures from before captures named children are linked once
per session by the backfill's pass (`linkChildren`, the `children linked`
mark), and by listing the parent before that. Every restore writes the
children with the parent, since they're its units, under the same fork
rule (where a child's units are shared), then tells the reader its store
changed (`SessionProvider.storeWritten`: Codex's rollout listing, Cursor's
child index and Claude Code's account roots are read again), so a child is
there the moment the restore returns. The person's delete of a kept
session (`removeKept`) forgets its records, its children's paths and every
home it was read back into, and removes any child its harness still keeps.
`packages/sessions/test/kept-children.mjs` runs all of it on every harness's
recorded store; `scripts/prove-kept-children.ts` runs it against the real
CLIs in a scratch home, with a Claude Code Agent, a Codex spawn and a `codex
exec review`, a Cursor Task, an OpenCode task, a Devin subagent and a Grok
subagent; and `npm run bench:kept-children` measures it on this Mac's newest
parents. On 2026-10-18, children added 0.80 s to capturing a Claude Code
session with 49 subagents (0.13 s without them) and a few ms elsewhere.
That kept parent opened in 0.76 s (1.18 s when its home took every
transcript; 0.44 s to read it back with no children at all), and a kept
child in 60 to 80 ms cold, as live, and under 16 ms warm. Linking took 4 ms
a session over the rail's newest 200, and 13 ms a kept parent.

Mako's attachment files go once no reader on the machine names them
(`attachment-sweep.ts`). There are three kinds: the archive's `assets/`
(saved beside its copies until 2026-10-18, and still by older builds),
each profile's `LiveAssets` (`<data root>/conversations/assets`), and the
staged `~/.mako/attachments` (`<time>-<random>-<name>`, or an earlier
translation's `<sha256>-<name>`, which harness records name and so is
kept). The sweep runs right after the archive's migration, in the same
worker and under the same lock. A pass marks every store a reader can name
one in, for every build and profile sharing `~/.mako`: the archive's rows
(read a row at a time by the capture token its triggers move, so an older
build's new copy costs one row), its legacy folders, the stores beside it,
the view store, and each profile's journals, native requests, own stores
and renderer localStorage. It also marks the localStorage of every browser
a development desk may have opened in. That is every Chromium-family
profile (`base/chromium-profiles.ts`), whose loopback origins it reads,
since Vite's port moves and the registrations go when a launcher exits;
Firefox's per-origin stores; and Safari's, when its container can be read.
`attachmentReaders` (`threads/attachment-readers.ts`) finds them all: every
`<appData>/mako*`, and each host the session ledger lists outside
`appData`. `leveldb-text.ts` reads a LevelDB folder in place, file by
file, and lists it again until the listing holds still through a
compaction. A name is a path's tail (`archive/assets/`,
`conversations/assets/`, `.mako/attachments/`, in any spelling) followed
by the head of a name (a hash, a UUID, a staging time), and it marks every
file with that head.

What can't be read names everything: a source, or a root that can't be
listed, stops the pass, and the trash comes back. A browser a desk is known
to have run in whose storage can't be read holds every file that existed at
its last run. Which browsers a desk opened in is recorded by the web
launchers' proxy in `~/.mako/desk-clients.json` (`base/desk-clients.ts`),
by user-agent family. Before that record began nobody can say, so every
staged file from before then is held; drafts have no retention. A file no
mark or hold names, whose newest time is more than an hour old, moves into
`<folder>-trash`. The stores are then marked again, and anything named since
comes back. A pass a day later deletes it if it's still named by nothing.
`LiveAssets` restarts a reused file's times, so a prompt that reuses an old
file by its hash keeps it through the grace. A build that does says so on
its launch in the session ledger (`liveAssetsTouch`). While a profile's
host holds its data root's lock (`hostLockHolder`, read without taking it)
and its launch doesn't say so, or the ledger has no launch for it, that
profile's `LiveAssets` is held for the pass, and the readout and the log
say which host. A source is read again only
when its stamp moves, and a pass with nothing changed costs a stat of each.
Cold reads run in a child process (`attachment-names-main.ts`, under the
decode's executable) with `MallocLargeCache=0` and `--expose-gc`. SQLite
holds a large value whole while it searches it, and the allocator keeps
what it freed, so the memory goes with the child, which is replaced once it
holds over 128 MiB. Values come over in 4 MiB pieces. A file the record
store holds the bytes of is kept while anything names its path, since no
reader of these paths reads the store; once nothing names it, it goes, and
a restore writes the session's own copy back. Harness records aren't read:
every prompt Mako sent with a file is in a journal or the native requests,
which aren't deleted, and a transcript carries its own copies.
`~/.mako/attachment-sweep.json` keeps the marks and the trash's times. A
newer build that marks a reader this one doesn't know raises its
`version`, and this build then sweeps nothing.

`tsx scripts/records.ts attachments` is a dry run showing each folder,
what's named or held and by whom, what a sweep takes, what the store also
holds, and the trash; `--sweep` runs a pass and `--restore-trash` undoes
one. `npm run test:attachment-sweep` covers it
(`packages/sessions/test/attachment-sweep.mjs`, in the sessions `npm test`,
and `scripts/test-attachment-readers.ts`). `npm run
bench:attachment-sweep` runs the dry run on this Mac's stores (`--here`
reads in-process, to compare) and the sweep on a clone. On 2026-10-18
there were 1,422 MiB in 13,272 files. The archive's 984 MiB had 583 named
and 401 reclaimable, and 867 MiB goes once the whole migration has run.
`LiveAssets` held 393 MiB in four profiles, all but 0.3 MiB named by their
journals. The staged files came to 45 MiB, with 33 MiB named, 5 MiB held
for drafts from before the record, 6 MiB kept by hash and none
reclaimable. A cold pass took 11.9 s and added 68 MiB to the worker's RSS,
with a 177 MiB child; read in-process it took 10.6 s and added 679 MiB. A
warm pass took 0.7 s, and one with nothing changed 62 ms.

What the saved readers couldn't read is counted where views are written:
each view, in memory or on disk, notes its `unread` entries (kind, reason,
id, the record they name, never their content) in
`~/.mako/views/unread.sqlite` (`@mako/sessions/unread-index`), replaced
with every decode. `unreadCounts` adds them up by harness, the version that
wrote each record's bytes (`RecordWriterLookup`: a session one version wrote
takes it whole; one several wrote, the version that captured the record's
first offset) and reason. Settings › Diagnostics shows them beside this
host's live unknown kinds (`mako:unread-records`, `unread-records.tsx`),
each row opening the newest one's bytes as Show original does (a live one
from its stream line, `mako:stream-original`); `npm run harness:doctor`
prints the same under `unread` and `live`; the day's totals go with the
heartbeat as `records.unread`, and live kinds as `native.unknown` with
their version. `scripts/bench-unread.ts` measures it. Once a pass of the
backfill has taken every session, it decodes again every view and every
unread record an earlier decoder build made (`rebuildStaleViews`, newest use
first, yielding to the person), so a decoder that learns a kind brings its
count to zero in every past session without each being opened. When a
harness ships a release: run it (capture and the counts go on), re-record
the fixtures (`bump-harness-versions.ts`), fix the decoder, and run `npm
run decode-diff -- --base HEAD`: it builds `HEAD`'s `@mako/sessions` in a
temporary worktree, decodes the newest 100 sessions with both builds, and
lists every entry that draws differently (by id, with the fields that
changed), entries added or gone, and the unread kinds now read
(`--show <path>` prints both builds' JSON; `--save`/`--against` keep a run).

What Mako itself did in a conversation is its log, a `log` table in the
conversation's journal (`packages/host/src/conversations/mako-log.ts`):
requests and their states, permissions, control's lists and fields, the goal.
`LiveJournal.commit` appends the events in the transaction that writes the
rows, which are the log's cache; opening a journal folds the log, takes in
whatever the rows hold that it lacks (`origin: journal`) and warns when the
log had begun. A new fact of Mako's goes in the snapshot's requests, control
or goal and is logged with no extra code; give a new control list its key in
`LISTS`. `MAKO_LOG_CHECK=1` makes every commit fold the log afresh and fail on
any difference; run the live and conversation-control suites with it after
changing either. `npm run mako-log -- <conversation id>` prints the timeline
without writing the journal, and `npm run bench:mako-log -- <conversations
folder>` measures it on clones of real journals. A call Mako closes when a
turn stops keeps what it had produced (`closeCutOffCalls`), and the request
names it in `interruption.closed`.

A journal names the session its history came from (`baseSource`) instead of
copying it, once the record store holds that session and the session covers
every live turn (`packages/host/src/conversations/base-source.ts`). The
history is read back when the conversation loads, and everything that needs
it waits for the read (`baseUnread`). The host's sweep
(`LiveSources.settleBases`) moves existing journals' copies onto their
sessions' records. `npm run conversations:doctor` shows each journal's
history source, why a copy is kept and what would compact, from local files
only. `npm run benchmark:base-source` measures the sweep and the opens on
clones of real journals. A conversation that went on in several sessions
names a span of its first (`BaseSource.span`: its record entries' count, a
hash of their ids, when the store held them), proven at the hold to merge to
the same turns (`sameTurns`), and read back from the session while it still
begins so, else from the record store as it was then
(`RecordStore.restoreAsOf`, `ThreadPageOptions.asOf`). A native fork's
inherited turns merge with its parent's history as the parent shows it
(`forkHistory`, `mergedBase`'s `inherited`): the copy it began from, then the
reading it holds, or the parent's journal when read back from its session;
`baseSupplied` counts what that added before `baseLiveStart`. Coverage is
taken when a turn ends, failed or closed included (`settled`), and the merge
keeps what a cut-off turn streamed where its harness declares its record
never keeps it (`cutOffTurn`; a turn holding a call that never returned, or
one Mako's log has stopped, failed or uncertain, `cutOffRequests`).

Mako never writes a session a harness didn't. A conversation goes on in
another harness as a new real session of that harness, whose first turn
carries a short note (`transcriptNote`) pointing at the conversation's
transcript, then the person's message; the operation decides, and there is
no setting. A switch back resumes the harness's own session with the turns
since; a fork into the same harness is that harness's own fork, and a
harness without one declares `fork: { kind: "transcript" }`. The transcript
is written once, by `@mako/sessions/transcript-builder`, for a switch, a
fork, an `@thread` reference and a copy alike: an index of every turn (each message
sent into a turn while the agent worked listed under it, by ref and line,
the latest 24), then the turns newest first, a payload past `PAYLOAD_LIMITS` moved whole to
`payloads/` with its size and first lines in its place. Nothing is cut. The
folder is noted for the session that was given it (`noteCarried`,
`@mako/sessions/record-carried`) and captured with its records, so a
restore writes it back where the first turn names it. A running agent reads
the rest with the `thread_history` tool on the `mako` server
(`conversations/thread-history.ts`), in the transcript's numbering
(`12.3/output`), from views, never from the transcript's files. The
transcript draws as "Continued from Codex · 12 turns" above the prompt it
went with. `npm run check:transcripts` reads real sessions back from their
transcripts losslessly, `npm run bench:transcript` and `npm run
bench:history-tool` measure them, and `test-conversation-transfers.ts`,
`test-thread-history.ts` and `test-carried-history-ui.mjs` cover the route,
the tool and the line. On the real CLIs, `npm run test:session-flows` runs
each harness as the destination of the next selected one
(`scripts/session-flows-continuations.mjs`: `switch`, `switch-back`,
`fork-other`, `reference`, `history-tool`, each recording whether the agent
read the transcript, a payload file or `thread_history`), and `--carry
<dir>` measures recall against the old pointer (`session-flows-carry.mjs`,
fed by the audit's `carry-prepare.mts`). A switch back resumes a session only
if its record hasn't moved, so a harness that writes bookkeeping after the
conversation checkpoints the conversation's lines alone
(`conversation-checkpoint.ts`): Claude Code appends `cost-state` and
`last-prompt` as Mako closes its process, Grok its Stop and SessionEnd hook
runs (`claude/` and `grok/session-checkpoint.ts`).

The live decoder and the history reader must draw a session the same way.
`npm run decode -- <capture> --compare <store file>` draws both, aligned, as
the window pairs them (`scripts/decode-compare.ts`). Pairs under
`fixtures/native-decoding/<harness>/pairs/` hold a capture, the store the
same session wrote, and each known difference with its reason;
`test:decoders` fails on any other. `npm run harness:decode-pairs -- grok
--write` records them from the real CLI, sealed against
`scripts/scripted-model.ts`, so no account is used. What only the harness's
own model drives (a turn it starts after its background work settles) is
recorded from a real session (`scripts/probe-provider-turn.mjs`, with
`--scratch <dir>` in a scratch home holding the harness's sign-in without
what renews it, the build to record first on `PATH`) and kept with
`--capture <capture> --store <store> --project <folder> --home <dir>/home
--version <cli>`, which keeps only that session's records, and its child
agents' sessions where the harness keeps them beside it, and leaves out the
person's setup (MCP servers, hooks, commands). A scenario that needs the
harness's model and leaves nothing behind (Grok's `subagent`) runs with the
probe's `--prompt`, `--files` and `--foreground`. A difference is fixed on
whichever side is wrong; one is listed only when the harness itself stores
something other than what it streamed. ACP captures mark where Mako sent a
prompt (`prompted`), because the wire doesn't echo it and the reducer scopes
plans and tool ids to the turn; a turn the harness opened carries the cause
the host drew for it (`prompted` with `turn`), and a marker the host drew
from its observers is `drawn`, so a replay draws both where live did. Where
Mako closed the session is `closed`: what the harness sends as it shuts down
reaches no view, so a replay stops there. When the wire leaves out what the store
keeps, the driver reads the store at a point the wire is known complete and
records the read in the capture, and the decoder draws only what the wire
never named. Codex goes further: its transcript is its rollout's records,
live and saved, through one decoder (`@mako/sessions/codex-records`). The
driver reads what Codex appended (`CodexRolloutTail`) before it handles each
app-server notification, since Codex writes an item's record a millisecond
or two before it notifies, and whenever the file changes; a capture keeps
each read as `{ records }` with its byte range (`npm run decode -- --records`).
The app-server's streamed text, reasoning and output draw under the id the
record will have until it lands; its notifications keep only what no record
holds: status, errors, usage, notices, approvals and the driver's effects. A
command its sandbox refused (no item in 0.159.3) and a code cell's MCP
calls (no response item) draw from their records like any call
(`refused-command.json`, `code-mode.json`,
`docs/audits/2026-10-12/codex-one-decoder`).

A marker about the harness's setup rather than the current turn (an MCP
server that didn't start, a configuration warning, an imported setting, a
failed start hook) is `setup: true`; build MCP failures with
`mcpServerFailedEvent`. Harnesses repeat these on every thread load or turn
(Claude's `system/init`), and every wake or restart opens a new live session,
so the shared reducer in `packages/sessions/src/live-content.ts` keeps one per
conversation (`sameSetupEvent`). Don't deduplicate them per decoder instead,
and leave `setup` off turn facts such as failures, model changes and
compaction.

Each harness reports MCP servers that didn't start in its own way; every
report becomes one `mcpServerFailedEvent` per server, with the reason in the
same words ("could not be launched", "sign-in required"). Codex and Claude
decode it in their decoders. An ACP source declares `mcpStartup`
(`grok/mcp-startup.ts`, `devin/mcp-startup.ts`), consulted before
`decodeNotification`, which may keep per-launch state: Grok gives no status
for a server it could not launch, so it is named once the first response
completes, and Devin says each failure twice. Both report while the session
is still opening, and the ACP SDK does not order vendor notifications
against the `session/new` response, so `acp.ts` holds notices said before
the session has an id and treats a startup notice naming no session (Devin
sends `""`) as the connection's. The Cursor SDK (1.0.31) reports no MCP
startup at all; a failed server shows only when a tool call to it fails.
`test:provider-turns` replays both harnesses' recorded startup through the
host.

Tool calls are identified once, in `@mako/sessions/tool-identity`. Each
harness declares its native tool names, wrappers (Grok's `use_tool`, Cursor's
`CallDynamicTool`, the code-mode scripts of Codex's `exec` and OpenCode's
`execute`) and argument keys there; `identifyTool` resolves a call to a shared
kind, label and target, and unwraps a wrapper to the tool it ran. Producers
send the harness's own name (`name` on live tool updates, the history block's
`name`); ACP's `toolKind` stays ACP's own kind. The transcript row, glyph,
views (`registerToolKindView` by kind), work summary and activity line read the
identity and never branch on a native name. A tool that resolves to `other`
needs a line in that table: `npm run audit:tools` lists those in this machine's
stores (names and keys only), `scripts/test-tool-identity.ts` pins samples, and
the transcript fixture page's "Harness tools" tab renders them.

What a call did to the machine is read once too, in
`@mako/sessions/tool-effect-reading`: its `ToolEffect`s
(`@mako/sessions/tool-effects`: files created, modified with a patch or an
edit's strings, written, deleted, renamed or read, and commands with their
folder, exit and the paths they name). Each harness declares per tool where
its arguments and result state the change (`NativeTool.effects`, refusal
wording in `refusals`), and the projections live decoders and history
readers share (`ClaudeProjection`, `CursorSdkProjection`, `AcpUpdateDecoder`,
`OpenCodeContent`) put a finished call's effects on the update that ends it,
so live and saved say the same; Codex's come from its own decoder. The live
engine hands each finished call to `LiveEngineHooks.effects` (by default the
`mako:tool-effects` topic) and `savedToolEffects` reads a saved session's.
`scripts/test-tool-effects.ts` (in `test:decoders`) holds every pair's live
and saved effects equal, `npm run attribution:effects -- <harness> <session>`
prints a session's, and `npm run audit:effects` counts how exactly this
machine's recent calls state their changes. A command names a file its own
text spells out, and so does what it ran (`scriptRuns`: the script of
`python3 draw.py`, `npm run gen`'s package script, `make`'s rules), each read
by the tracker as it was when the command started and never when something
touched it since (`attribution/scripts.ts`).

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
mark. `packages/host/src/threads/activity.ts` derives what the probe cannot say: a store
whose bytes or activity stamp moved within `WRITE_ACTIVE_MS` (45 s, long
enough to outlast a tool call that writes nothing) while a probe reports it
`open` or another host's hold names it is `active` with `evidence: "writes"`.
The renderer never treats that evidence settling as a finished answer; only a
process's own word on a turn notifies. `cursor-agent` is a shell wrapper, so
its open files are listed under `node`. Store writes are seeded from
`updatedAt` at boot so the first paint after a restart is right.
`scripts/test-thread-activity.ts` covers the promotion, settle, and identity
rules.

## Usage

Three numbers answer three questions and never stand in for each other
(`packages/host/src/contracts/usage-ledger.ts`): what the window holds now
(`LiveSessionUsage.used` of `size`, the harness's last reading), what each turn
spent (`LiveRequest.spend`, measured by Mako between two readings and kept in
the journal), and the harness's own count for its native session (`native`).
A compaction the harness doesn't measure leaves no fill, only `compactedFrom`,
until the next reply: an old number never passes for the new context. A cost
is the harness's (`cost`) or Mako's estimate (`estimate`, priced once at
settlement from a `PRICE_TABLES` entry it names, shown with "≈"), never a sum
passed off as one, and neither is a bill. Every model call Mako makes itself
(commit drafts, connection checks) is a helper run in
`usage/helper-runs/`, with what asked for it, and Settings › Usage lists each
purpose as a source. `npm run usage -- <conversation>` prints one
conversation's ledger with where each number came from.

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
  surface-panel rows carry `.contain-turn`. Timelines above 200 turns or 400
  messages and calls (a few prompts can hold thousands of calls), and
  navigators above 100 prompts, additionally window measured rows; a timeline
  stays windowed while it's shown. A conversation keeps at most 24 MB of
  finished turns (`CONVERSATION_MEMORY` in `live-residency.ts`), the one being
  read included: what's on screen, near it, read in the last minute or still
  at work stays, and the rest come back as the reader nears them. Preserve
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
event. Cursor's follower reads the root
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
nesting depth grows once per _entry_, not once per branch. A real session is
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
registerCommand({ id, title, section, keys: "mod+j", run }) // palette + keyboard
registerSlot("my-badge", "composer.controls", Component) // UI seams
registerToolView("bash", { summary, body, icon }) // transcript rows
registerSurface({ id, label, icon, render, minWidth }) // stage companions
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
first and then by _suffix_ against the tracked file list: one match is the
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
object is never replaced, because `host-call-recovery.ts` decides by `instanceof`.
`scripts/test-file-open.ts` covers both halves.

A turn's media is read from its records, never left to the agent to cite.
`callMedia` in `@mako/sessions/turn-media` reads each call as
`entriesToMessages` draws it (so live and saved alike): what `show` on the
`mako` server stated in its result's `_meta` (`MEDIA_META`, or the call's
own arguments where a harness drops `_meta`, by `identifyTool` whatever the
call is wrapped in), image blocks a tool returned, files `mako-computer`
says it made, create/write effects on media files, and media paths a
command line named. `mergeMedia` keeps each file once under its strongest
evidence; an image a call only looked at stays out unless the turn made
it. Only images, video, audio, HTML and PDF, never text. The host
confirms paths in one call per turn (`mako:resolve-turn-media`,
`packages/host/src/media/`): a named file counts only when it changed
while its command ran, each kept file is copied by content hash so the
turn keeps its own bytes after an overwrite or a `/tmp` cleanup, and the
answer is stored by call and path, so a reopened conversation reads no
disk. `show`'s result draws where it was called (a `shown` section, kept
in view by a settled fold); the rest sits on the shelf under the answer
(`MediaShelf`), less what the prose already previews. Every harness is told
one line (`SHOW_MEDIA_LINE`): Claude in its appended system prompt, Codex
as turn context, the others in Mako's note before the prompt
(`makoInstructions` on the live driver says which). The decode pairs draw
each turn's media, so live and saved must find the same files;
`scripts/test-turn-media.ts` covers each source and the host.

## Never lose a paragraph

A draft is the one thing in the desk the user made and cannot get back. Every
other state — the diff, the tree, the token count — is recoverable by asking
again. So the composer clears optimistically, because typing the next thing
should be instant, and `drafts` in `composer.tsx` keeps the text per session so
switching tabs mid-sentence costs nothing.

Restoring a refused send is where this gets subtle, and the trap is timing.
`session.prompt()` does not resolve when the prompt is _accepted_; it awaits
`_runAgentPrompt` and the whole `continue()` loop, so an awaited `send` settles
minutes later, when the answer is done. Restoring a draft on that promise
overwrites the paragraph the user has since typed — losing work in the name of
saving it — and can paint it into whatever session is on screen by then.
Rejection is a _preflight_ fact (no model, no key), so read it from the
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

Each harness's own hooks, commands and MCP servers are read and edited where
the harness reads them, from its definition's `hooks`, `commands` and
`mcpEditing` families (`packages/host/src/harnesses/<harness>/authoring.ts`),
on the shared editors in `packages/host/src/tools/authoring-*.ts`. A family
lists every source in the harness's order with its scope and trust, says what
the order decides (`names`: all run, first wins, last wins) and which
operations it has, each absent one with the harness's reason; `read` and
`change` are pure over what `sources` found. Nothing reads a hook by running
it, or a server by starting it. A change is previewed (`mako:native-authoring-preview`)
as the diff of the one file it writes, credentials redacted, and applied only
while that file is still the revision the preview read; the file as it was is
copied into `<data root>/backups/native-config`, never beside it. Edits change
only their entry: JSON with comments through `jsonc-parser`'s edits, TOML on
its text and then checked on its meaning (`verifyToml`), so comments, key
order and unknown keys survive. A switch is written the way the harness's own
command writes it (`grok mcp disable`, `devin mcp disable`, Codex's
`[hooks.state]`, Claude Code's `disabledMcpServers`), and the live tests hold
Mako's writes to the harness's own. `npm run harness:doctor -- <harness>
--cwd <project>` shows what Mako reads, and `npm run harness:authoring --
<harness> <family>` previews any change as a diff (`--apply` writes it).
`test-native-authoring.ts` round-trips the recorded shapes in
`scripts/fixtures/native-authoring`, `test-harness-concepts.ts` holds every
source to a place the harness reads, and `test:native-authoring-live` reads
back what Mako wrote with Codex, Grok and Devin in scratch homes.

## Browser and computer control

For the Local Control API refactor, migration and validation progress, read
[`docs/local-control-map.md`](docs/local-control-map.md). It records accepted decisions, completion evidence and remaining limitations.
The public API examples live in [`docs/local-control-api.md`](docs/local-control-api.md).

`@mako/control` (`packages/control`) is the pure layer under the control
server, like `@mako/sessions` under the catalog: no Electron, no MCP
transport, testable against a fake driver. `program/` is the runtime that
runs trusted async JavaScript in a `worker_threads` Worker and the artifact
spill; `control/` is the provider-neutral target, operation and planner
contract plus the compact page projection; `browser/` owns the pinned,
complete CDP type mapping and pure AX working-set selectors; `computer/` turns a native
driver's answers into something
a model can read every turn: `projection` (one line per element, the menu
bar out of a window state, `kind` on window records, the driver's data
unwrapped from its MCP envelope), `steps` (`view`, `act`, `until`,
`expect`, `windows`, built over the same actions a program calls by hand),
`reference` (the API text rendered from the live tool catalog) and `policy`
(the background input ladder and the keyboard verdicts).

`@mako/control-runtime` (`packages/control-runtime`) owns the Node session engine,
MCP adapter, CLI, browser connections, driver lifecycle, capture and recording. Its root
`createControlRuntime({artifacts,browsers?,native?})` requires explicit standalone
configuration. `/host`, `/browser` and `/session` serve the desktop and
transport adapters; `/contracts` and `/extension` are safe schema-only imports.
Mako imports these package exports. Keep OS permission hosts and app UI wiring in
`electron/`; do not move engine ownership back there. `runtime/control` is the
Linux deployment recipe, not another package implementation. Build with
`npm run build:control-runtime`; `npm run test:control-packages` checks packed
public imports/types, relocation, workers, cleanup and release boundaries.
`packages/control-runtime/src/browser-tools-main.ts` is a focused regression harness,
not a managed or runtime-recognized server.
`packages/control/test` covers the pure layer; `docs/audits/2026-09-14/`
holds the measurements the design rests on.

Every provider receives a task-owned `mako-control` CLI and private session file.
`ControlSessions` starts the worker; provider environments receive PATH/session
configuration through `applyControlEnvironment`. Mako agents primarily use the
`mako-control` MCP `js`/`js_reset` adapter from `@mako/control-runtime/mcp`. It borrows
that same session; it never starts a CLI subprocess or a second engine. The retired
status/help/exec tools stay removed. Keep the native driver’s private protocol. Local Control
v2 programs use `control.app({pid})`, `control.window({pid,window_id})`,
`control.tab(target)`, `control.openTab` and `control.claimTab`. The bound client
in `packages/control/src/control/client.ts` owns API composition; the host owns
routing, target validation, driver sessions and foreground checks. Public
`control.act/observe/advanced/wait` and the separate `page` helper are retired.
The internal driver test executor and browser regression harness are not public provider APIs.

MCP uses top-level await and persistent lexical bindings; first-use documentation
comes from the worker, with `control.rewriteDocumentation()` after lost context.
CLI exec still takes an async body with `return`; keep shared handles in `state`.
MCP reset clears program state without closing owned targets or recordings. The worker's AsyncLocalStorage associates
calls with their executing cell; a timer from a finished cell cannot borrow a
new run. Ordinary script errors preserve state; timeout, cancellation and worker
faults reset it. Programs are trusted local JavaScript, not an OS sandbox.

Actions return small dispatch receipts, never implied task confirmation. Read
with `handle.observe()` and select structured nodes with `view.get({role,name})`
or `view.select(...)`. `handle.expect(...)` polls exact structured evidence
without replaying input. Duplicate observed matches fail; absence requires
complete coverage. Positive assertions describe the observed match and its
coverage, not global uniqueness. Truncated text cannot establish exact equality.
Returning a view emits compact lines once; `.nodes` exposes structured data and
`.diff(previous)` returns changes without carrying old refs. Images are explicit.

Refs belong to the exact target's latest observation and expire on mutation.
Coordinates require that target's latest screenshot `view` token. Reobserve
before the next ref-based action; never carry tokens by label or position.
Unknown outcomes require observation and are never automatically replayed.
Native background/foreground routing remains host-owned. Page leases,
generations and action-scoped focus emulation remain BrowserService-owned.
Raw driver/page access is explicit through `control.native`, `window.raw` or
`tab.raw/cdp`; raw calls retire unified refs. Basic help and browser-only
execution do not require native driver startup. Protocol/native schemas load
through help only when needed. Long outputs spill whole to artifacts.

A computer action resolves to the driver's data, not the MCP result: every
model measured lost a turn to `result.structuredContent.apps` before it
found the data, and a window state returned whole paid for the tree twice
through the text echo. A refused action throws with the driver's message,
so `try`/`catch` in a program is the branch. `get_window_state` omits the
application's menu bar (118 of 180 elements on a real app were the Apple
menu and its Recent Items; `include_menu_bar` restores them) and
`tree_markdown`; `list_windows` records carry `kind: document | helper |
unknown`, because Finder keeps nine untitled 30-pixel strips at layer 0
and every model asked to list its windows counted them at every size of
context (F11). `view(target)` reads a window as one line per element
(~13 tokens a line against ~65 as JSON: 12,006 tokens for a real window's
state, 838 as lines); `act(action, args)` performs one action and returns
the lines that appeared and disappeared, re-reading every 250 ms while
nothing has changed (a WebKit page transition outlasted one settle and
the empty delta cost a turn), so a click and what it revealed are one
call and one turn; its receipt also names same-application windows opened
or closed by the action. `expect` stops a chained program with the current
view in the error when the screen is not what it assumed. Every read is a
new driver snapshot and only its newest tokens are valid. `token(line)`
extracts one without hand-parsing it; never remap an older token by role or
label because duplicate or reordered controls can silently change its target.

Output is never cut. A returned or logged value at or past
`INLINE_TEXT_BUDGET` (40 KB, about 10 K tokens; it was 200 KB, and the
same task then cost 306 K prompt tokens against 18 K), a run's inline text
past `INLINE_TOTAL_BUDGET`, and every image after the `INLINE_IMAGE_COUNT`th
are written whole under the task's artifact directory
(`MAKO_CONTROL_ARTIFACTS` or the temp directory, keyed by `MAKO_TASK_ID`)
and the result carries a receipt with the path, size, hash and an outline
of the value's shape; `artifacts.save(name, value)` lets a program keep
something on purpose. What a program returns crosses the port as JSON: an
object with an `undefined` member once failed the host's message schema as
"invalid message" and lost the run, so the worker round-trips every output
and names a value JSON cannot carry. `test-browser-runtime.ts`,
`test-browser-tools.ts` and `test-computer-tools.ts` cover the surface,
the spill, the receipts and the preflight checks inside programs.

The driver is started behind the user's window. `cua-embedded.ts` once
spawned the executable directly and the driver was the frontmost
application for a fifth of a second every time a host started it (sampled
at 60 ms: `Mako` → `cua-driver` → `Mako`), which is the focus theft the
whole feature was blamed for. The bundle is now launched the way the
driver's own CLI launches it, `/usr/bin/open -g -n -a CuaDriver.app --args
serve …`; `open` owns no child, so the daemon's pid is discovered from its
command line once the socket answers, recorded in
`runtime/provider-children.json` (`trackProviderPid`) for the next host to
reap, and signalled by pid on stop. An executable outside a bundle (a
fixture script) is still spawned directly. `test-local-control-e2e.mjs`
samples the frontmost pid continuously from before the driver starts and
fails if the daemon's pid is ever seen.

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
is refused while the window is not frontmost.

Nothing fronts the user's application unless the call says so.
`invoke_menu`, `bring_to_front` and `delivery_mode: "foreground"` are
refused before dispatch without `foreground: true`; a call that took the
screen reports `fronted: {ms, pid}` and `status.frontingEvents` counts
them, and the driver's own nudges towards the foreground
(`escalation.target: "foreground"`) are stripped from every result so a
model is never talked into stealing focus. A background Cmd chord is
refused before it is posted (an application that is not frontmost does
not dispatch menu key equivalents; `force: true` posts it anyway), and a
shift chord the driver could not read back is `unverifiable`, never
`not-delivered`. The semantic keyboard is `fill(token, text)` (the
accessibility value write, read back until the line shows the text),
`submit(token)` (the control's confirm action, else its press) and
`routes(target)` (the verdict of every input route for a window before a
round trip is spent on a refusal); `computer.script({language, source})`
runs AppleScript or JXA and `computer.shell({command})` a command, both
spilling long output like any result. An Electron or Chromium app gets a
page route: `launch_app({bundle_id, page_route: true})` starts it in the
background with a private DevTools port and registers it as browser
`app:<bundle_id>`, and the `browser` object is available inside every
computer program, so keyboard, pointer and DOM reads that never touch
focus reach the one kind of window the pid keyboard cannot.

The driver's agent cursor is quieted per session. It glides an overlay
along a Dubins path to every new target and awaits the arrival before
acting, and `set_agent_cursor_enabled(false)` hides the overlay without
stopping the awaited glide; measured 2026-09-14 on driver 0.28.0 against
Cocoa and Electron fixtures, every `click` or `set_value` on an element
other than the last one took 2.5 s and a repeat on the same element 0.1–1.1
s, `move_cursor` alone 1.5–2.5 s by distance. `glide_duration_ms: 1` (`0`
is the physics default) ends the glide at once: 20 ms per move, 1.1 s per
action, the composed `fill` + `act` 2.5 s instead of 4.2–5.1 s. The host
sets `set_agent_cursor_motion({glide_duration_ms: 1, dwell_after_click_ms:
0})` and hides the overlay before the first call that names a session and
again after `start_session`, which resets it; the embedded daemon also starts
with `--no-overlay`, so no overlay process activation or animation reaches the
user. The second that remains is the driver's `WindowChangeDetector`, a
one-second poll for a new window after every action whose private skip argument
ingress strips from MCP calls; `act` overlaps its first read with it. Driver
0.28.0/0.28.1 exposes no MCP or CLI duration control. Upstream's Rust
`Snapshot::detect_with` can take one, but action tools call the fixed
`detect_async()` path; test an upstreamable public duration without shortening
focus-steal protection silently before considering a second native AX lane.
Mako's embedded daemon runs
with `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`: the driver posts every tool call
to PostHog by default. `test-computer-tools.ts`
checks the two cursor calls and their order; the e2e's `fill-and-verify`
times a `set_value` and a `click` on two elements under 2 s each.

`scripts/benchmark-control-agents.ts` gives hosted models a shell and the task's
CLI, measuring turns, tokens, wall time, exact fixture outcomes and foreground
changes. Its internal driver executor only administers fixtures. Fresh provider
acceptance covers the actual launch environment and command discovery.

`control-session.ts` wraps the native driver (`cua-driver`, an external
install under `/Applications/CuaDriver.app`) and repairs what the driver gets
wrong for agents. The driver refuses an output path whose deepest existing
parent is a symlink (`/tmp` on macOS), so `computer-paths.ts` realpaths that
ancestor first. A driver session dies with the transport lease that created
it and cannot be revived from another, so the wrapper mints a per-connection
id (`mako-<task>-<nonce>`); never reuse a fixed id across reconnects. The wrapper
remembers which pid and window produced each snapshot so an `element_token`
alone is enough. Tokens are strictly snapshot-bound: every read invalidates
the session's older tokens for that window, and they are never remapped by role or
label; `fill` returns the exact newest `view` for the next action. The wrapper
defaults `max_elements` to 300 and drops `tree_markdown`
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
cannot. An attached Electron/Chromium route names one verified application
generation as `app:<bundle>:<pid>:<nonce>`; a live id is never replaced,
`detach` closes only that connection, and route cleanup never terminates the
application. Observations carry element states, viewport scroll context, paging
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
An unchanged semantic observation refreshes its refs to the newest backend
node ids. If the exact target disappears after an action dispatch, the outcome
is `target-closed`/`unknown`; no other tab is selected and nothing is retried.

External browsers are capability-discovered Chromium profiles, not a product
allowlist: `browser-extension-setup.ts` recognizes bounded user-data roots from
their standard `Local State` browser/profile records, so branded forks use the
same extension transport. `open` defaults to a background, task-lifetime target;
`disposition: "window"` creates a separate window and
`lifetime: "persistent"` is the explicit opt-out. A released temporary target
keeps its owner, takeover transfers that owner, and task-session cleanup closes
owned tabs and windows without disconnecting the shared browser.
`context: "isolated"` uses `Target.createBrowserContext` only on direct CDP,
is always task-lifetime, and is disposed as one unit; extension transports
refuse it because their debugger API has no browser-context capability.

The browser with id `mako` (`desk-browser.ts`) is Mako itself: hidden 1600×1000
windows of the desk exposed as page targets over a private loopback bridge,
capped at four, reaped after thirty idle minutes, never counted as a client that
keeps a profile host alive, and navigating only to the exact desk document
(`desk-browser-policy.ts`). It exists so an agent can inspect or capture Mako
without touching the window the user is in. Scripts run there inside the
trusted renderer with its host bridge; it is a convenience for the user's own
agents, not an isolation boundary, which is why the URL policy is exact.
A web launcher publishes its exact Vite URL through
`dev-renderer-registration.ts`; the matching host publishes its private
endpoint through `desk-browser-registration.ts`, and another host discovers it as a distinct
`mako-dev-<checkout>` desk carrying the exact origin and source root. Its
hidden windows still belong to the development host—an installed host never
loads Vite under its own preload. The host has no Electron of its own: the
desktop attached over `/desktop` makes them, or, with none attached, the agent
views app the host starts (`agent-views.ts`), a hidden Electron client with no
Dock icon that leaves with its host. Renderer registrations are launcher-owned and
survive a host runtime-directory replacement; concurrent launchers fall back
to the newest one still alive. `test-desk-browser.ts` covers local and cross-host
bridges with in-memory pages, `test:desk-browser-electron` drives a real
hidden window relayed over `/desktop`, and `test-fixture-desk.mjs` covers the
agent views app end to end.

A person points Mako at an element in a web page with the element picker
(`mako:element-pick-*`, `packages/host/src/control/element-picks.ts`). Mako
shows no web pages, so the pick runs in a tab the control runtime reaches:
`BrowserService.borrow` rides an agent's binding when one holds the tab (the
extension allows one debugger per tab; the agent's refs and view token are
untouched and only its input is refused until the pick ends) or claims the
tab and releases it after. `startElementPick` fronts the tab (the person
asked), draws the overlay from `@mako/control/browser`'s page functions in an
isolated world, reads React's component and owner stack through a main-world
probe that answers on two per-pick events, resolves the source through the
page's own source map within two seconds, and crops through the screenshot
path that never clips a live screencast. The overlay removes itself 45 s
after its host stops polling. `scripts/test-element-pick.ts` drives a React 19
page on Vite's dev server in headless Chromium.

An Appshot (a window's picture and its outline, attached from the + menu or
the Appshot shortcut) is a Mako control read, not a system of its own. The
outline is `@mako/control/computer/outline`, a sibling of the view
projection over the same element schema, role names and menu-bar rule; the
capture is `captureAppshot` in `@mako/control-runtime` (`native-appshot.ts`):
picture and tree read side by side, no window list for a known target.
`packages/host/src/control/appshots.ts` only adds the desktop's thumbnails
and icons to a lease on the driver broker; agents take the same capture with
`window.appshot()` and `mako-control appshot`. A new driver daemon's first
window picture costs about 3.6 s, so the broker warms each daemon once
(`warmAppshots`, a 16-pixel picture of Mako's own window, skipped without
Screen Recording) as it connects, and again when the chooser opens or the
shortcut is turned on if that was skipped. `packages/control/test/outline.mjs`
covers the projection and `scripts/test-appshot-live.mjs` a real capture, the
SDK and the CLI.

One process talks to the driver daemon: the host's `DriverBroker`
(`packages/control-runtime/src/driver-broker.ts`). It speaks the daemon's
own line protocol (`driver-daemon.ts`); no `cua-driver mcp` proxy runs. Each
consumer holds a lease, a transport identity at the daemon, so its sessions,
cursor, recordings and screenshot frames are its own and end with it: the
person's Appshots in process, and each task's session from its worker over
the broker's private socket with the grant `ControlSessions` gives it
(`connectBrokeredDriver`); a worker never sees the daemon's socket. Calls
go on connections of their own: one proxy read one call at a time, and a
quick read waited 3.1 s behind a 3 s `verify_state` on the same connection.
A task's calls stay in order; the Appshots lease lets its reads overlap.
Element snapshots are each lease's own: Mako's driver (+25,
`vendor/cua-driver/0003-transport-scoped-snapshots.patch`) keys them by
retained transport and says so in `metadata.snapshot_scope`, so an Appshot's
or another task's tree read never retires a task's tokens, and a lease's
snapshots go when it closes. Caps (8 per app and 32 per lease, 262,144
elements across leases) bound the daemon's memory; an evicted snapshot's
tokens are refused as stale, never resolved. The broker reads the daemon's metadata once per
daemon: a `contract_version` other than 0.8.x is refused before any call, and
a daemon without `snapshot_scope` (one snapshot per window for everyone) gets
the old guard, where the broker tells the task whose read replaced its
snapshot (`onSuperseded`) and its refs are refused before dispatch. The
readout says which. A daemon that dies is reconnected once for everyone and
warmed once.
`npm run control:driver` prints the broker's readout from a running host
(`mako:computer-driver-connections`): the daemon, each lease, calls in
flight, the last calls' timings and the processes on the driver's side,
never their contents. `packages/control-runtime/test/driver-broker.mjs`
covers it against a fake daemon, `scripts/benchmark-control-driver.mjs`
measures the topology, and the audits are
`docs/audits/2026-10-12/control-driver-broker.md` and
`docs/audits/2026-10-12/driver-snapshots/README.md`.

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
it; the dev launcher watches it). The preload imports only
`contracts/renderer-bridge.ts` and type-only contracts, because the other
contracts' schemas are values and would put all of zod into every renderer.
`test-preload.mjs` loads the bundle sandboxed.

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

## Hosted service boundary

Mako's hosted service is developed in a separate private repository, checked out beside this one as `../mako-backend`. The dependency runs one way: that repository consumes this one's packages as pinned artifacts, and nothing here imports from it, even behind a flag. Clients and the runtime reach hosted features only over the network, through open protocol packages and their tests. Everything committed here is public, so hosted design, pricing and planning notes don't belong in this repository's files, commit messages or pull requests.

Planning and audit docs under `docs/` that are gitignored (`docs/audits/`, `docs/meta-harness/`, `docs/meta-harness*.md` and the other ignored pages) are symlinks into the private checkout. Read and write them at their usual paths; a new audit in `docs/audits/<date>/<topic>/` lands in the private checkout directly. Never `git add -f` them. Audits meant to be public go in `docs/public-audits/<date>/<topic>/`, which is committed here. On a fresh checkout, run `npm run wayfinder:link` in `../mako-backend` to create the symlinks.

## Zero lint debt

Every source change must leave both ESLint and Oxlint clean. Run `npm run lint`
before handoff; `npm run lint:anti-slop` must report zero warnings and zero
errors. Do not disable, downgrade, or bypass anti-slop rules. A narrowly scoped
exception is allowed only when the owning external API makes a typed boundary
impossible, and it must include a precise safety invariant plus a regression
test. Existing debt is never a reason to add new debt.

## Disk space

Scratch copies of the checkout and scratch builds go in the Thread's data
folder (`$MAKO_THREAD_DATA_DIR`), and you delete them before you hand off the
task. Never copy `release/` or `node_modules` by hand: one hand-made update
rehearsal copied `release/`, reached 25.6 GB and filled the disk. To rehearse
a Settings update, run `npm run test:settings-build` (`-- --as-installed-updater`
rehearses an older installed updater, which passes no `MAKO_BUILD_SOURCE`); it
removes its working folder unless given `--keep`. Builds clean up after
themselves, so keep it that way when you change them: `package-mac.mjs` keeps
the newest three packaged builds in `release/` (`scripts/lib/prune-release.mjs`),
`update:local` removes its `.local-update-*` output when it ends, and Settings
builds and `update:local` refuse to start when the disk lacks room
(`ensureBuildSpace`). A new script that writes a build or a copy removes it on
every exit path.

## Git

Every Git process Mako starts goes through `@mako/git` (`packages/git`, no Electron imports). Its `Git` class is the one spawner, and the package holds no state outside it: each host makes one in `createHost` (`hostGit`) and hands it to everything that runs Git, and a test makes its own. `run` strips repository variables (`REPOSITORY_VARIABLES`) and sets `GIT_TERMINAL_PROMPT=0` and `LC_MESSAGES=C`, and it applies timeouts, byte caps and allowed exit codes. A read (`read: true`) adds `--no-optional-locks` and takes one of the instance's six read slots. `background: true` runs below agents through the `background` hook `hostGit` gives the instance. Stopping the host closes it (`git.close()`), which closes every repository it opened. A failure is a `GitError` whose `kind` (`not_repository`, `local_changes`, `conflicts`, `rejected`, `auth`, `moved`, …) is what callers branch on, never stderr text. Don't spawn `git` anywhere else; add the operation to the package. Worktree orchestration (`thread-worktrees.ts`, spares, `worktree-carry.ts` with APFS clonefile) is Mako's product logic in `packages/host/src/workspaces/`, on the package's runner. A Thread's checkout is of its project: started in a folder that holds several repositories without being one, it's a folder mirroring that project with a worktree of each repository inside, on one branch (`createProject`). The store keeps one `thread_worktrees` row per Thread and the repositories in `thread_worktree_repositories`; review, update, merge and the Git panels stay per repository, while removal and moving changes take the checkout whole. Which repositories a project folder holds is `projectRepositories` (folders with a `.git`, never one inside another repository, a second checkout of one already listed left out, at most 12); a Thread's start, its spares and the Changes panel all use that walk, so don't find repositories another way. A project's spare is one folder mirroring it with a locked worktree of each repository, claimed only when it holds exactly the repositories the folder has now, and placed by renaming the folder and `git worktree repair` in each repository. Settings › Worktrees lists checkouts (`worktreeCheckouts`), not repositories' worktrees.

A move into a Thread's worktree takes only the Thread's own uncommitted changes (`workspaces/worktree-move.ts`), never a stash of the whole checkout. The attribution journal (`attribution/`, `partition`) names each changed line's last writer: the worktree gets the base plus the Thread's lines and the files it created, deleted or renamed; the main checkout keeps everyone else's. Lines that might be the Thread's (`window`, `ambiguous`) and changes nobody can be named for (there before tracking, `unattributed`) stay unless the person chooses Bring these, on the move card before or on the toast after. A hunk that can't be split by line goes whole to whoever wrote most of it and is named. Without the journal nothing is attributed, so nothing moves unless brought. The move is all-or-nothing: it reads each file, checks it is what the journal holds and that the two sides add back up to it line for line, stores every version in the repository's objects, keeps the main checkout's whole state (files and index) as a commit under `refs/mako/moves/<id>` for 14 days, saves its plan (`<worktrees>/moves/<id>.json`, the receipt's `moving`), writes each file by a rename after checking it is still what it read, then reads both sides back. Anything off rolls back. A host that dies mid-move finishes it on the next start (`tidy`) when every file is as it was or as planned, and otherwise rolls back around whatever changed since. Each step is logged under `worktree-move`. `worktree_status` reports whose the main checkout's changes are; the move's result and the agent's message in the worktree say what came and what stayed. `npm run test:attribution` ends with `test-worktree-attribution-moves.ts`: three writers in one file, renames, deletes, binary and untracked files, staging, two repositories, and a process killed at each step.

What a turn changed has one source: the attribution journal, keyed by the request the turn answers (`LiveRequest.id` is the `turn` on every activity mark and entry; the harness's own run id rides along as `run`, metadata only). When a request's turn ends, `LiveTurnChanges` marks it `pending`, counts it from the journal once every change heard is in (`settling`), and again once the journal settles them (`settled`), into `LiveRequest.changes` (`contracts/turn-changes.ts`, `queries.ts` `turnChanges`: per file, first entry's before to last entry's after, each line counted for its last writer, the Thread's own apart from what only might be its). The same record is kept beside the entries (`turn_changes`). The line under an answer, its file links' "Changed in this answer" and "Changes made by the thread" (the sum of those records) all read it, so they agree, and a reopened conversation reads the stored record instead of counting again. A turn from before the record falls back to its checkpoints. The work summary counts steps ("made 2 edits"), never files. What Git put back (a checkout, pull, rebase, reset or stash no call named the file for) is journaled with `git` set, or not at all when a file holds exactly the new commit's content; no turn, "changes made", others' count or rewind writer counts it, and a version Git puts back keeps the writers it had. A call's exact bounds from a harness's hooks (`harnesses/call-bounds.ts`) go through `LiveActivity.bounds`, under the same request-keyed turn as the call's marks, so the journal has one record of each call.

Changes › Turn reviews any turn of the open conversation, live or reopened (`conversations/live-turn-review.ts`). Its files are the request's record; each diff is the turn's checkpoints when both were saved, else the journal's versions either side of the turn's entries, so Review on the turn line works without checkpoints, and a conversation nobody has open is read from its journal without loading it (`storedRequest`). Who wrote each changed line comes from the same walk the record counts with (`attribution/line-walk.ts`, `turn-lines.ts`), as runs per side (`mako:live-turn-writers`), drawn in the diff's annotation slot only where another writer shares a change block; "Only this thread's lines" redraws each diff with every other writer's change on both sides. "Undo this turn" (and "undo this thread") takes the scope's own lines back out of the files as they are now and puts back the lines it removed, keeping everyone else's; a stretch someone edited on top of since, or where a writer put back a line the scope removed, is left whole and named; what Git or Mako wrote is nobody's and stays. It's refused while a turn or background work runs in the checkout (the journal's open activity, on any host, and this host's own runs), and when the files changed after the preview (`token`). It writes with the move's writer (`rewriteInPlace` in `worktree-move.ts`): every version stored, the checkout kept under `refs/mako/moves/<id>` for 14 days, the plan saved in `<conversations>/undos`, each file checked and renamed into place, then read back; a failure puts every file back, and a host that dies mid-write finishes or undoes it on the next start (`resumeMove`). The index is left as it is. Rewind stays the whole-workspace restore. `scripts/test-turn-review.ts` covers it, and `scripts/turn-review-screenshots.mjs` draws it.

The agent's Git tools work in a project folder of several repositories, whose Thread checkout holds one worktree per repository, all on one branch. The `worktree_*` tools (`workspaces/tools.ts`) act on every repository at once. `worktree_update` updates each one on its own: the reply names each repository with what happened (merged, already current, refused and why, or stopped on conflicts with the files and how to finish), and a repository that's refused or stops doesn't keep the others from updating. `worktree_merge` checks every repository with commits before merging any; if Git still stops one, the reply says which ones merged and which didn't. A pull request belongs to one repository. `repositoryPlace` lists the repositories the calling Session can reach: this Thread's worktrees, each with its own start branch; the repository its folder is in; or each repository of a main checkout's project folder. Each is named by its folder in the project, which is how `worktree_status` lists it. Every `pull_request_*` tool takes that name as `repository`. Without it, a tool acts on the repository the Session's folder is inside, or on the only one. From the project folder itself, `pull_request_status` reports every repository. `pull_request_open` and `pull_request_merge` act only when exactly one repository fits (has work to push or open, or has an open pull request); otherwise they list where each one stands, before pushing or merging anything. The window adds the repository its Git panel shows to every staged Git action (`gitRepositoryName` in `contracts/git-actions.ts`, applied in `src/state/git-actions.ts`), so a person's button and the agent's call act on the same repository. `npm run test:thread-worktrees` covers both families: `test-git-actions.ts` against two real repositories, and `test-workspace-moves.ts`.

`git.openRepository(cwd)` returns one `Repository` per working tree (an LRU of 64 that never evicts a watched one). It keeps status in memory. `packages/host/src/git/workspace-git.ts` calls `watch()` when the repository is at or under the watched workspace and passes changed paths to `changed()`. The next `status()` then reads only those paths (`status -- :(literal)<path>`) and merges them in. Git's object store, locks, `FETCH_HEAD` and the package's own index copies are noise. Any other `.git` path, `.gitignore`, `.gitattributes`, `.gitmodules` or more than 500 paths means a full read, and so does a failed partial read. An unwatched repository (a linked worktree, or one above the workspace) is read in full every time. Entries come in Git's order: changes, then untracked files, each in byte order. Status runs with `--no-renames`: a rename reads as a deletion and an addition. Writes run one at a time per repository; `settled()` waits for them. Each repository keeps one `cat-file --batch-command` reader, closed after 30 idle seconds. Previews are cached per repository within one 64 MB budget per `Git`, least recently used first; worktree previews are cached only while watched. Commit drafting reuses piece summaries only from the `DraftSummaries` a caller passes; the host keeps one in `GitDrafting`.

Debug Git through host.log: with `MAKO_GIT_TRACE=1` (`HostConfig.gitTrace`) every Git process is logged under `git` with its arguments, folder, queued and running time, exit code and bytes. Without it, only processes slower than two seconds or stopped for time are logged. A failed probe alone isn't logged, since probes such as `rev-parse --verify` fail by design.

Drafting lives in the package too: `draftCommit`, `draftPullRequest` and `commitDraft` take a `DraftingModel`. `packages/host/src/git/drafting.ts` supplies that model from `UtilityWork.resolve("commit")`, which picks one of the person's API connections, never a harness. A chunked draft makes up to 80 model calls, and a harness would start its CLI process for each one and spend the person's subscription, so harnesses don't draft; a saved `agent:` choice from older builds reads as Automatic. `draftPullRequest` reads what the branch's commits change since `merge-base` with `origin/<base>`, never uncommitted files; the app doesn't call it. A pull request is written by the Thread's harness with its `pull_request_open` tool, by `PULL_REQUEST_WRITING`, in the session on screen or a new session of the Thread (`handGitAction` in `src/state/git-actions.ts`); the Changes form is the hand-written override. The `@` menu and the pull request's row attach it as a snapshot (`pull-request-context.ts`), as Git conflicts are. The commit prompt is the fixed `COMMIT_RULES` plus the person's style, or `COMMIT_STYLE` when they haven't written one; Settings shows `COMMIT_STYLE` as the default, so what is shown is what is sent. Structured output goes through `completeUtilityText` with the AI SDK's native structured output (`Output.object`, so Gemini gets `responseSchema`, OpenAI a non-strict `json_schema`, Anthropic `output_format` or a JSON tool, OpenAI-compatible `json_schema`) plus `extractJsonMiddleware`; a prompt-only "return JSON" request fails because Gemini wraps plain-text replies in ```json fences. A failed draft is logged under `git-drafting`, never with the model's text. `npm run test:git` checks the package against real temporary repositories and a fake model, including 120 random edits compared against full status reads.

`ChangesPanel` stages, commits, and pushes. Commit drafting uses the host-only
AI SDK connections in `utility-models.ts`, configured in Settings › Git ›
Commit messages, never a coding-agent session. API keys are encrypted through Electron
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
the location and the move. A key keeps its model's name beside the id
(`UtilityConnection.name`, from the catalog or provider list the dialog
showed), so Settings and the Generate tooltip read "Gemini 3.8 Flash", not
`gemini-3.8-flash`. A key saved before names were kept is named from the
models.dev catalog once per run (`savedModelNamer`); a custom id no list
names shows as the id. Which model drafts commits is the host's
(`UtilityWork`), read by every view through one snapshot in
`src/state/commit-model.ts`; with no key Generate becomes Connect API key,
and a chosen key that's gone becomes Reconnect key, both opening
`git#commit-messages`. Settings › Git › Commit messages holds it all: the
connected keys as one radio group (the checked key writes, Automatic being
the first), the Fast/Deep depth (the `commitAnalysis` preference), and the
instructions. Settings › Models keeps only the loadout and the harness order,
and the commit card only Generate and Commit. The button is
Commit, or Commit all when nothing is staged; the count is the Changes
header's to show.
`test-commit-model-status.ts` covers the resolution.
On macOS with a local certificate, every new build is a new keychain partition
(`cdhash:`, since only Apple-issued certificates carry a Team ID), so the first
keychain access after an install asks once for Always Allow; that is macOS,
not a lost connection.
Changing a custom endpoint requires re-entering its key. Non-sensitive text diffs,
including lockfiles and generated files, are captured completely. Working-tree
captures use private Git objects and a private index without modifying the real
index or object database. Reviewed worktree commits capture the files again and
compare tree ids, and check HEAD, branch, and index state before staging. Model request size bounds do not
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
Commit generation has explicit Fast/Deep modes in the shared input contract, saved once as `commitAnalysis`. Fast uses complete evidence with direct synthesis and low requested reasoning; Deep adds bounded inspections and higher requested reasoning. Changing this policy must not truncate source or alter Git safeguards. Commit errors must not offer automatic mutation replay; refresh the observed Git state instead.

`commit-drafts.ts` keeps per-workspace edits and offers late results as suggestions
rather than overwriting a message. `npm run test:commit-generation` exercises model resolution, AI SDK calls,
cancellation, and encrypted storage on top of the package's drafting.
`node scripts/test-commit-ui.mjs <isolated-dev-url>` runs the real-host connection
and drafting flow with trusted UI input and a local model endpoint. It requires
a host started with a temporary `MAKO_DATA_ROOT` (a `MAKO_PROFILE` host shares
the user's connections) and no existing model connections, and prints screenshots.
It also checks commit-footer geometry and the computed Shadow DOM colors of sidebar
diffs, center diffs, and source files across light, dark, and system-theme changes.
Pierre's `diffs-container` inherits Mako's color scheme and token bindings from
`src/index.css`; component-level dark/light overrides are unnecessary.

Git browsing is metadata-first. Line totals are deferred; unknown totals are `null`, never fabricated zeros. Concurrent readers share
status work, and index-only events do not reload open file contents. History lists
read commit metadata without `--shortstat`; per-commit files are paged in the UI.
`ChangeList` windows fixed 24px rows instead of mounting an entire changeset.
`@mako/git`'s previews limit interactive full-text comparison to 64 KiB/2,000 lines;
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
wanted — the package compares against the empty tree there. And
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
list; horizontal tabs inside the central workbench hold that thread's
sessions, then its files and diffs. The rail never nests sessions: a Thread
with several is one row wearing each Session's agent mark and the most
demanding status among them (`src/lib/thread-fold.ts`), and clicking it
opens the Session you last had open there. `+` and Cmd+T open the Thread's
new tab; nothing is created until its first message is sent, an empty new
tab disappears when you leave it, and one holding unsent text stays as a
Draft tab, its text kept per Thread (`src/state/thread-sessions.ts`). An
untitled Session's tab shows its agent's name, never a shared placeholder. A fork
joins its parent's Thread as a tab unless Option-click asks for a new one.
Moves are per Thread; no control offers to move one Session.

The composer groups file attachments, screenshots, references, skills, and MCP
settings under one + popover. `composer.controls` contributions render inside
that menu and may dismiss it before capture. Three sigils, each one gesture:
`@` points at context (files, folders as `@src/lib/`, conversations, Mako's
snapshots), `/` invokes (at the start of the draft the commands too; anywhere
else a skill or an MCP server the _selected_ provider will have, from the
same reach predicate the host projects into a launch,
`packages/host/src/contracts/mcp-reach.ts`), and `#` names a numbered thing,
any of the repository's pull requests (`usePullRequestSearch`). `$name` is
how drafts before October 12 spelled a skill; it still reads and nothing
offers it. Mako's managed servers wear the fin. A `/word` no skill answers
to is a word (`/tmp` stays a path), and a slash inside a word starts
nothing. Sentence punctuation after a token stays prose.
`scripts/test-composer-capabilities.ts` covers the tokens, reach and
ranking.

A `/skill` reaches whichever provider answers. `packages/host/src/contracts/skill-reach.ts`
is the one rule: a skill under the provider's own roots is `native` (the
message points at it), one found only under another provider's roots or the
universal `.agents/skills` is a `handover` (the host reads SKILL.md and the
message carries its body in a `skill` item that names its source, or a
pointer above `SKILL_HANDOVER_LIMIT`), and an unknown name is `missing` and
goes out as typed. Every provider declares `readsUniversalRoot` on its skill
source, `false` until a live check shows the CLI loading a skill that exists
in `.agents/skills` alone; none is verified yet, so a universal skill is
handed over everywhere. `disable-model-invocation: true` marks a skill
`manual`; a typed reference is that invocation and carries it like any other.
A body is carried once per conversation (`skills.resolve` in
`src/state/skills.ts`), later mentions point back; the key is the
conversation the send continues on the same harness, and a handoff, a move
or a fresh start begins with nothing handed. Names are read from the user's
words alone (never a referenced thread's title), need a letter (`$5` is
prose), and a host that cannot resolve them keeps the draft with the reason
rather than sending the bare token. The draft's chip says the route without
taking width (a dotted underline for a handover), the transcript chip adds
the source's mark, the menu row names the source, and Settings > Skills is a
matrix of skills by place — a filled dot is a copy the provider loads
itself, an outline is a provider that is handed the skill, a caution dot is
a copy that drifted from the listed one (`SkillOrigin.hash`), and a dot
opens the install, replace or remove for that one cell, previewed first.
`scripts/test-skill-references.ts` covers the rule, the items and the round
trip; `test-skill-ui.tsx` covers the matrix and both chips.

Context reaches an agent in one format, `src/lib/context/`. A chip in a
draft is either typed text a catalog resolves (`@path`, `@thread:…`,
`/skill`) or a record in the draft's context bucket (`useAttachments`)
placed by its anchor `@ctx:<id>`: a file, a snapshot Mako made (terminal
output, conflicts, the branch's pull request, app setup), or a `detail`
(`src/lib/context-detail.ts`: a comment on lines, a picked element, a quote
of a reply, a pull request), with bytes beside it where it has them.
Anything on screen adds one with `addContext` (`src/state/composer-context.ts`).
At send `writeDraft` puts a marker where each chip stood,
`[Comment 3: review.ts:200–208]`, and one `<mako_context version="1">`
block at the end with an `<item>` per number: attributes for the reader and
for Mako, a body for the agent (`wire.ts`, `kinds.ts`). A plan and a skill
are items for the whole message. Words can't open the block and bodies
can't close an item: those tag openings are escaped (`escapeTags`). The
transcript, Reuse, Edit, copy, a restored send and the queue all read a
message with `readSent`, which also turns a prompt from before the format
(one appendix per kind: `[Attachment N]`, `[Referenced conversation N]`,
`[Skill …]`, `<mako-plan-context>`) into the same shape, and `sentDraft`
turns it back into a draft. Adding a kind is a detail schema, a writer and
reader in `kinds.ts`, a chip in `reference-chip.tsx` and a glyph; nothing
else branches on it. `scripts/test-context-wire.ts` and
`test-context-kinds.ts` hold every kind's round trip and the old formats.

The textarea holds each chip's label (`@`, which its mark covers, then its
words: `draftView` in `src/lib/draft-view.ts`), never its token or anchor,
which stay in the saved draft. A conversation's token is 50 to 100
characters of ids, and while it sat in the textarea as transparent text
under its title, the rest of it read as blank space the caret walked
through one character at a time, and a long one split the chip across two
lines. Offsets cross between the draft and the labels only at the
textarea; a label is one unit for the caret, Backspace and any edit
reaching into it, and an edit over a selection is read with the selection
taken at `beforeinput`, because comparing texts can't tell typed
characters from a label's own. Copying writes the message as the agent
reads it as plain text, so another tool still gets every path, and the
records as rich text, so a paste here brings the chips back. A paste of
more than 12,000 characters or 250 lines becomes a text file chip, with a
toast to paste it as text instead; a pasted image is read from the
clipboard's items as well as its files. A conversation dragged from the
sidebar onto the composer becomes its chip there (`tab-drag.ts`). Before
the catalog loads a restored conversation reads `@Conversation`.
`npm run test:thread-references` covers conversations end to end.
Terminal remains on Command-J and
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
answered by the client that owns the window (`electron/client-main.ts` or
`src/dev/web-notifications.ts`), never by the shared host; one banner per thread is retained until it reports, and a click sends
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

To look at the interface without being able to change anything, run
`npm run desk:fixture`. It serves a web page on a `fixture-<checkout>` profile,
starts no desktop window, and its host refuses every host call outside
`packages/host/src/contracts/fixture-desk-policy.ts` from every client: the page proxy,
Electron windows on its socket, and its own hidden desk windows that agents
drive. Writes, provider calls, git, terminals and unknown calls fail with
`fixture-refused` before their arguments are parsed. It still reads the real
conversation catalog, so real titles and transcripts appear. Below the host
calls, the shared Thread store, session ledger and archive are constructed
`readOnly`, and the host hands its harnesses strict `NativeStores`
(`packages/sessions/src/read-only-sqlite.ts`, carried as `HarnessContext.stores`
and as `strictStores` into the usage worker and the Cursor and OpenCode child
isolates), so every harness database opens read-only and every removal
throws `ReadOnlyStoreError`. While a writer has a database open it is read
`mode=ro&readonly_shm=1`, so the main file and `-shm` are held read-only and
commits stay visible; SQLite always opens `-wal` read-write but this
connection never writes it. With no writer it is read `immutable` and
reopened once the file changes. A plain `--sandbox`
or `dev` desk changes real conversations and settings.

The host keeps its own log at `<data root>/logs/host.log` (`packages/host/src/base/host-log.ts`,
rotated to `.1` at 4 MiB) because it is spawned detached with its stdio ignored.
Every provider spawn, startup step, refused setting, failed prompt and exit is one
line; `console.warn`/`console.error` are mirrored; crash reports add a summary
line; Settings > Diagnostics reveals the file. Lines are published on
`mako:host-log`; `host-main.ts` keeps them (`installHostLog`), and a test that
wants them opens a log and calls `keepHostLog`. Fields are explicit and stderr
tails are scrubbed of bearer tokens: never log an environment, a header list or
a request body. ACP startup is bounded by silence, not a fixed budget
(`packages/host/src/harnesses/provider-startup.ts`): a step fails after 20 s without any stdout or
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
Mako-owned Node children use `headlessNodeExecutable` (`headless-node.ts`):
on macOS it selects Electron's bundled Helper, whose `LSUIElement` policy
keeps each Cursor SDK process, managed MCP server, browser native host and
daemon out of the Dock. Never launch a headless script through the main
Mako/Electron executable when the Helper is available.
Every harness process (agents, app servers, SDK children, model discovery)
starts through `spawnProviderProcess` (`providers/provider-process.ts`), which
refuses a folder that no longer exists with `MissingWorkingDirectoryError`
before spawning. Node reports that case only as `ENOENT` on the executable, and
a picker left open on a deleted worktree once retried Claude discovery there every
two minutes; discovery in a missing folder lists the account's models instead.
Inside the Cursor SDK child, a shell whose remembered folder was deleted
(`cd x`, then `rm -rf x`) made SDK 1.0.31 throw an unobserved `spawn /bin/zsh
ENOENT` rejection that ended the turn with exit code 70. Even with that
rejection tolerated, every later shell call failed. `shell-folder.ts` turns such a call
into a refusal naming both folders and moves the shell to the workspace. The
child logs spawn-failure and abort rejections instead of exiting, and the
`WriteIterableClosedError` a failed exec's unawaited write to its closed
stream rejects with (in SDK 1.0.35 and 1.0.40); any other rejection is still
fatal.
`test-provider-startup.ts`, `test-provider-process.ts`,
`test-cursor-shell-folder.ts`, `test-host-log.ts`, `test-provider-children.ts`
and `test-composer-settings.ts` cover these.

When the host closes for a restart, install or quit it answers every pending
call with `host-restarting` (`packages/host/src/contracts/host-connection.ts`) instead of
resetting the connection. The client turns that, and a dropped socket, into
`RuntimeDisconnectedError`; `packages/host/src/contracts/host-call-recovery.ts`
repeats a call once
the event stream reattaches according to one table,
`packages/host/src/contracts/host-call-policy.ts`: `read` channels change nothing;
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
epoch replaces the state outright and drops any batch still buffered from
another epoch: it came from a host that no longer answers, and replayed it
would ask the new host for a snapshot in its numbering forever (a window once
reread one conversation every 280 ms for an hour after a restart). An unstamped batch (an older host) still
applies by revision. `test-prompt-delivery.tsx` covers both.

A window reads a conversation's earlier history, released turns and full
outputs through a view the host captured (`LiveHistoryReader`). A
conversation keeps its newest four views; its newest stays while memory holds
the conversation, since it shares what memory holds, and the rest stay while
what they keep alive beyond memory fits 128 MB, so one conversation's stream
never pushes out the view of another being read. A read naming a view the host
doesn't hold is refused, and host.log says why under `history`. The window then
takes a current view and reads once more (`withLiveView` in
`live-recovery.ts`); a snapshot its stream overtook still gives its view when
every batch since merged in order (`takeView`), and rereads that bring nothing
newer back off to 8 s. A client making the same call about the same thing 40
times in 10 s is named in host.log under `rpc` (`RepeatedCalls`), and a
window's console warnings and errors land in desktop.log under `renderer`.
`test-live-view-recovery.ts`, `test-live-history-paging.ts` and
`test-repeated-calls.ts` cover them.

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
`--control` starts the embedded driver and a background AppKit fixture, asks
the installed provider to read a random workspace value and enter/verify it
without naming a control tool in the task prompt. The normal startup advertises
the task-owned `mako-control` MCP adapter. The test checks
the fixture state and continuous frontmost sample independently, and removes
the native session even when the turn fails. Grok needs an advertised tier that
pre-approves lazy MCP calls (currently `MAKO_E2E_MODE=access:full`); Codex needs
a model the installed CLI and account both accept.
The installed OpenCode v2 ACP server rejects concurrent prompts. A free
`opencode/` model passes normal replies and queueing: Zen withdraws them without
notice (`muse-spark-1.3-contributor-free`, then `space-bunny-free` and
`mimo-v2.6-flash-free` in October 2026), so the live tests take them from
OpenCode's own catalog in their isolated home (`scripts/opencode-free-models.ts`,
Zen's default first; `MAKO_OPENCODE_MODEL` chooses); verify it with `--continuation`, not by advertising unsupported
steering. OpenCode starts on its last models.dev catalog and refreshes it after
startup, so a default Mako read from the first can be a model it no longer
routes: the driver treats `models-dev.refreshed` and `integration.updated` as
catalog changes, and a session still on the default it was given moves to the
refreshed default before its next prompt.
No test, probe or proof runs a real harness in the person's own home. A
session it starts there is a real entry in their Codex, Cursor, Claude or
Grok history, and their own Mako lists it and keeps a copy: deleting the
native session afterwards leaves the row in their sidebar. On 2026-10-27
the moves proofs, packaged-app proofs and session flows had left 585 such
rows there. So each runs in a scratch home (`scripts/scratch-harness-home.ts`):
a CLI or an in-process driver in `scratchHarnessHome` or `enterScratchHome`,
a Mako host or app it starts in `scratchHostHome` (`PackagedApp` does so
itself, in `<root>/home`), each harness signed in with access alone (an
access token with no refresh token, or an API key), the person's CLIs on
`PATH`, and on macOS a keychain of the home's own, where a host keeps its
secrets: macOS finds a login keychain under `HOME`, so the person's is out of
reach. The copies live only as long as their run: 0600 files in 0700 folders,
never inside a Git checkout, removed by the process that made them however it
ends (`ScratchHome.dispose`; a `keep` home such as a moves proof's data root
loses only its sign-ins and keychain), and a run killed outright is swept by
the next one through a registry under the temporary folder. A proof that drives a running host takes a host of its own
(`--data-root`, `scripts/lib/proof-host.ts`), never this Mac's own Mako or
one of its profiles, and checks that host's catalog lists nothing from the
person's harness stores (`harnessStoreRoots`). `scripts/test-scratch-home.ts`
holds every script to it: one that starts a harness session in a host, app or
SDK it runs, or spawns a harness CLI, does so in a scratch or sealed home, or
is named there with why no real harness runs. `SessionCatalog.remove` still
takes a run's sessions out of its scratch stores (`--keep-native` retains
them); each `SessionProvider.remove` deletes only its own session under its
own roots and never a Cursor Desktop chat.
`npm run clean:fixture-sessions` lists sessions left in fixture-named temporary
directories by earlier runs and removes them with `--delete`: a temporary
directory named `mako-…`, as every test's `mkdtemp` prefix is.
`scripts/archive-proof-sessions.ts` lists the rows a running Mako shows in
any proof folder (`scripts/lib/proof-folders.ts`: those, the moves proof's
runs and a Thread's data folder) and, given that list, archives them through
the sidebar's own archive, which the person can undo from Archived. Mako
itself lists such sessions like any other: a folder's name or place never
hides a session, since `claude --resume` there lists it, and a second Mako on
this Mac keeps its Threads' worktrees in its own data root.

Normal desktop Quit closes the client, leaving the shared host and provider
processes running. Force Quit of the host and system shutdown are different: journals
recover history, not a running process. Host restart and update installation wait
for active work to finish. The `--background` launch switch keeps test windows
hidden until explicitly activated.

A live session's permission switch is saved only after provider acknowledgement,
separately for each provider. Before a session exists, every live driver declares
the ladder a new session will offer (`modes` on `LiveCapability`; ACP sources record
their verified `nativeModes`), the composer offers it for the selected provider, and
the saved choice travels with the first prompt. The host validates it against the
session's own list at start. Execution
preferences sync between windows; draft text and preview layout remain separate.

## Access tiers and steering

`packages/host/src/contracts/access.ts` is the one ladder: plan, chat, ask, edits, auto,
full, deny. A provider mode carries the tier it implements (`access`) and who
makes it true (`enforcement`): the provider itself or a native launch setting.
The picker orders by tier and shows the provider's own name beside it. Never
show a tier nobody enforces. Mako selects native policy and forwards the user's
answers; it must not implement a replacement tool-classification/approval policy.
`hostAccessDecision` and host-enforced mode declarations have been removed.
Legacy journal modes are filtered on read without deleting saved history. A mode id of the form
`access:<tier>` is Mako's normalized selection id; anything else is the provider's own.

A remembered answer is the harness's own: Mako offers it only when the
harness does, sends exactly what the harness would save, and lets the harness
save it. Claude Code's "Always allow" hands back its own non-session
suggestions as `updatedPermissions` (Claude writes the rule to the settings
file it names; none when it sets `suppressAlwaysAllowRule`); Codex's MCP tool
approvals answer with `_meta.persist` (`session`, or `always`, which Codex
writes as the tool's `approval_mode`); Grok's and Devin's are their own
`allow_always` options. What confirms the harness applied an answer is its
own record (`approvalEvidence`): Claude's and Codex's decision telemetry, a
rule Codex reports writing when it was the one offered, and for Grok's shell
approvals the command running or failing with or without its entry in the
project's `permission.toml` (`grok/approval-observer.ts`,
`test-grok-approvals-live.ts`). An answer no record tells apart stays
unconfirmed.

Answering a card hides it at once, and the live step names the call that now
runs. The host saves the answer as sending, then as handed over, and every
harness that asks hands it over in the same moment. The receipt's notice above
the composer (`approval-status-notice.tsx`) therefore stays away while the
answer is sending, unless that lasts past `APPROVAL_SENDING_SHOWN_AFTER_MS`;
otherwise it would draw a bar for one frame. It speaks only for an answer that
is still on its way, uncertain, refused, no longer waiting, or recorded as a
different decision. `npm run test:approval-answer-ui` checks this for each
harness that asks, live and reopened.

Each ACP provider declares its placement in `access` on its `ProviderAcpSource`
(`native`, `launch`, `base`); `packages/host/src/harnesses/acp-access.ts` builds the mode
list and resolves a selection, and `acp.ts` applies it. Verified on 2026-09-11
against the installed CLIs: Devin advertises all five tiers
natively. Grok reads `--permission-mode` at launch, so its tiers are
launch-only. Grok follows its own permission settings only: by default it
also imports Claude Code's `.claude/settings*.json`, whose `defaultMode`
replaced `--permission-mode default` (Ask), so Mako launches it with that
import off (`GROK_OWN_PERMISSIONS`, verified on 1.0.46; Claude hooks,
skills, `CLAUDE.md` and MCP servers still load), and
`test-grok-modes-live.mjs` keeps Ask asking with Claude at `auto` beside it.
Grok (1.0.44, verified live 2026-10-01) merges permission rules from
`~/.grok/config.toml` `[permission]` (string lists or `rules` tables),
`managed_config.toml`, and, only in a folder trusted in
`~/.grok/trusted_folders.toml` (its real path or its git root), the
project's `.grok/config.toml` up to the repository root. Deny beats ask
beats allow at every tier, Full included. `grok/permission-policy.ts` reads
the same sources with the same trust rule at launch, and a "Grok permission
rules" setup notice lists the rules by effect and file. In a folder it
doesn't trust, Grok also ignores the project's MCP servers, hooks, plugins,
agents, instructions and skills. Mako sets `x.ai/folderTrust.interactive` at
`initialize`, so Grok asks with `_x.ai/folder_trust/request` and its own list
of what it skips; `grok/folder-trust.ts` shows that as a card, and Grok saves
"Trust project" itself (`test-grok-folder-trust-live.ts`). OpenCode supports v2 only (2.x and known v2 prereleases); runtime
admission and update policy share `isOpenCodeV2`. Do not restore v1 execution,
model discovery or update feeds. OpenCode Ask/Edit/Full presets use per-process native JSONC configuration on the Build agent;
Plan and custom agents retain their native policies. Existing inline fields survive the merge.
The process reads its preset at launch; selecting that preset after Plan must switch the
native agent back to Build before reporting success. Native saved grants, session rules and
plugins remain OpenCode's responsibility. Mako forwards every native approval to the user. Follow the migration and retained-history
retirement gate in `docs/meta-harness/delivery-plan.md` (OpenCode v2-only migration).
Claude maps its own modes, with `bypassPermissions`
allowed at launch so a later switch is accepted. Codex sends approval policy,
sandbox, and reviewer with every `turn/start`; a change applies to the next
turn. Cursor is not an ACP provider: its ladder is the SDK's own and is
enforced by the SDK (below). `test-access-modes.ts` covers the placements
and decisions.

### Plan mode

Plan is one composer control (Shift+Tab, the palette's "Toggle plan mode",
the "Plan mode" row in the model menu) over two native shapes, resolved by
`planControl` in `src/state/plan-mode.ts`. The composer's Plan pill shows
only while plan mode is on, and clicking it turns plan mode off:

- A **setting**: a boolean model option with `role: "plan"`, sent per turn
  and independent of access, so Plan with full access is valid. Codex sends
  it as `collaborationMode`; Cursor sends the SDK's per-send `mode`. Codex
  keeps the collaboration mode across turns and restores it on resume, so
  Mako sends `plan` or `default` on every turn once the choice is known.
  Cursor reports only its model back, so the driver carries `plan` beside
  each report or the chip turns itself off after one turn.
- A **mode**: the access mode whose tier is `plan` (Claude, OpenCode, Devin,
  Grok). Entering it replaces the access level; leaving returns to the one
  remembered on entry. Grok's access tiers are launch-only, but its Plan is
  set live, and approving a plan returns it to the launch tier
  (`current_mode_update` to `default`). Devin reports the chosen build mode
  the same way. `npm run test:grok-modes-live` drives real Grok against a
  stand-in model to check both.

A setting wins when a harness declares both. Generic option menus and the
Settings defaults skip `role: "plan"`. A plan chosen for a session that has
not started is pending in `src/state/plan-choice.ts`. It is taken at launch,
restored if the launch fails, and never saved as the harness default.

Every harness turns its plan into a `proposed-plan` update with a stable id:
Codex's plan item, Cursor's `createPlan`, Claude's `ExitPlanMode`, Grok's
`exit_plan_mode` and its `_x.ai/exit_plan_mode` approval request
(`grok/plans.ts`), Devin's plan-file edits and `exit_plan_mode`
(`devin/plans.ts`), and the final reply of OpenCode's plan agent
(`OpenCodeContent`, which retracts that step's text parts). Each live driver
declares this as `planning` (a mode or a per-send setting, plus where the plan
comes from), checked by `validateLiveDriver`; `npm run audit:capabilities`
prints every harness's modes, plan mechanism, approvals and sign-in and fails
on a contradiction. The history readers in `packages/sessions` produce the same
card under the same id from saved sessions; Devin's live decoder and both
Devin readers share `DevinPlanTracker`.

Build answers the native plan approval when one is waiting for that plan
(`LivePermissionRequest.implementsPlan`, set by Claude's `ExitPlanMode` and
by the Grok and Devin plan decoders), and sends no prompt as well: a second
prompt would run the work twice. Without an approval it leaves plan mode and
sends the implement request. An earlier plan revision never answers the
current approval. "Build in new session" cancels the planning session, then
opens a session in the same Thread with the plan attached and plan off.
`scripts/test-plan-mode.ts` covers the mapping, locks, pending choices and
both build paths.

A reply typed while a plan approval waits asks for changes. Where the harness
takes words with its refusal, the approval names that answer
(`LivePermissionRequest.feedbackOption`). The composer then sends a text-only
reply as `feedback` on that answer, through `submitDraft`'s `deliver`, so the
draft is cleared and restored the same way as a message. Claude's deny message
and Grok's cancelled `_x.ai/exit_plan_mode` answer carry the words. Grok's
needs a plan file: with none it drops them, so its decoder names no feedback
answer. Both use Grok's `revise_plan_message` wording (`planFeedbackMessage`
in `@mako/sessions/harnesses`), and the plan-exit row reads the words back
from the call's result with `planFeedbackOf`, live and saved. Elsewhere, and
for a reply with attachments, the plan is refused first and the reply is the
next message. Each driver declares which as `planning.feedback`, with what
carries the words or why they can't go with the refusal. `LiveApprovals`
refuses words on any other answer, and a receipt's digest leaves them out. The
IPC schema keeps them. `scripts/test-grok-plan-feedback-live.ts` checks the
real grok, sealed, with a stand-in model: the words come back as the result
of `exit_plan_mode`, live and in the saved session.

A build is recorded in `src/state/plan-builds.ts` once it is confirmed: an
`implementsPlan` approval answered with its approve option, or a sent message
carrying the plan's implement request (from the card or the composer). The
card then reads "Built in this session" or "Built in another session", Build
becomes "Build again", and an open building session gets "Open build
session". The record lives in the host (`electron/plan-builds.ts`,
`userData/plan-builds.json`, newest 200 plans); recording is idempotent and
every window hears of a change through the `plan-builds` host event. A desk's
old `localStorage` record is handed to the host once, then deleted.

`npm run probe:plan-turn -- <harness>` runs one minimal real planning turn and
its build through the live driver, keeping its stream, printing only shapes
and ids; it spends model usage. It runs in a scratch home signed in with access
alone (`scratchHostHome`): a copy holding a refresh token could rotate it and
sign the user out, and the session never reaches their stores. `--start-only`
is free and shows launch notices.

How a catalogued thread is continued is the host's decision, not the
renderer's. `packages/host/src/contracts/thread-continuation.ts` turns one ref plus
what only the host knows — the live driver, the installed CLI, a run that
owns the path, another process in the store — into a `ContinuationPlan`:
`live` with the id to load, `native`, `handoff` with a reason, or `refused`
with a reason. The renderer asks `continuationPlan(path)` and follows it;
`live-start` with a resume id and `native-submit` each assert the host's own
plan first (`packages/host/src/conversations/continuation.ts`), so stale renderer state fails with
the reason instead of running on another transport. Before this the renderer
chose from provider flags served once at startup, and a wrong `canResume`
sent every Cursor reply to `cursor-agent -p --resume` without a word.
`test-continuation-plan.ts` covers the rules and both refusals. Verified
2026-09-12 with `test-provider-e2e.mjs <provider> --restart` on Grok: it
reopens a stopped session through `session/load` in place. Cursor reopens
through the SDK's own resume (below); `test-cursor-resume.ts` covers its
verdicts.

What a session ran under is remembered per user, not per host.
`packages/host/src/threads/session-memory.ts` keeps `~/.mako/session-memory.sqlite`, keyed by
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
released on hibernate, close and `stop`, stale after three minutes or when its pid is
gone, and another host's hold refuses the continuation plan by name and shows
as `external-open` in the rail. The journal's `modes` keep `access` and
`enforcement`, so Restart Mako no longer strips the tiers from the picker.
Choosing a tier while viewing a thread that is not live is the thread's
choice (`chooseThreadMode`, `mako:thread-remember-mode`), and the host applies
its own memory of the tier when a reply arrives without one. A host started
after the ledger existed offers its own journals to it once (`backfill`,
stamped with the journal's write time, never over a newer observation), so
sessions from before the ledger are not "Model not recorded" forever. The
ledger keeps its format in `store_meta` (`SESSION_MEMORY_SCHEMA`). A host
on a newer Mako's ledger reads settings, modes and holds and writes none:
what it would remember stays in its journals, which the updated build's
backfill takes at its start. Resuming a session needs its hold, which
such a host can't take, and `SessionMemory.resumeRefusal` is the one rule
for it. The continuation plan asks it first (`resumeLedger`): a reply goes
on from the transcript in a new session where a live driver can start one
(no other host knows that session, so `holdRunning` holds nothing ahead),
else it's refused saying why; another host's hold is still said first, by
name. The host's resume verdict asks the same rule (`resumingUnder` makes
it `closed`), so a send does what the plan said, and `hold` throws it for
anything else. A conversation of this host's that isn't running (hibernated
or disconnected) is asked the same: its plan says so (`attached` with
`makoUpdate`), and a send to it isn't woken by resuming (`reopens`) but goes
on from the transcript through a transfer. The composer shows the plan's
line with Update (`ledger-notice.tsx`). Every format of the ledger keeps
`holds` and lets an older host refresh and release its own rows
(`SESSION_MEMORY_SHARED`, which a build raising the format passes to
`guardStoreWrites`), so a session an older host already runs stays held,
heartbeat and all, after a newer Mako raises the ledger under it. A mode
change rewrites the mode alone, so settings a newer Mako wrote keep the
fields this build doesn't know.

Which Thread and Session a conversation belongs to is per user too.
`packages/host/src/threads/store.ts` keeps `~/.mako/threads.sqlite`; a fixture data
root outside Application Support keeps its own. A Session is one logical
conversation and may own several journals; a Thread groups Sessions, has an
owner, and starts with one. Both IDs are random UUIDs the store mints, never
derived from a cwd, native ID or journal ID: one native session reached
through a symlinked provider root, a Claude account alias or a reopen journal
stays one Session, and two journals in one directory stay two. On start
`LiveConversations` registers every journal in creation order as the
`migration` service, so journals an older host wrote join on the next start;
after that it registers a journal when it is created or its bindings change.
A registered journal keeps its Session, an explicit Session (a + tab) is
joined, a fork gets its own Session linked to its parent's, and anything else matches binding paths and the thread path, then
pathless native claims. The catalog places every row once it is ready
(`resolveRefs`, by catalog identity, path and native claim), and `annotate`
overlays `threadId` and `sessionId` onto each `ThreadRef`. When two Sessions
turn out to be one conversation, the loser is merged only if it is alone in
an untitled Thread and neither descends from the other; otherwise the host
logs a conflict and keeps both. Paths are compared through `realNativePath`.
`captureNative` adopts a native session only when the store places it in the
journal's own Session. `createSession` and `renameThread` take a
caller-minted operation ID: a replay returns the first result and the same
ID with different content is refused. Every journaled request records its
`actor` (a person for the desk and socket, or a Mako service such as
`auto-continue`; older records may name the removed
`relay` service, which still parses); the host assigns it and
never reads it from caller input. A store in a newer Mako's format is
read, not refused: the rail lists every Thread, rows are placed from what
the store recorded, and every write (a rename, a `+` tab, a worktree, a
move) is declined with the line; journals aren't registered and wait for
the next start of a build that can write the store, which registers them.
Only a store whose `reads` is past this build is refused, by version, and
Threads are off. `npm run test:thread-store` covers the rules, six-harness
migration across a restart and in a newer format, and actors.

A Thread's own name is `title` with `title_source` in the store: `user` for a
person's rename (`renameThread`), `frozen` for a name Mako gave a Thread it
started, and no source for a title an older build wrote, which counts as the
user's. It names the whole Thread in the rail; each Session's tab keeps its
own title, and a Thread without a name shows its first Session's. Mako
doesn't name Threads automatically: the `auto_*` columns and
`title_exchanges` that older builds wrote are kept for builds sharing the
store, and a title they mark `auto` isn't shown. `scripts/test-thread-names.ts`
covers it.

Every Session also has an execution owner (this device or a named cloud
runtime) and a generation that rises on every owner change, including to
nobody while in transit (`packages/host/src/contracts/thread-execution.ts`, the
`executions` and `moves` tables). Ownership changes only when the owner
releases and the destination claims. No timeout, heartbeat or lost connection
moves it. `LiveMoves` (`packages/host/src/conversations/live-moves.ts`) gates `drain`, `wakeNow`,
`open` (before the journal exists), `submit` and `transfer`: a Session owned
here runs, a leaving one admits prompts and holds them queued (not `held`, so
a cancel starts them), and one in transit or elsewhere refuses with the owner
named. Keep each check and the work it guards in one event-loop turn, with no
`await` between them; that is what makes a release safe. Release refuses
with `MoveNotQuietError` while any tab is busy or another host holds one of
the Session's native sessions, and never waits. Each dispatch records
`nativeDelivery.ownerGeneration`. Additive store changes are
`store_migrations` entries and raise no number; `THREAD_STORE_SCHEMA`
rises for a change an older writer would break, and `THREAD_STORE_READS`
only for one an older reader would misread. A missing `executions` row is read as this
device at generation 1. `test-thread-execution.ts` and
`test-thread-execution-host.ts` (six harnesses, round trip, cancel, restart,
two hosts) run under `test:thread-store`.

What the host holds of its conversations is `LiveRecords`
(`packages/host/src/conversations/live-records.ts`): a journal is read in
when something needs it and let go once the memory budget has no room for it
and nothing is using it. Everything that lists conversations, every second or
on every event, reads the listing (`LiveSummary`: the session, its paths and
native ids, its revision), never a journal: the Sessions report
(`ownedSessions`), the account's rows, the Thread lifecycle's archive keys
(`liveArchiveKeys` in `contracts/thread-lifecycle.ts`, the one rule the
lifecycle and the report share). On 2026-10-28 the report asked the lifecycle
whether each conversation was archived, the lifecycle read each one's
snapshot to answer, and the host loaded all 157 journals (1.3 GB) every
second, swept them, loaded them again, and ran out of heap 90 seconds after
each start, eight times. So every load from disk is counted to the work
running (`HostWork.current`, set by `run` for every call, job and domain
load, and only while it runs: a timer or a process the work set up that fires
after it ended names the run around it, or none, never work long done), the
residency lines name it (`by`, `loads`), Settings › Diagnostics
lists who read what in, and one reader loading `BULK_LOADS` conversations
between two sweeps is named in the log as a bug. A host whose heap crosses
`HEAP_PRESSURE` says so once with that readout and writes it whole to
`logs/memory-pressure.json` (`base/heap-watch.ts`), because an out-of-memory
report has no JavaScript stack. `scripts/test-live-conversations.ts`
(`bulkLoadsAreNamed`) holds the report and the lifecycle to loading nothing;
`scripts/test-event-loop.ts` holds a run's name to the run.

A ready provider process is a warm cache, not active work. `LiveConversations`
keeps at most two warm bindings per host and hibernates either the oldest excess
or any one idle for ten minutes. Hibernation closes the provider and its MCP
children, revokes its control grants, releases its session hold, and keeps the
journal and binding. The next prompt takes the hold, checks the resume verdict
and starts that same native session once; concurrent prompts share the wake.
Running or queued work, permissions, child delivery, transfers, checkpoints,
rewinds and automatic continuation prevent hibernation. A retired driver's late
events are fenced by the resident generation and cannot close its replacement.

A saved binding's fate is a `ResumeVerdict`
(`packages/host/src/contracts/conversation-control.ts`), not a boolean: `resumable`
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

Cursor runs through `@cursor/sdk` (`packages/host/src/harnesses/cursor/sdk/`) and
nothing else. `cursor-agent acp` was the transport before: it ended a turn
on the first reset frame of its backend stream (`RetriableError: http/2
stream closed … CANCEL`), asked before every command, and answered "Session
not found" for the CLI's own `chats/` stores, so those rows continued
through `cursor-agent -p --resume`, which forked each new turn into a second
store. The SDK retries its stream itself, enforces the access ladder itself,
and imports any `cursor-agent` store it is asked to continue; there is no
ACP source or CLI model list for Cursor, and a new Cursor thread never
waits on sign-in state to choose a transport. Its native runner
(`sdk/native-runner.ts`) is the same child in one-shot mode,
`child.js --headless <spec>`: it prints the reply's text, exits 0 when the
run finished and 1 with the reason as the last stderr line otherwise, and
cancels the run on SIGTERM. The spec carries the live driver's own model
selection; with none chosen it is the account's default, because local SDK
agents refuse a run without a model.

The SDK runs in a child (`child.ts`, spawned through the host's bundled
`LSUIElement` Helper with `ELECTRON_RUN_AS_NODE`) over an NDJSON wire (`wire.ts`) so a backend
stall or an SDK crash cannot take the host with it; `CursorSdkClient` bounds
every request except `login`. Its store is `SqliteLocalAgentStore` under
Mako's state root, `cursor-sdk` in the host's user root
(`cursorSdkStateRoot(userRoot)`, the one rule the driver, the native runner,
the catalog and its decode asides, record read-back and moves, writer
evidence, usage and the fixture cleanup all follow): `~/.mako/cursor-sdk` for
the installed app, every profile and a cloud machine, which share their
agents, and `<data root>/cursor-sdk` for an isolated host, which neither
lists nor writes the person's. It is Mako's store, not Cursor's
(`cursor-agent` and the editor keep theirs under `~/.cursor`, which every
host reads, as it does `~/.claude` and `~/.codex`), so an isolated host's
catalog lists only the agents it can continue. One
`agents/agent-<sha256(agentId)>/store.db` per agent plus a
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
check is `node` against `packages/host/dist/harnesses/cursor/sdk/client.js` in a
fixture-prefixed directory.

Cursor's SDK sums a turn's `usage` over all its model calls and names no
window, so how full the context is comes from the checkpoints instead. Each
root the SDK saves (a `ConversationStateStructure`) carries `token_details`,
the field Cursor desktop's own meter reads: `used_tokens` is the last model
call's input and output together, `max_tokens` the model's window, and a
breakdown by category sums to `used` (`parseRootContext`). The SDK saves a
root after every model call and moves the run's `latestCheckpointRef`
through `store.runs.update` before the run can end, so the child hooks that
call and writes a `context` event per new reading, plus one as an agent
opens from its latest root. Verified 2026-10-17 (SDK 1.0.31): a turn's
distinct readings sum exactly to its `inputTokens + outputTokens`. That
feeds the composer's meter and its itemized popover. Cursor summarizes on
its server mid-turn and the SDK streams nothing about it: the only trace is
a root whose `summary_archives` gains the window it replaced, still
repeating the reading from before, and the SDK writes that root only after
the step the summary preceded has run. The child marks it as that root
lands (a `compaction` event citing the window, with the reading from before
and the window's summary), and the meter waits with no fill. The run's next
reading that differs from the one before is what the summary left: the call
after it, input and output, in the meter's unit, as Codex's `tokensAfter` is
its compacting call's `total_tokens` (Cursor's categories have no output to
take apart). The decoder states the compaction again with `tokensAfter` under
the same id, and the live engine completes any compaction marker that way
for every harness: a restatement adds what it says to the marker it drew, the
reducer replaces the marker in place, and a replay that adds nothing draws
nothing. A summary after a run's last step is measured by the agent's next
run, its first main root that reads otherwise, and never across a newer
summary, which leaves it unmeasured: the decoder keeps it waiting across
turns, and a reopened agent's child names it as `drawn` with what the roots
since measured, so the new decoder completes the marker an earlier child
drew. Such a completion is `completes` on the event update, and the shared
reducer replaces that marker by its id in whichever turn it sits, or draws
nothing when the blocks don't hold it (a reopened conversation shows it from
the record). The saved reader finds the same roots by binary search over the
run's rows in `store.db` (`cursorCompactionReadings`: insertion order is
checkpoint order, and a subagent's roots are told apart by their system
prompt), searching later runs the same way, and draws the marker already
complete in the replay of the run that made the summary, after the step its
first root ends on; the stream merge keeps the record's place
(`SUMMARY_LANDS_LATE`). `index.db`'s `runs.usage_json` keeps each run's
tokens, so Settings › Usage reads Cursor from its own index
(`cursorUsageHistory`): Mako's state root and the stores other `@cursor/sdk`
programs keep under `~/.cursor/projects/*/sdk-agent-store/`.
`test-cursor-context.ts` covers the readings, the open, the decoder and the
driver (`--live` a real turn, `--live-compaction` a real summary), and
`packages/sessions/test/cursor-server-summary.mjs` the saved marker.

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
`interruption` (`packages/host/src/contracts/live-conversations.ts`) carries a reason
and the moment: `stopped` is the user's Stop; `host-quit` is written by
`LiveConversations.stop()` for every turn still dispatching when the host
closes for a quit, restart or install; `host-crashed` is what the next host
writes when it finds a turn still dispatching in a journal no host is
writing, and that request is `uncertain` because the provider may have
finished it. The exchange footer reads "Interrupted when Mako quit" or
"closed unexpectedly", and on the newest such turn while the session is idle
offers Continue turn (`turnStops`, `continueTurn`), which sends one plain
prompt through the ordinary send path; a user's Stop offers nothing. Delegate
is retired: related work is a Session in the same Thread (a fork into a
tab, or a switch into the Thread's worktree). A child it made reads as a
fork of its parent (`live-journal.ts`), a parent's list of children goes at
its next write, and the store's `delegation` Sessions become `fork` on open.
`test-live-conversations.ts` covers the reasons, `test-live-controls.tsx` the
footer and the recovery rows, and `test-conversation-transfers.ts` a journal
Delegate wrote across a restart.

Every Stop Mako sends a provider goes through `LiveConversations.stopProvider`,
which writes `live Mako stops the provider's turn` to the host log with `why`:
`person` (Stop), `handed-off`, `goal-budget`, or `not-saved` (a warning, with
the error: the conversation couldn't be saved). Codex's engine adds `codex
interrupt the turn` with the turn id Codex's own log names. A harness turn
that ends interrupted with no such line was stopped by the harness itself.
The turn a Stop ends reads as whose it was (`STOPPED_FOR`): only the
person's settles as `stopped`; a handoff's as `handed-off`, a conversation
Mako can't save as `not-saved`, and a goal at its token budget as
`goal-budget`, which the footer says as quietly as a Stop, with the goal's
mark, offering nothing, since going on would spend past the budget
(`endedAsChosen`).
A file an agent names that Mako can't read is an `unavailable` attachment
(`LiveAssets`), never a failure to save, which would stop the turn: a Codex
code cell's `view_image` names its image by a `file://` URL in the rollout
(`codexLocalPath`), and reading that as a path once stopped Codex turns with
nothing in the log (`makoStopsAreSaid`, the `cell-image` decode pair).

Only a journal write that fails is a conversation Mako can't save
(`JournalWriteError`, `storageFailed`). Its turn is stopped and settles as
`not-saved`, Mako's own interruption with what failed as the request's error,
however the driver reports the end and whoever presses Stop after; the
transcript ends that turn on its failure row ("Mako couldn't save this
conversation", the work stands, Continue turn), never the person's "Stopped".
What isn't saved stays in memory and `saveAgain` tries the journal every
`SAVE_AGAIN_MS` until a commit works, which tells every window: a stopped
provider says nothing more, and space coming back is no event. Saving what an
event observed (`keep`) carries on when the journal refuses it, so the fault
doesn't cut a turn's settlement short (its reason, a goal's pause); a save that
must land before Mako acts (a prompt sent, an answer given) is `flush`, which
throws and is rolled back. Anything else is
not a save: a copy into Mako's store that fails keeps the update as the agent
gave it, which the journal saves, and an event Mako can't read or take in is a
host-log warning (`an event from the provider couldn't be taken in`); neither
stops the turn. A host stopping with a conversation it can't save logs it and
saves the rest. SQLite rolls a full disk, an I/O error or a busy lock back on
its own, so the journal rolls back only an open transaction (`isTransaction`).
`unsavedTurnIsMakos`, `otherFailuresDontStop` and
`unsavedConversationDoesntBlockStop` cover it.

A journal keeps every interruption reason so a build before it still opens
it: builds through `handed-off` parse `reason` against the seven they know and
refuse the whole conversation for any other (a `ZodError` on open). So
`reason` is always one of `SAVED_REASONS`, and a newer reason is saved as the
one `OLDER_READING` names for it, with the exact one in `exactReason`, which
older builds pass over and this build reads back (`requestRow`, `controlRow`,
`readStoredReason`). A reason added later must name its older reading, or the
contract doesn't compile; `not-saved` and `goal-budget` read as `stopped`,
which is how every build before them recorded those stops. The window reads a reason it doesn't know
(a newer host's, relayed from the cloud) as "Interrupted" (`turnStopLabel`).

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

The SDK's own retry loop gives up in words, with no code: `Connection failed
repeatedly` after its transport retries, each of which resent the action and
re-ran its tools, and `Agent turn stopped after repeated resume attempts made
no progress`. Both settle `failed` with `RETRIES_EXHAUSTED_STOP`, which the
host never continues, except when the agent's turn had already ended. A
stream error after `turn-ended` makes the SDK resume inside the same run from
an older checkpoint; each resume re-streams the closing and ends the turn
again, and two that save nothing end the run with the no-progress error. The
child reports `turnEnded` on the result when `turn-ended` came with no work
begun after it (`turnEndedAfter`), and the driver finishes that turn
(`resumesFailedAfterAnswer`). On 2026-10-02 (SDK 1.0.31) this showed as an
answer, the same closing twice more, then "Turn failed"; T3 Code saw it with
1.0.35 (pingdotgg/t3code#24226), and 1.0.40's retry loop is unchanged.

A dropped turn is continued by the host itself, once. The turn's work is on
the provider's side, so when the settled request is the newest one and
nothing is queued behind it, `LiveConversations` stamps its interruption
with `autoContinue: { at }` and, `AUTO_CONTINUE_DELAY_MS` (2 s) later, admits
a request carrying `continueTurnPrompt("connection-lost")` under the
interrupted turn's own `tuning`, marked `continues: { requestId, reason,
auto: true }` (`packages/host/src/contracts/turn-continuation.ts` holds the prompt,
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
user's bubble, and so does the person's Continue turn ("You continued the
turn after Mako closed"): its words are Mako's, not theirs. A store keeps
only the words, so `continueTurnPrompt(reason, sender)` ends with a
sentence naming who sent it, and `savedMakoPrompt` reads both back whole,
as it reads the goal loop's prompts; words from before that sentence
existed name no one ("The turn continued after …"). `test-live-conversations.ts` (`autoContinuedTurn`),
`test-prompt-delivery.tsx`, `test-live-controls.tsx` and
`test-notifications.ts` cover the send, the bound, the declines, the journal
and the quiet.

A turn whose provider process dies is continued the same way, for every
harness. Between 2026-09-26 and 09-28 the Cursor SDK child died mid-turn eight
times on SDK rejections nobody awaited (`ConnectError`, `AbortError`, `spawn
ENOENT`). Each turn was recorded `failed` and sat there until the user sent
again, once for seven hours, while auto-continue never fired: it required a
live driver and only knew Cursor's own dropped-connection stop.
`continuableInterruption` in `live-settlement.ts` now decides from the
delivery receipt. A request the provider `accepted` that ends with the
session `disconnected` is `interrupted` with reason `provider-exited`. One
that fails with a `network` failure kind while connected is
`connection-lost`. Without a receipt the outcome is unknown and stays
`failed`, the user's call. With no driver, the continuation reopens the native
session through `LiveTransfers`' reconnect, the path a user's send takes, and
the transfer carries `continues` beside its actor so the new request is Mako's.
Only a turn that ended in the transition being handled is considered, and
only when nobody meant to end it. `stopRequest` marks the request
(`Resident.stopping`) and `closeResident` sets `closing`, so a turn the user
stopped or closed settles `stopped` however its driver reported the end:
Cursor closes the SDK child when a cancel is not acknowledged, which reads
exactly like a crash, and Claude's interrupt can settle as a failed result
first. A session that reports itself `closed` is never continuable, and
`scheduleAutoContinue` takes the id of the request that just settled, so a
continuation the user declined is not revived by a later provider-started
turn or compaction ending. Codex and Claude retry dropped streams inside a
turn without ending it; only their turn-end signals (`turn/completed`, the
SDK `result`) settle, so a retry never triggers a continuation.

Drivers owe the receipt early, the death in one update, and the native
path a new session resumes from. Each declares that in `turnRecovery`
(`ProviderLiveDriver`), with the tests that kill its process mid-turn;
`validateLiveDriver` refuses a driver that leaves it out, and
`test-turn-recovery-contract.ts` loads the real provider modules and checks
each named test exists and has an npm script. A driver that cannot resume
declares `manual` with the reason. ACP answers `session/prompt` only at turn
end, so the agent's first output for the turn is its receipt. A prompt that
fails because the connection closed is left to the process exit, which kills
a process that closed its pipes without exiting. OpenCode's exit handler
fails the turn and disconnects in one patch. Claude's hooks report a fresh
session's transcript only when its first turn ends, so a death before that
finds the file by session id under the account's `CLAUDE_CONFIG_DIR`
(`ClaudeTranscript.locate`); without it the reconnect refused with "native
session source has not been located". A resumable ACP source declares
`locateSession` (`acpLiveDriver` refuses one without it), and the transport
reports the located source on the ready update and again on the exit update,
since a new session is not on disk when it opens: Grok searches
`~/.grok/sessions/*/<id>/updates.jsonl`, trying the URL-encoded launch
directory first because a macOS temporary directory may be spelled under
`/private`; Devin names `sessions.db#<id>` once the row exists. Before this,
Grok and Devin got the path only from the thread catalog, which the live test
host does not run, and Grok's killed first turn was left to the user.
`test-live-conversations.ts` (`providerExitContinued`, including Stop, close
and declined cases), `test-claude-sdk.ts`, `test-acp-provider-turn.mjs` and
`test-opencode-live.ts` cover them without a model, and
`test-turn-recovery-contract.ts` covers both locators. `npm run
test:turn-recovery-live -- codex claude cursor grok devin` drives the real host
with the real CLI and sign-in: it kills the provider process Mako spawned while
the agent runs a shell command, and requires the reopened session to finish
the turn with one continuation and send nothing more.

A failed turn carries a `failure` kind decided once on the host
(`packages/host/src/contracts/provider-failure.ts`, no imports, shared with the
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
(`packages/host/src/contracts/message-anchor.ts`): the entry's index plus the
provider's own id and timestamp when the store records them. A fork and
a transcript name the answer by its anchor, and `resolveAnchor` finds
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
`test:session-flows` restarts the host under every installed harness and checks the
native session, its context and its mode are kept. `test-devin-resume.ts` checks
native revisions, lock handling and records without a checkpoint.

New checkpoint payloads use private Git packs, not the user's object
database. A pack holds what the checkpoint adds to the commit checked out (the
turn's new and changed files, staged blobs), never that commit's own tree: a
rewind is refused once HEAD moves, so every restore finds those objects in the
repository, and a 50,000-file checkout's checkpoint keeps kilobytes, not the
whole tree. Captures must not add objects or refs to that database. Restore
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
bytes for 100-, 5,000-, 20,000- and 50,000-file fixtures.

A checkpoint takes what Git can read cheaply, not only plain repositories. The
working index is a copy of the person's, so Git rereads only files whose stat
changed; a sparse checkout's skipped entries stay off disk (`add --sparse`), and
a file flagged skip-worktree or assume-unchanged that is on disk is unflagged in
that copy alone, so its edits are captured and the person's flags survive a
rewind. A restore starts from the current state's own working index, so Git
rewrites only the files that differ. A project folder of several repositories,
and a repository's checked-out submodules, are captured one repository at a time
under one group checkpoint; their rewind restores each repository as its own
durable operation naming the whole, puts back those already restored when one
fails, and forks once at the end. An untracked repository inside a checkout is
its own, left out. Turns sharing a workspace (Threads in one main checkout) both
get checkpoints, each naming the other (`shared`), and the rewind preview lists
each changed file's writers from the attribution journal; restoring still waits
until no turn runs there. What still refuses (no Git at all, merge conflicts,
more than 250,000 files, a turn's new files past 256 MB) says why where Rewind is
offered.

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

The runtime behind a provider is one declaration on its module
(`host.updateSources.register`, `ProviderUpdateSource`): how to resolve the
binary, the npm package that publishes it, its Homebrew formula or cask, its
own updater with the install root that updater owns, and the path fragments
that mean another app owns the copy. `packages/host/src/harnesses/runtime-updates.ts` does the
rest for every provider alike and no provider spawns `npm` or reads a
version itself. The host reads every runtime five seconds after it starts,
when a window asks and the reading is over ten minutes old, hourly for the
public version, and after an update; each reading is pushed to every window
as `runtime-updates` and kept in `~/.mako/runtime-updates.json` so the next
host paints the last reading before its own lands. A window that asks for a
refresh (`mako:harness-updates` with `true`) gets the reading taken after
its ask, so a refresh right after an update or a terminal's install never
answers the old version. Settings > Agents
therefore shows versions the moment it opens, and opening the model picker
runs nothing. Before this the card was one IPC that spawned five CLIs and
ran `npm view` for each on every open of Settings, read "No runtimes found"
for the second that took, and stalled ten seconds offline.

The installed reading is keyed by the binary's mtime and size (Omnigent's
rule for its Codex catalog): a re-read spawns nothing until the file moves,
and when it moves — Mako's update or the user's `npm i -g` in a terminal —
`onRuntimeChanged` fires and `refreshHarnessProfiles` drops that provider's
model catalog in every workspace and discovers again, so an updated Codex
lists its new models without a restart (it once served the old CLI's list
for the rest of the host's life). The public version is
`registry.npmjs.org/<pkg>/latest` with a four-second deadline and a bounded
body, held an hour, a failure ten minutes; it never blocks the installed
reading and leaves it standing with `latestError` beside it. Versions are
ordered by `compareVersions` in `@mako/sessions/runtime-version` (re-exported
by `contracts/runtime-version.ts`), the same function in the host, the
window and the record store's restore gate, so `0.154.0-alpha.6.2` is behind `0.154.0`
everywhere. The channel is read off the binary's real path in evidence
order — another app's registry, an app bundle, the CLI's own install root,
bun, pnpm, npm, Homebrew, else `manual` — and the plan follows: `npm install
-g --prefix <prefix> --allow-scripts=<pkg> <pkg>@latest` (npm 12 blocks
install scripts and still exits 0, leaving Claude's native binary a stub),
`bun add -g`, `pnpm add -g`, `<prefix>/bin/brew upgrade [--cask]` only for a
declared formula, or the resolved binary's own `update`. An update goes where
the binary Mako runs lives: npm's prefix is read off the package's real path
(`<prefix>/lib/node_modules/<pkg>`) and passed explicitly, with that prefix's
`npm` and `node` first on PATH, because npm's own config can name another
tree (an `.npmrc` with `prefix=/opt/homebrew` under nvm's node put a second
Codex there and left the one Mako runs as it was); a project's own
`node_modules` gets no update at all. The update has worked only when the
binary Mako runs reports the version the plan installs; short of that the
receipt fails with both named ("npm installed Codex 0.164.0 into …, but
Mako runs …/codex, still 0.159.3"). The plan run is the one the reading
offers: a click doesn't ask the registry again inside its hour, so a slow
registry can't take back the update a person was just shown, and a reading
already at the target answers `unchanged`. Updates run one per channel at a
time and one per provider, under a five-minute deadline, and the receipt
names `from`, `to` and the updater's last words on failure; the row reads
"Updating…" in every window meanwhile and a runtime with no plan is refused
with why, by name. `scripts/test-runtime-updates.ts` covers the ladder, the
signature cache, the registry TTL, persistence, the locks, the receipts and
the row's words (`src/lib/runtime-updates.ts`);
`scripts/test-harness-update-paths.ts` runs a real npm against a scratch
prefix, home and registry with a misleading `.npmrc`, and holds every
harness's offer to the update it runs on every kind of install.

Each harness declares its versions once (`<harness>/versions.ts`, shape in
`packages/host/src/contracts/harness-versions.ts`): `oldest`, the oldest
build whose protocol Mako's client speaks, set only where the sealed session
flows passed against that build (Codex 0.146.0, Grok 1.0.25, OpenCode 2.0.0
through `opencode/legacy-api.ts`; Devin, Claude Code and Cursor have none); `tested`, the
newest the flows passed on, which the vocabulary, native-tools, decoder and
concepts records are held to (`test-harness-definitions.ts`); and feature
floors, none declared yet. Mako's installs and its Update go to `tested` and
never move anyone down. A newer build runs with nothing shown but a faint
"Newer than Mako has tested" in its Settings row, because people who update
the day a release comes out must not be nagged; an unreadable version blocks
nothing. Below `oldest` is the one blocking case: a line above the composer
when that harness is picked, with Update (`runtime-version-notice.tsx`), and
the launch is refused with the same words (`runtime-floor.ts`). A version
change at or above `oldest` keeps a resumed session's execution context
compatible. Cloud images install exactly `tested` with the vendors'
auto-updaters off; a person's own machine keeps its own. The daily job
(`scripts/bump-harness-versions.ts`, `.github/workflows/harness-versions.yml`)
proposes the next `tested`.

A missing CLI installs from its Settings row. `install` is required on every
`ProviderUpdateSource`, most preferred first: the vendor's documented
`scriptInstall(url)` (`curl -fsSL <url> | bash` under pipefail) or
`npmInstall(pkg)`, and empty only when sessions need no local CLI (Claude
runs the build the Agent SDK ships). A reading with no binary offers the first
plan whose command exists here, and the row shows that exact command before
the Install button runs it. `RuntimeUpdates.install` shares the update's
runner, channel locks and deadline, then reads the runtime again; the binary
where `binary` looks, reporting a version `supportsVersion` accepts, decides
the outcome, not the installer's exit code, because Devin's installer ends in
the interactive `devin setup` and fails without a terminal after the CLI is in
place. So every plan must land where `binary` resolves: OpenCode installs
through npm because `opencode.ai/install` takes the main repository's latest
release, which is v1. Detection resolves each CLI the way the vendor installs
it, not through one other app: Devin checks `DEVIN_CLI_PATH`, the shared
resolver (PATH, `~/.local/bin`), `Devin.app`'s bundled CLI, then Zed's
registry. Each installer was proven against a scratch `HOME`.

`test:message-queue` covers these boundaries with held discovery promises and real
fixture subprocesses. ACP and app-server startup must consume the host-provided
MCP snapshot, including its local-control readiness gate. `test:host-shutdown`
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

The lifecycle test always uses a temporary `MAKO_DATA_ROOT`, with the packaged
desktop starting that profile's own host (`scripts/lib/packaged-app.mjs`), and
stops the host itself: closing the desktop alone would not test host restart. Keep acknowledgement,
provider dispatch, first content, and completion measurements distinct. Archive checks
reject missing local named/default exports as well as missing import paths; frozen
files can still contain an incomplete concurrent compiler emission.

For the normal terminal workflow, run `npm run update:local`. It resolves the
verified installed signer, or an unambiguous signer from existing local release
artifacts during the first transition; builds to a unique output; asks before
installation; waits for safe shutdown; installs and reopens Mako; and removes
the output whether it installed, was declined or failed. It never
force-stops agents. `npm run update:local -- --check` is read-only, and
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
measures real Electron rendering and trusted input. Its agent-session cases
shape conversations like long agent work (few prompts, hundreds of tool calls
and answers each), time key-to-paint with Event Timing while a turn streams,
and assert that streaming reparses no unchanged prose and that switching keeps
at most three conversations loaded; `Input.insertText` returns on dispatch and
times nothing a person feels. `--file` checks production
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

`npm run perf:decoders` (the last step of `test:performance`) times each
harness's decode, host, projection, recorder, merge and saved-open paths,
and `test-performance-budgets.ts` the host's and window's live-path hot
paths, as multiples of a calibration workload; a kept row more than 25% over
its baseline (`scripts/perf-decoders-baseline.json`,
`scripts/performance-budgets.json`) is suspect. Load doesn't scale
every row alike: memory-heavy rows (the large merges, `cursor/host`) slow
more than the calibration, and under load macOS moves work onto the
efficiency cores, so at a load average of 6 to 8 unchanged code read 17 to
29% over on some rows and 12 to 17% under on others. A suspect row is
therefore measured again beside the commit its baseline names (`at`):
`perf-reference.ts` exports that commit with `git archive`, links `@mako/*`
to its own packages and everything else to this checkout's `node_modules`,
builds its sessions and host packages, and runs its script and this
checkout's in turns, three processes each, on this checkout's recordings; a
row still over after three gets four more each and is judged on all seven,
because macOS places a whole process on a performance or an efficiency core
and a memory-heavy row slows there more than the calibration (unchanged merge
code once read 30% apart on three unlucky draws).
A child's results are read from a file: a Node process that exits on an
uncaught error drops what it queued for a pipe on macOS. The row fails only if this checkout's median is more than 25%
over the reference's; the table prints with the load average and core count.
A passing run builds nothing. A reference that can't be built or has no such
row fails the row as before, with the reason. The rows read `@mako/*` from
`packages/*/dist`, so build the packages before measuring, or a run times
stale code. `--update` records `at` only on a committed tree, so it names
the code it measured; re-record a row only when its cost changed on purpose,
on an A/B (`--rows <keys> --ab`, or `--reference <commit>`), never on one
loaded run. CI's `performance` job measures every kept row beside the commit
a change goes onto (`perf:decoders -- --reference HEAD^1`), so a change that
slows a row fails at review, beside the code just before it. The budgets
alone don't: a baseline recorded long before, on older recordings, leaves
room for regressions to add up unnoticed on a quiet machine until a slower
one goes over and compares the row with that old commit. Devin's saved open
crossed at a person's update that way, +69% over its baseline's commit, from
two changes neither over budget: a subagent analysis on every read, and the
media `_meta` parses below. `npm run update:local` runs no `test:performance`; Settings >
Updates does, in a copy without `.git`, alongside `test:application` and
`test:renderer-assets`, and names its source in `MAKO_BUILD_SOURCE` for the
export. An installed app from before that variable doesn't pass it, so a copy
with neither reads the checkout `source.json` names beside it, which every
updater writes (`buildRepository`, `test-perf-reference.ts`); without it the
first update after the A/B landed failed on rows it couldn't measure. On a per-message path, a `WeakMap` entry per message cost the
recorder a tenth of its time in collection and an `AsyncLocalStorage.run`
per message a fifth of the host rows': carry a value on the object a caller
already passes (`RecordedLine`), and scope one for a synchronous call with
`SyncScope`. Six named helper closures built per call cost the window's
projection a fifth of its time, each a property definition under tsx
(`EntryDrawing` holds them as methods); a schema parse that fails on nearly
every message builds an `Error` each time (Grok's MCP startup read every
update that way, and the media a tool result states in `_meta` every call's
result: about 7 µs each, the decode and host rows' third or more; read such
a schema with `.optional().catch(undefined)`); work a read needs for only
some sessions runs only when what the read already holds says it applies
(Devin's subagent analysis reads the session's whole forest, and runs when
its chain calls `run_subagent` or its store heads a subagent); and a reference copied whole per update grows with its
stream (`joinedRanges` shares the ranges before the last). The full run
warms these paths with earlier rows, so measure a suspect row alone beside
its reference (`--rows … --ab`) before trusting that it held.

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

`packages/host/src/application/lifecycle.ts` owns pending install/restart
operations and the host's `Admission`, which refuses new prompts while it stops. Count native runs, live requests, queued work,
permission waits, startup, workspace operations, and background builds. A stale
Stop confirmation must never stop a newer turn. Ordinary Quit detaches the
client; explicit Stop closes managed agents and holds queued prompts.
`application/window-shutdown.ts` requires every affected window to acknowledge draft saving.
Do not close a window with failed draft persistence or interpret a missing
acknowledgement as consent.

Settings > Updates and the command palette share the same state actions.
Local builds use an explicitly selected trusted checkout and a private copy with
internal workspace links. Physical copies and cleanup must use
`physicalFiles()` (`packages/host/src/base/physical-files.ts`, Electron's
`original-fs` under Electron), not its ASAR-aware filesystem: dependency
archives must remain ordinary files. Exclude nested generated caches and local environment files;
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

A local build never takes the checkout on trust. Before anything is copied,
`local-update-source.ts` fetches the remote's default branch (15 s, no
credential prompts; offline is said and the last fetch is used) and reads the
checkout against it. Only a checkout on the branch that tracks it, behind it,
with no changes to tracked files, is fast-forwarded (`fastForward` in
`@mako/git`: `merge --ff-only --no-autostash` under the repository's write
queue, refused if HEAD moved since the reading); anything else (changes,
diverged, another branch, detached, no remote) is built as it is and the
reading says why. Nothing is stashed, no branch is switched, and untracked
files stay (Git refuses rather than overwrite one). A build that would carry
the installed, clean revision doesn't run: Settings says "You're already on
<rev>". The installed revision is the bundle's `makoBuild`; the available one
is the reading's upstream. Settings › Updates and `npm run update:local` say
it in the same words (`contracts/update-source-text.ts`), and what a build
brought (`build-changes.json`, keyed by build id) shows under the revision
once that build runs. A checkout 21 commits behind once built and installed
the revision already running, and the update read as done. `npm run
test:update-source` covers it against scratch repositories and a local bare
remote, and draws every state.

Then the checkout's node_modules must hold what its package-lock.json lists
(`local-update-dependencies.ts`: each lockfile entry against npm's
`node_modules/.package-lock.json`, by version; optional and peer entries
aside). When it doesn't, as after a fast-forward or a pull that changed the
lockfile, Settings (phase `installing`, "Installing dependencies…") and
`update:local` run `npm install --no-audit --no-fund --no-save` in the
checkout with the npm and Node the build uses, before anything is copied:
never `npm ci` (it deletes node_modules under whatever else reads it), and
`--no-save` so package.json and package-lock.json stay as Git has them. It's
refused while any package.json or package-lock.json has uncommitted
changes, stopped with its process group after 10 minutes, and every failure
ends with the command to run by hand. No dependency install script is
approved: the build needs none of the ones npm's `allowScripts` would hold
back, and `test-local-update-dependencies.mjs` (in `test:update-source`)
names each and fails when one arrives or leaves.

`npm run test:application` covers the lifecycle state machine, draft-close
acknowledgements, source-copy isolation, replacement rollback, real Electron
private-socket clients, and the production Settings/dialog/palette components.
Providers and installations are fixtures; these checks do not replace the user's
app or send provider prompts. `npm run test:application-ui` retains light/dark
screenshots and checks trusted input, safe focus, cancellation and reduced motion.
`test-draft-persistence.ts` also checks failed-save exit refusal and retry routing.

## Detached daemons and profile hosts

Two processes outlive the host on purpose: the terminal daemon
(`packages/host/src/terminals/daemon.ts`, one per profile) and the session sync daemon
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
its main thread: `packages/host/src/threads/catalog-worker.ts` runs the catalog on a
`worker_threads` Worker that serves the daemon's own frame protocol
(`serveCatalogOnPort`) over a `MessageChannel` port transferred in with the
worker data, and `threads/catalog.ts` adopts it exactly as it adopts the daemon
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

`SessionCatalog.open` keeps translated threads warm within count and native-byte
budgets defined in `catalog.ts`, and a
write invalidates only what it can have changed: a per-file store drops its
own path, a shared database (`rescanRoot`) drops that provider's threads and
no other's. Before this the cache was one entry that any rescan cleared, so
Cursor Desktop writing `state.vscdb` on every keystroke made every open of
the Codex thread on screen re-read a 3.7 GB tail (135 ms, on every reopen and
every preview). `packages/sessions/test/streaming-correctness.mjs` covers the
scoping and the bound; `test/daemon.mjs` covers the port transport, including
a port transferred into a real worker.

Directory notifications can silently stop arriving. Followed sessions therefore
share file-stat subscriptions, with provider-owned `observationPaths` for WALs,
metadata and synthetic database locators. Keep these subscriptions scoped to
viewers, release them with the last viewer, and drain in-flight observation
before closing provider resources. `test/observation-lifecycle.mjs` exercises
delivery without directory events and cleanup; the native provider tests
verify their source mappings. Periodic discovery also runs every 30 seconds,
shares overlapping sweeps and refreshes missing/configured root subscriptions;
`test/discovery-lifecycle.mjs` verifies new sessions without directory events.
A rejected discovery must preserve known sessions, not declare an empty store.

launchd is consulted through `launchctl print`, never through the exit code
of `bootstrap` or `bootout`: a bootstrap that loads the job has returned an
I/O error, and deleting the plist on that verdict once left a job running for
three days with no definition and no host able to see it. A loaded job with no
plist is booted out by the installed app.

A profile host (dev, sandbox, test) stops itself 15 seconds after nothing
holds it: no client, no lifecycle work and no launcher lease (`host-idle.ts`;
the dev launcher holds a pid-keyed lease beside the host socket). Its
`host.log` records what holds it each time that changes (`lifecycle idle
watch holds=…`). The installed
app's default-profile host never does. Every host removes its runtime
directory on exit but the leases a live launcher holds there, which hold the
profile's next host after a restart, and a new host removes driver sockets whose owner is dead.
Retained previous applications are pruned after a verified, launched install:
only the newest backup survives, and only staging directories holding nothing
but a backup and its installer script are removed, under the install lock.
`updates/build-*` directories are removed when `LocalUpdates` loads: the
prepared build is copied into `/Applications` before the host quits and its
state lives only in that host, so every one an earlier host left is dead
weight (four held 3.4 GB). `test-host-idle.ts`, `test-local-update-install.ts`
and `test-local-build-source.ts` cover these.
