# Parity implementation

## Native agent observations and conversation controls

Claude SDK task events and Codex app-server collaboration items now populate a provider-neutral Agents companion. The roster preserves native identity, activity, results, reported model and usage, and the originating provider binding. Ordinary shell/MCP background tasks are excluded. Missing usage is left absent.

Observations persist in the conversation journal. Disconnect, restart and provider transfer turn active observations into “Status unavailable”; they do not manufacture completion. Late Claude progress cannot revive a completed task. Nested Claude agent messages no longer become part of the parent's answer. The roster is capped at 256 observations, preferentially evicts settled entries, and displays an omission notice. The panel mounts 40 rows at a time.

Agent-only events use narrow batches and retain the renderer's transcript projection by identity. Agent results expand in place. The composer shows the agent count only when observations exist; delegation remains a distinct action. The delegation dialog focuses its task field, preserves the draft, and restores focus when closed. Completed action receipts stay in the actions popover.

Validation:

- `npm run typecheck`: each TypeScript project passes in a separate process with a 768 MB V8 heap cap and a 120-second timeout. The earlier 512 MB cap was insufficient; a heap cap is not a physical-footprint guarantee.
- `npm run test:native-agents`: provider lifecycle, bounded roster, nested-content isolation, journal persistence, restart, and narrow host batches.
- `npm run test:live-controls`: production components render expected states; agent-only batches preserve the transcript projection; draft persistence regressions pass.
- `npm run test:live-actions` and `npm run test:codex-protocol`: existing driver/control regressions pass.
- `npm run lint`: no ESLint errors, two existing isolated-virtualizer React Compiler warnings, and no Oxlint warnings/errors.
- Actual local host opened without mock mode; inspected a real saved Claude test conversation and the registered Agents companion. No prompt sent.
- The explicit `/scripts/live-workflow.html?mock` fixture uses production components. Browser checks covered narrow/wide layouts, expanding results, nested provider picker Escape behavior, dialog Escape/focus return, task autofocus, draft restoration, mode picker and conversation actions.

During the roughly five-minute browser check, sampled host RSS fell from 510 MB at startup to 354 MB; the Vite process fell from about 1 GB during startup to 73 MB. System memory free readings ranged from 36–39%. This is a short observation, not attribution of the earlier memory incident or a soak-test result. The temporary server and tabs were closed afterward.

Still unverified: real newly spawned provider-agent events end to end, packaged behavior, workflow grouping, per-agent controls, and native-history import outside a captured live conversation. This unit does not close the entire native-agent parity row or establish whole-product parity.

## Proposed plans

Codex plan deltas and final plan items, and Claude ExitPlanMode proposals, now produce one shared proposed-plan artifact. Revisions replace the stable artifact instead of duplicating it. Plans survive the journal and canonical/native transcript conversion, appear as compact expandable cards, and contribute to whole-answer copying. The execution checklist also updates when its tool details change.

Cards support copying, Markdown download, creating a workspace file, and preparing implementation or revision replies. Saving refuses overwrites, paths outside the workspace, stale workspace selection, and oversized content. Incomplete or truncated plans cannot prepare implementation replies.

Prepared replies preserve existing text and attach the exact selected plan version as a removable preview chip. Switching between the two prepared intents replaces the unchanged trailing instruction. The provider receives the complete plan context; the transcript displays it as a chip, and prompt reuse preserves it. Drafts and refused sends retain plan references. A late send result cannot clear or overwrite newer text or references.

Validation:

- `npm run test:proposed-plans`: SDK permission capture, revisions, canonical/native round trips, copy/export, capture limits, journal persistence, and real workspace save boundaries.
- `npm run test:codex-protocol`: streamed plan deltas and final replacements retain one artifact.
- `npm run test:live-controls`: production card rendering, preparation, intent switching, stale-conversation rejection, and preservation across pending/refused sends.
- `npm run typecheck` and separate typechecking of the new test scripts; `npm run test:web` covers the new host method and generated input contract.
- `npm run lint`: zero errors, the same two isolated-virtualizer ESLint warnings, and zero Oxlint warnings/errors.
- Explicit production-component fixture checked in the browser: short drafts, preservation of existing text, plan preview/removal, intent switching, narrow layout, and save dialog focus. No provider prompt was sent.

