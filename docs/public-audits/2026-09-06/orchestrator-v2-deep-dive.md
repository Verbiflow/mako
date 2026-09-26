# Orchestrator v2: corrected assessment

Follow-up: [Mako versus T3 transfer comparison](mako-versus-t3-transfers.md) traces our existing native conversion, portable bundles, persisted lineage and fork paths, with three executable failure probes. It refines this report's Mako comparison and recommends a hybrid.

Reviewed T3 Code PR #2829 at `415ed0f73b97f1655b6282492f81d0b2bba3a9cc`, confirmed against its remote head on this follow-up. The earlier repairs report described the reliability subset we adopted. That was an incomplete account of v2. Its larger contribution is an app-owned execution and conversation model spanning provider-native sessions, delegation, branches, context transfer, and recovery.

This is source and test inspection, not a successful upstream test run. The PR remains open, and its author notes outstanding all-provider replay/schema alignment work. Some TODO checkboxes and design passages lag the implementation. Conversely, code existing is not proof of production readiness.

## What is actually interesting

| Capability | Concrete behavior | Evidence and maturity |
| --- | --- | --- |
| One app conversation, multiple provider histories | AppThread identity survives switching providers; runs, attempts, native provider threads, nodes, requests and checkpoints have separate identities. Child completion cannot finish the root run. | Implemented contracts and adapter events; broader than a persisted message list. |
| Return to a previous provider | Codex handles runs 1–5, Claude 6–8, then Codex resumes its backing thread with the missing 6–8 context. A new target gets full context; returning targets normally get a delta. Pending merge-back and active-turn restart can require full context. | `Orchestrator.ts` lines 3849–3930 implements run-range selection and strategy, not merely a design proposal. The implementation uses last-run ordinals and handoff records; the design's richer coverage discussion should not be mistaken for a complete general coverage solver. |
| Cross-provider delegated agents | A parent can create a child using another provider/model, track it, cancel it, and collect results. A child receives its supplied task and role rather than automatically inheriting the full parent transcript. Native provider subagents and app-owned delegated children remain distinguishable. | MCP toolkit/service plus a deterministic integration scenario explicitly covering cross-provider delegation; an additional Codex replay test covers running/queued follow-ups. |
| Durable result delivery | Child completion becomes a tracked delivery to the parent. Continuations queue behind active work, retry transient dispatch failures, and reject stale or disposed deliveries. Recovered messages are not blindly dispatched again. | `ProviderContinuationService.test.ts` tests retries, backoff, archive/delete barriers, persisted-message recovery and invalidation. This is orchestration beyond simply launching multiple processes. |
| Agent access to the application | MCP lets agents start/read/list/update/send/wait/interrupt ordinary threads, separately from delegation. Credentials are scoped to provider sessions, and child permissions cannot exceed the parent. Agent-created prompts preserve their provenance. | Implemented toolkit, session registry and service. Ordinary top-level thread creation is explicitly distinguished from child delegation. |
| Lazy forks | Creating a branch records its source point without immediately starting another provider. First dispatch chooses a native fork or portable context. Earlier Codex source turns use a child-local rollback; Claude has native fork paths too. | Active replay integration tests cover Codex and Claude first-dispatch forks, earlier turns and fork-local rollback. |
| Merge findings back | A fork can prepare its changes in conversation context for the original thread's next run. This is context transfer, not a Git merge. | Service/orchestrator implementation exists, but the dedicated merge-back integration scenario is `it.skip` at `ThreadFork.integration.test.ts:1463`. Do not describe it as fully verified. |
| Coordinated rewind | Checkpoint handling connects filesystem state, provider conversation position and app execution history; provider capabilities determine what rollback is possible. | Checkpoint capture/rollback services and tests. A transcript-only rewind cannot provide equivalent semantics. |
| Capability-driven controls | Support is described separately for steering, queued turns, interrupt/restart, native forks, snapshots, approvals, subagents, plans, context injection, terminal quality and identity strength. | The contract is much richer than provider name plus a resume flag. Advertised capability still needs adapter validation. |
| Scheduling and workspace automation | The branch also includes persisted scheduled tasks, thread launch/management integration, schedule calculations, and MCP worktree tooling. | Implemented adjacent services. These are broader branch scope, not all intrinsic to the orchestration core. Mako explicitly excludes a worktree manager from its product surface. |

