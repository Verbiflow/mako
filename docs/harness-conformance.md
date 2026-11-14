# Harness conformance

Findings for Claude Code, Codex, Cursor, Grok, OpenCode and Devin, and the suite a new harness has to pass. The suite is `scripts/test-harness-conformance.ts`. Whole-file writes go through `publishFile`. The open-step watches are the list below.

The five harnesses with a local stand-in for their model ran through Mako's own drivers, in a sealed home, for 150 turns of about 8 KB each way. Resident memory is the harness process and the processes it started. The host heap is read after two collections. The script is `scripts/probe-harness-footprint.ts`. It asserts nothing. Cursor has no local stand-in, so its row is the fixture copy of a 146-turn conversation measured while fixing its transcripts.

## What each harness costs

150 scripted turns, one run of all five together:

| Harness | Open | Idle | Peak | Rest at turn 150 | Resume, 1 turn then 150 | Rest growth, second half | Host heap growth |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Code | 0.9 s, 163 MB | 172 MB | 315 MB | 315 MB | 0.2 s, 0.3 s | 366 KB/turn | 2 KB/turn |
| Codex | 0.2 s, 80 MB | 84 MB | 123 MB | 115 MB | 0.1 s, 0.1 s | 63 KB/turn | 6 KB/turn |
| OpenCode | 1.9 s, 285 MB | 285 MB | 409 MB | 409 MB | 1.2 s, 4.9 s | 481 KB/turn | 3 KB/turn |
| Grok | 1.0 s, 89 MB | 90 MB | 156 MB | 156 MB | 0.5 s, 0.4 s | 287 KB/turn | 3 KB/turn |
| Devin | 1.5 s, 56 MB | 67 MB | 103 MB | 103 MB | 0.06 s, 0.07 s | 266 KB/turn | 2 KB/turn |

Each of those is one process once the turn has settled. Host heap stayed between 163 MB and 180 MB. Heap snapshots after 60 turns keep no turn text, except OpenCode, which keeps the last 11 prompts and then drops them.

The rest slopes, 63 KB a turn for Codex up to 481 KB a turn for OpenCode, are the vendor process: Claude Code 366, Codex 63, OpenCode 481, Grok 287, Devin 266. Cursor's fixture rests near 90 MB, which is a different measurement, a repaired transcript rather than 150 scripted turns. The suite prints a fresh RSS and heap per turn and does not fail on either. There is no memory budget.

OpenCode's 4.9 s resume happened while the other four were running. Alone, the same 150 turns resume in 1.1 s after one turn and 1.2 s after 150. Phases on that solo resume: record check and `session.get` together 741 ms then 547 ms, server handshake 145 ms then 398 ms, plugin activation 168 ms then 189 ms. Resume time does not climb with this conversation.

Cursor, on the 146-turn fixture, after the transcript repair: a bare child is 51 MB, a child with an agent and no turn is 55 MB, a long turn peaks near 350 MB and rests near 90 MB. A second agent in the same process adds about 1 MB, and the child Mako launches refuses a second open. One process per Fin.

## Where the growth comes from

The host process is flat on every harness. The climb in the table is inside the vendor process, a few times the size of the turn text, and it is still climbing at turn 150. There is no clean workaround for that: it is their allocator and their session, and forcing a collection was already dropped for Cursor.

One cost was ours. Every OpenCode open called `verifyOpenCodeSession`, which hashed every `session_message` row for the session and then threw the hash away. The caller only needed to know that the session exists and that no native input is waiting. The hash stays on `openCodeCheckpoint`, and the open path stops at that existence check; that change is separate from this suite. The worker that does the read is capped at 6 seconds and 64 MB.

`session.get` returns a small session record, not the messages. The event stream does not replay. Neither one explains a long resume.

No vendor leak turned up that a patch should paper over. Cursor's transcript growth was the one of that kind, and it is already fixed.

## Open steps that can sit quiet

`ProviderStartupWatch` fails a step after 20 seconds with no stdout or stderr, and the launch trace names each phase. Every request an open makes to the harness process is a watched step or has a short deadline of its own:

- Watched: Claude's SDK initialization; Codex `initialize`, `thread/start`, `thread/resume`, `thread/fork`; OpenCode's readiness, info, event stream, plugin activation, the catalog read together with each `mcp.add` (one step, since the watch runs one step at a time and they run together), session create, get and fork, `session.move`, `session.switchAgent` and `session.switchModel`; Grok and Devin `initialize`, `session/new`, `session/load`, `session/set_mode`, and their forks' `initialize` and fork request, in the fork's own process. A failed fork names the request it died in.
- A short deadline of its own: Codex `account/read` (5 s, and identity falls back to unavailable rather than failing the open), Cursor `me` (5 s). Cursor's `hello`, `authStatus`, `models` and `open` are watched; the transcript repair runs inside the watched `open`.
- A phase but no watch: Claude's transcript locate on resume (`session-resume`), a directory walk with no process to hear from.
- Deliberately unwatched: Grok's and Devin's `authenticate`, which waits on a person signing in (`human-sign-in`); silence there is the person reading the page, and Stop ends it.

## Files a crash can tear

Cursor transcripts are already published by rename, with the directory synced and a torn append cut back on the next open. Approval decisions are synced a line at a time, and their reader stops at the last newline.

