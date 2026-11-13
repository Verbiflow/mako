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
A `mako-host` command that took the lock to read (a `join` ending, a `status`
of an older build) is waited out, `CLI_HOLD_MS` at most, unless something
answers on the host's socket, which is a host and refuses at once; `status`
itself takes no lock (`device-cli.ts`), since a reading must never turn a
starting host away, as one polled with `status` inside a container did.
`createHost(config, owner)` in `create-host.ts` is the host. Its `start()` opens
each domain in `electron/domains/` in dependency order, declares every method,
then listens on the socket; its `stop()` releases everything in one fixed
order. Before draining host calls, `HostStopping` cancels outside work: the
owners registered together in `core.ts`, provider children, commands and
HTTP requests (including response bodies). Keep local commits and stores
open through that drain. Register new outside waiters with that scope. Start commands through
`hostCommand`/`hostExecFile`, streaming children through `hostSpawn`, and
IPC children through `hostFork`. These runners and provider launches own isolated
process groups on macOS and Linux. They keep their stop registration until
cleanup confirms no live group member remains, even after the parent exits.
Deliberate daemon, app, installer and editor handoffs keep their independent
lifetimes at the named launch exceptions. `check-host-children.mjs` (in lint) rejects
raw Node process starts in the host and every local package it references,
except its documented owner and handoff boundaries. Git's commands and object
reader use one independent process runner; `hostGit` injects the host's scoped
adapter, and `Git.close()` joins child cleanup. A write to what a repository's
checkouts share (its refs, its worktrees, its configuration: `writesShared`)
waits for the writes asked for before it in that repository, keyed by the
folder they share (`commonDirOf`), so Mako's own writes (a spare being made, a
Thread's branch made or deleted) never meet at a lock; network commands,
those that run hooks or rewrite files (`commit`, `merge`, `stash`, a `checkout` of an existing branch) stay out of
that turn (a worktree is added `--no-checkout` in it, then filled and its post-checkout hook run as `worktree add` runs it, `fillWorktree`), and a
write that waits past `WRITE_TURN_WAIT_MS` fails naming what held it. Every
non-read command waits out a ref lock another program holds
(`REF_LOCK_WAIT`, 3 s), and a failed write is logged with Git's own words.
`test:git` and `test-worktree-writes.ts` hold it. `HostStopping.run` also binds
the control-runtime and sessions adapters per async context, so package code
cannot start an unregistered child under a host call. Standalone workers keep
their own lifetime; no process adapter is changed globally. UTF-8 buffered
commands follow Node's decoded-string slicing at `maxBuffer` overflow;
borrowed SDK checks cancel their operation without taking the client's
ownership. An unfinished login reports that Mako quit and asks for a new
sign-in; a saved result stays saved (`test:stop-provider-checks`). A stop still running at 2 s and 10 s logs
`stopping is slow` with its step and the named work open. A host that can't start says why on stderr and in `host.log`, stops
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
- **A held loop says what held it.** `loop event loop held` names every piece
  of work open at a hold, most of it waiting on a process or a reply; a hold
  of a second or more starts a 10-second profile of the host's own thread
  (`HeldLoopProfiler`, at most one per 10 minutes), logged as `held loop
  profiled` with its longest slices by the host's own functions. On a day of
  many Fins the log blamed worktree summaries and live reads while Git
  spawns held the thread. `npm run bench:host-load` runs a real host on a
  world of that day's size (52 Threads' worktrees, 95 apps, Fins editing,
  building and writing transcripts, three windows polling). A shared
  runner's speed varies by several times between runs, so its limits are
  calibrated in the same run by a yardstick process timed beside the host;
  it fails only on a clear regression (a loop held for seconds, or several
  times the yardstick's waits), never on a fixed number of milliseconds, and
  writes every number to the job's summary. CI runs it as `host-load`.
- **Follow, don't poll.** What only says where something stands (a line a
  window shows) reads what each owner already holds, and is woken by the
  owner's own change (its event or callback). That read never sets off the
  work it reports (a sign-in check, a harness's store, a network call). What
  says nothing as it changes gets a slow job that `needs` a demand on only
  while it's under way, and looks only while a window watches
  (`CloudTurnOnFollower`).
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
`backgroundStop` says. On a harness whose `backgroundStop` is
`ends-with-turn` (Cursor) the host ends what the roster still shows at work
when its turn ends, as the turn ended (stopped, failed, or unknown for a
turn that finished), and heals a journal a build before saved that way
when it reads it (`endedTurnsOnRead`); `test-roster-turn-ends.ts` replays
ten Cursor subagents over a stopped and a failed turn and a restart. A roster entry's progress shares the frame's flush;
its start and end flush at once. `npm run test:background-work` replays
Claude's captured messages and covers the state, the ranking and the
conflation; Settings > Diagnostics lists each session's background work with
its sources.

Glossary: a Thread that starts others is an **Apex**, and each one it
started or took is a **Fin** (`APEX_WORD`, `FIN_WORD`); there is no word for
the group. Data structures still say parent and child (`thread_parents`,
`ChildState`), and the wire keeps `"lead"` for the role and for a question
the Apex answers (`APEX_ROLE`, `blocked.on`), so builds on either side of the
names read each other.

A Fin's edge is the record (`thread_parents`, `contracts/agents.ts`), on its
`ThreadRef.parent`, so `threadList` lists it under its Apex and never as a
Thread of its own (`listedAsThread`), while its copy and originals still
sync right after its parent's (`uploadScope`). How a Fin stands is computed,
never stored (`childState(edge, thread, journal)`). `Agents`
(`conversations/agents.ts`) starts, follows, delivers and ends them; each
verb is defined once in `contracts/agent-tools.ts` as `mako:agents-<verb>`
(start, move, link, list, read, report, stop, wait), its schema generated from the
handler, and reaches the agent three ways from the one projection
(`conversations/agent-tools.ts`): the in-Thread `mako` server, `mako agents
<verb>` and `mako mcp`, the caller named by `MAKO_SESSION_ID`. A start
commits the Fin's Thread, its edge, its Session and its first request (the
brief, the Apex's words, not the person's) together
(`LiveStartOptions.parent`), at an access tier no higher than its Apex's.
A harness with no mode at or below the tier asked (Cursor's one mode is
full) sends a Fin that named no harness, model or rule to the person's next
harness that offers it, and otherwise runs it on the harness's nearest mode
within its Apex's own (`fitAccess`, `modeWithin`), the start's note saying
which; only a mode wider than the Apex's is refused. It starts
here, or on another of the person's devices (`place: device:<name>`,
below); `cloud` is refused for now. It never waits unasked:
past its place's bound or a tree's running budget, a start is refused with
the count unless it passes `queue: true`, when it waits behind every spawn
that waits for that place ("Queued: 3 ahead, your limit of Fins at once is
in use"). Each place has its own bound (`placeFull`). A device runs its
capacity (`fin-capacity.ts`): its cores and memory, less a reserve for the
person (a seventh of the cores and a fifth of memory where they work at it,
less on a headless box), less room for a few builds, divided by what a Fin
costs there, its light cores and memory outside builds, learned per harness
on that machine (`FinCostModel`, 75th percentiles moving over days, priors
from 2026-11-03: 0.35 core, 0.8 GB, builds 6 cores and 3 GB). That is 17 on
a 14-core, 36 GB Mac, 2 on a 2 vCPU 8 GB box, and at most `DEVICE_CEILING`
(64). `CapacityGovernor` lowers it only under pressure that holds (memory
pressure or swap, heat, the person's own work, disk; a 5-minute average,
held 3 minutes, then a Fin a minute, never below half) and brings it back
after relief holds 5 minutes; running Fins are never touched. A machine's
work is CPU time really spent since the last reading (`coresBusy`), never the
load average, and the person's own work, the busy cores the Fins' own
processes weren't measured to take, presses only while it leaves fewer idle
cores than their reserve: on 2026-11-05 six short `git status` at a time
held this 14-core Mac's load at 18 with 5 cores idle. Every check run holds
one of the builds capacity keeps room for (`BuildSlots`), first come first
served. A check that finishes frees its slot once its tree is gone, and its
detached children are left alone: nobody asked for its build daemon to die,
and what such a daemon takes shows only in busy cores. A check that's stopped
frees its slot once its tree and every child its mark finds or a look saw are
gone (`untilGone`, `strays`), and one that outlives SIGKILL keeps the slot
while a waiting check says so. What a stop has seen is kept beside the run's
record (`<key>.stopping`), so the next host counts it and goes on with the stop. A check the last host left holds its slot by
those same two rules, and finding it ends nothing. It's counted before any
slot goes out, and a read of it that fails holds them all (`recoverSlots`). The person
can fix a number per device instead of Auto (Settings › Fins), and
`FinCapacity` reads the machine on the engine's 10 s tick. The cloud, a
machine per Fin, is bounded by the plan and the daily spend ceiling only
(`cloudCapacity`, `AgentsDeps.cloudLimits`), for when placement lands. Over
every place the person's ceiling (`FIN_CEILING`, 64) is a safety net, and a
tree's running budget (32) caps one Apex's fan-out. A refused start names
the places a start may name that have room. This Mac's load also shows in
the start's answer when it's busy (`macLoad`, `mac`) beside the device's
number (`atOnce`). `MAKO_FIN_SLOTS` fixes the number, as a test's host does.
What waits goes the moment a place frees, by event, never a timer: a Fin
that stops holding one (its turn ended, it stopped, failed, was archived or
waits on its own Fins) or a place whose number rose (`capacityChanged`)
starts the first waiter that fits, first come first started, one whose
`after` isn't done passed over. Every start is one record per Apex and
client key (`StartRecord`), made before its call awaits anything: the same
key again joins it, and the record alone holds its name, its place and its
stop until it settles; a stop marks it, and `mako:live-start` writes no
edge for a stopped one (`test:start-interleavings` generates schedules of
starts, stops, preparations and crashes against it). Each queued start launches on its own, so
a harness slow to come up holds its place, never the queue; a freed place
is taken within a few milliseconds (`test:background-agents`). One a
Thread's shell ran is followed through its own Session in the catalog and
its process (`agent-runs.ts`, at most `TAIL_READS_PER_SECOND` tail reads
across the host), its end written once. Linking it again with another pid
follows it there, and the link's name is its Thread's title. When its
process goes, a process of its Apex's shell holding its Session is the same
run (a chat resumed to hand it a message), and otherwise its end waits until
its Session has been quiet for `END_CONFIRM_MS`. A run whose Session is
written again after its end reads as working while that Session is still
being written, and a digest drops the end the host inferred for it
(`AgentWakes.current`). A stop closes the edge with
its reason (`closedReason`) before it cancels the turn. The cut turn then reports
nothing and wakes no one, and the Fin reads as stopped in those words. A
stop is a pause: a message from its Apex (`agents_send`, the person's
`direct`) or the person writing in its own Thread opens the delegation again
(`ThreadStore.reopenEdge`, `ThreadParent.resumed`) in the same Session, and
a stopped or failed Fin reads beneath that message when and why it stopped
and what moved since (`finResumedText`): its checkout (`checkoutSince`) and
its branch against the one it goes into, with commits landed there touching
its files (`branchSince`). Its turns report and wake the Apex again, and a
repeat of the message resumes it once. Archiving its Thread is the one
end: one at work stops in those words, once (`Agents.archived`), and
nothing resumes it until the person restores it (`test:fin-resume`). A
stop also pauses what was queued for the Fin (`halt`), and a stop of one
stopped already ends whatever still runs there. A paused message first in
line holds the ones behind it (the person editing it keeps its place), and
nobody presses Resume on a Fin's queue, so a message that reaches a Fin
sends on what its stop or an exit paused behind it (`resumeFin`), never
one the person paused to edit (`LiveRequest.editing`); a stopped
Fin that is an Apex hears its own Fins' digests only then (`ready`). A Fin
reads working only from `LiveConversations.atWork`: a turn running, a
message being sent, or the next in line (`nextQueued`) about to go, never a
message nothing will send; a stopped Fin never reads working, and only
working Fins hold room against the Mac and the tree (`test:fin-states`). A
Fin's harness asking (`askApex`) wakes its Apex, told whether it may
answer, and so does its agent asking through Mako's tools (an `AgentAsk`, kept
in its conversation and read as a pending approval, `LiveAsks.pending`, which
`agents_answer` and the person answer through `LiveConversations.permission`):
an approval under an Apex below full access is the person's at once, and the Apex hears so in the digest's "waits on the person" (`Report.told`).
One the Apex may answer that it leaves for `APEX_ANSWER_MS` (a minute) goes
to the person too (`escalate`), as an Apex mid-turn on a harness that hears
a digest only at its turn's end would leave it; the Apex hears they were
asked, and the first answer is the one the Fin hears. A digest drops an ask
its Fin no longer waits on (`test:orch-answer`). A report says how the work
went and, separately, who must act: a `done` report may ask the question a
`needs-input` one does (its options, the one it recommends, `action`), with
`decides` (`apex`, the default, or `person`). Its Fin reads as done with that
decision open (`ChildState`'s `ended.decision`: its question, `on` and the
same `FinAsk`), never as blocked; `decisionOn` says whose it is: the person's
when the Fin said so, when its Apex left it to them, or when its spawn's
`wake` isn't `decisions`. Its result wakes the Apex as any done report does,
its line in the digest, the front door and the `apexes` digest one
(`decisionWords`: "done; decide: Merge #371? (Merge · Leave open, recommends
Merge)"). One its Apex leaves for `APEX_ANSWER_MS` goes to the person too, as
a done report of the same decision (`escalateDecision`, on `AgentsDeps.later`,
which a test fakes). The person's counts under needs you (`childGroup`) and
reads "Done · needs you: <question>" (`askWords`) wherever asks are answered
(`openAsk`, `personAsks`); the Apex's counts as done. An answer claims the
question before it's delivered, so of two at once (its Apex's and the
person's) one reaches the Fin and the other is refused as answered; a
delivery that fails lets go of it. The claim is the store's
(`agent_answers`, `ThreadStore.claimAnswer`), kept with the request its
message goes as before any delivery, so a restarted host still holds the
decision answered and sends an answer it never delivered once, under that
request (`undeliveredAnswers`), and a repeat of the same answer, in flight
or after, gets that answer's result. An answer settles exactly the ask it
names (`ChildJournal.answered.ask`), never another by the clock: a newer
question is open even in the same millisecond. A delivery that reached the
Fin but couldn't be stamped stays pending, and the next start finds it under
its request and stamps it. The answer is the Fin's next message, and
until its next report its row says who answered (`working.answered`). `test:fin-decisions` holds the matrix,
`test:fin-decision-ui` the surfaces (`?mock&app=apex&fins=decisions`).
"Needs you" is never the whole of it: a Fin's rail row says what it waits on
under its name (`askWords`, else `childLine`), its tab's tip says it, and the
Fin opened from that row draws its ask with its answers above its own composer
(`FinAsks`, read from its Apex's roster and answered through the Apex), or a
line saying on what when nothing there can answer it; an approval its own
conversation holds keeps that conversation's one card. `test:needs-you-ui`
holds it at a 1352 × 847 desk window.
New explicit report questions carry `retainsQuestion`: later narration,
notice delivery, and reads do not resolve them. `ThreadStore.openReportAsks`
derives pending questions from report IDs, exact answer claims and explicit
`supersedes` IDs. Legacy rows keep their prior latest-report semantics; never
invent outstanding work from every old unclaimed question. `agents_read`
returns eight pending IDs per page (`afterAsk`), `agents_list` gives counts,
and every Apex dispatch, including autonomous continuations, gets a bounded
pending view. `agents_answer` accepts `ask`, required when several remain;
its receipt names that decision, not completion of the requested review.
`personAsk` also keeps person-owned retained questions reachable after narration.
A Fin may withdraw/replace its own question IDs with `supersedes` and a reason
in summary; progress remains quiet. Existing escalation keeps the question's
original due time across narration/restart and explicitly hands off ownership.
Placed-Fin exact selection is refused until receiver capability is verified.
Ordinary readiness prose still needs an explicit question/action handoff.
`test-fin-obligations.ts`, run by `test:orch-answer`, covers the burst boundary.
A report may name what it waits on outside its tree
(`waitingOn`: a pull request until its checks, review or merge, the person,
or `other` in a few words), carried on the blocked state and the open
decision and said as "waiting on #412 checks" (`waitingWords`) in the digest,
the front door and the strip. A progress report that names it, with the
Fin's turn ended, reads as idle waiting since the report (`ChildState`'s
`idle.waitingOn`, `since`), in the crew row, the strip and the front door
as "Waiting on acme/app#371 checks · 12m" (`waitingStateWords`); the
orchestration text tells a Fin to report so and end its turn rather than
poll checks. The report result's `subscriptions` distinguishes a registered
PR watch, an outcome already claimed for delivery, an inactive old wait,
unsupported prose, and a host with no reader. `person` and `other` only
record intent; Actions runs and main-commit CI have no automatic watch here.
An unsupported or unavailable receipt needs a verified external notification
or an explicit outcome owner. Run/job/commit references stay as reported,
including across restarts; no text or artifact is parsed into a watch.
`PullWatch` (`conversations/pull-watch.ts`) reads only the pull
requests open Fins' latest reports name, rebuilt from the stored reports on
each tick and so on start, through `readPull` (the same `gh pr view` and
check normalising `pull_request_status` uses), on the job `read the pull
requests Fins wait on`, which runs only while something is watched: each
read a minute after it's first watched, doubling while unchanged up to
`PULL_WATCH_MAX_MS` (8 min), a minute again once it changes. A reading's
outcome (`pullOutcome`, `contracts/pull-waits.ts`) matched to `until`
(current-head checks settled, or one failed while others run, even before
the report; a review submitted since, by anyone but the author; merged or
closed, which end any wait) is claimed once per Fin, retained dependency and observation
(`ThreadStore.claimPullWake`, `agent_pull_wakes`) and delivered to the Fin,
never its Apex, through `deliver` under a named request as Mako's words
(the `pull-watch` service actor): one line, "Mako: PR acme/app#371 checks
settled: 2 failed (lint, e2e). <url>" (`pullWakeNote`), queued after a
working Fin's turn, never steered. The reader also preserves `headRefOid` as
`PullReading.head`; the wake and transcript event name that observed head.
The wait follows the PR's current head when read, rather than pinning a commit.
A queued note remains an observation of that head; it grants no authority to
merge a later head, which must be verified at the action gate. Consecutive
reports retaining the same PR and condition share their first registration
(`pullWaitReports`), separately from narration timestamps. A head/check
completion cursor keys the existing durable outcome claim, so clarification
reports neither cancel queued outcomes nor re-fire unchanged terminal results.
A changed head or completion cursor can produce a new observation; withdrawal,
a failed report or a changed condition ends the registration. Legacy claims
without a cursor retain their original identity; the receipt explains that
re-arming one requires withdrawing and re-registering. Already retired legacy
claims can regenerate under the current registration. It never reopens, resumes or takes over
a stopped Fin (`deliver`'s automatic send), and goes through the one
admission point every prompt does, the handoff with its Stop latch
(`LiveDispatch`, #391): there `Agents.admits` reads the wait again, the
Fin's newest report still retaining the original dependency and condition,
without an intervening withdrawal, and its delegation open. One that no longer
holds is refused (`HandoffRefused`'s
`withdrawn`, the request canceled) and its claim retired as obsolete
(`retirePullWake`), never sent. The same reading runs before the claim and
before delivery. A host that stopped first sends a claim once on start
(`undeliveredPullWakes`), if its wait still holds. The Fin's transcript
draws it as an event line by its words (`pullWakeWords`, `MakoPrompt`'s
`pull`). A note an exit or a crash left held, proven unsent, is Mako's, so the
next host sends it on through that same handoff, keeping a Stop's mark. "Newest
report" means the store's order of taking them (`rowid`), since `at` can tie.
`test:fin-pull-waits` covers it with a stub reader and a fake clock, and a real
SIGKILL with the note prepared on each harness (`test-fin-pull-wake-crash.ts`).
A Fin's strip, its crew
mates' view and the `apexes` digest say how long it has been idle
(`idleFor`, seconds, only while it isn't working) and its open pull requests
(`openPRs`, `finPullRequests`): its worktree branch's as the worktree
summaries last read them (`ThreadWorktreeService.heldPulls`) and those its
reports name, with no read of GitHub of their own. A pull request is its
repository's (`owner/name`, from its URL) and number (`pullRef`, `pullKey`),
never its number alone, since a Thread can hold several repositories; a bare
`#12` is the Fin's one repository's, or stays unqualified when it has several,
and a line names the repository only when two could be confused. A Fin
that ends a turn without `agents_report` while its own Fins work, or while a
`worktree_move` it asked for is pending (`movePending`), hasn't finished.
Its turn's end writes no report, and it reads as working with "Waiting for
…" (`waitsOn`). Its result is the turn after that work ends: the one its
Fins' reports wake, or, with nothing to wake it, that turn's reply
(`checkAwaiting`). A message to it
(`agents_send`, `takeOver`) stops the run, resumes its Session in the Fin's
Thread on Mako's live driver at no more than its Apex's access, and arrives
with `HANDED_OVER_NOTE` saying its last step may have been cut. From then on
Mako drives it. What a Fin runs on is decided once, at admission
(`resolveFinTuning`, `contracts/fin-tuning.ts`): a `model`, `reasoning` or
`fast` the spawn names is held to its harness's catalog, read leniently, and
refused (`unknown-model`) with the choices it offers; left out, the person's
Settings › Fins choice for that harness, else its Apex's model and options on
the Apex's harness (never its plan mode), else the model the person last
started or sent with there, else Mako's pick (`HarnessDefaults.work`), else
the harness's own. A layer whose model the harness stopped listing is passed
over in a note its Apex and its row both show (`ThreadParent.tuned`). Fast is
the model's speed option, or its fast sibling where the harness lists one as
a model (Grok, Devin). The host keeps the choices and what the person used in
`<user root>/fin-defaults.json` (`mako:fin-defaults`), so the web app reads
them through the Mac, and a Fin's row says its model, reasoning and fast lane
(`NativeAgent.runsOn`). A harness whose account in use is at its limit
(`HarnessAccounts.limited`, read for at most `LIMIT_READ_MS`) takes no Fin:
one whose Apex named no harness or model starts on the person's next harness
with room (`harnessOrder`), its answer's `limited` and its row's note saying
until when and which other account of that harness has room; a named one,
or one with nowhere to go, is refused (`limited`) with the same. That is the
rule with Settings › Fins' one switch, "When an account runs out, continue on
the next one" (`FinChoicesReading.moveOnLimit`), off. On, the default, a Fin
goes on at the first step of one harness-blind order with room
(`fallbackOrder`, `contracts/fin-fallback.ts`, read by `FinMoves`): the
person's other accounts of its harness in their order
(`HarnessAccounts.standing`; an unread one is never taken), keeping harness
and model; their model connections its harness's routes take for its model's
family (`ModelRouteAdapter.model` names the model as the harness lists it);
then their next harness that fits its access and has room. At a start it
applies whether or not the harness was named, and a named model keeps the
refusal. Another account runs only that Fin's launches
(`ProviderStartOptions.pinnedAccount`, from its binding's `account`),
never the person's selection, and admission checks the pin before each input
as it checks a selection. Mid-run, what waits out the limit (#391's held
request with its `retry`: the continuation of a turn the limit cut, or a
message the harness refused) moves instead, when the harness's own marker
(`TurnReply.limit`) or the account's reading says it's a limit: the move takes
that very request over through `continueOn`, first with the move's words on it,
yielding to a Stop (`unlessStopped`), and handOff guards its send as every
send's. What it was decided on (`stillDecided`: the Fin open and not released,
this host's claim on the same wait) is read at admission and again before
commit; when that or the request's state (a Stop's latch, `pause`) no longer
holds, the move is retired in the store and nothing says it moved. An Apex with
Fins open moves the same way, whatever waits, its person's message included, and
what stood idle on that account goes with the tree; a Fin that finished stays
until a message finds it. A Thread with no Fins is the person's: one card offers
the next place (`Agents.nextPlace`). It goes
on in the same session on another account where its driver declares
`accountContinuation` `resumes` (Claude; `test-harness-definitions.ts`
requires every harness to declare it), on a connection's model, or by a
hand-off to the next harness, each told where it stopped and what moved in
its checkout since (`finMovedText`). The logical turn's places, the waits it
moved for and the host generation taking a move are the store's (`fin_moves`,
`FinTurn`, cleared when a turn ends without a limit), so a restart never sends
it back to a place it ran on; with every step at its limit or run on, the Fin
stops, its row saying "Out of accounts: personal and work are at their limits
until …" (`outOfAccountsLine`). A turn the person sent in the Fin's Thread, or
a run Mako doesn't drive, never moves.
Its row and strip say "Moved to Claude (work): personal is at its limit until
…" (`child.moved`, `movedLine`), its transcript has the line, and its Apex's
next digest says it once without being woken for it (`test:fin-fallback`). The person's rules for Fins (`FinPolicy`,
Settings › Fins: their own words, each to a harness and maybe a model, first
fit wins, and where the rest go) reach every Thread's agent ahead of the
person's next message once they change (`finPolicyNote`, `rulesNote`), and
an Apex of its own with its brief. `agents_start`'s `rule` names the one a
Fin follows: its harness and model apply unless the spawn names them (a
model only on the rule's own harness), a spawn with no rule, harness or
model goes to `otherwise`, a missing rule is refused (`unknown-rule`), and
the Fin's row and strip say the rule (`ThreadParent.tuned.rule`). Beside
them the person keeps standing rules in their own words for every Fin and
every Apex (`forFins`, `forApexes`, at most `ROLE_RULES_CHARS`; empty is
none, and then briefs and notes are byte for byte as before). Each is saved
alone (`mako:fin-role-rules-save`), and every save of the Fin-defaults file
keeps what it doesn't name, a newer build's fields included. They're standing
lines of Mako's note (`roleRuleLines`, merged with the host's own in
`LiveDispatch`): a Fin reads the Fin rules, and a top-level Thread, an Apex
or a Fin started as one the Apex rules, each whole on a process's first
prompt, a Fin's being its brief's, then only when they change, whoever's
message starts the turn (`standingLines`). A request keeps which rule lines
its prompt carried (`LiveRequest.ruleLines`), so a conversation that read
rules the person cleared is told they no longer apply, in every later process
too. Settings › Fins on the desk and the phone (`web-client/fins.tsx`)
edits both through the same calls and previews only what each adds to the
note, from the same functions (`roleRulesPreview`); `npm run test:person-rules` covers it. A worktree in a project folder of several
repositories can be on a branch it names, adopted in each repository that
has it and made from the newest start in the rest. A report (`agents_report`, else one
implicit report at a turn's end) sends its Apex a notice; an idle Apex waits
`WAKE_COALESCE_MS` and takes ONE turn with the digest, a busy one gets it at
its next step where its harness steers there and at its turn's end where it
doesn't, at most `WAKES_PER_MINUTE` an Apex (`agent-wakes.ts`): the Apex
never polls. A steer the harness doesn't take goes as the Apex's next turn,
never dropped. The digest is an entry in the Apex's own queue
(`LiveRequest.digest`), its reports heard once it's there, so the queue
keeps it through a crash, sends it once and retries it as any message: a
burst's window is a hold until its time (`RequestWake.after` is
`DIGEST_WAITS`), a notice joins the newest digest still unsent
(`LiveConversations.rewriteWaiting`), a stopped Fin's digest is paused for
its resume, and a withdrawn notice or one no longer current leaves whichever
unsent digest has it (`AgentWakes.withdraw`, `refresh`). A digest in the
queue is its notices' receipt (`carried`): a host killed between the
digest, its claim in the store and the store's receipt re-notices the
report on its start and finds it carried, so it's sent once. The minute's
budget is the queue's, kept as it sends (`LiveDispatch.overBudget`, from
`LiveRequest.digest.sentAt`). A journal the timer can't write fails its own
conversation alone, runs storage recovery, and is tried again; the timer
always arms for what's next. Nothing of it lives only in memory but a steer
unanswered (`test:wake-queue`). Each start sets its `mode` and `wake` (on the edge's
`asked`), and `reportRoute` is where its reports go: `background` returns at
once, `wait` holds the call at most `WAIT_LIMIT_MS` (half the 60 s Cursor's
MCP client and the MCP default give a tool call) for the result or a
question, then answers `pending`; a timeout never stops the Fin, and the
result it waited for starts the Apex's next turn, never steered
(`settledOnly`, after `RESULT_COALESCE_MS`), in full. `wake: decisions` (the
default) wakes the Apex for results and questions, `finish` for results
only, `never` for none unless it waited; a question its Apex doesn't hear is
the person's, never dropped. A Fin's turn an exit or an update cut short
always continues in the next host (`LeftTurn.always`), and its messages the
exit paused go on. So does an Apex's own turn while it has open Fins
(`inTree`, `continueCrashed`), under the same loop guard. The next host reads
every journal that resume looks at in first, one at a time and a slice at a
time (`Agents.resumeInSlices`, `LiveConversations.readIn`): read whole, a
day's Fins held its loop 4.8 s as it started (`test:resume-holds`). Reading
one in commits the restart's changes, the first frame into a WAL its last
host closed, whose header SQLite syncs even at `synchronous=NORMAL`: 100 to
300 ms on a busy disk, on the host's thread, until a worker wrote it first
(`WalPrimer`). A crash's
cut reads as `uncertain`. A Fin's cut turn that nothing picks up within
`STRANDED_AFTER_MS` (`strandedTurn`) becomes a question for its Apex
(`reportCut`). That covers the loop guard being spent, a sign-out, a reason
Mako doesn't continue, and a continuation that was dropped. The question says
what cut it (`CUT_BY`), why it isn't going on, and what it had in flight. A
followed run whose process ended unexplained asks the same way, naming a quit,
crash or shutdown when no host saw it alive. The Apex answers with one
`agents_answer`: `Continue` continues the turn, or resumes a run's session
here, through the resume path a stopped Fin takes; `Stop` pauses it; other
words go to the Fin as its next message. Beneath its words, a continuation
Mako sends for a Fin or an Apex carries the account a resumed Fin reads
(`finResumedText` with `how: "cut"`, `cutAccount`). That account says when and
what cut the turn, what moved in its checkout since, and where its branch
stands. `savedContinuation` still reads it as a continuation. A message to
a Fin whose session is reopening waits for that to settle (`switchSettled`).
`test:orch-recovery` kills hosts to show each of these. Fins are roster entries (`childEntry` under
`CHILDREN_BINDING`, `withChildren`) built from the store, never saved in a
journal. `npm run test:background-agents` covers the engine,
`test:agents-doors` the three doors, `test:agents-migrate` migration 6 from
#286's `background_agents`, `test:orch-update` an update mid-tree,
`test:agents-wake` every mode and wake setting, and `bench:agents-follow`,
`bench:orch-wake`, `bench:orch-wake-latency`, `bench:orch-spawn` and
`bench:orch-host` hold the follow, the wakes, a report's way to its Apex, a
spawn's receipt and the host's loop to budgets.