Still unverified: a newly generated plan through each actual provider, packaged export/download behavior, and a full browser send/reload/reuse cycle. These checks establish the local implementation, not equal quality or latency against T3.


## Prompt delivery and queue

Idle sends now enter the conversation before awaited provider settings or host acceptance. A stable request ID joins the optimistic prompt to its host acknowledgement. Startup remains visible as “Starting…” or “Sending…”; only follow-ups waiting behind a turn appear in the queue. A refused submission removes its own pending projection.

Follow-ups share one compact “Up next” card above the composer. The card previews two messages, expands with bounded pagination, and supports editing and removal for live and native requests. Editing pauses the queued request durably so completion of the current turn cannot dispatch half-edited text. Save or Cancel releases that hold. The host checks request status and expected text before changing it; removed messages do not become failure cards. Edit drafts persist separately from the main composer. Escape restores focus to the edit button.

The reference comparison used Monocode (`568f246c`), OpenCode (`101ff6d1`), and T3 Code (`cd096b9a`), read only under `ignore/`. Monocode informed the compact editable queue beside the composer; OpenCode and T3 informed optimistic insertion before asynchronous submission work.

An additional delay came from refreshing provider discovery after a 30-second metadata TTL. Warm sends now reuse an available profile for the same provider/account/workspace; ordinary discovery and explicit refresh retain their refresh behavior. This removes unnecessary discovery from that path; it does not establish a provider first-token latency bound.

Validation:

- `npm run test:message-queue`: live/native pause across turn completion, one dispatch after edit, stale edits, removal races, journal rollback, durable hold/removal, original submission retry identity, and warm discovery/account/workspace isolation.
- Its production renderer test invokes the real send action with discovery deliberately unresolved: the prompt appears before the await and retains its identity after acknowledgement, with no duplicate bubble.
- `npm run test:live` and `npm run test:web`: conversation and generated IPC contract regressions passed.
- `npm run typecheck`, separate typechecking of the new test scripts, and `npm run lint`: zero errors; Oxlint zero warnings/errors; two existing React Compiler warnings on isolated virtualizers.
- Explicit production-component fixture checked in the browser: idle startup, compact and expanded follow-ups, narrow layout, edit/save, Escape/focus return, and removal. No actual provider prompt was sent during these checks.

Still unverified: packaged behavior, actual provider startup timing, and reload before the host has accepted an optimistic send. These changes do not claim complete product parity.

## Checkpoint reachability

A real Git garbage-collection regression exposed that blobs present only in the saved index could become unreachable. Each new checkpoint now retains that index tree as a parent commit of the working-tree checkpoint. Restore validates staged blobs before modifying workspace files, including for older checkpoints that lack that parent.

`npm run test:workspace-snapshots` reproduced the failure with `git gc --prune=now` in an isolated temporary repository, then verified staged-only content survives collection. A separate legacy-checkpoint case confirms missing blobs cause restore to refuse before changing the workspace or index. No collection was run against the user repository. Age/count retention and a private checkpoint-payload byte budget were subsequently implemented as described below.

## Interrupted sends

The composer saves a recovery copy before clearing text or detaching attachments. A new renderer presents unresolved copies for explicit restoration or dismissal; it never sends them automatically. Restoring appends to an existing paragraph. Successful host acceptance removes the copy, while a refused send returns it to the draft. If recovery storage cannot be written, the composer remains intact.

`npm run test:message-queue` now also starts a fresh process to verify recovery persistence, retained staged attachment paths, absence of automatic replay, accepted-receipt cleanup, and storage-quota refusal. The production-component browser fixture verified restoring beside a newer paragraph and returning focus to the composer.

## Exact Claude forks and host-owned native identity

Claude now supplies its account-scoped transcript path through SDK lifecycle hooks. The host also links provider-native catalog discoveries to live conversations without requiring a renderer to open them. This fixes a restart gap where an unopened conversation retained its visible transcript but lacked the native path needed for safe resume.

Completed Claude turns retain a separate fork boundary. A bounded native-tail reader follows the observed main-thread message through tool carriers and trailing attachments, and requires the persisted leaf marker to agree. The reader briefly waits for the native writer because the SDK result can precede its file flush. Steering into an already-ended turn is refused during that interval. Missing or ambiguous evidence leaves portable forking available. Native forks use the SDK's `resume`, `forkSession`, and `resumeSessionAt` options. Empty context packages are no longer sent as reading instructions when native history already covers the selected point.