Whole-file writes go through `publishFile`: a temporary file of its own beside the destination, synced, renamed over it, and the directory synced. A directory sync the platform refuses (`EINVAL`, `ENOTSUP`, `EOPNOTSUPP`, `EPERM`, `EISDIR`) is success. Nothing is locked while the bytes are staged. Only the rename takes the file's own kernel lock, the same lock as a Cursor transcript, on `<file>.mako-place-lock`, and it is never held across an await, so a synchronous save beside an asynchronous write waits for nothing. A staged file is deleted by a later writer only once its process is gone.

Two writes stay on the final path, because a crash cannot tear them into a lie. The login-pending marker is created empty, and approval decisions are one synced line at a time; their reader stops at the last newline. The native stream every harness appends loses its last line on a crash. The reader rejects a range that is not whole lines, so a torn line cannot be decoded, and the line is still gone. The Cursor transcript lock stays as it is, because two processes share those files.

## The suite

One test, `scripts/test-harness-conformance.ts`, run from one npm script, over `registeredHarnessIds()`. A harness joins by adding its module to `harnessModules` in `harness-host.ts`. The host, its live drivers and the test all install from that one list. The test talks to `ProviderLiveDriver` only, and always to the harness's own driver. The test's `CONFORMANCE` table has one entry per harness: how to point that driver at a stand-in on its wire, and, if the live sections run elsewhere, why. A registered harness with no driver of its own, or no entry, fails the run. An entry for a harness that isn't registered fails it too. The generated checklist in `docs/adding-a-harness.md` gains one row when the test exists.

The silence cases need a child that never prints. A real CLI resets the silence timer whenever it writes, so each driver is pointed at `scripts/fixtures/native-failure-agent.mjs` in place of its binary. `withStartupClock` lends that start a clock, and the case advances it by the silence interval instead of waiting 20 seconds. Each points through the variable its driver already reads for the CLI: `CLAUDE_CODE_EXECUTABLE`, `CODEX_EXECUTABLE`, `OPENCODE_BIN_PATH`, `DEVIN_CLI_PATH`, Grok on `PATH`, and `CURSOR_SDK_CHILD` for Cursor's SDK child. Cursor's stand-in is a silent SDK child; the others' is a silent peer on their wire. That is the same seam, not a Cursor-shaped test.

1. **Startup.** A silent peer makes `start` fail, and the error names the step that stalled. Every wait listed above is a watched step by then, and Claude's locate is a phase. A step that finishes while its process prints advances.

2. **Stop and cancel.** Against the scripted model, `cancel` leaves the session not running, reaps the process tree the driver recorded, and a following prompt is accepted or the session is closed. The only deadline is a hang guard: a turn that never finishes fails the run. There is no timing budget. Cursor's cancel runs against its silent-child stand-in, so CI does not call Cursor's model.

3. **Crash recovery.** The helper's tests kill the writer mid-write and find the previous file intact, and they record the sync order the way the Cursor transcript tests do. An append killed mid-line reads back as the lines that finished. The suite then checks that a harness writer of a whole file goes through the helper. It counts every name of Node's whole-file writers (`writeFile`, `writeFileSync`, `createWriteStream`, `copyFile`, `cp`, and their sync forms) in each harness file, however it is spelled: imported, aliased, as a method or in a string. Each count must match an exact allowance that gives its reason. The scan proves on sample sources that it catches each spelling.

4. **Fin cost.** Two conversations start. Their recorded process ids are disjoint, one tree each. `FinCostSampler` attributes each tree, children included, to its own conversation. This is the check that a shared process cannot be added later without the suite seeing both conversations charged for it.

5. **Memory.** Twelve scripted turns, then a collection. The search reads the strings in a heap snapshot. It also reads, through the inspector's `queryObjects`, the bytes of every live typed array (Buffers included), DataView, ArrayBuffer and SharedArrayBuffer, in UTF-8 and UTF-16, since a snapshot never lists those. An array buffer is read whole, whatever views it, because bytes outside a small view are still reachable through its `.buffer`; the run turns off Buffer's pool so that a buffer still in the heap is one something holds, not a slab of Buffers long gone. Before trusting the search, the test plants text in each of those forms, and in the rest of a buffer a one-byte view keeps, and must find every one. Then no turn's text outside the driver's window may be found in any form: the last 11 prompts for OpenCode, the one in hand for the others. Twelve is enough for that window to have dropped the first turn. RSS and heap are printed per turn and never fail the run. Cursor is not in this run.

6. **Steer and queue.** The message the person sends into a running turn shows up in what the model is asked next, before that turn ends. `test-steer-landing.ts` already covers the landing policy against fakes; this is the same landing on the real driver and the scripted model. No millisecond limit. Cursor stays on the existing opt-in probe that uses the person's sign-in.

When the sections end, pass or fail, every driver is stopped. The run then fails if anything still keeps Node running: a worker, a port, a server, a process or a timer. It names what is left. A run that passes exits on its own.

A harness with no scripted stand-in implements the silent peer and still passes sections 1, 3 and 4. Sections 2, 5 and 6 run wherever `scripts/scripted-harness-env.ts` can point the model.
