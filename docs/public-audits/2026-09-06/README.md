# Mako session fidelity and streaming audit

> Historical baseline. The implementation and current verification are documented in [repairs.md](repairs.md).

Mako has demonstrable session correctness problems beneath the UI. The main cause is that native history and live activity use different, lossy representations and become separate sources for the same displayed conversation. Storage revisions, message identity, attachment ownership, and run outcomes need explicit contracts before further transcript polish.

This review covers the current working tree, including the existing uncommitted session-reader, tool-output, and file-citation work. No application source was changed. Fresh Codex, MonoCode, and T3 Code references were fetched into `/tmp/mako-audit-2026-09-06`. The project's existing `ignore/` checkouts were preserved. There is no `repo_ignore` directory here; I interpreted that as the reference-clone request. Exact revisions are in [references.json](/Users/kashyab/pi-ui/docs/public-audits/2026-09-06/references.json).

The findings below combine code inspection, synthetic native stores, and actual renderer state actions against a mocked host. They establish specific failures. They do not constitute a real-provider compatibility certification or an Electron rendering benchmark.

## Findings that should drive the repair

### 1. P1: archived content can be stale or never captured

[archive.ts:181](/Users/kashyab/pi-ui/packages/sessions/src/archive.ts:181) rewrites `entries.jsonl` only when the entry count changes. Completing a tool or extending an assistant message often changes an existing entry. The archive then writes new metadata and state while retaining old content.

The reproduction archives a user prompt and pending tool call, adds its output, and archives again. The saved revision advances from 100 to 200 bytes, but the result is still missing. Once the native store disappears, the archived conversation cannot recover that output.

There is a separate coverage gap. [catalog.ts:193](/Users/kashyab/pi-ui/packages/sessions/src/catalog.ts:193) emits discovery events only when `emitChanges` is enabled. Archival scheduling happens only through those events at [catalog.ts:695](/Users/kashyab/pi-ui/packages/sessions/src/catalog.ts:695). Startup discovery and opening an unchanged session do not schedule capture. `scan()` followed by `open()` and a settle delay produced no archive.

Use a content revision or hash, and commit content, source checkpoint, and metadata as one generation. Reconcile archive coverage from discovered revisions in a bounded background queue. Catalog notifications should not determine whether history survives provider pruning. The current archive is also a normalized, bounded copy, so it should not be described as a lossless native backup.

### 2. P1: normalization erases real user content before rendering

[ThreadEntry and EntryBlock](/Users/kashyab/pi-ui/packages/sessions/src/format.ts:36) retain user text and assistant text, thinking, and flattened tools. They cannot express native attachments, rich tool output, native item identity, or distinct assistant phases.

An image-only Claude user message disappears entirely through [claude.ts:443](/Users/kashyab/pi-ui/packages/sessions/src/providers/claude.ts:443). Cursor's text-content parser, OpenCode's user parsing, and Devin's ACP content extraction likewise retain text rather than complete media references. Reopening, archiving, or moving the conversation inherits this loss.

The live path loses content independently. [acp-notifications.ts:34](/Users/kashyab/pi-ui/electron/acp-notifications.ts:34) converts message chunks through a text-only helper. Image and resource-link chunks produce no visible event. Standard ACP tool `content` is ignored when `rawOutput` is absent. The diagnostic supplies a completed tool with text in its standard content field; the resulting update has no output.

Codex's replay parser keeps only `type` and `text` from user content at [codex-app-parse.ts:425](/Users/kashyab/pi-ui/electron/codex-app-parse.ts:425). A `localImage` survives as a type label while its path is erased. `imageView` becomes `unsupported`, which the protocol handler ignores. The shared [Block contract](/Users/kashyab/pi-ui/electron/contracts/conversation-session.ts:63) names an image kind but has no image source; [Response](/Users/kashyab/pi-ui/src/components/transcript/exchange.tsx:387) renders text, thinking, and tools only.