A real SDK test kept a selected value, excluded a later replacement, allocated a different native session, and recalled the selected value without portable history. The closed source transcript's fingerprint stayed unchanged. Evidence: [claude-native-fork.json](./claude-native-fork.json). Rerun with `npm run build:electron && node scripts/test-provider-e2e.mjs claude --fork-only`.

`npm run test:live-actions` covers native-path discovery without renderer binding, idempotent discovery, delayed native writes, stale boundary removal, carrier/attachment retention, bounded tails, torn writes, and ambiguous chains. Conversation transfer, native request, native continuation, native history and relay-conversation regressions also pass.

## Package verification work

A packaged restart test exposed the missing host-side native binding described above. A separate packaging attempt caught a build-output race: compiling while the packager collected files produced imports without their corresponding files. Packaging now freezes compiled inputs, checks that the copy matches the source, packages from that copy, and compares the resulting archive bytes against the frozen inputs. A TypeScript-parser-based check also verifies relative imports in the packaged host before launch. The rerunnable lifecycle test uses an isolated profile and a disposable workspace.

## Checkpoint retention and startup validation, September 9

Checkpoint cleanup now targets 30 days and 1,000 records per profile/workspace, removing at most 64 per pass. Active run baselines, persisted 30-minute preview leases, and unfinished restore inputs/backups take precedence over those limits. Cleanup verifies ownership and uses a compare-and-swap Git transaction before deleting saved indexes and metadata. It never runs Git GC. Completed restore receipts still work after the target checkpoint expires.

`npm run test:workspace-snapshots` passes count/age limits, active-run protection, preview persistence, actual restore-process death, cleanup interruption/retry, changed and symbolic refs, legacy checkpoints, profile isolation, and bounded cleanup batches. These checks run only in disposable repositories. At this stage, Git object reclamation, completed-receipt growth, a physical byte quota, and matched large-repository latency were still open; the follow-up below records the subsequent storage changes and verification.

Repeated packaged testing exposed a startup draft race: input could be saved under `project:/` before workspace metadata arrived, then disappear from the composer when its target changed. The composer now stays inert and read-only with an opening-workspace placeholder until a workspace or existing conversation supplies a draft target. The production-component UI regression verifies this boundary with trusted input and retains a startup screenshot.

The rebuilt isolated package at `/tmp/mako-retention-package-23403-boot/mac-arm64/Mako.app` passed archive-byte verification for 859 files, 383 relative host imports, ad-hoc signature verification, and launch. Two renderer-only runs each preserved a draft through three reloads. Reports are retained in `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-FVVnvC/result.json` and `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-duF3Vg/result.json`. Rerun with `npm run test:packaged-lifecycle -- /path/to/Mako.app --renderer-only`; it starts no provider.

The initial live Claude package test was blocked by an expired OAuth session that could not refresh. The initial broader workspace UI run passed the startup regression but failed its offscreen-animation assertion, and repository lint caught a concurrent `no-runtime-typeof` violation. Those failures were retained rather than reported as passes. The follow-up below supersedes their pending status.

## Reliability follow-up

After authentication was restored, the current full UI suite and full lint passed. The UI run covers offscreen/reduced-motion behavior, startup input gating, attachment editing, single-send behavior, draft reload, and window isolation. Typechecking, host/web boundary tests, stage/identity tests, live controls, conversation transfers, queue/recovery tests, and snapshot tests also passed. ESLint retains the two known isolated-virtualizer warnings; Oxlint reports zero warnings and errors.

New snapshots now hold self-contained Git packs in private 0700 directories. Capture leaves the user's Git object database and refs unchanged. Restore imports the selected pack before publishing its saved index, so expiration cannot make staged blobs disappear. The default retained-payload budget is 1 GiB per workspace/profile, with 512 MiB per snapshot. Allocation-aware file measurements drive eviction and admission, rather than estimated source sizes. Protected recovery data takes precedence: a full budget refuses a new retained capture instead of deleting a baseline or unfinished restore.

