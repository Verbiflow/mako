# Snapshots, orchestration and browser/computer control

Checked September 8, 2026. This review led to working filesystem/conversation rewind in Mako and a browser observation size limit. It establishes specific behavior and tests, not overall superiority to another product.

## References and scope

Fresh reference checkouts were cloned outside the workspace and updated with `git pull --ff-only`. The reference-only `ignore/` directories were untouched. Source findings below are pinned to these revisions:

| Project | Revision reviewed |
| --- | --- |
| [T3 Code main](https://github.com/pingdotgg/t3code/tree/0fe4c99ee6df4cbb7a9064d2d86ece65ecef5eb3) | `0fe4c99ee6df4cbb7a9064d2d86ece65ecef5eb3` |
| [T3 Orchestrator V2](https://github.com/pingdotgg/t3code/pull/2829) | `6102d00bdb06f4318be3fad2c79465c08186f45e`, open and unmerged |
| [Orca](https://github.com/stablyai/orca/tree/8f78c28248fbfa4d55fb837ab6698ac77d4e35c5) | `8f78c28248fbfa4d55fb837ab6698ac77d4e35c5` |
| [MonoCode](https://github.com/hardbeat920/monocode/tree/a57dd0afc603be0261c8ba13553b0be67ba457b0) | `a57dd0afc603be0261c8ba13553b0be67ba457b0` |

The reproducible issue/PR index searches titles for snapshot, checkpoint, rewind, rollback, browser and computer use across all states. It collected 285 distinct T3 records, 848 Orca records and one MonoCode record, with no truncated search query. These counts describe search coverage, not a claim to have read every issue or source file. Relevant discussions, PR bodies, comments and file metadata are retained in `details/`. The full V2 changed-file inventory contains 1,047 files across 11 API pages; implementation review focused on checkpoint, rollback, provider-control and browser/computer paths. Other detail API lists are bounded to their fetched pages. PR author test and performance claims are not our verification.

Rerun the index from the repository root with `node scripts/audit-snapshot-controls.mjs`. This requires authenticated `gh` access. The script refreshes the search index; it does not recreate the manually selected detail bundle.

## What T3 gets right, and what still fails

T3 captures Git trees through a temporary index, leaves HEAD alone, and attaches checkpoint readiness to actual turn boundaries. Its merged [terminal capture fix](https://github.com/pingdotgg/t3code/pull/9841) addresses edits arriving after an earlier completion signal. The merged [summary optimization](https://github.com/pingdotgg/t3code/pull/9694) avoids computing full patches just to display counts. These are good foundations.

Current main's [Git checkpoint implementation](https://github.com/pingdotgg/t3code/blob/0fe4c99ee6df4cbb7a9064d2d86ece65ecef5eb3/apps/server/src/vcs/GitVcsDriver.ts#L715) restores the worktree and index, cleans untracked files in scope, then resets staging against HEAD. It does not preserve the user's original staged/unstaged distinction. Capture uses Git's object store and a 30-second operation budget. The [large-repository report](https://github.com/pingdotgg/t3code/issues/3646), [index-cache proposal](https://github.com/pingdotgg/t3code/pull/10792) and [failed-pack cleanup proposal](https://github.com/pingdotgg/t3code/pull/9809) show why capture cost and failed writes need separate treatment. The latter two were unmerged when checked.

The [main rollback reactor](https://github.com/pingdotgg/t3code/blob/0fe4c99ee6df4cbb7a9064d2d86ece65ecef5eb3/apps/server/src/orchestration/Layers/CheckpointReactor.ts#L682) checks provider rollback support before changing files, but restores files before performing the provider rollback. A later runtime failure can leave files and conversation inconsistent. [Issue 8958](https://github.com/pingdotgg/t3code/issues/8958) reports that exact sequence. Capability preflight does not prevent failures during the operation.

The current [V2 rollback service](https://github.com/pingdotgg/t3code/blob/6102d00bdb06f4318be3fad2c79465c08186f45e/apps/server/src/orchestration-v2/CheckpointRollbackService.ts) does more validation before restoration, including provider/thread/run matching. It still restores files before `rollbackThread`; its error mapping does not compensate those file writes. Its focused tests cover preflight rejection, not post-restore compensation. This is a source finding, not a reproduced T3 runtime benchmark.

The live proposals matter as much as main:

- [10608](https://github.com/pingdotgg/t3code/pull/10608) addresses capture/restore/provider-start ordering and durable queue recovery. It remained open.
- [10482](https://github.com/pingdotgg/t3code/pull/10482) addresses rewind after runtime restart. It remained open.
- [9896](https://github.com/pingdotgg/t3code/pull/9896) addresses V2 baseline scope across runs. It remained open.
- [9069](https://github.com/pingdotgg/t3code/pull/9069) evolved toward backup and compensation. Its later discussion supersedes the simpler provider-first idea in the initial description.
- [10299](https://github.com/pingdotgg/t3code/pull/10299) proposes a durable fork and recovery journal. It was closed without merging. [10297](https://github.com/pingdotgg/t3code/pull/10297), a terminal capture barrier, was also closed without merging.

Closed and merged are different states. None of the unmerged proposals above is credited as shipped main behavior.

## Mako changes and the actual guarantee

`electron/workspace-snapshots.ts` now captures worktree content through a separate Git index and stores the original expanded staging index with a checksum. Capture leaves the user's real index untouched. Snapshots include tracked files, untracked non-ignored files, deletions and symlinks. HEAD does not move. The scope is the whole Git worktree, explicitly shown before restoration.

`electron/live-checkpoints.ts` captures before provider dispatch and after terminal completion, before the next queued prompt can start. Running managed writers block restore. Overlapping managed runs make their snapshots unavailable rather than implying that each session exclusively owns those file changes. Ordinary prompts still work when checkpoint capture is unavailable.

The transcript offers rewind before a prompt and after an answer. Preview shows the scope, changed-file count, filenames and staging changes. Restoration creates an idle historical fork and keeps the original conversation. Before-prompt forks carry portable history; after-answer forks can use provider-native history where the registered driver supports the exact run. A new provider rollback call cannot fail after file restoration because this operation does not mutate the original native conversation.

Restore verifies that the preview remains current, validates the saved tree/index and repository identity, and records a durable intent with a safety backup before writing files. A failed conversation save restores the backup. Interrupted operations can recover after restart. Recovery refuses file content or staging that matches neither the backup nor the target. A completed receipt can recreate its fork without restoring files again. Tests exercise process exit after file restoration, not just a thrown exception.

This is workspace-wide rewind. It can replace changes from the user or other tools, which the review dialog states. It is not selective undo of one agent's edits. A process outside Mako can still write files during the restore critical section; Git locks cannot make arbitrary editor writes atomic. Unsupported index flags, conflicts, sparse checkouts, embedded repositories and submodules are rejected. Non-Git workspaces do not get file checkpoints. Capture is capped at 20,000 files, 256 MB and bounded Git operations. There is no total retention/garbage-collection policy yet, and failed Git object writes do not use a private disposable object store.

## Browser and computer comparison

| Area | Findings at the pinned revisions | Mako status |
| --- | --- | --- |
| Browser observation size | T3's merged [10501](https://github.com/pingdotgg/t3code/pull/10501) bounds snapshot text at 60 KB and repairs result/screenshot handling | Added a 60 KB serialized UTF-8 observation budget, individual field limits and explicit truncation counts. Only emitted node refs remain actionable. Large Unicode fixture verifies bytes and usable refs |
| Browser target ownership | Orca's `browser-host-lease-fence-dispatch.ts` checks connection tokens, generations, routes and pages | Existing conversation-owned target leases and generation checks reject stale/reassigned targets. Uncertain mutations require observation before further mutation |
| Browser accessibility | Orca's `snapshot-engine.ts` supplements accessibility with cursor/onclick/tabindex/contenteditable candidates, combines cross-origin iframe accessibility sessions, and disambiguates repeated names | Mako has bounded accessibility observations and explicit CDP iframe targets. Automatic combined cross-frame observations and Orca's DOM candidate promotion remain gaps |
| Browser command timing | Orca's `desktop-script-request-queue.ts` separates queue expiry from command execution and keeps predecessor ordering | Existing cancellation/uncertainty fixtures cover queued work, late work and no mutation replay. A matched timing benchmark against Orca has not been run |
| Native computer use | Orca owns platform-specific native transports and bounded clipboard processing | Mako forwards the installed native CUA contract, task identity and image metadata. Disposable-app entry/click/readback passed in the earlier control rebuild. This is not universal background-input or Windows certification |
| MonoCode checkpoints | `src-tauri/src/checkpoint.rs` keeps per-file before/after content, limits capture, checks ownership/current content and blocks overlap before undo | MonoCode's selective undo is a useful separate product choice. Its sequential file restores do not demonstrate durable cross-file compensation; staging is reset against HEAD |
| MonoCode browser/computer use | Repository searches found no agent browser or native computer automation runtime. Its harness preview describes tool output; [PR 48](https://github.com/hardbeat920/monocode/pull/48) concerns remote UI access | No browser/computer parity claim can be inferred from those features |

Orca's merged [conversation rewind backend](https://github.com/stablyai/orca/pull/19235) and open [rewind UI](https://github.com/stablyai/orca/pull/19338) concern conversation history, not coordinated filesystem restoration. Its open focus, click and keyboard reports are useful test inputs, not proof that the current product always fails those interactions.

The [earlier Mako control report](../../2026-09-07/orchestrator-browser-computer-comparison.md) contains the all-six-provider browser workflows, exact-target isolation, computer readback and their evidence. Those results already superseded the old failure summary quoted in the request. This review added observation bounds and rewind tests; it did not rerun every earlier provider/browser workflow.

## Verification and remaining parity work

- `npm run test:workspace-snapshots` uses real Git for staged/unstaged/untracked restore, ignored files, stale previews, damaged saved indexes, locks, unborn HEAD, symlinks, crash recovery, post-crash edit refusal and active-writer exclusion. Live integration tests cover queue order, journal failure compensation, restart recovery, cancellation during capture and rewind before the first prompt.
- `npm run test:live`, `npm run test:mcp`, `npm run test:web` and `npm run typecheck` passed. The MCP suite includes the new observation byte limit and stale-ref checks. The web suite validates all 154 generated host method schemas and the real preload boundary.
- Real Codex and Claude each made two file edits through the normal host. Rewind restored the first edit, produced an idle fork and preserved both source requests. Reports are [Codex](verification/codex-rewind.json) and [Claude](verification/claude-rewind.json). The Codex web UI was also exercised through its actual dialog, and the resulting file was independently read. These runs do not test sending a new continuation on the resulting fork. The live Codex run preceded the final before-prompt UI addition and index-checksum hardening; those additions are covered by the focused suites.
- `npm run build` passed, including Electron, browser extension and production renderer. The bundler reported large-chunk and ineffective-dynamic-import warnings. See [build output](../../../audits/2026-09-08/snapshots-controls/verification/build.log).
- `npm run lint` passed with zero errors and two existing TanStack Virtual compiler warnings. Oxlint had zero warnings and errors. See [lint output](../../../audits/2026-09-08/snapshots-controls/verification/lint.log). No rules were disabled.

Rerun paid provider verification with `npm run test:rewind-e2e`, or `MAKO_REWIND_PROVIDER=claude MAKO_REWIND_PORT=5185 npm run test:rewind-e2e`. It creates an isolated host and disposable Git workspace, sends real prompts and checks resulting files. It consumes provider usage.

The provider-control limitation recorded at the end of this initial pass has been superseded by the [SDK/control follow-up](../sdk-controls/README.md). Mako now has explicit Claude and Codex steering, exact active-turn checks and durable uncertain-delivery handling. Claude compaction passed a real recall test; Codex manual compaction remains withheld after context loss. Full V2 parity is still not established. The [current parity matrix](../t3-parity/README.md) separates remaining product gaps from verified workflows. Workspace changes have not replaced the installed application.