There is also a direct prompt-loss bug. [userTextFrom:136](/Users/kashyab/pi-ui/packages/sessions/src/format.ts:136) returns nothing for an entire message beginning with a recognized injected envelope. A message containing `<recommended_plugins>…</recommended_plugins>` followed by a genuine request loses that request. The actual Codex reader reproduction retains the assistant answer but zero user turns. Title filtering and faithful transcript extraction must be separate operations.

Preserve typed content references and native item IDs before projecting a compact display. Provider-specific decoding belongs with the provider. Unknown content should remain an explicit unavailable or unsupported item with a source reference, rather than silently disappearing. This does not require putting every provider's private schema into one union.

### 3. P1: live and saved history can display the same turn twice

[acp-panel.tsx:198](/Users/kashyab/pi-ui/src/components/viewer/acp-panel.tsx:198) concatenates native-history exchanges and live exchanges. The native follower stays subscribed after a viewed thread is resumed through ACP or app-server. When the provider persists the same turn, both copies remain.

The reproduction uses the real `view` and `resumeAndSend` actions with a mocked host, then delivers live updates and native entries. It confirms that no `unfollowThread` happens, the active and viewed thread paths match, and the selected panel projects two identical prompts and answers. This is an actual state-route failure, not merely an example of concatenating duplicate arrays.

Use one conversation projection keyed by native item identity and run identity. A persisted item must acknowledge, replace, or enrich its live counterpart. Text matching cannot safely deduplicate repeated prompts. Stable IDs also prevent pagination and earlier-history insertion from changing every displayed identity.

### 4. P1: renderer reconnect cannot recover live controls

[acp-state.ts](/Users/kashyab/pi-ui/src/state/acp-state.ts:50) starts with an empty conversation map. Boot does not enumerate and hydrate the host's live provider sessions. [applyAcpSession:95](/Users/kashyab/pi-ui/src/state/acp-live.ts:95) ignores events for an unknown live session, and updates only enter a bounded buffer.

The synthetic reset clears renderer state while the host-side session is assumed to remain alive. Subsequent running-state and text events restore zero conversations. Reading a native transcript later cannot restore a process-bound approval, queued user submission, or stop control.

Add a host-owned live-session snapshot with provider binding, active attempt, pending controls, and event cursor. Restore it before replaying later events. Persist accepted user submissions and their attachment references before clearing the draft. Explicitly expire process-bound requests when the owning process dies. This finding concerns renderer reload/reconnect; host-crash behavior was not executed.

### 5. P2: a file size is not a valid provider checkpoint

[ClaudeProvider.read:379](/Users/kashyab/pi-ui/packages/sessions/src/providers/claude.ts:379) discards the offset returned by the JSONL reader. [catalog.ts:274](/Users/kashyab/pi-ui/packages/sessions/src/catalog.ts:274) instead follows from `ref.bytes`. Codex and Devin-local share the pattern.

Opening one complete record plus the first 20 bytes of another, then appending the remainder, produces two entries on a fresh read but only one through open-plus-follow. The follower intentionally skips a partial record when asked to begin inside it. It was given the wrong checkpoint. A reload may heal the omission, but the live view is incorrect until then.

Cursor exposes the same mistaken assumption differently. Its discovery stamps the main `store.db` at [cursor.ts:279](/Users/kashyab/pi-ui/packages/sessions/src/providers/cursor.ts:279). [catalog.ts:478](/Users/kashyab/pi-ui/packages/sessions/src/catalog.ts:478) skips an unselected session if that size and mtime remain unchanged. A WAL-only rename produces a fresh title through direct `peek`, while the actual watcher rescan leaves the catalog's old title. This gate also prevents scheduling archive updates for such changes.

Return a snapshot and opaque provider checkpoint from the same read. Keep byte size as metadata. JSONL can use a complete-record offset; SQLite needs a revision or dirty-session mechanism that accounts for WAL and other native metadata.

### 6. P2: live updates rebuild completed conversation structure

[acp-panel.tsx:188](/Users/kashyab/pi-ui/src/components/viewer/acp-panel.tsx:188) converts all live blocks into new messages and exchanges whenever blocks change. The live reducer copies the block array, and the projection recreates even completed messages. A one-token update retained zero of 499 completed exchange and response identities in a synthetic 500-turn session.