A quota-full regression exposed unnecessary duplicate restore backups. Restore now reuses the persisted preview as its safety backup and uses bounded temporary current-state captures, including for compensation after a failed conversation commit. These temporary stores are cleaned up. Process-death tests verify abandoned captures are reclaimed; completed uncatalogued stores and live captures are preserved. The payload quota does not cover the SQLite catalog, provider-native history, or temporary working files. Legacy repository-backed objects are not garbage-collected automatically.

`npm run benchmark:snapshots` verifies capture, preview, restore, and staging on 100-file and 5,000-file fixtures. The latest retained payload measurements were 134,624 and 3,263,968 bytes. Timings varied under concurrent machine load; they are individual observations, not percentiles or matched T3 performance results. Full measurements: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-snapshot-benchmark-9UG6ju/results.json`.

The final isolated package is `/tmp/mako-reliability-verified-20260909/mac-arm64/Mako.app`. Its 865 compiled files were compared with frozen inputs and 396 relative host imports resolved. Ad-hoc signature verification, launch, real Claude completion, restart, same-native-session resume, and marker recall passed. Report: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-IkM1QT/result.json`. Cold acceptance was still slow in that run, about 53.6 seconds; this is not a startup-speed claim. A separate real Claude workflow passed two file-writing turns, checkpoint preview, file restore, and an idle conversation fork: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-rewind-e2e-t8SvyP/result.json`.

The approved non-privileged memory run passed 54 reloads over 611,146 ms with the draft intact. Median measured physical footprint declined from 2,081,073,304 to 1,878,781,184 bytes. Whole-tree RSS and measured physical footprint stayed within their 4 GiB test limits, and the system-memory-free floor held. macOS denies physical reads for setuid-root `ps`; those readings remain explicitly unavailable, not successful zeroes. Report: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-VDwTrJ/result.json`. This verifies the recorded ten-minute workload and coverage, not a multi-hour or all-workload stability guarantee.

## Send startup latency, September 9

An instrumented package reproduced 35,119 ms from request to acknowledgement: local control consumed 1,416 ms, full provider discovery another 33,578 ms, and host acceptance itself about 8 ms. The request contained no model overrides, yet it waited for every model's defaults. The production composer had another display-discovery await before the host call.

Native defaults no longer require model discovery. Providers can declare that their native model IDs need no translation; Claude model-only requests preserve the exact requested ID and leave its acceptance to the native provider, as unknown IDs already did. Option-bearing requests still use catalogue validation. Claude shares the launch catalogue with background discovery without waiting for per-model default probes, and background enrichment cannot mutate that catalogue. Legacy preference migration still obtains the metadata needed to translate old option names.

Profiles remain account/workspace scoped, with real-path keys so workspace aliases reuse the same validated profile. Discovery retains the four-process maximum, reserving capacity for launch catalogues rather than allowing background enrichment to occupy every slot. Read-only Claude discovery excludes MCP startup; actual agent MCP configuration is unchanged. Local-control readiness is awaited where the provider consumes its MCP snapshot, including ACP and app-server starts. Independent provider MCP discovery and managed diagnostics run concurrently, retaining both results.

Measured packaged runs:

| Run | Acknowledgement | First observed reply text | Completion |
| --- | ---: | ---: | ---: |
| Before, cold native defaults through the bridge | 35,119 ms | Not recorded | 80,248 ms |
| After, cold explicit native model through the bridge | 150 ms | 34,246 ms | 36,067 ms |
| After, cold real composer input and Send click | 183 ms | 43,955 ms | 46,241 ms |
| After, warm explicit-model start | 12 ms | 26,138 ms | 27,159 ms |

The final package is `/tmp/mako-startup-finalized-20260909/mac-arm64/Mako.app`. Archive bytes were checked against 876 frozen build files, and 419 relative host imports resolved. Both final reports passed a real Claude completion, full standalone-host restart, same-native-session resume, and marker recall without replaying the marker into the second prompt:

- Before: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-22TvqD/result.json`.
- Cold explicit model: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-D8If1P/result.json`.
- Real composer and warm start: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-CBhOUx/result.json`.

Rerun with `MAKO_STARTUP_TRACE=1 MAKO_STARTUP_BUDGET_MS=5000 npm run test:packaged-lifecycle -- /path/to/Mako.app claude --ui-start --warm`, or replace the last two switches with `--model=<native-model-id>`. The test explicitly selects `MAKO_STANDALONE=1` and a private `MAKO_DATA_ROOT`, so it exercises a full host restart instead of merely closing a shared-host client. These measurements do not establish default shared-host launch latency. Discovery traces retain executable-resolution, queue, and execution durations without recording arguments or credentials.

Regression coverage includes dispatch while display discovery is held unresolved; legacy option migration; rejected options; native-ID pass-through; account/workspace isolation and aliases; reserved launch capacity; metadata redaction; and ACP/app-server refusal to launch before host MCP readiness. Existing queue, transfer, permission, native-history and MCP-control checks remain in place.

The final verification also reran `test:workspace-ui`, `test:workspace-snapshots`, `test:web`, `test:message-queue`, `test:mcp`, `test:conversation-control`, `test:live-actions`, `test:background-lifecycle`, `test:renderer-assets`, and settings migration checks. Project typechecking passed. Full lint passed with zero Oxlint warnings/errors and the two known isolated-virtualizer ESLint warnings. UI evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-workspace-ui-a6hHBZ`. The snapshot benchmark also passed; its separate observations are in `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-snapshot-benchmark-pYDRTM/results.json`.

A concurrent build also produced an archive whose runtime connection imported `RuntimeCallSchema` from an older module without that export. Packaging now checks statically known local named/default imports and re-exports as well as file paths. `test-packaged-import-guards.mjs` reproduces this failure before app launch; it does not claim to resolve arbitrary external wildcard exports.

These are individual observations on an active development machine, not latency percentiles, an SLA, or matched T3 results. Provider dispatch and first reply still take seconds; the acknowledgement reduction is not a claim of instant model output. One later restart attempt hit the unchanged Claude SDK initialization deadline and was retained in `mako-packaged-lifecycle-AkMs0z/result.json`; the subsequent complete run above passed. No SDK deadline, permission check, or option-validation rule was relaxed. The earlier retention, rewind and memory evidence remains historical evidence for those workloads, not new multi-hour or all-provider proof.

## Streaming and large-history performance, September 9–10

The renderer now reuses settled history and rebuilds the affected live tail. Reducer dirty ranges use weak references rather than retaining every previous array. Tool-derived Context data keeps its identity through prose-only updates. Sidebar lookups use maintained native/path indexes while preserving provider scope, alias behavior and current conversation values. Unseen background summaries no longer eagerly hydrate entire transcripts; selecting a conversation rebuilds or hydrates current content before display.

Large timelines window measured rows above 200 turns, and navigator lists above 100 prompts. Small threads keep their existing progressive mounting. Trusted-input browser checks cover oldest-turn jumps, keyboard End/Enter, following live output, preserving a reader's position during tail growth, and anchor preservation while prepending native history. Programmatic virtualizer adjustments cannot release follow mode. Complete answer-copy data remains independent of mounted rows.

Streaming Markdown now memoizes the actual subtree. Answers above 16 KiB can parse in a single coalescing worker, retaining exact initial/settled rendering and a safe local fallback. Worker and local paths share GFM/citation plugin composition and still use React Markdown's component and URL handling. Postprocessing receives a clone, so it cannot mutate the cached tree. The DOM-free entity decoder is resolved explicitly for both development and worker builds. Production HTTP and file-URL audits assert worker use and compare final HTML hashes.

Claude final text/thinking no longer shrinks at 128 KiB. Completed tool input/output reaches the host intact for bounded previews plus durable full-content artifacts. The partial tool-input preview stays bounded and does not repeatedly emit the same capped prefix. Consecutive compatible updates coalesce without changing the wire schema or crossing tool/user boundaries.

Journal text growth uses bounded append records in the same FULL-synchronous transaction as metadata. It compacts at 128 appends and at settlement, handles authoritative replacement and truncation, and preserves split UTF-16 characters. Rollback/retry and reopened-journal tests verify exact content. Closed leaf journals use an 8-entry/64 MiB estimated warm cache; active operations and parents remain protected. Eviction closes resident handles, not persisted history. Native-view cache accounting measures loaded entries rather than undercounting large entries from file-size heuristics.

The daemon caches unfiltered catalogue ordering and exposes a cheap count. Filtered queries preserve filtering-before-alias-deduplication semantics, and returned lists cannot mutate the cache. Host activity joins rebuild on identity changes rather than each file-size update. Cursor Desktop now emits changed suffixes instead of resending unchanged prefixes, with equal-length edits covered. Devin/OpenCode retain their existing safe revision/branch-diff fallbacks; these changes do not claim all native database reads are O(delta).