A Fin can run on another of the person's devices: `agents_start` with
`place: device:<name>` (`conversations/agent-places.ts`). The name is
resolved among the account's devices that run Threads, whatever its case;
none or several of that name is refused with the names there are, and this
device's own name is `here`. The Apex's host asks the device what it offers
(`mako:agents-capabilities`: the version of placement it speaks, its slots
used of how many, its harnesses; a stand-in for the runtime link's
`advertise` frame, whose `slots` these are, until that lands and the probe
carries the harnesses and the version too) and refuses with why when it isn't
connected (`place-unavailable`), when its Mako has no such call or speaks
another version (`unsupported`), or when it lacks the harness. Admission is
a start's here, against that place's room by the device's own word
(`awayFull`): full, it's refused with the count, or with `queue: true` waits
on the Apex's device and is asked again on the room watch and when a Fin
there reports. Then one call, `mako:agents-place`, settled there by the
Apex's own op (`start:{apexSession}:{clientKey}`), carries the brief, the
harness and model asked, the most access it may have, the Git remote of the
Apex's folder (a folder with none is refused) and the Apex as its parent.
The start is recorded on the Apex's device before the call goes
(`agent_placings`, a table a build from before placement never reads, so
such a build sharing the store neither starts it here nor drops it) and its
row goes once the Apex's record of the Fin is written. A call whose answer
is lost, or a host that dies with it under way, leaves the row: the start
answers `queued`, and is asked again under its op once the device says what
it offers, or at the Fin's first notice, and finds the Fin already there.
The device starts it as it starts its own (`Agents.place`, then `admit`):
at most at the Apex's access and the device's ceiling for Fins started
elsewhere (`PLACED_CEILING`, auto), in a worktree of its checkout of that
remote (`PlacedCheckouts`: a clone under `<user root>/projects` or a folder
its Threads work in, matched by `remoteKey`, cloned when it has none), its
edge naming its Apex there (`ThreadParent.remote`). The Apex's device keeps
where it put it (`ThreadParent.placed`, an edge whose child Thread has no
Session here; `ThreadStore.keepEdge` keeps a row for the far end of either
edge), so the Fin is in its Apex's roster and tree as any. Its reports stay
in its own device's store until the Apex's device takes them: each goes as
`mako:agents-notice` (`notice:{child}:{reportId}`, the report with its
`ownerGeneration`) to that device's runtime, is kept there once by its ID (a
repeat is `deduped`, a stale owner's is refused) and wakes the Apex through
the same digest as a Fin's here (`noticeOf`). One that isn't taken is tried
again after 5 s, doubling to 5 minutes, on a job that runs only while one
waits; it never expires, so a device away for weeks takes them when it's
back. The Apex's device tells its places it's back when its runtime's link
opens and when its host starts (`knock`), and a place that hears from it
sends at once. `agents_list`, `agents_read`, `agents_send`,
`agents_answer`, `agents_stop` and `agents_move` on a placed Fin are the
same host calls on its device with the Apex as their caller (`ApexCaller`);
a device that can't be reached is said, and list and read fall back to what
it last sent. A Stop always wins. Before a start's call leaves, its row says
so (`QueuedStart.away.sent`): from then whether a Fin runs there is that
device's to say, whatever became of the answer. A Stop of such a start is
kept on the row (`away.stop`) and sent as `mako:agents-cancel`, by the
start's op: the device keeps the stop first (`agent_cancels`), so the start
is refused there whenever it arrives, then stops the Fin if the start made
one and answers it, and only that answer retires the row; the Apex's device
keeps the Fin it then hears of, stopped. A device that can't be reached
leaves the stop where it is: `agents_stop` answers `pending` with why and
never `stopped`, and the stop goes again on the room watch, when the device
is next heard from and when this host starts. A Stop of a placed Fin that
has its edge is kept the same way on the edge (`Placed.stop`) until its
device answers or its Apex sends it on. Whether a placed Fin is at work is
kept on its Apex's edge too (`Placed.working`), never in memory, so a host
that restarts still counts it against its tree: its start, and each message
and answer that reaches it, set it, with a count (`Placed.epoch`) the Fin's
device records as heard (`RemoteParent.heard`). Every notice says how the
Fin stands as it's sent (`standing`: whether it holds a place, the count it
had heard, and which saying of its host's this is); the Apex's device takes
only the newest, by a mark it keeps on the edge with `working`, written
together (`Placed.said`), so a notice replayed or late changes nothing,
after a restart too, and only one that had heard everything it sent, so a
report from before a message never ends the turn that message started. A
place's answer to a list carries the same mark on each strip (`said`), so
a notice from before the list changes nothing after it. A
Fin whose standing changes with nothing to report (its turn ended after a
report it made itself, or the person sent it on there) says its last report
again with how it stands now (`restate`). Each place is also asked how the
tree's Fins stand (`listAway`) before any start in that tree is admitted,
when the Apex lists them and when its device is back, so work the Apex's
device never sent counts against the running budget before admission. Where
it runs, a placed Fin is a Thread of its own in the rail, and the device
running it writes its row to the account's list (`listedUnderApex`), since
its Apex's Thread isn't there. Every other device shows that row under its
Apex, by the Apex's row that names the Fin among its Fins (`listedApexOf`,
the one rule a Mac's host and a browser fold by), never as a Thread of its
own, and opens it from there with the Fin's own device answering: the
desk's rows (`finOpening`: its listed conversation, else its transcript
here; one with neither draws as not openable and sets no view), the
phone's chips and its Needs you, where a placed Fin waiting on the person
is a row of its own that opens on its device (`placedWaiting`). The Fin's
row carries what it asks whatever its Apex's device is doing: a window's
roster of the Apex takes the Fin's own conversation and standing from it
(`placedOver`), the Apex's word standing only while the Fin's device is
quiet. A placed Fin's Thread may hold several Sessions on its device (the
person continued it there), and the Apex's device holds no group of that
Thread, only its device does: so every row a device lists says its Session's
place in its Thread as the owner's store keeps it (`ReportedSession.order`,
link version 22 on, `sessionOrderIn`), and `newestSaid` ranks a Thread it
holds no group of by it, as it ranks one it holds by the group; a row from a
host before the field ranks where it arrived, as every device did before.
So the person answers a placed Fin's approvals in its own Thread, on
that device, on the web or from another device, with the Apex's device off
too. Its Apex never grants them: it calls at no more than the device's
ceiling (`PLACED_CEILING`, `auto`: the person's decision of 2026-11-06,
"Auto edits, Full by choice", kept in one place until the per-device
ceiling's Settings replace it), which is below full access.
`scripts/test-placed-rows.ts` holds the fold, the Apex-off case and what
opens; `test:placed-fin-ui` draws the row on the device running it, under
its Apex on the desk, the laptop browser and the phone, waiting on an
approval, on a quiet device and with the Apex's device off. Not
yet: `place: cloud`, a Thread attached as context, the person's direct
message or answer from the Apex's Thread, and a start from the Apex's
uncommitted work. `npm run test:fins-placed` runs two hosts through the
protocol's gateway (the start, the outbox with the Apex's device off and a
host restarted, a repeat, a stale owner, every refusal, a full place, a
start whose answer is lost and whose host restarts, the routed operations,
a Stop of a start whose answer was lost, with the device reachable and not,
by name and by `all`, a start that arrives after its Stop, and a Fin's
activity through its Apex's restart); naming cases after the script runs
those alone. `scripts/prove-fins-placed.ts` runs two `mako-host`s against a
deployed cloud.

What an Apex and its Fins tell each other is kept short without dropping
what the reader needs. Every `agents_*` answer is its JSON on one line
(`agentToolText`), every field kept. A finished Fin's digest line
(`finishedLine`) is its report's first paragraph past any heading, on one
line, at most `FINISHED_CHARS`, with how many more characters the
report holds (`agents_read` gives them), and every artifact by its ref with
its label beside it.
A Fin reads its Apex and the other open Fins it started with `agents_list`
`scope: crew` (`AgentsCrew`): the Apex's title, harness, whether it works and
its last step, what it was asked when it is a Fin too, and each other Fin as
the front door's note names it (name, harness, state, what it was asked, its
branch and last report). The person's direct words to a Fin stay out. It
reads typed state, never a transcript, and its brief's first line says it's
there. Crew discovery grants no sibling-send authority. A refused sibling
send names the target and parent, sends nothing, and points to an explicit
`agents_report` parent relay; `delivered: notice` proves that handoff, not
a send to the sibling. `npm run test:orch-comms` covers all three.
An Apex reads the person's other Apexes with `agents_list` `scope: apexes`
(`AgentsApexes`): every tree's top Apex but its own whose conversation is
open here, each with its title, harness, whether it works and its last step,
folder and branch, its Fins' `rollup`, and a digest of its open Fins' last
reports and its own last reply's first paragraph. Reading wakes no one.
`agents_send` `to: apex:<title or Thread>` messages one: Mako's words
(`fromApex`, `apexNote`), never the person's, after its turn unless steered;
the transcript draws it as a card from that Apex. The turn that answers it
sends its reply back once, as the sender's wake (`Notice.reply`), and that
wake sends nothing on. At most three go from one Apex to another an hour
(`rate-limited`). The rule for when to message is in
`ORCHESTRATION_INSTRUCTIONS`; `test:orch-comms` covers it too.