The host also emits each ACP/app-server chunk directly through IPC. The existing bulk `acp-updates` path supports replay, but does not establish frame coalescing for ordinary token notifications. Coalescing after IPC would still pay serialization and bridge delivery for each chunk.

The projection-only microbenchmark grew from roughly 4 ms for 1,000 updates over 30 turns to 37 ms over 500 turns and 301 ms over 5,000 turns. Those totals exclude React, IPC, Markdown parsing, layout, and paint. They prove history-dependent work, not a measured user-visible latency.

Existing protections matter: `Prose` is memoized and throttled, the timeline initially mounts a limited number of exchanges, and offscreen content has containment. It would be wrong to claim every old Markdown body reparses on every token. The demonstrated waste is rebuilding the history projection and invalidating mounted exchange props.

Apply updates by item ID, preserve completed object identity, and coalesce deltas before IPC. Always flush terminal events. Measure provider-event-to-paint latency on representative long conversations before choosing a final paint budget.

### 7. P2: output presence and process readiness masquerade as success

[acp-blocks.ts:80](/Users/kashyab/pi-ui/src/lib/acp-blocks.ts:80) treats any tool output as a finished tool. The reproduction sends the first output chunk while source status remains `in_progress`; projection already emits `toolResult`, causing the downstream tool pairing to lose its pending state. Partial output must coexist with a running tool.

Failed turns have a related modeling problem. [acp.ts:583](/Users/kashyab/pi-ui/electron/acp.ts:583) catches a provider failure and reports a ready session with an error. [acp-live.ts:73](/Users/kashyab/pi-ui/src/state/acp-live.ts:73) recognizes failure only through `status === "failed"`; ready sessions can be marked for review and drain queued prompts. [LiveStatus](/Users/kashyab/pi-ui/src/components/viewer/acp-panel.tsx:107) displays Ready. The reducer reproduction produces `review` attention after a failed turn.

Separate process readiness from turn outcome. Give each tool an explicit lifecycle and incremental content. Preserve the failed turn visibly while allowing the provider process to remain ready for another request.

### 8. P2: hyperlinks and attachments are inferred from presentation text

The new citation parser handles `#L12-L18` and two Codex citation forms, but [file-citations.ts:75](/Users/kashyab/pi-ui/src/lib/file-citations.ts:75) does not split colon-based line suffixes. `/work/src/a.ts:42` becomes a filename ending in `:42`; `a.ts:42` is not recognized as a local target. The default Markdown URL transform strips `file:` and editor schemes before link handling. [linkFileCitations:45](/Users/kashyab/pi-ui/src/lib/file-citations.ts:45) also rewrites literal citation examples inside fenced code, changing their displayed and copied contents.

All recognized file citations route through a workspace file viewer. [readThreadFile](/Users/kashyab/pi-ui/electron/threads.ts:450) enforces that thread's workspace root through `WorkspaceFiles`. An agent-generated artifact outside the repo needs an explicit artifact route, not a blanket removal of the workspace boundary. Markdown media similarly needs a resolved media source rather than treating an absolute filesystem path as a browser URL.

Attachments have a separate demonstrated display loss. [parseAttachmentAppendix:390](/Users/kashyab/pi-ui/src/lib/attachments.ts:390) removes the whole appendix once it finds any staged file. A prompt with an inline text attachment and a staged image returns only the image chip; the text attachment's name and contents disappear from the display projection.

[composer.tsx:293](/Users/kashyab/pi-ui/src/components/composer/composer.tsx:293) catches image staging failure and still constructs a sendable prompt. On the Codex path, the missing staged path also means no `localImage` input. The composer can therefore clear after sending a request whose screenshot never arrived. Text attachments are truncated at 200,000 characters without preserving their original file through the text path.

Use a durable attachment record with ID, name, MIME type, byte size, source/blob reference, and staging state. Keep prompt text separate. Provider adapters should report exactly how each attachment can be delivered. A failed required attachment should preserve the draft and show the failure before a send is accepted.