Observed production-component fixtures on this Apple M3 Max:

| Workload | Before | After | Measurement boundary |
| --- | ---: | ---: | --- |
| 5,000-turn text batch, median | 14.2 ms | 2.4 ms | Renderer batch application |
| Inactive 5,000-turn batch, median | 7.2 ms | 0.1 ms | Renderer state application |
| 300-turn oldest jump | 226 ms | 41 ms | Trusted click through visible target |
| 64 KiB rich Markdown, renderer work median | 70 ms | 13.4 ms | React Markdown call; worker CPU is separate |
| Half-MiB block plus 24 small deltas | 12,589,032 bytes | 432 bytes | Full-prefix serialization equivalent versus persisted append payload, not filesystem allocation |

Before: `mako-render-performance-XOlIQs/result.json`; worker comparison: `mako-render-performance-76J9wh/result.json`; expanded navigation audit: `mako-render-performance-ePRbgT/result.json`; production file loading: `mako-render-performance-75DIHc/result.json`. These directories are under the printed macOS temporary root. The 4/32/64 KiB final Markdown HTML hashes match their pre-offload counterparts. Runtime audit: `mako-runtime-performance-px9nwq/result.json`.

Reference revisions: T3 Code `cd096b9ad5a4156ffeab85de617cbb219057007f`, Comet/Zeron `6a46ea53d9943fd636b16b23a40427e9d649788e`, OpenCode `101ff6d1a2e55c57419aaeaeebf466a180c95011`, Monocode `568f246cfc200dcb57377dfad8fe2c5700b07465`. References under `ignore/` were not changed. T3 and Comet were cloned to independent temporary directories for execution.

T3's real development client opened seeded 10/1,000/5,000-turn histories, retaining roughly 645–655 DOM nodes. Evidence: `mako-reference-ui-yi3Hak/result.json`. Its development/server-fetch timings are not comparable to Mako's preloaded production fixtures and are not a speed ranking. T3 uses LegendList/stable timeline rows; Comet uses block-level virtual rows and incremental Markdown; OpenCode offloads Markdown and caches sanitized output; Monocode uses Streamdown. These are architectural comparisons, not whole-product parity percentages.

Comet built successfully with side-by-side Rust 1.95 (the default toolchain was unchanged). Its isolated native resource profiler refused to proceed without Accessibility access for `/tmp/mako-comet-resource-20260909/macos-profile-window`. No native CPU/frame success is claimed for that blocked run. T3's isolated server was stopped after its checks. Neither application used the user's live app data directory.

Concurrent 1/4/8-stream checks preserve exact journals and exercise reduction, JSON validation and projection together, but their latency tails were contaminated by severe system contention: load averages reached about 27/97/119 and swap use about 20 GiB. The outliers affect pure projection as well as persistence; they are not clean attribution of disk or host latency. A clean concurrent soak and matched native-client profiling remain necessary before universal latency or parity claims. The new source changes are not an update to the earlier packaged startup artifact, and the running Mako host was not restarted.

Final focused checks passed: performance regressions, native session/daemon/content suites, live controls/transfers/SDK behavior, snapshot recovery, stage/provider identity, and workspace/Git UI. The current file-URL audit (`mako-render-performance-qLqoQl/result.json`) also passes follow mode, keyboard navigation, prepend anchors, worker use and exact final markup with no ResizeObserver warnings in that run. The latest workspace UI evidence is `mako-workspace-ui-Dwb8PQ`. Full lint passes with zero errors, four isolated-virtualizer React Compiler warnings, and zero Oxlint warnings/errors. The audit scripts were separately typechecked.

Full project typechecking and build passed earlier in this implementation pass. Subsequent concurrent Kiri integration now references `Comparison`, `RepoPath`, `discover`, and new Git operations that the installed `@kiri/client` tarball does not expose. That SDK synchronization is an unresolved full-tree verification gate; no casts or compiler-rule relaxations were introduced to hide it. Mechanical constructor-field and catch-boundary syntax fixes preserve the integration's behavior. Comet native profiling remains pending actual Accessibility approval; the repeated denied attempt is not a successful native benchmark.