The person's message in an Apex's conversation goes to the Apex, which
passes it on (`agents_send`, drawn as a routing line). Nothing goes where
the last one went. To skip the Apex's turn, the person presses Reply on a
routing line or picks a Fin from `@` in the Apex's composer
(`addresseeStore`, cleared once sent): `mako:agents-direct` delivers it to
that Fin as the person's own words through the same `deliver` as
`agents_send`, settled by the composer's request ID so a retry delivers
once, and records it in the Apex's conversation as a stream-only event
(`DirectRoute`, `recordDirect`) that the harness never sees, so no Apex turn
runs. It is drawn as the same routing line, marked direct, and the Apex
hears of it in its next front-door note. A roster entry's `child.name` says
its host takes direct messages; one without it offers no Reply or `@`.
`test:orch-front-door` covers both ways (`addressedFromTheApex`: no Apex
turn, dedupe, steer and queue, refusals), and `bench:orch-route` times a
message in a Fin's tab, addressed, and routed through a scripted Apex.

How a message reaches a working Fin is its sender's choice, `agents_send`'s
`deliver`: `queue` (the default) after its turn, for more to do; `steer` into
the turn it runs, for a correction to what it's doing now; `interrupt`, which
stops that turn (`LiveConversations.interrupt`) and starts the next with the
message, ahead of what was queued, which still follows in order. An idle Fin
takes any as its next turn. A direct message, a redirect and an answer steer.
A steer queues the message first and steers that request (`steer-queued`), so
one the harness refuses, then or when its turn ends (Cursor's `answersOnEnd`),
stays where it was queued and nothing sent after it overtakes it; the call
waits `STEER_WAIT_MS` and `STEER_ANSWER_MS` at most, so a steer Cursor holds
while its subagent runs answers before it's taken. The result's `hears` says,
in one sentence, when the Fin hears it on its own harness, never the
sender's: the driver's `SteerCapability.hears`, seen on a real run
(`scripts/probe-steer-semantics.ts`). `test:orch-deliver` covers each choice
across harnesses, and `eval:orch-tools`' `deliver` cases
(`cases-deliver.ndjson`) whether an agent picks the right one.
A request keeps its `admissionOrder` in the journal, independent of queue
priority and wall clocks. If a queued agent message follows newer instructions
already handed over (including accepted steers), its handoff note restates
those instructions with request IDs, original admission times/orders and
accepted steer receipts (`agent-message-order.ts`).
Older journals use their saved admission times when available. This conveys
instruction order; it does not enforce a hold on external operations. Prose
in `agents_answer` does not invoke Stop; admission order and host ownership
are not a permission generation. Only explicit newer instructions may release
a newer prose restriction; queue delivery is no release.
`agents_send` with `reply: "none"` marks an informational message durably. A
successful notification synthesizes no result and preserves an existing wait;
failures, questions and explicit reports still report. A completed task turn
without a report or final response is failed, never a successful result.

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
A copy the journal keeps is a row per entry (`base_entries`), written by
identity: a history read again keeps the objects of the entries that say the
same (`sharedEntries`), so a turn writes, weighs and holds only what it
added. While the journal keeps no copy its rows stay, written ahead between
other work (`stageBase`, `writeAhead`), so the next turn names them without
writing them; the compaction drops them once the journal closes.
`npm run bench:live-read` fails if reading a huge conversation holds the
event loop. A journal read in a slice at a time (`LiveRecords.loadSliced`, as a
window or a notice reads a conversation not in memory) has its rows read
and parsed on a reader (`JournalReaders`: up to four worker threads, each
opening the file read-only, its rows handed over a part at a time,
`journalRowSteps`) and its snapshot made on the loop from them; a reader
that fails leaves the journal read on the loop as before. On a 60MB
journal it held the loop 42–91 ms in all against 108–477 ms read on it
(`bench:live-read`'s `journalRead*`). A history read from its session whose
merge was overtaken is merged again on the next drain, not read again
(`LiveSources.pagesRead`). `agents_report` never reads a journal: a
notice for an Apex not in memory reads it in first (`readIn`), and the
wake's queue reads memory before it would load one. The roster and the
list read the Thread store's per-Fin rows in one query per commit
(`ThreadStore.threadConversations`, `thread`, `openReportAsks`,
`answerOf`, each kept until the store moves), `edges()` keeps its object
through a commit that changed no edge, and `Agents.sync` takes reports and
answers since its last mark rather than rebuilding every Fin
(`keptSince`). `npm run bench:agents-report -- --foreign-writes` runs the
person's day (226 Fins, 3,400 reports, another Mako committing between
reports) on a scratch host.

The host doesn't hold a conversation's history whole, running or not: its
finished entries are paged (`packages/host/src/conversations/paged-entries.ts`).
The journal holds every live block as a row and, while the conversation is
open, every entry of its history (`base_entries`, kept or written ahead), so
a paged entry keeps its short fields (type, id, request, status, a call's
name, a stream's or record's place) and reads its long ones back from its
row when something reads them. It is still an entry: JSON, spreads, deep
equality and every reader see what they saw, so nothing that reads history
needs to know, but a pass that reads all of it at once (a merge) reads it
back first, a slice at a time (`readBack`). `LiveRecords`' sweep pages each
conversation in memory but its turn under way and its newest `WARM_CHARS`,
then weighs what is left; a block only while the journal's rows hold the
blocks as memory does, a history entry once its row holds it (by identity,
`LiveJournal.pageBase`). A row is never written over or dropped under a
paged entry: the journal gives the entry its content back first (`detach`).
A closed journal's paged entries read through a connection of their own,
and its rows written ahead stay, and the file isn't compacted, until the last
is collected (`LiveJournal.released`); a window's views hold the paged copies
(`LiveHistoryReader.paged`) and go with their conversation. A batch carries a
changed base only while it's short (`carriesBase`); a long one is the notice
that the history changed. A journal has one writer, the host holding it: an
entry paged from a row reads what that row holds now. On 2026-10-30 a running
conversation of 30,845 blocks and a 157MB history held 422MB here; `npm run
bench:running-memory` holds one of 150MB to under 72MB while it streams, a
window reads it back whole, its turn ends and a new host reopens it, and
fails on a host that keeps it whole, or on any of those (or the sweep's
measure of a copy) holding the event loop past 50ms. A pass over a whole
history (a merge, a journal's read, that measure) is written once as `Steps`
(`@mako/sessions/slices`) and run `inSlices` wherever the host, or the sync
daemon, can wait. One that outlives its host's stop takes a `stopping` check
and ends at its next step (`StepsStopped`, thrown into the steps so a read
transaction rolls back): a resume read cut by a stop resumes nothing and is
the next host's, and a count or pass the journal's close cuts ends quietly
(`test:resume-holds`, `test:attribution-holds`); a turn starts once the history's rows are written ahead
(`LiveJournal.writtenAhead`), so its first commit writes none of them. `MAKO_PAGING_CHECK=1` pages every field
of every entry as soon as a commit writes it, the turn running included; run
the live, transcript and conversation-control suites with it after changing
paging or anything that reads history (test-live-conversations' crash fixture
runs two hosts on one journal at once, which breaks that one-writer rule).
`scripts/test-paged-entries.ts` (in `test:performance`) covers paging.

A Thread goes on on another harness through one operation, `continueOn`
(`conversations/continue-on.ts`), whoever asks, with `actor` saying who: the
person's switch (`mako:live-transfer`) and a reply to a dormant binding, a
Fin's relaunch, `agents_move` and Mako's automatic moves.
`test:fin-move` fails on a caller that goes around it. A move (`ThreadMove`)
is a quiet switch: no message of its own and no row, so every waiting message
stays a row, goes on the target at commit in its order and carries the
transcript with the first (a pending merge), and a target of the same harness
that keeps the session only pins its binding (`ProviderBinding.account`,
`LiveConversations.pinnedAccount`, a Fin's and an Apex's alike). It asks nothing
of the harness it leaves, so it works on a Fin stopped, ended, failed or out of
usage, keeping its Thread, name, edge, worktree, branch and reports. Its rules
beside a Stop and a hold are in `docs/delivery-queue.md`, rules 10 to 12.
A same-harness target that names a model, reasoning or fast retunes the
session: its binding and settings take it, and the next message naming none
carries it into the running process (`Resident.retuned`); `agents_move` to
the harness a Fin is on does this when it names one, held to that catalog as
a start is, and says "already" only when it names nothing. Onto another
harness, the selection goes only as far as the target lists it
(`HarnessProfiles.carried`, `carriedTuning`): another harness's encoding
(Cursor's `claude-opus-5-5[context=1m,fast=false]`) goes as the model it
names, a model the target doesn't list goes as nothing, so the target runs
its own default. A message to a Fin whose session's records were never
located (`ResumeVerdict` `unavailable` with `lost`) goes on in a new session
of that harness with the whole conversation, as a record kept closed does,
and `agents_send` answers only once the session opened: a reopening that
fails is refused with why, one waiting to go again says so, never "takes it
now" (`Agents.reopening`). A session Mako started that never ran a turn
(`neverRan`: not resumed or seeded, never located or checkpointed, no request
run on it) has no record to find, since Claude writes a session's file with
its first turn: it starts in its own binding with the whole conversation, not
as a lost one. A conversation started again after its first start failed
(`relaunch`) starts under its active binding's ID, which its messages are
sent to: under the conversation's, a Fin a move had put on Claude failed
every message "The agent execution owner is unavailable" (2026-11-11).
`npm run test:fin-reopen` reproduces each on a scratch host, with a Fin moved
from Codex to Claude and a restart before its first turn there.
`agents_start` and `agents_send` attach another Thread as a person's `@` chip
does (`context: [{ thread }]`, a ref, a Thread ID or a Fin's name; `agents_list`
`scope: threads` finds a ref). What can be attached can be read and exported, so
one check bounds it and that search (`Agents.reachOf`): the Apex the person talks
to reaches what their picker offers, every attach a chip in its Thread, and a Fin
below reaches its own tree and what it holds by reference, so a Thread comes down
only as an Apex hands it on. What a Thread holds is a stored fact: a person's chips,
and each message's `LiveRequest.grants`, never items an agent's text spells out
(`heldReferences`). This scopes what agents are offered and can ask Mako for; it
isn't a sandbox. A Fin's shell runs as the person, so `mako send` from it reaches the
host as them, and whatever it reads on disk it reads as them.
`@mako/sessions/thread-references` resolves and
writes both, and `thread_history` reads the caller's referenced threads and
its own tree (`thread-tree.ts`): its Fins, its Apex and the Fins beside it, each
by Thread ID or a Fin's name. `thread: "tree"` searches all of them, and `export`
writes a Thread out through the bundle a switch and a chip hand over.
`agents_read`'s transcript is a quick tail, and says where the whole is.

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

A tool row is one line of fixed height (`ToolWords`), and a view's `summary`
is inline words in it: a flex or block element there breaks the line in two,
and the second line draws over the row below (`FileTarget` once did, on every
file row). `scripts/test-tool-row-words.tsx` (in
`test:transcript-events`) renders every harness sample's row, settled and
running, and refuses a box among its words; `npm run test:tool-rows-ui` streams
a Cursor turn's edits on the desk and in the phone's steps sheet, short and
windowed, and holds every drawn row apart on every frame.

Mako's own `mako` server speaks in its own words, from one table
(`packages/sessions/src/mako-tools.ts`, `makoToolWords`): each tool's name
("Start fin:x on Codex", a failed call's words), its running words and its
settled ones, read from its arguments and, once it answers, its answer
("Opened PR #374"). The desk's row, the phone's steps, the activity line and
a Fin's last step all read it; its rows carry no server tag and their glyph
says what the tool is about. A new tool of the server needs a line there, and
`scripts/test-tool-words.ts` fails until it has one and a row on the fixture
page (`src/dev/tool-words-fixture.ts`, `tool-rows.html?rows=words`). A row's
facts sit in its label face: a failed command's exit code (its command
effect's, else the text its shell declares as `exitText`), a read's range
(":120–180") and an edit's lines ("+12 −3"), read by `toolFacts` only for a
row that draws them: `identifyTool` runs for every call a decoder reads, and
counting a patch's lines there slowed every harness's decoding. A turn's folded summary counts a
failure only while no later call of the same kind with the same normalized
arguments (a command's in the same folder) succeeded, by the exit facts its
row shows (`unfixedFailures`); the failed row still says failed.

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
conversation's ledger with where each number came from. Every surface says
a token count and a dollar amount through `@mako/sessions/amounts`
(`formatTokens`: K, M, B, T in three figures; `formatUsd`: cents below $10,
whole dollars grouped above), and a figure is "at API prices", never "spent":
a subscription is billed by its plan. The usage ledger keeps each event's
reader, so a harness that gains its own history drops what Mako's journals
measured of it; `scripts/test-usage-truth.ts` holds every harness's real
records to totals worked out by hand.

## The hot path

Token streaming must never re-send the session. The host emits `stream` with
only the in-flight message; `messages`, `tree`, and `git` go out only when they
actually change. A conversation's first change after a quiet frame flushes at
once, and the rest of a burst one flush per frame (`LIVE_FRAME_MS`, 50 ms, in
`contracts/live-conversations.ts`): windows, watching devices and the journal
get the same batches. The frame is the window's paint frame (`StreamFrames`
takes it): on 33 ms the batches beat against the paints, a third of them were
painted over unseen and a word waited longer for its paint. Status changes,
questions and approvals don't wait for it. A batch says `activityAt` only when
it moved into another second, and carries a whole value (a control, a request,
a roster) only when its content changed (`sharedFields`); a message whose
record lands on what streamed travels as its frames alone
(`deliverLiveUpdates`). On the
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
  surface-panel rows carry `.contain-turn`. Timelines above 40 turns or 120
  messages and calls (a few prompts can hold thousands of calls), and
  navigators above 100 prompts, additionally window measured rows; a timeline
  stays windowed while it's shown. A row coming in restyles itself, never the
  page: no `group-has-[…]`, whose universal last part restyles all of `main` for
  any element added, so write `[.group:has(…)_&]:…`
  (`test-transcript-rows-ui.mjs` counts it). Its mounted rows are also held against the
  virtualizer before each paint (`row-check.ts`), so an observer that goes quiet
  never shows, and a correction it didn't report is logged with what was found
  (`Transcript row corrected` in the host's log). A conversation keeps at most 24 MB of
  finished turns (`CONVERSATION_MEMORY` in `live-residency.ts`), the one being
  read included: what's on screen, near it, read in the last minute or still
  at work stays, and the rest come back as the reader nears them. Preserve
  prompt identity, prepend anchors and complete answer-copy data. Only actual
  user scrolling may release follow mode; virtualizer size adjustments must not.
  Follow changes only as the reader moves: up leaves the end, down into it
  follows again, and a scroll's end decides nothing. A move counts from 24 px
  (`LEFT_END`), a wheel's as its travel within 500 ms since it last turned, so
  a trackpad's rest jitter never lets go while a flick up does at once, and a
  wheel up then as far back down follows the end again (its net was nothing,
  which read as rest, and the end went unfollowed). A wheel taken by a
  scroller inside the transcript (the crew card's list, a code block) stays
  with it until it settles, as the browser's own gesture does. Input ends when
  it settles (`INPUT_SETTLE_MS`), for input that moved nothing and a browser
  with no `scrollend`: left standing, the next layout shift would read as the
  reader's. Focus resting in a turn keeps that turn, and only a selection or
  moving input postpones what's released; `test-follow-ui.mjs` holds all of it
  through bursts of reports on every form. Under a finger the end
  waits for it to lift, and a `scrollend` there (the browser sends one for the
  page's own writes too) doesn't end the gesture;
  `test-phone-scroll-ui.mjs` holds both by touch and by wheel. A Thread
  opened paints its newest turn at the end and nothing moves it after: its
  entrance (`animate-thread`) only fades, since a 4 px rise read as the
  transcript settling late, and a windowed one opened again places its rows
  at the sizes they last measured (`measuredRows`), since the virtualizer's
  own measurements land a frame after it paints and jumped the newest turn
  48 px; `test-phone-open-ui.mjs` holds both. A Thread's transcript whose
  code is here draws without a Suspense boundary (`chunks.ts`): React holds
  a fallback it showed for 300 ms, and every cold open waited that long. One
  opened with nothing of it on the page (its first open, or after a reload)
  shows the transcript's loader (`TranscriptLoading`; in a laptop's browser the
  desktop's own `ConversationSkeleton`, in the transcript's column) over its still-empty
  transcript until its turns arrive, never an empty column under the bar: the
  transcript stays mounted under it, so the turns land at its end as a held
  one's do (mounted only once they'd arrived, a 260-turn one jumped 48 px).
  `test-phone-open-ui.mjs` reads every frame for it, a Thread and an Apex,
  cold and warm, on a Mac and on a machine.
- **Streamed prose is throttled, not debounced.** `useThrottled` in
  `markdown.tsx` paints through `StreamFrames` (`src/lib/stream-frames.ts`):
  the first token of a burst at once, then at most every 50 ms, up to 90 ms
  for a long piece, whose re-parse costs about 1.2 ms per 1,000 characters.
  A pending frame survives further tokens (cancelling it per token would
  never fire under a steady stream). Only unmount stops it, and stopping must
  forget it was pending: StrictMode's simulated remount once ran that cleanup,
  re-ran the scheduling effect against a ref that still looked pending, and
  every answer sat on its first character until the turn ended ("I", then the
  tool rows). `test-streaming-markdown.ts` holds `StreamFrames` to both, and
  `test-workspace-ui.mjs` streams a reply and requires the prose to catch up
  while the turn is still running.

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
registerSurface({ id, label, icon, render, minWidth, reading, useOffered }) // stage companions
```

No pane is left blank on the stage. The viewer's panes hold only the chat and
documents they can draw (`shownPanes`, on every write to the store), so a pane
left with neither goes; a chat pane beside the focused one whose Session left its
Thread goes too (`watchSessionPanes`), and one whose Thread the window doesn't
list says so with Close. A pane with nothing to show says so with Close
(`EmptyPane`). When the stage stays laid out wrong for 3 s (panes short of the
workbench, a composer above its pane's bottom, a pane showing nothing) the desk
logs `Stage layout off` once with the window's, workbench's and each pane's size
and what each shows (`stage-layout-watch.ts`), carried to the host's log as
row-check's warnings are. `test:stage-panes-ui` holds both.

The stage's surfaces — Changes, Files, Terminal, Control, Agents —
are all registered through `registerSurface` on exactly the same footing as
anything a plugin would add. One reading surface opens in the right rail at
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
disk. The turn's record of changes (`LiveRequest.changes`) adds media no
call names, such as a PNG a script drew (`changedMedia` in
`src/lib/media-shelf.ts`), but only files the Thread changed for sure
(`own`): a file only timing names (`maybe`) may be what a pull or another
process wrote in the checkout while the turn ran, so it is never the
turn's media. A page counts there only when the turn created it, since an
`index.html` it edited is an app's entry. `show`'s result draws where it
was called (a `shown` section, kept in view by a settled fold); the rest
draws after the stretch of work holding the call that made it, and what
only the record names ends the answer (`placeMadeMedia`), less what the
prose already previews. An inline page (`InlinePage`) fits the height the
page reports (`PAGE_FIT_SCRIPT` in `contracts/page-frame.ts`), between
`PAGE_MIN_HEIGHT` and a cap. Until a page reports one, or when it is too
big to be fitted, it holds 16:10 of the column. A page that loaded and
drew nothing shows a quiet empty state at the minimum height, never a
sliver. Every harness is told
Mako's primer (`contracts/primer.ts`, whose `routes` block carries
`SHOW_MEDIA_LINE`): Claude in its appended system prompt, Codex
as turn context, OpenCode in an instructions file, the others in Mako's note before the prompt
(`makoInstructions` on the live driver says which). That note
(`makoNote`, `conversations/control-cadence.ts`) has standing
lines, each under a name (the cloud machine, Local Control, the Thread's
environment, and on a harness without a slot the primer's `routes` and
`policy`), and notices (a worktree move, a cloud
return), each said once when it happens. A binding's process hears the
standing lines whole on its first prompt, then only those that changed
(`CHANGED_LINE`), nothing when none did, and the whole note again
(`REPLACED_LINE`) when one stops applying. `Resident.controlSaid` records
what it heard under the binding's start (`bindingGenerations`), so a
relaunch or resume hears it whole; a compaction, a rewound history or a
failed send forgets it. `scripts/test-control-cadence.ts` covers it, and
`scripts/test-primer-delivery.ts` the primer on it. The decode pairs draw
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

The web app's phone composer keeps the same promise across a page the system
may kill at any moment (`src/web-client/drafts.ts`): each Session's draft and
New's are kept in `localStorage` by account and place, written a quarter second
after the last key and at once when the page hides or the composer closes. A
send mints the message's request ID in the composer; the words leave the field
at once but stay in the draft under that ID until the host confirms them, and
the renderer's outbox (`message-outbox.ts`) holds the message under the same ID
across a reload, so a page that dies mid-send finds it again rather than
losing it or sending it twice: re-asked under its ID, which the host settles by
(`LiveConversations.submit`), it lands once. A steer is kept the same way
(`steerTo`): its action takes the composer's ID, and with no turn left to
steer, or a steer the host refused before the harness heard it, the words go
as the next message under that ID; the host takes one ID once, as a steer or
as a message. A queued message edited in the composer isn't paused: ✓ replaces
its words only if the host still holds them as they were, as the desk's queue
edits do. The host admits messages to a conversation in the order they
arrived (`admitInOrder`), whatever each resolves first. A host that comes back
after a crash pauses what was still queued, as a quit does, and Resume wakes
the conversation. `npm run test:send-race` sends from the Mac, a phone and
another Mac at once, through the protocol's gateway, with lost replies, cut
links, messages taken twice from the account and restarts, and holds each to
landing once, one turn at a time, in arrival order, with nothing left queued.
The outbox never turns the person away for a host that can't take a message
yet (`sendTo`, `steerTo`, `delivery-policy.ts`): a message is drawn and kept at
once, and one conversation's messages reach the host one at a time, in the
order sent. A host that's away (the composer sends to a live conversation
while disconnected), slow (an answer past `DELIVERY_PATIENCE_MS`, or the
bridge's `HostCallTimeoutError`) or busy (a rewind, a provider switch, a turn
still ending, a move in transit; `waitsFor`) leaves it waiting, with that
reason on its row in the queue ("Waiting · …", with Send now and Remove), and
later messages wait behind it; it goes by itself under its one ID. A steer
shows as steering until the turn takes it; a host busy with the previous steer
is asked again for `STEER_BUSY_MS` before the words go next, and a steer whose
outcome is unknown no longer holds the next one (`LiveActions.submit`).
`npm run test:durable-outbox` holds it to that against a scripted host: away,
busy, 5 s stalls, a lost answer, duplicate tries, steers mid-turn and a reload
mid-delivery; `test:steer-landing` checks a message queues and a steer lands
mid-turn on each of the six harnesses by its own driver's landing.
A refused message comes back
into the field only if the field is empty, else it's kept under the composer
with Retry (`outbox.ts`). Under each sent message the phone says where it is,
in a word (`delivery.ts`): Waking…, Sending…, Not confirmed · Retry, Queued,
Delivered; and the status capsule says Working only once the host started the
turn. `npm run test:cloud-conversations` (`test-web-client.ts`) covers the
rules, and the web proof's Mac (`prove-web-client.ts`, `begin`) gives the
phone's behaviour cases a Thread of their own on each scripted cue.

When something can't be reached, the web app says where it stops, never just
"off" (`src/web-client/diagnosis.ts`): the chain this phone → Mako Cloud →
the Mac (or the cloud machine) → its harness, each reached, not reached, or
not checked, from what each call last met (`reach.ts`: the gateway's own
outcome and correlation ID, kept by the place it went to), the list's word on
a quiet Mac (last seen, clamped to now) and the open Session's failed start.
One headline names the first hop that failed; Try again reads the list afresh
and asks the Mac, and Copy diagnostics quotes IDs, versions and times, no
secrets. A read the network failed is asked once more; a change never is
(`Gateway.rest`). An account whose Mac was never heard from gets Connect your
Mac (`connect-mac.tsx`), which ticks itself from `device-joined` and the Mac's
first rows or answer; a Mac the account calls quiet connected before, and gets
the diagnosis instead. Only `owner-unavailable`, `unavailable` and `restarting`
say a place wasn't reached; any other refusal came from one that answered, and
a Mac's live update is it answering. Mako Cloud's standing is one fact for the
list and every Thread (`cloudReach`): the live account stream, else the last
request. A Thread's app is said once per screen (`appShownAs`): the capsule's
App running · Open on a phone, a card per server with a tablet's or laptop's
room (`previews.ts`, read from `mako:thread-app` while the Thread is in front,
closely while it starts, and passively, so a window left open on a cloud
Thread neither wakes its machine nor keeps it running); loopback links in its
transcript open there. A move between a Mac and the cloud is watched, not
waited on: a Mac's rows say it from its first step (`ListedSession.move`,
link version 11, `MovesUnderWay`, cleared when the move stops running however
it ended), a watched conversation's owner relays each `thread-move-step` and
`thread-return-step` (`SessionPublisher.own`), packing with its upload's bytes
(`SentProgress`), and a strip above the Thread's transcript, which stays with
its composer (`move-card.tsx`), draws a bar that only goes forward
(`move-progress.ts`), written through refs, from the step's start as the list
said it. After `own-branch` with `to` the forked conversation is followed. A
move's answer the network lost is `unconfirmed`, never a failure: the Mac is
asked again under the same move ID (`followAnswer`), and a later step
overrides it; Retry mints a new move only after the owner's refusal. A turn a
refused move paused goes on here in words that say it stayed
(`SavedContinuation.stayed`), so no transcript draws "Moved to the cloud" over
it.

The account's devices are one component on a Mac and in a browser
(`src/components/settings/devices.tsx`, `Devices`): Settings › Devices on the
desk (`devices-section.tsx`, fed by the host's `mako:cloud-devices`) and the
web app's Settings (`web-client/devices.tsx`, fed by the account's list and
the gateway). It reads nothing itself; `form` picks a window's sizes or a
finger's. Every rule it shows is in `contracts/account-devices.ts`, so both
say the same of a device: its family (`deviceFamily`: a `runtime` device is a
machine of the person's own), its health (`deviceHealth`: the account's
`device-quiet` where the list hears it; then `heard`, a device that lists
work the account doesn't call quiet, which is there whatever its record says;
else `lastSeenAt`, which is only as new as the record's last read and which
the cloud writes as a device joins, so one that never moved past that never
connected. A row is evidence of when it was heard, never of now, so the
list's word, quiet or there, counts only while the list is current: in a
browser, followed live and said something within `HEARD_FRESH_MS`
(`deviceReadings`; each event and each re-read of the devices while Settings
shows makes it so), never a list painted from the cache or one being
followed again; on a Mac, while its own link to the account is up
(`deviceEvidence` in `lib/device-places.ts`, over the conversations its host
lists). Otherwise the counts stay and each record speaks for itself),
whether its Mako is behind (`needsMakoUpdate` against `DEVICE_MAKO_NEEDED`; a
checkout's 0.0.1 is never judged), and the lines Add a machine shows
(`joinCommand`, `containerCommand`), which are `docs/linux-device.md`'s and
change with it. Every line runs as it's written: where a window can't name
the cloud the container's line passes the shell's own `MAKO_CLOUD_URL` on,
never a placeholder a shell would read as a redirection. A Mac names the
cloud it's signed in to; a browser names the one its gateway says of itself
with its connection (`WebConnection.cloud`), since the app's own host passes
on only the app's routes and a machine can't join there. A row's facts say each thing once (`deviceFacts`: a Linux
machine's system leaves out the Linux its kind said), each kept whole when the
line breaks. What runs on a device is its Threads, counted from what the
window already holds: a browser folds the list's rows by Thread, a Mac its
conversations by the place they name; which rows are Fins the list doesn't
say. Add a machine waits on the account's `device-joined`
(`cloudAccountStore.joined`, `accountListStore.joined`) and turns into what
joined; while it's open the join's toast is left out (`addingMachine`). The
account never says a join failed, so the sheet stops claiming a wait once a
code's life is past (`JOIN_WAIT_MS`, by the list's clock, which is read again
when the window comes to the front; copying a line starts the wait again) and
says how to get a new code (the join line again; in a container
`CONTAINER_START_COMMAND`, since a container whose code ran out has stopped
and keeps its name, so its run line can't run twice); a machine that joins
after still turns it. On a phone a row's facts break between facts and its
lines wrap, so nothing runs into Remove or is cut; the web UI test measures
that at 393 and 320 wide. A
removal pressed in the sheet fails in the sheet (`failure.device`), never
behind it. Where a Thread runs is one glyph
(`ui/place-mark.tsx`, `runPlace`): a cloud, a server for a machine of the
person's own, a laptop for a Mac. The device's kind travels with the row
(`LiveSummary.elsewhereKind`, from the account's devices in
`CloudConversations` and `sessionOf`), and a conversation's place stays what
its listing said through its live batches (`summaryOf`), so a window that
lists after one still names the machine. `scripts/test-account-devices.ts`
holds the rules, `npm run test:account-devices-ui` both windows at a
desk's, a laptop browser's, a tablet's and a phone's form
(`?mock&cloud=signed-in` and `scripts/web-devices.html` hold every state; the
fixtures' `makoMockAccount` and `webDevicesCheck` have a machine join, a
code run out and a removal fail, and `web-desk.html?machine` and
`phone-apex.html?machine` run the Threads on a machine).

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

Mako's hosted service is developed in a separate private repository, checked out beside this one as `../mako-backend`. The dependency runs one way: that repository consumes this one's packages as pinned artifacts, and nothing here imports from it, even behind a flag. Clients and the runtime reach hosted features only over the network, through open protocol packages and their tests. Everything committed here is public, so hosted design, pricing and planning notes don't belong in this repository's files, commit messages or pull requests. Neither does a machine's identity: a test, fixture or audit names a placeholder home (`/Users/someone`), a path from its own temporary folder or the repository root, and an `example.com` address. The Public text workflow fails a pull request whose added lines, new file names, commit messages, title or body hold a home folder, macOS's per-user temporary folder, a personal address or a name in `scripts/public-text-denylist.txt`; `npm run check:public-text` runs it locally.

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

## File watching

Everything the host watches goes through one watcher child
(`workspaces/watch-backend.ts`): one FSEvents stream per distinct folder and
ignore list, which parcel shares, plus the child's canary. The canary calls
delivery silent only after 30 s with nothing heard, and reports how late beats
arrive otherwise: a degraded fseventsd delivers in batches, seconds apart,
with nothing lost. That is a fault, not a busy Mac. One a month up held 24 GB
(10.5 GB resident) and delivered every app's events 2.6 s late at the median;
`sudo killall fseventsd` brought it back to 11.5 ms and a few megabytes, and
it stayed there through three times the traffic. A silence makes every watch poll
(`pollTree`) and restarts the child, at most once every 10 minutes. The
tracker rescans a root for lost events at once after a quiet while, then 2 s
after the last, doubling to 10 minutes while losses keep coming; roots take
turns, and each next rescan rests 19 times as long as the last ran. A watch
polling because delivery went silent is rescanned once, when it listens
again. A canary later than 5 s tells every watch it's `late`, and each also
polls every 15 s (`CALM_POLL_MS`): an fseventsd that far behind was seen
holding one stream's events back for minutes. A change heard as late as the
canary measures is still dated by its
modification time, and calls are kept that much longer for it to reach
(`TrackerOptions.deliveryLagMs`). History reads leave Mako's own folders to fseventsd (`exclude`, at most
eight inside a root). `WatchReadings` counts all of it and logs each change of
state under `watch`; Settings › Diagnostics shows it as Mako's footprint
(`mako:mako-footprint`, `FootprintReadout`), with Mako's own processes apart
from the agents it started. Once a 5 s canary deadline on such a Mac muted
every watch, restarted the child and rescanned every root about once a
minute, all day: 45 million files stat-ed in two days. `npm run
bench:mako-footprint` runs a scripted stretch of work against budgets
(`--drops <s>`, `--slow-delivery`).

The daemon's own health is read apart from any watch
(`workspaces/file-events-service.ts`, `contracts/file-events-service.ts`),
without root: every canary beat goes to the host (`beat`), and fseventsd is
degraded when two readings a minute apart of its resident memory (`ps -o
rss=`) are past 1 GB, or when the median beat of the last five minutes (three
at least) is past 1 s, or the canary is unheard for three. Lag counts only on
a Mac not busy with other work (`busySinceLastAsk`: half the cores, or heat)
and not in the ten minutes after fseventsd starts over, when only memory is
judged. Healthy, a beat takes 13 to 60 ms on a quiet Mac and a few hundred on
a busy one: a first cut at 250 ms told a person with a healthy 11 MB daemon
it was degraded at 257 ms, two seconds after they had restarted it. The
degraded daemon this is for was 2.6 s late for days at 10.5 GB. The 5 s
`SLOW_DELIVERY_MS` is only when watches start polling around it. The host
decides whether the desk says it (`notice`): once an episode, which only half
an hour healthy ends; "Not now" (`mako:file-events-dismiss`) holds until
midnight, kept in `<data root>/file-events/notice.json` for every window and
the next host, and only a reading twice as bad, or degraded for a new reason,
says it again. A restart answers its episode the same way. A sample every 15 minutes, and at each change of
state or daemon, keeps memory, lag and what Mako did since (watches and
streams, watcher starts, history reads, turns running, wakes) in
`<data root>/file-events/fseventsd.jsonl` for a week. Degraded, the desk says
so above the panes (`FileEventsNotice`) with the numbers, and Settings ›
Diagnostics shows the readings and the day's samples (`FileEventsReadout`).
"Restart it" (`mako:file-events-restart`) runs one privileged step through
macOS's administrator password dialog (`osascript … with administrator
privileges`): into a folder root makes itself, a 5 s `sample`, `vmmap
--summary`, `footprint` and two hours of fseventsd's `log show`, then `killall
fseventsd`, which launchd answers by starting it again, then the folder handed
to the person. Mako copies it into its crash-report folder as
`fseventsd-<time>/` with `clients.txt` (the sample's
`com.apple.fseventsd.client.<pid>` threads: who subscribed, gone or not) and
`summary.json` (the zones' allocation counts, before and after, the day's
samples), starts the watcher child over (`recover`: every watch hears
`dropped` and rescans) and ends history reads under way, and measures
delivery again with a probe (`probeDelivery`, five beats in a child of its
own). A new fseventsd pid, from Mako's restart or anyone's, is a restart: a
history read whose mark is from before one reports every root `lost`
(`DaemonRestarts`), and app proofs say links weren't checked rather than
passing. A history read waits for its sentinel with replays spaced from 20 ms
doubling to 500 ms: each replay is a stream fseventsd registers, and at a
steady 20 ms a daemon 2.6 s behind was asked 130 times a read.
`scripts/test-file-events-service.ts` covers it against fakes, and
`test-watch-backend.ts` through a real child whose canary is held 400 ms
late. Tests that start apps reap them in `finally` and on a signal
(`scripts/lib/reap-apps.ts`): they're detached, so they outlived failed runs.

## Files

The Files view (the right sidebar's Files, the web app's Files over a Thread or beside its transcript, and the
composer's `@` list and the palette's Open file) reads one index per folder on the host that has the folder
(`workspaces/file-index.ts`, its pure core `contracts/file-index.ts`). It's built once: what Git tracks from its
index alone, so a 100,000-file repository is browsable in milliseconds, then the untracked files, which take a walk
of every folder, join it. A folder that isn't a repository is a bounded walk that asks each repository inside it for
its own files. After that every path the tab's watcher hears is asked of Git again at that path (`listFileStates`,
`ls-files -t` with the path as a literal pathspec), so ignore rules and new folders come out as Git says and the
index adds or removes what differs; only a lost event, a burst of more than 500 paths or an index nobody watches and
nobody read for five seconds reads the folder again. A conversation's folder browsed from another device has an index
of its own with a watch of its own, dropped three minutes after the last look (`ConversationFiles.index`).

A window asks for folders a few at a time (`mako:files-folders`, `mako:live-files-folders` for a conversation's),
each listed folders first and to 2,000 entries, a chain of lone folders folded into one row, and says which version
it holds, so a refresh with nothing changed is one small answer; Git's changed marks follow a step behind and never
hold a listing up. A name is found at every keystroke (`mako:files-find`): a character mask rules most paths out, a
query that only grew searches only the last one's matches, a match in the file name outweighs one across folders,
and letters strewn far from the best are dropped. Text inside files (`mako:files-grep`) waits for a pause, runs
`git grep` over what each repository tracks without `--untracked` (which walks every folder before its first match:
5.4 s against 76 ms on 100,000 files), reads the untracked files the index already knows itself, and stops at its
limit; a newer search in the same folder stops the last. A host older than these calls is answered in the window by
the same core over `listFiles`. Highlighting runs in Pierre's worker pool (`lib/highlight-pool.tsx`) with one theme,
`lib/syntax-theme.ts`, onto the `--syntax-*` tokens; each file wears its kind's mark (`lib/file-kinds.ts`,
`components/ui/file-icon.tsx`), drawn in one stroke on one grid and told apart by shape, never hue.
`scripts/test-file-index.ts` holds it to that, and `scripts/bench-file-search.ts` (CI's `file-search`) times it against
the old way in turns in the same run on this checkout and 100,000 generated files. `node scripts/files-ui.mjs` serves the real
panel and viewer over a folder's index, and `scripts/files-ui-shots.mjs` draws them, `--phone` as the web app does.

## Git

Every Git process Mako starts goes through `@mako/git` (`packages/git`, no Electron imports). Its `Git` class is the one spawner, and the package holds no state outside it: each host makes one in `createHost` (`hostGit`) and hands it to everything that runs Git, and a test makes its own. `run` strips repository variables (`REPOSITORY_VARIABLES`) and sets `GIT_TERMINAL_PROMPT=0` and `LC_MESSAGES=C`, and it applies timeouts, byte caps and allowed exit codes. A read (`read: true`) adds `--no-optional-locks` and takes one of the instance's six read slots. `background: true` runs below agents through the `background` hook `hostGit` gives the instance. Stopping the host closes it (`git.close()`), which closes every repository it opened. A failure is a `GitError` whose `kind` (`not_repository`, `local_changes`, `conflicts`, `rejected`, `auth`, `moved`, …) is what callers branch on, never stderr text. Don't spawn `git` anywhere else; add the operation to the package. Worktree orchestration (`thread-worktrees.ts`, spares, `worktree-carry.ts` with APFS clonefile) is Mako's product logic in `packages/host/src/workspaces/`, on the package's runner. A Thread's checkout is of its project: started in a folder that holds several repositories without being one, it's a folder mirroring that project with a worktree of each repository inside, on one branch (`createProject`). The store keeps one `thread_worktrees` row per Thread and the repositories in `thread_worktree_repositories`; review, update, merge and the Git panels stay per repository, while removal and moving changes take the checkout whole. Which repositories a project folder holds is `projectRepositories` (folders with a `.git`, never one inside another repository, a second checkout of one already listed left out, at most 12); a Thread's start, its spares and the Changes panel all use that walk, so don't find repositories another way. A project's spare is one folder mirroring it with a locked worktree of each repository, claimed only when it holds exactly the repositories the folder has now, and placed by renaming the folder and `git worktree repair` in each repository. Settings › Worktrees lists checkouts (`worktreeCheckouts`), not repositories' worktrees.

A move into a Thread's worktree takes only the Thread's own uncommitted changes (`workspaces/worktree-move.ts`), never a stash of the whole checkout. The attribution journal (`attribution/`, `partition`) names each changed line's last writer: the worktree gets the base plus the Thread's lines and the files it created, deleted or renamed; the main checkout keeps everyone else's. Lines that might be the Thread's (`window`, `ambiguous`, and a `window` found only after lost events, `entrySide`) and changes nobody can be named for (there before tracking, `unattributed`) stay unless the person chooses Bring these, on the move card before or on the toast after. A hunk that can't be split by line goes whole to whoever wrote most of it and is named. Without the journal nothing is attributed, so nothing moves unless brought. The move is all-or-nothing: it reads each file, checks it is what the journal holds and that the two sides add back up to it line for line, stores every version in the repository's objects, keeps the main checkout's whole state (files and index) as a commit under `refs/mako/moves/<id>` for 14 days, saves its plan (`<worktrees>/moves/<id>.json`, the receipt's `moving`), writes each file by a rename after checking it is still what it read, then reads both sides back. Anything off rolls back. A host that dies mid-move finishes it on the next start (`tidy`) when every file is as it was or as planned, and otherwise rolls back around whatever changed since. Each step is logged under `worktree-move`. `worktree_status` reports whose the main checkout's changes are; the move's result and the agent's message in the worktree say what came and what stayed. `npm run test:attribution` ends with `test-worktree-attribution-moves.ts`: three writers in one file, renames, deletes, binary and untracked files, staging, two repositories, and a process killed at each step.

What a turn changed has one source: the attribution journal, keyed by the request the turn answers (`LiveRequest.id` is the `turn` on every activity mark and entry; the harness's own run id rides along as `run`, metadata only). When a request's turn ends, `LiveTurnChanges` marks it `pending`, counts it from the journal once every change heard is in (`settling`), and again once the journal settles them (`settled`), into `LiveRequest.changes` (`contracts/turn-changes.ts`, `queries.ts` `turnChanges`: per file, first entry's before to last entry's after, each line counted for its last writer, the Thread's own apart from what only might be its). A count reads the journal a step at a time (`countingTurn`, run in slices, one count at a time), through the newest entry when it began, and letting go of idle roots reads it the same way (`JournalStore.recency`): each read at once held the host's loop over a second (`test:attribution-holds`). The same record is kept beside the entries (`turn_changes`). The line under an answer, its file links' "Changed in this answer" and "Changes made by the thread" (the sum of those records) all read it, so they agree, and a reopened conversation reads the stored record instead of counting again. A turn from before the record falls back to its checkpoints. The work summary counts steps ("made 2 edits"), never files. What Git put back (a checkout, pull, rebase, reset or stash no call named the file for) is journaled with `git` set, or not at all when a file holds exactly the new commit's content; no turn, "changes made", others' count, rewind writer, move or `worktree_status` share counts it, and a version Git puts back keeps the writers it had (a whole file's, too: `lastEntry`). A change a rescan finds after lost events is placed by its file's modification time: content older than the gap names nobody, and a file the journal holds as created though HEAD has it as it is (a commit took it before the journal read it) is settled as clean on the next start or rescan (`settleCommitted`). A Fin's roster entry on its Apex is no background work of the Apex's: the Fin is a Thread of its own, and its Sessions mark their own work. A call's exact bounds from a harness's hooks (`harnesses/call-bounds.ts`) go through `LiveActivity.bounds`, under the same request-keyed turn as the call's marks, so the journal has one record of each call.

Changes › Turn reviews any turn of the open conversation, live or reopened (`conversations/live-turn-review.ts`). Its files are the request's record; each diff is the turn's checkpoints when both were saved, else the journal's versions either side of the turn's entries, so Review on the turn line works without checkpoints, and a conversation nobody has open is read from its journal without loading it (`storedRequest`). Who wrote each changed line comes from the same walk the record counts with (`attribution/line-walk.ts`, `turn-lines.ts`), as runs per side (`mako:live-turn-writers`), drawn in the diff's annotation slot only where another writer shares a change block; "Only this thread's lines" redraws each diff with every other writer's change on both sides. "Undo this turn" (and "undo this thread") takes the scope's own lines back out of the files as they are now and puts back the lines it removed, keeping everyone else's; a stretch someone edited on top of since, or where a writer put back a line the scope removed, is left whole and named; what Git or Mako wrote is nobody's and stays. It's refused while a turn or background work runs in the checkout (the journal's open activity, on any host, and this host's own runs), and when the files changed after the preview (`token`). It writes with the move's writer (`rewriteInPlace` in `worktree-move.ts`): every version stored, the checkout kept under `refs/mako/moves/<id>` for 14 days, the plan saved in `<conversations>/undos`, each file checked and renamed into place, then read back; a failure puts every file back, and a host that dies mid-write finishes or undoes it on the next start (`resumeMove`). The index is left as it is. Rewind stays the whole-workspace restore. `scripts/test-turn-review.ts` covers it, and `scripts/turn-review-screenshots.mjs` draws it.

In a laptop's browser the web app is the desktop app, drawn by the desktop's own pieces (`src/web-client/desk.tsx`): the title strip (`TitleStrip`, without the traffic lights), the rail (`AgentThreads`), the Session tabs (`SessionTabList` in `WorkbenchStrip`), the transcript, the composer and the palette. The rail lists the account's Sessions as a Mac's window lists another device's (`listedSummary`, `desk-listing.ts`), so a Thread's Sessions fold into one row and file under their project; what it and the tabs open goes to the Session's address (`state/window-routes.ts`), and a window that routes offers its own Thread menu and nothing that needs a host of its own. What a Mac's rail shows of a row besides its state travels on the account's list from link version 12 (`ListedRail`: the project it's filed under and what that project has checked out, its Thread worktree's branch, the agents it ran in before, the background work its ended turn waits on), read by the Mac from what it holds (`ownedSessions`, `CheckoutHeadService.known`), and a window draws it with the same components as its own rows: the branch beside the project, the earlier agent's mark, the hourglass. Projects are in the same order on both: by when the person last sent a message there, from any device, as each Session's owner says it (`promptedAt`, link version 14). `?mock&app=busy` and `scripts/web-desk.html` draw the same busy Thread on both for side-by-side checks; `node scripts/test-web-desk-ui.mjs` holds the desk to the window's width and the rail to the desktop's.

The web app reviews turns too (`src/web-client/review*.tsx`): Review on a turn's line, and Changes in a Thread's menu, open Changes over the Thread on a phone, over its pane on a tablet, and beside the transcript on a laptop's desk. Its files and every count are the request's record, read from the conversation the page already holds, so they are the line's own. Each file's diff comes from its owner through the gateway as stretches (`mako:live-turn-hunks`, `conversations/turn-hunks.ts`): the changed lines with three around each, from the journal's own line diff, bounded by `TURN_HUNK_LIMITS` (4,000 rows, 256 KB), its writers with it only where someone besides the turn wrote a line, never both versions whole; a host from before it is read with `live-turn-diff` and `live-turn-writers` and drawn the same. It reads the files nearest the screen first, four at once, keeps what it read by the record in memory and in IndexedDB (24 MB), and a file past 400 changed lines or 24,000 characters waits behind "Load diff". A comment on a line or range is the desk's own comment chip (`CommentDetail`): on the desk it goes into the composer, on a phone it waits over the Session's composer (`review-notes.ts`) and goes with the next message in Mako's context format, or with "Finish review", never by itself. Undo there is the desk's: the preview, then the undo with its token, refused by the Session's computer while a turn runs. `scripts/test-web-review.ts` covers it, and the phone's behaviour cases `open-review`, `comment-to-draft` and `finish-review` drive it on a real gateway and Mac.

The agent's Git tools work in a project folder of several repositories, whose Thread checkout holds one worktree per repository, all on one branch. The `worktree_*` tools (`workspaces/tools.ts`) act on every repository at once. `worktree_update` updates each one on its own: the reply names each repository with what happened (merged, already current, refused and why, or stopped on conflicts with the files and how to finish), and a repository that's refused or stops doesn't keep the others from updating. `worktree_merge` checks every repository with commits before merging any; if Git still stops one, the reply says which ones merged and which didn't. A pull request belongs to one repository. `repositoryPlace` lists the repositories the calling Session can reach: this Thread's worktrees, each with its own start branch; the repository its folder is in; or each repository of a main checkout's project folder. Each is named by its folder in the project, which is how `worktree_status` lists it. Every `pull_request_*` tool takes that name as `repository`. Without it, a tool acts on the repository the Session's folder is inside, or on the only one. From the project folder itself, `pull_request_status` reports every repository. `pull_request_open` and `pull_request_merge` act only when exactly one repository fits (has work to push or open, or has an open pull request); otherwise they list where each one stands, before pushing or merging anything. The window adds the repository its Git panel shows to every staged Git action (`gitRepositoryName` in `contracts/git-actions.ts`, applied in `src/state/git-actions.ts`), so a person's button and the agent's call act on the same repository. `npm run test:thread-worktrees` covers both families: `test-git-actions.ts` against two real repositories, and `test-workspace-moves.ts`.

`git.openRepository(cwd)` returns one `Repository` per working tree (an LRU of 64 that never evicts a watched one). It keeps status in memory. `packages/host/src/git/workspace-git.ts` calls `watch()` when the repository is at or under the watched workspace and passes changed paths to `changed()`. The next `status()` then reads only those paths (`status -- :(literal)<path>`) and merges them in. Git's object store, locks, `FETCH_HEAD` and the package's own index copies are noise. Any other `.git` path, `.gitignore`, `.gitattributes`, `.gitmodules` or more than 500 paths means a full read, and so does a failed partial read. An unwatched repository (a linked worktree, or one above the workspace) is read in full every time. Entries come in Git's order: changes, then untracked files, each in byte order. Status runs with `--no-renames`: a rename reads as a deletion and an addition. Writes run one at a time per repository; `settled()` waits for them. Each repository keeps one `cat-file --batch-command` reader, closed after 30 idle seconds. Previews are cached per repository within one 64 MB budget per `Git`, least recently used first; worktree previews are cached only while watched. Commit drafting reuses piece summaries only from the `DraftSummaries` a caller passes; the host keeps one in `GitDrafting`.

A spare belongs to a project, whatever a start comes from: a Fin started from its Apex's worktree takes one of the real project's (`homeOf`), at the commit it asked for, and its start asks for more there. Keyed by the folder asked from, 27 of 30 starts with no spare on 2026-11-06 were these, looking for spares of a worktree, which has none.

A spare's tracked files are cloned from the main checkout wherever it holds the same file (`cloneTracked`), so a worktree shares their blocks rather than writing them: 59 MB of its own for `mako-backend` where a checkout wrote 694 MB, with a stale main checkout too, since only what differs is written. It's a hint for Git: the index is refreshed, which hashes every clone, and `reset --hard` writes what's missing or came out different. That costs time, 7.3 s against 3.3 s for `mako-backend` on a busy Mac, so only a spare's fill does it, in the background: a start with no spare ready writes its checkout as Git does. Node's `COPYFILE_FICLONE` copies on macOS, reporting success, and `FICLONE_FORCE` is `ENOSYS` there, so this calls `clonefile` itself.

Every spawn holds the host's thread for a moment, so what windows poll reads what a repository shares once, not once per worktree. `summaries` (every window's rail, every half minute and on focus) runs one pass at a time, shared by everyone who asked while the last ran; each pass reads a repository's branch tips with one `for-each-ref`, its start point once, and each worktree's `status` at most every 15 s, a wait that doubles to 5 minutes while nothing changes there unless a conversation is at work in it or its index changed (a spawn on Linux forks the whole host and held its thread for 300-450 ms, and 180 worktrees read every pass took 5 cores on this Mac), and keeps landing, ahead and behind by the commits they were read at. Before, each worktree spawned about seventeen processes outside the read slots: 1,800 a pass at 104 worktrees.

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

Settings › Models › Connections is every way the person pays for models, and
Add a connection lists them in four groups (`MODEL_CONNECTION_PROVIDERS` in
`contracts/model-connections.ts`). A subscription is a harness's own sign-in:
its row starts that harness's account sign-in (`accounts.signIn`), or, for
GitHub Copilot and ChatGPT through OpenCode, names `opencode auth login` and
reads OpenCode's login back. Mako never asks for, reads or keeps a
subscription's token; Claude connects only through the `claude` CLI's own
sign-in. A gateway, a local server or a custom endpoint is a
`ModelConnection` (`harnesses/model-connections.ts`, `ProviderHost.modelConnections`):
what it is in `<user root>/model-connections.json`, with no secret in it, and
its key the saved key `connection/<id>` its `credential` names. Check access
lists `/models` before anything is saved; a gateway's key goes only to its
own host, a local server is only ever on loopback.

What a launch receives of them is the model-route part of the layering
contract (`contracts/model-routes.ts`), the same for every harness: a
`ModelRoute` per model, with its connection, kind, wire (`anthropic`,
`openai-chat`, `openai-responses`), base URL, model and credential
reference, never the key. Each driver declares `modelRoutes` beside
`nativeRouting`: `accepts` (the wires and kinds it takes, and an adapter
that turns routes into its own configuration), `planned` (its way in, which
no adapter uses yet) or `absent` with why. `HarnessAccounts.launch` applies
them last for whichever harness launches (`routeLaunches`, wired in
`createProviderHost`), so every start and discovery gets them and nothing
outside an adapter names a harness; Settings lists a connection under every
harness whose declaration takes its wire and kind. OpenCode's adapter
(`opencode/connections.ts`) is the one built: each connection is the provider
`mako-<id>` in `OPENCODE_CONFIG_CONTENT`, an `@ai-sdk/openai-compatible`
endpoint with the models kept, its key in `MAKO_CONNECTION_KEY_<ID>`, which
the provider names in `env`, never in the config's text; OpenCode's own
discovery lists the models. Claude (`ANTHROPIC_BASE_URL` and a key per
launch) and Codex (`config.model_providers` and `modelProvider`) are
`planned`; Cursor, Grok and Devin are `absent`. A key that won't open (the
keychain locked) leaves its connection out of the launch and says so on its
row. `npm run test:model-connections` covers the store and the providers;
`npm run test:model-connections-live` adds connections, finds their models in
the installed OpenCode's catalog and runs a turn on one against a stand-in
endpoint in a scratch home; `npm run test:model-connections-ui` drives the
list and the dialog.
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

`docs/design.md` is the one reference: tokens, shape, the fin, the components to use and the motion rules, in a page.
`npm run lint` refuses radius classes, literal colours in classes and stylesheets, and the old accent
(`scripts/check-design-tokens.mjs`); the rest is review.

- Tokens live in `src/index.css` and nowhere else. No literal colors in
  components. Chrome (`--shell`) carries no shadow, ever. **No lines in the
  chrome.** The title strip, the rail and each pane's tab strip sit on the
  shell; a pane's body is the surface; panes side by side are parted by a 6px
  gutter of the shell (`Divider`, whose bar shows only under the pointer), and
  a pane's sections by tone and spacing, never a hairline. The composer's
  input is one raised box inset from its pane. Hairlines stay for content
  (a diff's file headers, a table) and controls (an input's or a button's
  outline). **Every corner is square**, as the fin is: the radius tokens
  (`--radius-*`) are all 0, so panes, rows, tabs, cards, fields, buttons,
  menus, dialogs, toasts, the composer, the prompt bubble and avatars meet
  at square corners. Only what means a dot (status dots, the unread sphere,
  a switch's knob, a sheet's grab handle) is round, through `rounded-full`;
  a device frame drawn to its hardware keeps the hardware's corners.
- **Two rails and the conversation between them; a tab is opened on purpose.**
  The right rail is the left's twin, on the shell with its row (`RailRow`):
  `SideRail` draws a row a surface in a fixed order, each with its `reading`
  at the end (lines changed, who needs the person in the attention hue), and
  `useOffered` keeps a row away while nothing stands behind it. A reading
  selects its own fact, so a token repaints no row. Changes is a list and a
  diff opens as a tab (`changesView` keeps Review, every diff in one scroll,
  in Settings). No Fin has a tab for starting: the crew card and the rail hold
  them, and `OpenFinTab` is the one tab of the Fin opened in place, whose close
  is the Apex again. The phone has a count in the bar (`PhoneFinCount`) and the
  crew card, whose rows open a Fin through `RoutedOpenContext` on the web, as
  `openFinInApex` does on the desk; a laptop's browser draws the same rail
  (`WebSideRail`: Changes, Files and Agents, at the desktop's width) and one Fin tab. Open Fins hold no state that can
  outlive them: `openFinInApex` is the one way in, routed by `windowRoutes.fin` where a Thread's page holds the Fin; the
  browser's `DeskFin` keeps its Apex inside the Fin, Agents keeps only that it's open and reads whose roster from what's
  on screen, and `watchApexView` ends the desk's view once anything else shows. `npm run test:side-rail-ui` holds the
  rail, and `test:fin-transitions-ui` each way in through closing, another Thread, a reload and the rail on every form.
- **One count and one vocabulary for an Apex's Fins.** Every surface (the
  composer's chip, the crew card, the rail's pips, the Agents panel, the stop
  card, the phone's row) counts from the Thread's one roster
  (`threadChildren` / `threadRollup` in `src/state/apex-fins.ts`) through
  `rollup`, and words it with `rollupLine`, `rollupChip` or `rollupLabel`
  (`packages/host/src/contracts/children.ts`). They are Fins, never agents,
  and they stand as needs you, working, queued, idle, failed or done; an idle
  Fin is open for its next message, so it is neither working nor done and is
  never background work. A Fin's step reads as a phrase (`readableStep`:
  "Running gh pr checks 340", "Reading desk.tsx"), never the raw command or a
  home path. "Waiting on 4 agents" beside "3 Fins working" is what happens
  without this; `npm run test:fin-counts-ui` draws every surface from one
  roster and requires the same numbers, and `test:fin-words` holds the words.
- **A Fin's row says how long it has stood as it does, never how old it is.** `childSince` is the one rule, carried
  as the entry's `since`: a working Fin's current turn, from when its request was dispatched (`dispatchedAt`), since a
  message can wait long after it's admitted; one waiting on its own Fins from when its turn ended; each other state
  from when it got there. A working Fin with no known turn says no time. Its line always says something (`At work`
  with nothing else known), and "answered" only for an answer to this turn, in plain words: a plain message from its
  Apex may close a question (rule 13), and it's still the next job and not an answer. `npm run test:fin-row-time` holds the rule, and
  `test:orch-deliver` and `test:crew-card-ui` the real turn and every form.
- **The notice above the composer speaks for what the person did.** A steer Mako sent by itself (a Fin's digest, an
  Apex's message) raises nothing, whatever became of it, and hides nothing of theirs: what the harness didn't take goes
  as the next turn, which is Mako's to handle. `actionNotice` picks the person's newest, and `sentByMako` tells them
  apart by Mako's header, so a row already kept stops raising it. What stands over the composer keeps to its edges, on
  every form: `npm run test:steer-notices` and `test:composer-edges-ui` hold both.
- **Every message wears who wrote it, as a square** (`message-avatar.tsx`):
  the person's own face beside their prompt, at its last line; an agent's
  fin, still, with its harness as the badge, on its reply's byline; and a
  Fin's own fin beside each report it sent its Apex (`FinReports`), where the
  person's face stands. Every avatar is square, the rail footer's too. Real shadows exist only on
  floating surfaces (`.overlay-panel`: menus, palette, dialogs).
- **The ramp is warm neutrals — red-shifted near-blacks, warm off-white
  text — and stays that quiet.** The one accent is the brand's sea
  (`--sea`): the steel blue of the fin's lit face in the icon kit
  (`mako-icons/_masters`, #415f81 to #6386a6) and the marketing site's own
  `--sea` (mako-cloud `apps/site`), hue 245. Until November 2026 the accent
  was an orange "ember" that appeared nowhere in the brand. It is
  punctuation: the open Thread's lit fin, the glint crossing a working fin,
  the composer caret, at most one badge. Never on links, borders, focus, selection, hover
  fills, icons at rest, or any fill larger than a badge; if two sea moments
  are visible in one pane, one is wrong. Selection and hover are tints of the
  text colour (`--fill-hover` / `--fill-selected`), never the accent. Beyond
  sea, hue appears only where it carries meaning: diff add/remove, error,
  warning.
- **Every Thread and Fin wears Mako's fin, doing what it does** (`LiveMark`,
  `src/components/ui/live-mark.tsx`; states, kinds and motions in
  `src/lib/live-mark-state.ts`). A Thread is the two-tone fin of the app icon,
  a Fin the plain fin, and the harness a small square badge in the corner:
  the harness is secondary, the brand's fin is who. The fin itself moves, one
  calm gesture a state, as Grok Bot's character does rather than a spinner
  beside an icon: a working fin catches the light (a band of the sea crosses
  it, clipped to its outline), and thinking it bobs, writing it glides,
  running a tool it braces in two steps (`motionOf` reads which from the
  status line or step), its turn done with work still running it bobs at
  half speed, needing you it turns the attention violet over a breathing
  waterline,
  asking its Apex it drifts, failed it lists over in negative; queued, idle
  and open elsewhere are still and dimmed, and an answer to read wears the
  unread sphere. The open Thread's face takes the sea, the pane's one accent.
  The rail, the tabs, the Agents panel, the crew card, the Inbox, the folder
  chip, the asks and the phone draw this one mark, and avatars draw it still.
  Its motion is `transform` and `opacity` on HTML boxes only (an SVG
  element's own transform runs on the main thread), every moving layer runs
  on the shared clock and rests off screen (`observePhaseLockedAnimation`,
  whose play-state rule must stay as specific as the state rules' shorthand
  or they reset it), and no React state moves it. `npm run bench:live-marks`
  holds 500 moving marks, and the desk at 500 more Apexes watched in one load
  with its marks stopped and then moving, to no React commit, no layout and
  no style pass per frame; `scripts/live-marks.html` draws every state.
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
with several is one row wearing the live mark of the Session its most
demanding status comes from (`src/lib/thread-fold.ts`), and clicking it
opens the Session you last had open there. `+` and Cmd+T open the Thread's
new tab; nothing is created until its first message is sent, an empty new
tab disappears when you leave it, and one holding unsent text stays as a
Draft tab, its text kept per Thread (`src/state/thread-sessions.ts`). An
untitled Session's tab shows its agent's name, never a shared placeholder. A fork
joins its parent's Thread as a tab unless Option-click asks for a new one.
Moves are per Thread; no control offers to move one Session.

This is changing: a Thread becomes one conversation (`docs/one-conversation.md`).
The Thread store's split of every multi-Session Thread, forks and `+` as
Threads beside their source, and shared places (`thread_places`, `placeOf`)
are built behind `ThreadStoreOptions.oneConversation`, off except on an
isolated host with `MAKO_ONE_CONVERSATION=1`; the windows' half is listed
there. `npm run test:thread-split` covers the split.

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
second animated status. The composer carries no Queue/Steer control: the
placeholder and the send button's icon say what Enter does, Cmd+Enter does
the other, and the preference is a row in Settings > Conversation. The
composer bar has no overflow menu either. Its `···` once held a compaction
control, saved messages, the history of switches, steering and approvals,
and End live session, and showed a days-old "Steering message not accepted"
to a person who had never opened it. Each has a home now or is gone:
compaction is in the context meter beside the composer, a message that
wasn't answered is its row in the transcript where it failed, a switch, a
steering message or an approval is a notice above the composer only while it
is under way or went wrong (`src/desk/notices.ts`), and an idle provider
closes itself after ten minutes. A notice that no longer stands is not kept
anywhere to be found later. The
routing row gives way in a fixed order as the pane narrows (the centre can be
450px), found by measuring rather than a width breakpoint
(`use-compact-row.ts`): the access chip drops to its glyph first, the harness
chip second, and what still overflows scrolls behind a faded edge instead of
being cut off silently. The model and its reasoning are what people read
there and are never shortened.

Setup is what each place a project's Threads run in has for the project:
Settings › Apps › a project › Setup, a Setup tab in a Thread's side panel
showing that Thread's own place, and the phone's Settings › Setup. A
segmented control picks the place (this Mac, each device, Cloud); six parts
follow in a fixed order (Needs you, Code, Files, Accounts and secrets, Tools,
Services), and every row ends in one dot and a few words against its source
(`syncWords`: "Synced 2 d ago", "Mac's is newer" with Send, "Copy · 3 h old",
"Waiting on you", "Not here" with Add, "Didn't copy: couldn't be read" with Retry,
"Stays here"), never colour alone. Every row is a borrowing grant or lease
(`@mako/protocol/borrow`), an agent's ask, or a place's own reading (the
recipe's carry, prepare and processes, sign-ins and saved keys by name), and
`setupView` in `@mako/protocol/setup` (re-exported by
`@mako/host/contracts/setup`) derives them all, with `SetupViewSchema` for the
page, so the host (`workspaces/setup-view.ts`), the mock bridge and the
account's broker answer one page by one function. The host reads this device's own brokers (the worktrees' checkouts, the
saved secrets) and the account's (`/v1/borrow/*`), and sends each answer and
Stop back to the broker that holds the ask or the grant. Agents propose; only the person's tap adds: an ask is in Needs you, in
the Inbox and above its Thread's composer, and Keep, Add to setup and the Add
menu draft the recipe change in a new Thread for the person to send. No value
is ever shown. `packages/protocol/test/setup.mjs` (in `test:protocol`) covers the
rows and words; `npm run test:setup` the host's readings and brokers.

## Notifications

Five kinds, the same on every surface (desktop, web app, Web Push), declared
once in `@mako/protocol/attention` (re-exported by
`@mako/host/contracts/notifications`): `needs-you`, `question`, `approval`,
`failed`, `finished`, with one rule (`attentionFact`), one key, one test of
whether a fact still stands (`factStands`) and one wording table
(`ATTENTION_WORDS`). A Session's owner says what it waits on in its row
(`waitingFor`); never read the kind back out of `waitingOn`'s words. Starting,
tool calls, and attach/detach never notify. The attention
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
the rail's own marks and the Inbox already say. The list is the Inbox
(`src/state/inbox.ts`, opened from the rail's top rows or Cmd+Shift+U, which
pressed again opens the first item), the announcement is the toast, and the
Inbox row's caution count is the rail's one count. Banners and the badge are
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
`npm run test:notifications` (`scripts/test-notifications.ts`, in CI) covers the policy, bursts, retirement,
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
A host that stops leaves none running: discovery ends its queries and refuses
any asked after (`DiscoveryProcesses.stop`), and once every owner has stopped
its own, whatever is still recorded gets SIGTERM, then SIGKILL, with its process
group (`ProviderChildren.end`). A Grok sign-in check asked as a host began
stopping once spawned after it and went on writing into a test's scratch home
while the test removed it. A test removes a scratch folder with `removeScratch`
(`scripts/lib/scratch-processes.mjs`), which waits for whatever still runs there
and names it instead of flaking; `test-isolated-host.mjs` asserts none is left.
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
repeats a call once a host is there to take it (the same one, shown alive, or
the one the event stream reattached to) according to one table,
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

A window's connection status follows its event stream, never one call
(`HostLiveness`, `packages/host/src/contracts/host-liveness.ts`, used by
`client-main.ts` and the web bridge). The stream is open while the host runs
and carries a heartbeat every 15 s, so the reconnect banner goes up when it
ends and comes down on the next `ready`, or as soon as the same stream is
heard again. A dropped call with the stream open asks the host's `/health`
and listens to the stream; either answering keeps the window connected and
the call is repeated at once, and only no host at the socket or 35 s of
silence raises the banner. A call that waits past its deadline is
`HostCallTimeoutError`: slow, never a disconnect, never repeated, and
`unconfirmed` for a mutation. Every request to the host opens its own
connection (`agent: false`): on 2026-10-30 a window kept the banner while its
host streamed on, because the host, its event loop held past its five-second
keep-alive, closed a pooled connection a read had just been written to, and
the reset read as the host leaving. `test-host-liveness.ts` covers these.

Every `live-batch` and `LiveSummary` carries the host's `epoch`, minted per
`LiveConversations` instance: its start on its data root (`g<generation>.<root>.…`,
`takeHostStart`, one past the last, kept on disk before it's used), or, from a
build before starts, none. Revisions climb within one epoch, but a recovering
host rewrites what it reopens at the same revision and two hosts never share a
counter, so `live-recovery.ts` merges a batch onto held state only within the
epoch, and orders what hosts said by their start, then revision (`olderThan`),
never by a clock. A reply whose order can't be established (a build before
starts, another data root) never replaces what the window holds: the current
host is read afresh. A batch of another start buffers and takes a snapshot;
after it, what waited goes on if it's of a newer start or of the one the stream
last said, and is otherwise past: replayed, it would ask the new host for a
snapshot in its numbering forever (a window once reread one conversation every
280 ms for an hour after a restart). An unstamped batch (an older host) still
applies by revision. `test-prompt-delivery.tsx` covers both.

What reaches the window about a live conversation goes through one door,
`receiveLive` (`src/state/live-door.ts`): a batch, one that waited on a
snapshot, a listing or a reconnect's summaries, an unlisting, its owner's
connection, a move's, a return's or a continue's step, a snapshot (a read's or
an action's answer) and a history page. What its host says unasked goes on the
record of every read of it out (`moved`, `heard`), so no answer of a read
speaks for what came after it was asked. A reconnect's summary carries no
permission, so a Session of this host keeps the one it had and is read again.
`test-ask-notices.ts` generates host restarts, late and stray replies, and
batches and listings while reads are out (300 runs, in `test:notifications`);
`test-live-door.ts` drives each way in under a watch of the store that fails on
any write around the door (`watchDoor`), which the window's suites keep on too
(`failAroundTheDoor`).

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

The person's access choice per harness (the mode a new session of it starts
in) has one owner: their Mako account (`@mako/protocol/access-choices`,
`GET`/`PATCH /v1/access`, said whole on the account's stream as
`access-chosen` at a revision). Every surface reads and writes it there: a
window through its host (`AccessChoiceStore` in
`packages/host/src/harnesses/access-choices.ts`, `mako:access-choices`,
`mako:access-choose`), the web app and a phone straight from the account. The
host keeps the last revision it heard in `<user root>/access-choices.json`,
with any choice it couldn't send yet laid over it and sent at the next sync,
so a start offline still has it and a Mac that isn't signed in keeps its own.
`mako:live-start` without a `modeId` starts a new session (a fresh Thread or
an added Session, not a resume) in the person's mode for that harness,
whoever asked: a window, the web app or a phone through the Mac's link. The
web passes the mode it shows to every start, the cloud's included, since a
machine acts for no account. A window's old `providerModes` preference is
handed to the host once (`mako:access-adopt`), taken only for harnesses with
no choice yet. A move to the cloud carries each session's mode, and a return
remembers the mode it ran in there (`rememberMode`).
`scripts/test-access-choices.ts` covers the store.

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

So a send needs a target, not a fresh read. A conversation opened from the
window's cache (or painted from its record's tail) is on screen while its
fresh read lands, and the composer sends to it at once (`openingHoldsSend`
in `thread-viewing.ts`). Only a session the window itself routes from its
ref (`copyOnly`, `resumeUnavailable`: straight to a move) waits for that
read, at most four seconds, its send button turning meanwhile. With nothing
on screen yet the button turns and Enter says nothing. A refresh that
fails leaves the saved messages on screen under one quiet "Couldn't refresh
· Retry" line, and they still take a send. An open that fails with nothing
to show is said by the viewer alone; Enter there says "Could not load this
conversation" with its reason and Retry loading, one notice however often
it is pressed. A reconnect reads either again.
Before this, every Enter on a cached conversation stacked "Wait for this
conversation to load" while a slow host read it. `test-thread-opening.ts`
and `test-opening-send-ui.mjs` cover it.

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
when something needs it, its finished entries are paged (`paged-entries.ts`,
above), and it is let go once the memory budget has no room for what is left
of it and nothing is using it. Everything that lists conversations, every second or
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

The report reads the Thread store once for all its rows: who executes each
Session (`ThreadStore.executionsOf`) and each Thread's name (`titlesOf`), one
query each, answered from memory until any commit, this host's or another's
(`revision`); `groups()` is one query, kept the same way. Before, each row
read both alone, about 900 queries a report on this Mac, and `groups()` took
a query per group and per Session each time the window's rows were read;
`npm run bench:session-report` measures it against a copy of this Mac's store.
One link has one reporter: a cloud machine's is its machine runtime's tick,
and a link the publisher already reported on, served again after a moment
without one, isn't told everything again. A change a list shows goes out at
once, on a Mac and a cloud machine alike: each batch is checked against what
the list shows of its conversation (`conversationShown`, the rule its row is
made with), and one that moved it (working, waiting, idle, failed, what it
waits on, its title) is reported on the next turn of the event loop, at most
every 100 ms, without waiting for the second's pacing or a held foreground.
A Thread renamed or a Session archived here goes the same way: no batch says
either, and a rename once waited for whatever next marked the list changed. So
does a new conversation, once its journal is placed (`opened`), before its
harness starts and sends a batch; and a turn's last batch comes after its
"after" checkpoint, so the list reads it at rest.
On 2026-10-28 status waited for the 1 s tick and took 0.4 to 2.7 s to reach
a phone. A row's `activityAt` alone is said at most once a minute
(`ACTIVITY_REPORT_MS`): said with every batch, it was half the account's
events. A Mac delivers each account event as it's heard, in order, and keeps
the last one heard (`seen`) a couple of seconds later, with every keychain
write of the sign-in in one queue. A watched conversation's live
updates go out through `gatewayEventLine`, as a cloud Thread's events do: a
batch over `MAX_EVENT_BYTES` goes as the notice that its history changed
(`historyChangedNotice`, the same one a window's event stream sends for a
batch over its limit), which the watcher answers by reading it again.

A dropped or stalled link costs a watcher nothing it can see
(`@mako/protocol/live-tail`, link version 9). The gateway numbers each
watched conversation's stream itself, from a base above every number it gave
before, and keeps its last 512 updates (256 KB) in memory (`LiveTail`); a
stream its last watcher left lingers `LINGER_MS` (30 s), its owner still
sending. A watcher hears the stream's head first (`streamNotice`), then, when
it subscribes after the last number it holds, what it missed from the tail,
or `reread` past it, the one case that reads a snapshot. Followers
(`CloudConversations.#follow`, the web client's `#run`) keep their place with
`StreamCursor`: a skipped number is asked for again at once from the tail, a
stream that ends is followed again at once with jitter (`followAgainInMs`),
and a conversation at work that goes silent `SILENT_WHILE_WORKING_MS` (3 s)
has its connection pinged (`probe`) and replaced unless it answers in
`PROBE_ANSWER_MS`. A gateway that sends no notice is read as before. The
owner numbers what it sends (`live`'s `n`) and keeps each watched
conversation's updates (`KEPT_BYTES`): its publisher learns its link when the
link is served (`linked`), not at the next tick, and a new link's `watch`
says what the gateway last relayed of each (`after`), so what went into a
dead link's last moments is sent again, relayed once, or past the bound
replaced by the notice to read it again. A Mac's runtime link silent while it
sends what's watched is probed the same way (`CloudLink.probeIfSilent`), and
a link that worked for `STABLE_MS` (5 s) comes back in a quarter second. A
cloud Thread's watchers resume its log after the last event heard; the
account's stream is gap-checked on every device, and a skipped or `lost`
number reads the list whole again (`onAccountGap`). Before, a dropped watcher
waited a second, missed what went by and read a snapshot; a lost last batch
left a turn looking busy on every other device; a stall went unseen for a
minute.

A conversation's batches go in the compact live form wherever everyone
reading them reads it (`@mako/protocol/live-form`, link version 13). A client
says the form it reads as it connects (`?live=2` on its connection's route,
`x-mako-live` on a host's `/events`); one that says nothing reads the whole
form. The gateway tells each owner the form every current watcher of each
conversation reads (`watch`'s `forms`) and every reader of each Thread it runs
(`live-form`), again as one comes or goes. The owner's host writes each batch
both ways (`compactLiveBatch`, in `LiveConversations`' flush) and its link
sends the compact one only where the gateway said so, from the next update on
(`SessionPublisher.#send`, `RuntimeThreads`); one still in flight as a reader
of the whole form came reaches that reader as `reread`, never misread. A
compact batch says only what changed since the revision before: more of the
answer last streamed (`more`), the changed fields of a request or binding the
reader holds, no `changedFrom` the block count implies, no file a call's
frames are in that the call names, and on the gateway no route around it (its
line is read by its first characters, `readEventLine`). Every reader decodes
it in one place, `applyLiveBatch` in `live-recovery.ts` (`expandLiveBatch`),
the desktop's windows and the web client alike, and one it can't read against
what it holds (a batch missed, a `more` with no answer to go on) is read again
as any gap is. A Mac relays another device's conversation to its windows as
heard, marked compact (`form`), and a window that reads only the whole form
gets the notice to read again in its place. The owner's host logs each change
of form under `sync`; the gateway logs `live-form` with how many read it and
how many of them read only the whole form; Settings › Diagnostics' Sync says
how many watched conversations go compact, or why they go whole, and each
followed stream how much of it came compact. `test-live-form.ts` and
`test-machine-runtime.ts` cover mixed readers on a Mac and a machine, and the
protocol's conformance runs mixed watchers, an old link and a resumed one
against any gateway.

A host's own windows hear rosters as what changed, form 3 (`ROSTER_LIVE_FORM`): the entries new or changed, those gone and a seal over the resulting roster, every field in order. The writer falls back to a whole roster when a patch costs more or cannot preserve order. A window applies it only against the preceding revision in the same host start; a failed seal or missing base follows the existing guarded snapshot recovery (`receiveLive`, `hydrateLive`, `readLive`), including for listed Sessions. There is no separate roster revision or read history. Other readers keep hearing rosters whole (`LiveForm` stays 2). `test:roster-delta` checks the contract, real renderer recovery and generated lifecycles.

One update can be followed from its owner to every device. One batch in
`TRACE_EVERY` (25) of a conversation, and each that starts or ends a turn or
asks or answers the person, carries `emittedAt` and a trace (`traceOf`,
`TRACE_PREFIX` `st-`), which rides as the event's correlation ID (a cloud
Thread's `event`, a watched conversation's `live`): the owner's host logs
`traced update sent`, the gateway `event trace` or `live trace`, and each
Mac that hears it `traced update heard` with its lag, all under `sync` and
the trace. Search one trace across host logs and the gateway's to see
every hop's time. Each device keeps its readings in memory
(`SyncRecorder`, `contracts/sync-readings.ts`): for each stream it follows,
traced lag, skipped numbers asked for again, rereads, probes, and why it
followed again (`closed`, `silent`, `gap`, `failed`); for the account's
list, its stream's number, its gaps, and each change's time from its owner
(`changedAt`); and on a Mac what it sends of its own watched conversations
(in which live form, resent, notices). Settings › Diagnostics shows them as Sync
(`mako:sync-readings`, `SyncReadout`), the phone's Diagnostics in its
lines, both in the same words (`describeFollow`, `describeList`). Lags are
each device's clock against its owner's, good to a few milliseconds where
clocks keep time.

`npm run bench:sync-latency` measures how long another device takes to see
what one does, on the real code (`scripts/bench-sync-latency.ts`): two
screenless hosts of the checkout signed in to one account, A running a sealed
Codex against the stand-in model paced to 50 words a second (`pace` in
`scripts/scripted-model.ts`), B opening A's conversation as a window does; a
phone played through the web client's `Gateway`; and a cloud Thread's
`MachineRuntime`, in process, fed A's batches. Each word is unique, so its
first arrival anywhere is found by its text, and one clock times every hop.
Each device's link is a proxy the bench stalls or cuts. Without `--cloud` the
cloud is the protocol's fake gateway behind the routes a host and a browser
use (`scripts/lib/sync-bench-cloud.ts`), which keeps no presence, so the quiet
phase (`--quiet`) needs a real gateway; with `--cloud <url>` a helper on stdin
and stdout plays the person there (`helperCloud` says the asks). It prints one
JSON report: live content per hop, status on the phone's list and the second
Mac, six link disturbances (words missed, time to current, rereads, a stall
noticed, and with the owner's last batch lost, when the turn's end showed),
quiet devices, messages and bytes per token per hop, and from each word to
its paint on each device (`paint`: the device's arrivals through the window's
own `StreamFrames`, which per-hop latency leaves out). It judges the plan's
budgets so a busy runner can't fail them and a real regression still does.
Counts fail at once: words missed, whole snapshots read, batches past one a
paint frame (`LIVE_FRAME_MS`) of the words
the model wrote, and bytes a token as if each batch carried the plan's two
tokens, so the runner's pace doesn't move them; and the design itself (the
protocol's silence and probe within the stall budget, a frame of at least two
tokens). Times, and a change held past the status budget that a device
never showed, are read past the owner's own showing, which leaves the
harness's time out, and at the median; a stall must be noticed while it
lasts (8 s, against the design's 4.5). A time over its limit is measured
again in a second run, and fails only if it's over in both (`--once` skips
that). On 2026-11-05 a turn's start on the second Mac read 327 ms at p95 on
one CI run, Codex taking the prompt; the regressions these guard (a report
waiting for a tick, a hop held a frame, a reconnect waiting a second) are in
every run. Past a budget it exits 1 unless `--report-only`; a run that
doesn't finish exits 2. Every check goes to the job's summary. It takes
about two minutes and needs a real Codex CLI; CI runs it against its
budgets with Codex at the tested build (`sync-bench` in `checks.yml`). The
first baseline is `docs/public-audits/2026-10-28/sync-latency/`.

The account's rows here (`CloudConversations`) take nothing from a catalog that
isn't read: until `catalog.ready()`, and while a lost reader is replaced,
`keepsNative` says nothing (undefined), and a row it would decide is left as it
is, listed or not. A catalog write names its native session
(`nativeChanged`), and writes are looked at together every 250 ms, one look at
a time, at the rows naming them alone. An account event is looked at for the
rows it names alone too (`#named`); a device going quiet or a Thread archived
looks at every row. Whether a device is quiet is the list's
to say of every one of its conversations, one a window follows included: a
quiet device sends no batches, so nothing else ends its working spinner. A Mac
going to sleep, shutting down, quitting or signing out says so on its runtime's
link first (`going-quiet`, link version 8; `mako:machine-leaving` from the
desktop app's `suspend` and `shutdown`), and the link stays closed until the
wake (`CloudLink.quiet`), so its device is quiet at once rather than after
missed heartbeats; `test-cloud-account.ts` covers it. The cloud hears it only once
the handoff under way answered (`machineLeaving`): agents at work go to the
cloud as a Mac goes off, as it sleeps (the sleep watch holds the sleep,
`SleepHandOff`), as it shuts down (the desktop app tells the host on
`powerMonitor`'s `shutdown`, prevented until Mako quits, and the host hands
off within `SHUTDOWN_HOLD_MS`, its own stop waiting for what's still under
way as long again; a quit's Apple event fires no `shutdown`, and isn't held,
since a quit held during a shutdown reads as refusing it) and from the quit
sheet (`CloudHandOffs`). A Thread
in the project folder is paused first and goes onto its own branch as the
same session with only its own changes (`ownBranch`'s `asItself`), then to
the cloud. One a Mac going off couldn't release in time stays with its turns
paused (`goesOff`, `parked-turns` beside the moves' plans), so it reads idle
for Continue in the cloud from another device; a continue this Mac joins
carries those turns there, and otherwise they go on here once the Mac hears
its account (`CloudMoves.unpark`, on `ownerChecked`). While a Thread in the
project folder works, it's kept ready like one in its own worktree
(`CloudReadiness`): its cloud Thread stands by at the worktree its move would
make, named ahead from the same names a move tries and with nothing made
(`ThreadWorktreeService.plannedCheckout`), so a handoff takes a machine
already up rather than one it boots.
`test-handoff-going-off.ts` runs it on the host's own parts with scripted
harnesses and a stand-in cloud. A Thread's name is the
list's to say too: no batch carries it, and a followed conversation once kept
its old one on a second Mac while the phone showed the rename. The
account's archived cloud Threads are said only from a list the account
answered (`archivedChanged`), never as none at a sign-out, and
`ThreadArchives` keeps their keys by account, so a restart shows them
archived before the list is read again. `scripts/test-thread-store.ts`
(`manyAtOnce`), `test-account-threads.ts`, `test-cloud-conversations.ts` and
`test-thread-lifecycle.ts` cover these.

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

The SDK saves a new root after every step and never deletes the one it
replaced, so an agent's store grows by its whole hash list each step (on
2026-11-01 one long-used Mac kept 30.85 GB of them, one agent 9.45 GB of
roots in a 10.63 GB store). Mako collects them
(`packages/sessions/src/providers/cursor-sdk-collect.ts`): it keeps every
root a run, the meta row or a kept blob names, and every root the
compaction search settles on, deletes the other roots of an agent idle for
half an hour (five minutes when the person asks) in short checked
transactions, and VACUUMs once enough went.
The host runs it in a worker per agent (`harnesses/cursor/sdk/checkpoint-collector.ts`),
every six hours, on a disk under 10 GB free and from Settings › Storage, and
stops a sweep of an agent the driver or the native runner is about to open
(`hold`). A VACUUM holds the store for seconds, so `patch-cursor-sdk.mjs`
raises the SDK's busy wait to a minute. `packages/sessions/test/cursor-sdk-collect.mjs`
covers crashes between batches, a write mid-sweep and that every agent reads
the same after; `scripts/prove-cursor-checkpoints.ts --root <copy>` collects a
copy of a real store and diffs every agent's read.

Settings › Storage (`usage/storage.ts`, `mako:storage`, `mako:storage-free`)
measures each folder in the user and data roots with `du` off the event
loop, lists each harness's `HarnessStorage` (`host.storage`), frees what they
collect on request, and warns once through a `notice` when the disk drops
under 10 GB free. `scripts/test-storage.ts` covers it and
`scripts/storage-ui-screenshots.mjs` draws it from the mock bridge.

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
no project rules. `Run.steer` cuts a running command short (SDK 1.2.0: a
foreground `sleep 150` ended 0.5 s after the steer) and the model continues
with the message, so the driver advertises `interrupt`. A running `task`
subagent is not cut short: the SDK holds the steer until it returns (136 s in
the same check) and answers `revert_to_followup` for one its run ends before
taking, so its words go as the next message; the driver declares that answer
(`answersOnEnd`), and `LiveActions.settle` waits for it rather than calling a
stopped turn's steer unknown. The SDK runs every turn with a logger that
drops every entry, among them its retry, resume and stall account
(`[nal_agent_retries]`, `[AGENT_ERROR_DIAGNOSTICS]`); `scripts/patch-cursor-sdk.mjs`
hands each entry to the process and the child writes those to the host log
(`run-log.ts`). `@cursor/sdk-*` is
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
into the running turn at the agent's next step (Claude, Codex, Grok through
`_x.ai/interject`, OpenCode, Devin); `interrupt` cancels the current step and
continues with the message (Cursor). `hears` says when the agent hears one, as
`npx tsx scripts/probe-steer-semantics.ts [<harness>...] [--cursor]` reads it on
each real harness against the scripted model (Cursor on its own): a 15 s
command steered 4 s in. Claude, OpenCode and Grok hear it once the command
returns; Codex's command yields to the model at once and carries on; Devin
hears it when its command hands back, which it does by itself after about 10 s;
Cursor cuts the command short. A Stop ends the turn within 0.2 s on all six. Enter steers a steerable running turn and
Cmd/Ctrl+Enter queues; the `steerOnEnter` preference swaps them. Re-verify a
provider's kind with a real multi-step tool task before changing it: a single
long generation cannot distinguish step delivery from turn-end delivery.
Each renderer and web document owns its workspace pool and git target, selected
through async request context. Provider conversations remain shared. A preview
must never change another window's cwd, file target, or active workspace tab.
The rail opens with five fixed rows (`src/components/rail/rail-top.tsx`: New
thread, Search, Inbox with its caution count, Pull requests with the open
count, Automations with how many are on; a window that routes, the web desk,
has no project of its own and shows the first three), then Pinned, then
Threads by project. There is no view switch: Recent, a bounded chronological
list, and Archived are choices in the Threads heading's filter menu, and the
heading names the one showing and leads back. The phone's list
(`src/web-client/list.tsx`) has the Inbox as a chip, then Needs you (each Fin
asking as a row of its own, "Mobile polish ·" before its question), Working
and Recent, and `/inbox` is its Inbox screen (`inbox-screen.tsx`, the same Fin
asks answered through `answerFin`). Where a Thread runs and its project are said
in one order on every screen, the device then the project ("build-box · mako"),
from one function (`placeLine` in `src/web-client/threads.ts`): the list's row
leaves the device out while the account has one. The rail and the list carry no lines:
spacing and type part them. Never gate provider names or the rail on model discovery.
Position in the rail never carries status. `stableThreadRanks` in
`src/lib/thread-folders.ts` gives a busy thread its rank when it starts, keeps
it while the thread is working, observed, or externally active, and settles it
once when it finishes, so a file that changes on every token moves nothing.
A folder's place is when you last worked there (`workedFolderRanks`): the
newest of its Sessions' `promptedAt ?? createdAt`, counted before the fold
hides any, so a prompt from any device or a Thread started lifts it and an
agent's reply or a finished turn never does. The time is the owner's: each
host reads its conversations' requests and steers (`personPromptedAt`, kept per
journal in `prompted`) and says it on their rows from link version 14
(`ReportedSession.promptedAt`), so every Mac window and the web order the same
rows by the same function, and the order is the rows', whatever arrived first.
A cloud Thread a Mac started takes its machine's word on it from the list
(`CloudConversations`), and remembers it for its next start. A Mac's host
doesn't keep the account's list between starts: other devices' rows arrive
when it's read, a second or two after the window opens, and a folder last
worked in from elsewhere rises then, once.
`test-rail-order.ts` holds a Mac's window and the web to one order. Status
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
`test-rail-ui.mjs` cover both marks. Rows never regroup by state: what needs you is
the Inbox, one list across Threads and Fins read from the records the marks
read, answered in place; Archived is reached from the filter glyph. While the pointer is inside the rail the order caught at
entry holds, so a click cannot land on a row that moved, and rows that do
move glide there through `use-row-flip.ts` (transform only; nothing on first
fill, view changes, offscreen, or under reduced motion). Every folder shows
the same number of lead rows; selecting a project never resizes one.
`test-stage-layout.ts` covers the ranks and held folders;
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
resume re-runs the tool calls still in flight under the same call ids, so a
cut while `task` subagents work starts each over: on 2026-10-31 (SDK 1.2.0)
five 18-minute subagents restarted twice, 49 s and 34 s apart, before the
no-progress error; the same subagent work ran 21 minutes uncut in a
scratch check, so a long call alone doesn't cut the stream. A
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
A continuation never reads as a new turn. Its words are Mako's, whether Mako
sent them or the person pressed Continue turn, so they are never the
person's bubble, and the turn reads as one run: `toExchanges` puts a
continuation into the exchange it continues (in the lead exchange when that
turn is on an earlier page), where it draws nothing. The fold times the
turn's work without the wait before it went on. How the turn ended is its
newest part's (`turnRequest`), so the stop it went on from leaves no footer,
and the provider's own stop marker at that seam is dropped
(`notesBesideContinuations`). Each part keeps its changes row. The words
alone mark a continuation, the same live and saved: a store keeps only the
words, so `continueTurnPrompt(reason, sender)` ends with a sentence naming
who sent it, and `savedContinuation` reads both back whole; words from
before that sentence existed name no one. The facts stay one switch away:
with Settings › Diagnostics' originals on, the seam is a quiet line saying
why and who ("Mako restarted Claude Code and continued the turn"), opening
onto the exact words, with their Original. A step a lost machine undid
changed the person's files, so that seam always says so ("The last step was
interrupted; Claude Code picked it up again"). Wherever a list names a
request by its words (Changes' turns, a failure's notice, the queue), a
continuation is named by the turn it continued (`turnWords`), and the
composer's recall leaves it out. `test-live-conversations.ts`
(`autoContinuedTurn`), `test-prompt-delivery.tsx`, `test-live-controls.tsx`,
`test-transcript-events.tsx` and `test-notifications.ts` cover the send, the
bound, the declines, the journal, the one turn and the quiet.

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

One delivery queue. Every message into a conversation is an entry in its
journal's request queue (`LiveRequest`), sent by `LiveDispatch` alone; the
rules every change to it keeps, a provider switch's included, are in
`docs/delivery-queue.md`, and `test:switch-interleavings` holds generated
schedules of switches, Stops, edits and crashes to them after every step.
Step one: why a held message waits has one reading (`holdOf`, in
`contracts/request-hold.ts`): `edit` (the person paused it to edit it),
`sign-in`, `retry`, `until` (a usage limit's timed resume) or `paused`, by
the person's Stop (or an Apex's of its Fin, `LiveRequest.pause`) or by Mako
(its exit, a crash, a lost steer). What goes next has one rule
(`nextInLine`, behind `nextQueued`): an edit, a sign-out's pause, a message
about to go again or one Mako paused keeps its place and holds what's behind
it, since nobody chose to put it off; a timed resume or what a Stop paused
lets later messages go, so after a Stop a new message goes while what the
Stop paused waits for Resume, as its row says. (`test:send-race` holds a
restart's pause to the order messages came in.) A new message makes a message
about to go again due now, so it goes first. Every release goes through
`released`, and every held message's time through one timer, armed for the
soonest by each commit that gives one a time (`LiveConversations.armWakes`),
which replaced the 15 s held-wakes poll. The queue's order is the journal's:
once a request moves from where it came (an interrupt, a Fin's resume), the
journal keeps the order (`request_order`), so a restart or a crash reads it
back as it was (`test:request-holds`, with a host killed by SIGKILL).

A message its harness can't take for now waits and goes again by itself,
never as a failure (`packages/host/src/contracts/delivery-retry.ts`). On
2026-11-04 an Apex woken for its Fin's report showed "Could not reopen this
session" twice: once on Cursor's "Server at capacity", once because the
session was still open in the process Mako had just put to sleep. Neither
needed the person. A start or a wake that fails for a cause that clears by
itself (`retryCause`: the harness at capacity or rate-limited, its service
failing, the network, a stalled start, or the session open in another
process, `SessionBusyError` or another host's `SessionHeldError`) holds
each queued message with `LiveRequest.retry` instead of failing it, and
leaves the session asleep rather than failed (`LiveAccounts.failedStart`,
`retriesBegun`). A prompt the harness refuses unsent for such a cause does
the same (`LiveDispatch`). A turn it fails partway for one, having run it, is
continued as a dropped connection's is, by a continuation held first in line
(`LiveAutoContinue.continueFailed`); the failed turn carries the same
`retry`, so its row reads "Continues by itself at …" with nothing to press,
and a new message supersedes the continuation. The held-wakes job sends each
again when its time comes (`wakeDue`), across restarts, as it does a usage
limit's timed resume; a Resume sends it now. A session Mako's exit closed
reopens for it, while the person's own close stops it waiting. The waits grow
from ten seconds to ten minutes and repeat (`RETRY_STEPS_MS`), and every
cause ends (`GIVE_UP_MS`): a rate limit after six hours, so a usage limit's
window is waited out, the service, the network or a stalled start after an
hour, a session open elsewhere after half an hour, each then failing with its
card. A cause the person must fix anywhere in the words is never waited out,
whatever transient words wrap it (`permanentFailure`: "API error: 400 Bad
Request: unknown model …"). A turn continued by itself leaves its session
ready, so what the person queued behind it goes in the order they sent it.
A first start that fails so, with no session yet to resume (a Fin's brief),
holds its message the same way, and its release starts the conversation
again (`LiveLaunches.relaunch`); a transfer that does (a message to a
session with nothing to wake, a reconnect) stays queued with its own
`retry`, gated until its time (`LiveTransfers.start`, `transferDue`).
Signed out still pauses for Sign in, and anything else fails at once with its
card.
The queue row says when it goes and why (`retryWords`). This holds for the
person's messages, an Apex's wakes and a Fin's messages alike, on every
harness (`test:delivery-retry`).

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
force-stops agents. It runs under plain node but loads every `@mako/*`
package from the checkout's source (`scripts/lib/workspace-source.mjs`: tsx
plus a resolve hook mapping each export's `dist/x.js` to `src/x.ts`), never
from `packages/*/dist`: that was whatever was last compiled, so the fetch,
fast-forward and dependency code that ran was stale, and a checkout compiled
before a module existed failed to import it. Keep its workspace imports
dynamic and after `useCheckoutSource()`, and its failure handler free of
imports. Its npm steps stop with their whole process group on Ctrl+C or the
install's time limit, as Settings' do. `npm run update:local -- --check` is
read-only, and `npm run test:update-local` exercises orchestration and signer
selection without building or replacing the user's app;
`test-update-local-cli.mjs` (in `test:update-source`) covers the source
loading against a stale and an incomplete dist, and the group stop.

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
checkout's in turns, three processes each, on this checkout's recordings,
because macOS places a whole process on a performance or an efficiency core
and a memory-heavy row slows there more than the calibration (unchanged merge
code once read 30% apart on three unlucky draws).
A child's results are read from a file: a Node process that exits on an
uncaught error drops what it queued for a pipe on macOS. A row is judged on
its rounds' head over reference (`judge`): a sign-test interval for their
median wholly over 1.25 is slower and wholly under it within, busy or not.
Before each run the machine is read for a second with nothing measured
running (`@mako/host/base/machine-load`): other work holding more than half
the cores, thermal pressure or memory pressure makes it busy; the load
average is printed but not judged, since it lags and counts the measurement's
own threads. On a quiet machine a median under the allowance is within on
three rounds; a busy machine is first waited out for up to 3 minutes. A row
over it at the median alone, on either, gets up to 15 rounds (past seven,
only within 5 minutes of busy measuring), and one they can't settle is
unsure, not slower: on 2026-11-05 a quiet CI runner's median read unchanged
code 29 to 36% slower on three runs, between -29% and +52% at 95%. On the
morning a person's update failed, the update's own dependency copy had Spotlight
indexing at a full core and the load average at 26.7: unchanged merge code read
+43% there and +3% on CI. Every load is simulated in `test-perf-reference.ts`;
`test-machine-load.ts` loads every core for real. Without
`MAKO_PERFORMANCE_VERDICT` an unsure row fails as a slower one does, saying to
measure it on a quieter machine, except in CI's `performance` job
(`MAKO_PERFORMANCE_UNSURE_REPORTED=1`), which fails only a row its rounds
show slower; the table prints each row's rounds, its interval and how many
rounds were busy.
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
media `_meta` parses below. `npm run update:local` runs no performance check;
Settings › Updates runs `test:update-performance` (`test-update-performance.ts`),
unless CI passed the commit (below):
only `perf:decoders` and the budgets, never the harness's unit tests or the
rest of `test:performance`, alone after `test:application` and
`test:renderer-assets` so it doesn't time them, at a gross 1.5× line
(`MAKO_PERFORMANCE_ALLOWED`, `allowedRegression`) rather than CI's 25%, and
skipping a comparison none of whose inputs (its imports followed into the
packages' sources, its fixtures and baselines, the lockfile) changed since the
installed build (`MAKO_UPDATE_CHANGED`). It names its source in
`MAKO_BUILD_SOURCE` for the export, and a file in
`MAKO_PERFORMANCE_VERDICT` (`contracts/performance-verdict.ts`) that each
comparing script appends its rows to: a slower row fails the update by name,
and unsure rows leave it built, verified and `ready` with `performance` set,
saying "Your Mac was too busy to measure performance" with what was measured,
Retry (`mako:measure-update-again`, the check alone again) and Install anyway.
Mako measures again by itself after three quiet one-minute readings in a row,
not while an install or restart is pending. An installed app from before that variable doesn't pass it, so a copy
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
the complete Settings build service against a private profile without installing
(`-- --from upstream|checkout` picks the source; it prints each step's time).
They preserve npm security configuration, run the update's checks, and verify
the existing signing identity. The checks are `UPDATE_CHECKS`
(`application/local-update-checks.ts`): `build` alone, then `test:application`
and `test:renderer-assets` together, then `test:update-performance` alone,
only what protects the install; lint, typecheck and the whole performance
suite gate every change in CI instead. They run through `runUpdateChecks`, in
the environment `updateEnvironment` builds from the few variables
`updaterInherited` lets through, and CI's `update-checks` job (macOS,
`scripts/ci-update-checks.ts`) runs that same function in that same
environment: an update once failed three times on a test that broke only
under the updater's verdict variable, which nothing at review set. Add a
variable the updater sets there, never in a check alone. So a commit whose push
to the default branch passed whole, `update-checks` among it, has passed all of
this already, and an update of it (`from` upstream, clean by construction) runs
the compile and `test:update-machine` alone (`application/local-update-ci.ts`):
a real host and this Mac's Electron, every step of it among `checks`, about 10 s
against 4 to 9 minutes. The performance check took 80 to 88% of `checking`, at
load 26 once. It found two real problems: drift over a baseline (Devin's saved
open), which `update-checks` now trips at the commit that causes it, on a quiet
runner; and a hotspot (`startsWith` over resent output) behind a failure that
hung on process-to-process timing, so a reading that was partly luck. The newest
run of the commit's push decides, and GitHub says which branch is the default,
as a local `origin/HEAD` can be stale. No answer runs every check: a run still
going, a reading that disagrees with itself, no `gh`, a remote that isn't GitHub,
a commit from before `test:update-machine`. A build of the checkout never asks.
`test:settings-build -- --ci-passed` rehearses a commit CI passed. A failed build says
whose it is (`local-update-failures.ts`: the code, the Mac, or the checkout),
what to do next, and the failing command's last lines apart; each step's time
is logged (`build ready`, `build failed`) and carried on the ready build. Public
release updates remain separate from local builds. `package-mac.mjs` stamps the
actual packaged inputs with a build ID, timestamp and source revision, and
the uncommitted files the build took (`makoBuild.uncommitted`, below).
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

A local build never takes the checkout on trust, and Settings never changes
it. Before anything is copied, `local-update-source.ts` fetches the remote's
default branch (15 s, no credential prompts; offline is said and the last
fetch is used) and reads the checkout against it. The reading's plan offers
two builds and recommends one (`UpdateSourcePlan`): the upstream's newest
commit, checked out clean in Mako's own clone (`upstream-copy.ts`,
`updates/upstream.noindex`: `clone --shared`, so no history is copied, and
`checkout --force` plus `clean -ffd` per build, so nothing untracked goes in
while `node_modules` and the compile output carry over; the recording
encoder is carried from the checkout, packaging checks its recipe), or the
checkout as it is. The upstream is recommended whenever the checkout is
behind, or has uncommitted files and no commits of its own; the checkout
when it has its own commits on top. Settings shows the recommended one as
Build and the other beside it. Nothing is stashed, no branch is switched or
moved. `update:local` builds in place, so it alone fast-forwards
(`forwardable`, `bringForward`: `fastForward` in `@mako/git`,
`merge --ff-only --no-autostash`, refused if HEAD moved since the reading),
after asking. A build that would carry the installed, clean revision doesn't
run: Settings says "You're already on <rev>". The installed revision is the
bundle's `makoBuild`; the available one is the reading's upstream. Settings ›
Updates and `npm run update:local` read it with the same words
(`contracts/update-source-text.ts`), and what a build brought
(`build-changes.json`, keyed by build id) shows under the revision once that
build runs. A checkout 21 commits behind once built and installed the
revision already running; one 35 behind, with another session's 8
uncommitted files, built that old code three times and failed on a test main
had fixed. `npm run test:update-source` covers it against scratch
repositories and a local bare remote, draws every state, and
`test-update-behind-dirty.ts` runs Settings' builder end to end on a checkout
behind and dirty, the checkout byte-for-byte untouched.

Built as it is, the checkout goes in with every uncommitted file in it, other
agents' work in progress included, and nobody should be surprised by that:
each file names who changed it, from the change journal (`writers`,
`rewindWriters`: Thread titles, "you").
`readUncommitted` (`local-update-source.ts`, `git status -z` with renames)
names each tracked change and untracked, non-ignored file (edited, added,
deleted, renamed from, untracked, conflicted; the first 200 by name, the rest
counted), and the reading carries it: Settings › Updates says "Includes 41
uncommitted changes" on the offer with the files behind a disclosure, and
`update:local` lists them before it builds. Each updater reads them again as
the build takes its source and hands that list to packaging
(`MAKO_BUILD_UNCOMMITTED`); `package-mac.mjs` stamps it into the bundle as
`makoBuild.uncommitted` beside `dirty` (`buildUncommitted`; packaged by hand
it reads the checkout itself). That stamp is the one record of what an app
took: Settings shows it on the ready build and under the installed revision
("Revision 9a7a5c0c with 41 uncommitted changes"), and the CLI prints it for
the build it made and the app installed. A build from an older updater has
`dirty` only and says just "with uncommitted changes". Nothing answers the
install question for the person: `update:local` takes no `--yes`.

Then the build's node_modules must hold what its package-lock.json lists
(`local-update-dependencies.ts`: each lockfile entry against npm's
`node_modules/.package-lock.json`, by version; optional and peer entries
aside). When it doesn't, as when the upstream's lockfile moved or a pull
changed the checkout's, Settings (phase `installing`, "Installing
dependencies…") runs `npm install --no-audit --no-fund --no-save` in its own
copy, never the checkout (a fresh clean copy starts from the checkout's
node_modules, cloned), and `update:local` runs it in the checkout it builds
in place, with the npm and Node the build uses:
never `npm ci` (it deletes node_modules under whatever else reads it), and
`--no-save` so package.json and package-lock.json stay as Git has them. It's
refused while any package.json or package-lock.json has uncommitted
changes, stopped with its process group after 10 minutes, and every failure
ends with the command to run by hand. Every build step, in Settings and the
CLI, runs through `runProcessGroup` (`application/process-group.ts`): its
own process group, SIGTERM to the group then SIGKILL after 5 s, and a
stopped step settles only once its group is empty, so a rerun never installs
over an install still running. No dependency install script is
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

A request the sync daemon can't read is never dropped: it's logged
(`mako-syncd: refused a request it couldn't read`) and answered with an error
its sender shows at once, not at its 3 s timeout. `daemonIsForeign` keeps
builds apart, but the wire still reads an earlier build's sync words: the
sync window was 30 days before it was 7 (`SYNC_WINDOW_MS`), so a scope naming
a `month` tier reads as `week`, and the status carries an empty `month` for a
host that requires one (`syncStatusOnWire`). The daemon answers requests on
the thread that writes reading copies, reads exports and captures records, so
none of those may hold it for long: a copy is written 64 entries at a time as
the bytes its view keeps (`SessionView.json`), never parsed and drawn again,
and an export reads its batch in one query (`RecordStore.exportFor`). Before,
a 146 MB copy held the thread 1.1 to 1.5 s (5 to 7 s on a loaded Mac) and a
batch of a 342,965-row Cursor chat 1.4 s, and between them they timed out the
host's 3 s status request 31 times in a day and a half. A copy waits for its
turn by the work it costs (`MS_PER_MIB`, 100 ms a MiB: 15 s for 146 MB), and a
Session changed before its turn goes when the turn comes, not at the next look.
Captures of Sessions outside the scope (the backfill's) look at nothing, and
captures during a look are looked at together after it, one look at a time.
The daemon logs each hold of its thread of a second or more (`loop held
ms=… during=…`, `loop-watch.ts`) with the work under way by name (`copy`,
`push`, `capture`, `request <op>`). `test/daemon.mjs`,
`test/reading-copies.mjs` and `test/loop-watch.mjs` cover these, and `npm run
bench:sync-pipeline` measures write-to-account latency on the real daemon
(`--daemon <daemon-main.js>` for another build's).

The hold is the loop's, not only the work the log names: a log names what is
under way, and a page or a push waiting its turn is named beside what held
it. Nothing the size of a Session runs on that loop in one stretch. A write to
the record store takes its lock with SQLite's own wait off and lets the loop
turn between tries (`beginWriting`): the backfill's process keeps the lock
until its capture's next commit (`SLICE_MS`, 2 s), and SQLite waited for it on
the loop, so six of the seven holds of a second or more the daemon logged on
2026-11-01 fell inside a backfill pass. A capture's read of a harness's database ends
within `READ_MS` (25 ms). A Cursor chat's fold, a view's write, and a fold's
comparison with what its listeners hold run as `Steps` `inSlices`, and a
follow replaces from the first entry that changed, not from the start of its
exchange: a headless agent's chat is one exchange, so each step it wrote sent
the whole conversation again. A Cursor SDK agent's run, which a Fin's
checkpoints fold again from its prompt, replays as `Steps` too: its events
read from `index.db` a page at a time and projected and reduced between
yields (`cursorSdkRunEventSteps`, `cursorRunEntrySteps`); one replay in a
step held the daemon 8 to 14 s on a loaded Mac. A push's export reads 500
rows and passes at most 2,000 units a read (`RecordStore.exportSteps`), and
what the account holds after it is noted 500 units a turn (`remoteHolds`).
`test/loop-holds.mjs` times each on a 25MB Cursor chat, a push of 30,000
versions and an SDK run of 23,400 events against a 50 ms budget of the
thread's own CPU time, which a runner taking the CPU away doesn't stretch
(a push once read 117 ms on the clock on CI, unchanged), and a write
waiting on another's lock by the loop turning all through the wait. `npm run
bench:syncd-loop` runs the real daemon on a large chat as it goes on
(`--store <store.db>` for a copy of a real one, `--sdk <dir>` for copies of an
SDK agent's `store.db` and of an `index.db` of its rows, `--writer-holds-ms`
to play a backfill pass's lock), with a window
reading it and the host asking its status, and fails when a ping waited past
50 ms or a status read failed. A status read that fails changes nothing the
rail shows: `SessionUploads` keeps the status the daemon last answered.

A Session is never out of the account without saying so. A pack the account
refuses is sent again in sixteen smaller ones, and so on down to the chunks it
refuses alone (`RecordSync.#isolate`); every other chunk goes, each unit's
versions go up to the first that names a refused chunk, and the failure names
it ("The account refused one chunk of this Session (8fd50237a1c4, 40,960
bytes) and took the rest: …", `RecordChunksRefusedError`), tried again alone
at a refusal's pace. A capture that fails every retry counts the Session out
of the cloud and is a failure in the status until one is taken. Every 30
minutes, and when a link is given, `ScopedUploads` sets the account's list of
its sessions (`GET …/sessions`) against what the store believes it holds
(`RecordStore.remoteVersionCounts`); a Session it holds less of is caught up
from its holdings. Whether a Session is not synced is the daemon's word, never
a clock read in a window: `ScopedUploads.status` says a failure only once the
Session's pushes have failed for `LASTING_MS` (2 minutes) and been tried again,
whatever each try said, keeps it while the Session is behind, and drops it the
moment a push goes; a failure not yet lasting is only counted (`retrying`). A
refusal the next try heals is never said, and a healed one is never said again
when the Session falls behind at its next capture (it was, so the rail's line
came and went at every capture of a live Session). Each failure carries its
`kind` (refused, unreachable, conflict, unread), which the rail ("2 Sessions not
synced · The account turned down part of it · since 5:20 AM", `SyncRailLine`),
Settings › Account and Diagnostics say in the same words (`syncFailureWords`,
`describeSending` in `contracts/sync-status.ts`), the account's own words and
correlation ID one disclosure away. A refusal carries the gateway's `detail`
(`GatewayHttpError.detail`: which chunk, and why). `test/record-refused-chunks.mjs`,
`test/sync-not-synced.mjs`, `test/record-reconcile.mjs` and `npm run
test:sync-status-ui` cover these.

A Session is never "not synced" on a token of Mako's own that ran out. Only
the host can renew the connection token the daemon's links carry, so a link
says when its token is due (`renewAt`, the host's `renewAtMs`) and the
daemon's `LinkCredential` asks the host for a fresh one (a `link-due` event,
`ThreadCatalog.onLinkDue`) before a call goes on a due one; a call the gateway
refuses with a 401 renews once and goes again (`GatewayHttpOptions.renew`).
After the first scope the host gives its links before the scope and each on
its own (`SessionUploads.#give`): a scope the held daemon didn't answer in 3 s
once kept every renewed token from it, and six Fins' Sessions went "not
synced" on "The connection token has expired". `test/link-renewal.mjs` and
`test-account-threads.ts` cover these.

The sync daemon and the backfill's process write one record store, the same
newest pack in turn under its write lock. A process's buffer of pack entries
waiting for its transaction answers reads only for those entries (`written` to
`size`, `Packs.copyWaiting`); a chunk the other process appended since is read
from the pack, and a rollback drops what waited (`Packs.abandon`). The buffer
once answered every read past where its own process last wrote, so the daemon
sent chunks the backfill had just captured with stale bytes and the account
refused each (`test/record-pack-reads.mjs`).

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

The sync reader keeps its own log at `~/.mako/logs/syncd.log`, with the
user's shared state rather than in a profile's data root, because one reader
serves every profile's host; Node's
fatal-error reports go to `~/.mako/logs/syncd-reports` (newest five kept). It
records its start (pid, role, build, socket, identity), each client, each
backfill pass's process and how it ended, its memory when it moves 64 MB, what
it prints, and why it exits: retired (`no clients`, `memory` with the guard's
samples, `asked`), another reader holding the claim, discovery failed, a
signal, or an uncaught exception or rejection with its stack, written
synchronously. Its writer is `@mako/sessions/process-log`, the same format,
rotation and scrub `host-log.ts` uses. A reader can't log its own SIGKILL or
out-of-memory abort, so the host that spawned it logs its exit code or signal
(`catalog-connection.ts`), and every host keeps the last 50 adoptions and
losses of its reader with the reason it saw (`threads/reader-history.ts`),
shown in Settings › Diagnostics with the reader's log. Once a reader restarted
every 20 to 60 s for an hour and nothing said why. `test/syncd-log.mjs` and
`test-reader-history.ts` cover these.