For links, normalize destinations into file-plus-range, artifact, external URL, and provider deep-link variants. Parse provider citation syntax within the Markdown structure so literal code stays literal. Keep provider-specific syntax in provider-owned modules and use shared components for the resolved destination.

## What the upstream projects actually contribute

### Codex

The fetched Codex revision has typed items with stable IDs, a client user-message ID, assistant phase, citations, and delivery fields. User input distinguishes text spans, local and remote images, local and remote audio, skills, and mentions. It also has explicit image-view and image-generation items. Mako's handwritten subset discards several of those distinctions. Use the protocol version exposed by the installed provider to generate or validate the boundary, and keep unknown item handling observable. [Codex item contract](https://github.com/openai/codex/blob/112be0bd74ce327788613f4f8f92e8b7c92447c7/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L234), [Codex input contract](https://github.com/openai/codex/blob/112be0bd74ce327788613f4f8f92e8b7c92447c7/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L392).

Its app-server also distinguishes metadata reads from paginated turns/items. The lesson is to use provider-owned observation and history APIs where available while retaining native-store discovery for external activity. A fresh upstream checkout is a compatibility reference, not proof that the user's installed CLI already speaks that revision. [Codex history APIs](https://github.com/openai/codex/blob/112be0bd74ce327788613f4f8f92e8b7c92447c7/codex-rs/app-server/README.md#L706).

### T3 Code Orchestrator v2

