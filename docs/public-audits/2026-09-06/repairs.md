# Session foundation repairs

Implemented against the existing Mako working tree. The initial audit in `README.md` is a historical baseline; its reproduction scripts assert the former defects. Use `npm run verify:sessions` to verify the repaired implementation.

## What changed

| Area | Repaired behavior | Main implementation |
| --- | --- | --- |
| Live ownership | The host owns conversation IDs, durable request acceptance, queues, permissions, connection state, and revisioned snapshots. Repeated request IDs do not dispatch twice. Rejected acceptance cannot execute later. | `electron/live-conversations.ts`, `electron/live-journal.ts` |
| Recovery | Renderer boot reads summaries and hydrates selected conversations. Missing revisions request an authoritative snapshot. Lost start/send replies are checked against accepted requests. Restarted provider connections remain disconnected; uncertain completions are visible and are not replayed automatically. | `src/state/live-recovery.ts`, `src/state/acp-start.ts`, `src/state/acp-queue.ts` |
| Storage | Archive metadata and content commit together in SQLite. Same-count edits and initial discovery are captured. Shutdown awaits queued captures. JSONL following starts at the last complete record; Cursor revisions include WAL and metadata changes. | `packages/sessions/src/archive.ts`, `catalog.ts`, `providers/cursor.ts` |
| One history | A captured native baseline and host-owned live updates feed the same projection. Native file updates cannot append the same live answer a second time. Pagination refuses to mix changed native revisions into an old capture. | `src/state/live-projection.ts`, `electron/live-conversations.ts` |
| Streaming | Host batches ordinary updates per frame, flushes controls and terminal state promptly, and bounds bursts before IPC. Large text updates are split. Large live tool results retain full output in an attached artifact and show an explicit preview. Completed message and exchange identities are reconciled. | `electron/live-assets.ts`, `electron/contracts/live-content.ts`, `src/lib/reconcile.ts` |
| Provider composition | Interactive execution and native-resume capability come from provider registrations. Codex no longer falls through an old renderer hard-coded resume list. Public controls and events use a provider-neutral live contract. | `electron/providers/live-driver.ts`, provider registrations, `src/state/thread-tuning.ts` |
| Content | Canonical entries retain image/file/audio/resource attachments and native item/tool IDs. ACP standard content is decoded. Tool output can remain visibly in progress. Repeated prompts are preserved. Injected metadata envelopes cannot erase following user text. | `packages/sessions/src/content.ts`, `thread-schema.ts`, provider readers, `electron/acp-notifications.ts` |
| Attachments | Original staged files remain available; pending/failed staging blocks send. Archives retain attachment bytes, including after original deletion. Portable imports retain attachment references. Transcript exports include their sidecar content. | `src/lib/attachments.ts`, `packages/sessions/src/attachment-storage.ts`, `emit.ts`, `transcript.ts` |
| Links | File line/column suffixes, file URLs, editor URLs, Codex citation markers, and Cursor code ranges resolve through the shared renderer. Literal code is preserved. Reads use the originating conversation, with signed preview URLs and exact provider-referenced artifact grants. | `src/lib/citation-markdown.ts`, `src/components/transcript/source-context.ts`, `electron/file-previews.ts` |
| Drafts | Text, rejected sends, and staged attachment references persist across reloads. The 64-session eviction limit is removed. Restoring a rejected send cannot overwrite text typed in another draft. | `src/state/drafts.ts`, `src/lib/draft-persistence.ts`, composer |

## What Orchestrator v2 contributes

**Correction:** The following describes only the reliability subset adopted in these repairs. V2 also implements a broader execution graph, provider switching with context deltas, cross-provider delegation and lazy forks, plus partially verified merge-back. See [the corrected deep dive](orchestrator-v2-deep-dive.md) for source evidence, maturity limits and the remaining Mako gaps.

The reviewed [T3 Code Orchestrator v2 PR](https://github.com/pingdotgg/t3code/pull/2829) makes command acceptance, durable events/projections, outbox dispatch, and reconnect recovery explicit. It distinguishes a conversation from the provider process serving it. Its value here is operational correctness: accepting a command has a durable meaning; reconnecting does not invent completion; an approval cannot outlive its process.

Mako adopts those principles with independent SQLite conversation journals, request receipts, explicit dispatch state, provider-owned drivers, and revisioned snapshot recovery. This is a smaller snapshot-based design; it does not reproduce T3's entire event-sourcing system or claim exactly-once execution inside a provider. A crash after dispatch is deliberately reported as an uncertain result.

Codex informed typed item identity and authoritative final-item replacement. MonoCode informed native Cursor metadata handling and file citation conventions. No upstream implementation was copied verbatim. Exact source commits and reference checkout locations remain in `references.json`; `ignore/` was not edited.

## Verification

`npm run verify:sessions` passed on the repaired working tree. It runs typechecking, the complete sessions package suite, live coordinator and actual bridge-routing tests, draft and citation checks, Codex protocol tests, provider composition, host file/git tests, stage tests, the existing performance check, lint, and a production build. Full output is in `repair-verification.txt`.

Specific evidence:

- A 1,000-chunk burst produces at most nine batches; each batch holds at most 128 updates.
- A 400,000-character answer remains intact; a similarly sized tool result has a bounded preview and an exact saved artifact.
- A token added to a 500-turn conversation preserves all 499 completed exchange objects.
- Disk-write failure cannot convert rejected intent into a later dispatched request. Lost start replies recover the accepted request without resending it.
- One corrupt journal does not block other conversations from opening.
- All four native emitters (Claude, Codex, Cursor, Grok) preserve user and assistant attachment references on read-back. Devin and Grok native image-only ACP prompts survive translation.
- The native suite covers gigabyte Codex input, complete-record following, concurrent catalog refreshes, archive deletion ordering, WAL revisions, provider tool updates, and daemon recovery.
- The browser fixture UI was exercised through actual clicks and sends: native Codex history remained visible, the new prompt and reply appeared once, completion cleared the working state, and an unsent draft survived reload.

## Scope and remaining validation

The checks exercise real storage, parsers, coordinator, renderer actions, and the browser UI against synthetic provider transports. They do not certify every installed CLI version or measure real provider-event-to-paint latency. Provider processes still end when Mako quits; saved conversations and accepted intent survive, and old process-bound approvals do not.

Native readers and archives retain their explicit bounded-history budgets. They are not raw, unlimited native-store backups. Provider output that was already truncated upstream cannot be reconstructed. Cursor and Devin native interactive resume remain capability-limited; their fresh interactive execution and native CLI continuation paths remain available.

The verification run reports two existing React Compiler warnings for isolated TanStack virtualizer components and existing large-bundle warnings. ESLint reports no errors; Oxlint reports no warnings or errors. No lint rules were disabled or downgraded.