## Limits worth carrying into our design

`ContextHandoffService.ts:94–163` creates handoff text by selecting visible item types and compacting their text. It is not a demonstrated sophisticated semantic memory system. Full/delta selection is valuable; summary fidelity and attachment/resource transfer still deserve independent tests. Neither the graph nor an outbox automatically solves provider-specific citations, attachment bodies, efficient markdown rendering, or event-to-paint latency.

The design describes root turns, tools, approvals, plans, native subagents and delegated work in one execution graph. That enables accurate parent/child status and navigation. It does not require displaying a literal deeply nested tree or replacing Mako's exchange-based transcript. A useful Mako presentation would keep exchanges and expose child work, handoffs, approvals and branches as linked records with clear provenance.

## What Mako has, and what our repairs did not deliver

The repaired `electron/live-conversations.ts` and `electron/live-journal.ts` provide durable conversation ownership, request receipts, queues and recovery. Native history plus live projection now avoids duplicate rendering. Those are useful foundations, but they are not equivalent to v2's execution graph and transfer model.

Mako's current `src/state/acp.ts:252` handoff reads the saved native thread, closes the live session, and invokes `threads.moveAndSend`. It is a different mechanism from retaining several provider-native backing threads under one app conversation and tracking each provider's context coverage. The live registry exposes availability/resume behavior, not v2's detailed capability matrix.

Mako already has a provider-neutral relay worker/job/event protocol and backend MCP integrations. Calling it devoid of orchestration or MCP would be inaccurate. The specific gap is integrating local conversation lineage, provider continuity, delegated child execution and result delivery into one durable model. Existing relay transport should not be duplicated to do this.

## Recommended adaptation order

1. Define app conversation, run/attempt, provider-thread binding and context-transfer records. Prove Codex → Claude → Codex retains one app identity and injects exactly the missing completed history, with a safe fallback when native resume fails.
2. Make capabilities explicit and validate them through adapter replay fixtures. Test root-vs-child terminal events, approval ownership, content/resource fidelity and cancel/restart behavior.
3. Add app-owned child runs and scoped MCP delegation through the same host command path. Prove crash/retry cannot duplicate delivery or revive canceled children; preserve agent-vs-human provenance.
4. Add lazy forks and explicit context merge-back with source-point tracking. Require active passing integration coverage before shipping merge-back.
5. Integrate checkpoint rewind only where both filesystem and provider semantics can be stated truthfully. Keep unsupported operations explicit.

This is a proposed architecture sequence, not a claim that these capabilities were implemented by the previous repairs. The corrected investigation changes audit documentation only.

## Sources and reproducibility

All source links below are pinned to the reviewed commit:

- [Architecture and goals](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/docs/orchestration-v2/README.md)
- [Lineage and transfer design](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/docs/orchestration-v2/thread-lineage-and-context-transfer.md)
- [Switching implementation](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/Orchestrator.ts#L3849)
- [Handoff formatting](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ContextHandoffService.ts#L94)
- [MCP tools](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/mcp/toolkits/orchestrator/tools.ts)
- [Delegation integration scenarios](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts#L468)
- [Continuation recovery tests](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ProviderContinuationService.test.ts)
- [Fork integration tests and skipped merge-back scenario](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/testkit/ThreadFork.integration.test.ts)
- [Capability contract](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/packages/contracts/src/orchestrationV2.ts)
- [Scheduled tasks](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/scheduledTasks/ScheduledTaskService.ts)

Rerun `python3 docs/public-audits/2026-09-06/index-orchestrator-evidence.py /path/to/t3code` to regenerate the accompanying `orchestrator-v2-evidence.json`. The script reads the exact git revision, indexes source documents and named effect/live/skipped tests, and explicitly records that tests were not executed. It is an evidence index, not a behavioral test or an exhaustive test parser.