V2 was still the open [PR #2829](https://github.com/pingdotgg/t3code/pull/2829) at inspection, with head `415ed0f7`. The fetched main branch is a separate comparison. Do not equate the proposed design with a released, proven implementation.

Its strongest mechanism is the command transaction. It reserves an idempotent command receipt, appends domain events, updates projections, enqueues provider effects, and finalizes the receipt in one SQL transaction. It publishes only after commit. Mako can adopt this boundary for accepted sends, provider bindings, and durable control state without copying the whole orchestration stack. [EventSink](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/EventSink.ts#L462).

The stream subscribes before capturing the high-water mark, replays the gap, then delivers later events. Its bounded stream falls back to a snapshot beyond 128 events or 1 MiB. Stored tool detail and wire projections are separate. These directly address Mako's read/follow and reconnect gaps. [Replay ordering](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/EventSink.ts#L588), [stream budget](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ThreadStream.ts#L1).

V2 also separates app-thread identity, provider-native thread, run attempt, item, and process-bound interaction. Recovery expires requests that can no longer be answered and settles interrupted attempts before an optional restart. That is the right separation for Mako's provider-neutral host and pure sessions package. [Identity contracts](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/packages/contracts/src/orchestrationV2.ts#L557), [runtime recovery](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L174).

However, this branch defaults legacy token streaming off and filters running assistant message/item events unless enabled. It is a recovery reference, not evidence of a better instantaneous token display. Preserve narrow, incremental assistant deltas in Mako. [Streaming filter](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/RunExecutionService.ts#L528).

### MonoCode

MonoCode persists its own session record plus provider-session binding, orders writes per session, and prevents late writes after deletion. It uses immutable block identity to decide whether content changed, rather than serializing the whole conversation merely to compare it. Those are useful mechanics for Mako's archive and renderer. Snapshot debouncing still needs a stated durability policy; it does not persist every displayed token. [Session persistence](https://github.com/hardbeat920/monocode/blob/93cf01ac334c3b1271ef19516f2bdd9ac3af6503/src/lib/sessionStore.ts#L116).

For Cursor, it enriches specific pending tool IDs from the native store, bounded to 256 per query. Its Markdown parser recognizes Cursor's `start:end:path` code-fence citation form. Both are useful fixtures and provider-owned enrichment patterns. [Cursor enrichment](https://github.com/hardbeat920/monocode/blob/93cf01ac334c3b1271ef19516f2bdd9ac3af6503/src/lib/harness/cursor.ts#L981), [citation parsing](https://github.com/hardbeat920/monocode/blob/93cf01ac334c3b1271ef19516f2bdd9ac3af6503/src/surfaces/AgentMarkdown.tsx#L536).

Do not copy its generic text merge heuristic. It guesses delta versus snapshot from equality and prefixes. Two legitimate `"ha"` deltas collapse to `"ha"` rather than `"haha"`. The provider adapter should declare whether an update appends or replaces. [Merge implementation](https://github.com/hardbeat920/monocode/blob/93cf01ac334c3b1271ef19516f2bdd9ac3af6503/src/lib/harness/streamText.ts#L12).

## Proposed target and delivery order

Keep provider-owned processes and native stores, the React-free state layer, one shared transcript renderer, bounded readers, narrow subscriptions, and existing reconciliation/containment. A provider should still be installed through its existing module. No embedded coding-agent runtime is needed.

The target is one host-owned conversation projection receiving both live provider events and native observations. Durable identity connects those inputs. Content can reference stored or provider-owned assets; large details load separately. The renderer receives versioned item changes and a snapshot-plus-cursor for reconnect. Displayed history and live activity then use the same items.

1. Repair known data loss first: archive content revisions and initial capture, partial-record checkpoints, Cursor WAL invalidation, and mixed-envelope prompt extraction. Each has a small executable fixture here.
2. Define stable thread/run/item/tool identity and explicit append, replace, complete, fail, and cancel operations. Converge native and live paths into one projection, retaining immutable completed entries.
3. Add typed content and durable attachment references, then migrate readers, live adapters, handoffs, archive versions, and rendering together. Remove text-appendix inference once its callers migrate. Preserve a source reference and an honest loss marker for unsupported content.
4. Add accepted-command receipts, live-session hydration, and process-aware recovery. Reuse suitable pure relay concepts without importing Electron or provider implementations into `@mako/sessions` or `@mako/relay`.
5. Coalesce before IPC and profile the real app. Validate with long histories, tool bursts, large output, session switching, attachments, and reconnect. Ship provider fixtures for the same semantic scenarios across Codex, Claude, Cursor, Devin, OpenCode, and Grok.

Acceptance criteria should include: one visible item for a live/native duplicate; identical content after reopen; complete attachment identity after restart; exactly one accepted send after a retry; partial JSONL records preserved; WAL-only revisions observed; no old attempt modifying a new one; running tools remaining running during output; failed turns remaining visibly failed; and completed exchange identities surviving token updates. For performance, start with a proposed p95 event-to-paint target below 100 ms, then validate or revise it against actual Electron measurements. It is a target, not an audit result.

## Verification and limits

Run the diagnostic bundle from the repository root:

```sh
node docs/public-audits/2026-09-06/run.mjs
```

These assertions deliberately confirm the defects described above. They are diagnostic evidence, not passing acceptance tests. After repairs, replace their assertions with the expected behavior in the owning test suites. The archive and Cursor checks invoke the existing runtime-private write/rescan methods to exercise settled commits and watcher reconciliation deterministically. Other checks use provider readers, pure transforms, or actual state actions with a mocked host. No test reads private transcripts or calls a live coding provider.

All seven diagnostic files reproduced their cases. [Captured output](results.txt) includes the performance sample and actual resume/follow routing.

Existing checks also passed: the full `@mako/sessions` suite, `test:stage`, `test:codex-protocol`, and `test:performance`. The resume matrix validates Mako's emitted sessions with Mako's readers; it does not establish current vendor-CLI resume compatibility. That requires separate provider-owned integration fixtures and controlled real-provider smoke tests.

`npm run lint` exited successfully. ESLint reported two existing React Compiler incompatibility warnings around `useVirtualizer` in `file-tree.tsx` and `search-view.tsx`, with zero errors. Oxlint reported no warnings or errors. No lint rules were changed.

The audit did not run upstream test suites, exercise real provider processes, profile Electron paint, or verify every current vendor hyperlink convention. Cursor WAL behavior, Codex envelope loss, Claude image-only loss, shared ACP rich-content loss, and the described state transitions were executed. Other provider coverage includes code tracing and the repository's synthetic suites. Current uncommitted code may still be evolving; the reviewed base and upstream commits are pinned in the manifest.
