# Mako and T3 v2: transfer mechanisms compared

Historical comparison before the implementation. See [the implementation and verification record](../2026-09-07/conversation-control.md) for the current behavior. The old probe command now runs the desired-behavior regression suite; `transfer-comparison-verification.txt` retains the original failure evidence.

Mako already supports transferring context, continuing native sessions, importing history into another provider, branching after an answer, and recording provider lineage. The previous recommendation understated this. The architectural gap is durable execution ownership and exact relationships between those operations, not an absence of transfer features.

Reviewed the current dirty Mako working tree and T3 PR #2829 at `415ed0f73b97f1655b6282492f81d0b2bba3a9cc`. Mako findings below distinguish executed failure probes from code inspection. T3 findings are code/test inspection, not an upstream test run. This follow-up changes audit artifacts only.

## What our current paths actually do

### Continuing on the same provider

`src/state/thread-continuation.ts:91` routes by activity and resume support. An idle native thread can resume interactively through a registered live driver, or through the native CLI path. An externally open/active thread goes through `moveAndSend`, even when the provider is unchanged. That creates a continuation rather than taking control of the other application's running process. An ambiguously observed thread is refused until it settles.

This distinction is necessary for a meta-harness. Observing another app's store does not give Mako ownership of its process. Preserve that boundary and make “resume”, “continue from this point”, and “switch the running provider” explicit domain operations.

### Moving context to another provider

`moveAndSend` calls `mako:thread-continue-with`. The renderer preference defaults to `transcript`; the host handler also supports native emission. Its older comment calling native replay the default is misleading about the current UI default.

- Transcript mode builds a content-addressed bundle and asks a fresh provider session to read it. Captured tool payloads and attachments can live in sidecars; budgets and source losses are declared.
- Native mode uses the target provider's registered emitter to create a new native session. The renderer opens and resumes it. Unsupported emission falls back to a transcript artifact.
- Synthesized native history is not a provider-native fork. `packages/sessions/src/emit.ts` flattens foreign tools into assistant text and clips tool inputs to 600 characters and outputs to 2,000. Its header's broad “full history” language exceeds that implementation.
- Switching back follows the conversion/start path again. There is no selection of a prior backing provider thread based on its covered app runs.

### Switching from an active live conversation

`src/state/acp.ts:252` locates the native session, polling the catalog up to 20 times at 100 ms intervals if necessary. It reads that native history, closes the source live connection, removes it from renderer state, then calls `moveAndSend`.

The journal retains source data, but the transfer operation does not have its own durable acceptance, destination-binding or completion record. A destination failure cannot simply leave the source connection as it was. The transfer reads provider storage even though the live coordinator already has a captured baseline and live updates. A lagging native write is therefore a concern that needs a provider-boundary replay test; this audit does not claim to have reproduced that race.

### Lineage and forks

`electron/lineage.ts` persists a map keyed by native path. An origin contains provider and optional title, not source conversation ID, run ID or a fork checkpoint. Synthesized sessions bind directly because Mako knows the emitted path. Fresh CLI sessions instead consume the first pending provider/folder/time match. This is useful display provenance but insufficient execution identity.

`forkAt` passes a numeric entry index to `mako:thread-fork`, generates a sliced transcript bundle and immediately starts a fresh provider. It already provides a portable branch. It does not record a durable, immutable source-run relation or defer provider creation until the first user prompt. The host accepts a numeric slice rather than validating a completed source run.

### Queues, remote control and child work

The repaired live coordinator has durable request IDs, accepted queues, attachments and explicit uncertain outcomes. The older native thread queue is still a renderer-owned array of strings. These are two different quality levels inside the same product.

`@mako/relay` already has job identity, leases, events, stop controls and provider-neutral execution hooks. Its job payloads include new, resume, inspect and configure operations. Those mechanisms should be reused for remote transport. They do not currently supply the reviewed local live contracts with an app-owned parent-run/child-run relationship and durable child-result delivery. Native subagent observations, independent remote jobs and app-owned delegation are distinct capabilities.

## Direct comparison

| Area | Mako now | T3 v2 at reviewed commit | Recommended decision |
| --- | --- | --- | --- |
| Conversation identity | Native paths plus live UUIDs; a live UUID is tied to one provider/workspace | AppThread owns runs and multiple provider-thread bindings | Adopt separate app and provider identities. Retain paths as exact native-store references. |
| Transfer identity | Display lineage and fresh conversion; no single transfer receipt | Explicit transfer/source-point/handoff records | Adopt durable IDs and lifecycle. Remove folder/time matching from owned launches. |
| Return to prior provider | Convert/start again | Select prior provider thread and transfer missing completed runs | Adopt with native-resume capability checks and divergence handling. |
| Portable history | Rich deterministic bundle, sidecars and declared loss | Visible item selection with 240-character text compaction in handoff formatter | Keep Mako packaging; add T3-style transfer selection and records. |
| Native conversion | Writes synthesized target history through provider emitters | Native fork/resume when supported, portable handoff otherwise | Keep emission as explicit import compatibility. Prefer actual native resume/fork when available. |
| Transfer failure | Source closes before destination acceptance in live handoff | Durable commands, transfers and effects model the operation | Adopt explicit stages; design recoverable destination preparation without simultaneous uncontrolled writers. No promise of distributed atomicity. |
| Fork | Immediate portable session at numeric entry index | Idle app fork, exact source run, first-dispatch native or portable resolution | Adopt lazy fork and immutable source point; keep portable bundle fallback. |
| Merge-back | No integrated fork-delta/result-delivery path found in reviewed continuation contracts | Implementation exists; dedicated integration scenario is skipped | Borrow relationship model, but require passing behavior tests before shipping. |
| Delegation | Native/provider activity plus independent relay jobs; no equivalent local parent-child contract | Cross-provider child tasks, scoped MCP, completion deliveries and continuation recovery | Add parent/child semantics through the same host coordinator. Reuse relay for delivery transport. |
| Streaming and transcript | Narrow batches, identity reconciliation, shared exchange renderer | Execution graph provides semantic status and relationships | Keep Mako hot path; project small graph updates into it. Do not resend full graphs per token. |
| External sessions | Broad native-store observation and activity probes | Primarily app-managed orchestration model in reviewed paths | Preserve Mako's external-session strength. Unknown activity is not permission to seize a writer. |

T3 source anchors: [switching selection](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/Orchestrator.ts#L3849), [handoff formatter](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ContextHandoffService.ts#L83), [fork planner](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ThreadForkService.ts#L54), [delegation integration](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts#L468), [continuation recovery](https://github.com/pingdotgg/t3code/blob/415ed0f73b97f1655b6282492f81d0b2bba3a9cc/apps/server/src/orchestration-v2/ProviderContinuationService.test.ts).

## Failures executed against Mako functions

`node docs/public-audits/2026-09-06/compare-transfer-paths.cjs` transpiles the actual repository modules and substitutes only their boundary dependencies. It is a historical defect reproducer, not a desired-behavior regression suite.

1. Two transfers to Claude in the same workspace are pending. Destination B appears first. `bindLineage` assigns it transfer A's provenance. No process correlation participates in matching.
2. A busy native thread receives a prompt with a structured image attachment. `reply` returns true; `queueReply` persists only the text in renderer state. A textual staged-file appendix can survive, so this proves loss of structured delivery rather than deletion of every attachment byte.
3. Live source handoff calls close and removes source renderer state, then the destination rejects. The action returns false with no source restoration. The saved journal/history is not deleted.

Separate code inspection finds that the live-switch composer calls `acp.handoff(harness, full)` without its `acpAttachments`, although same-provider sends and archived-thread moves pass them. The path appendix in `full` can still point at a staged file. This is inconsistent provider delivery, not proof of total file loss.

Fresh validation also passed the sessions build, transcript-bundle tests and content-fidelity tests. Those verify useful properties of the packaging we should keep: deterministic ordering, fences, sidecars, budgets, retained attachments and emitter-reader attachment round trips. Reader round trips do not certify each installed provider's model context.

## Which architecture to choose

| Option | Benefit | Cost or unresolved gap | Judgment |
| --- | --- | --- | --- |
| Patch existing conversions only | Small immediate fixes for matching, attachments and close ordering | Still path-based identity, repeated context conversion and split queues | Necessary repairs, insufficient destination |
| Port T3's orchestrator wholesale | Broad reference implementation for execution graph and delegation | Large migration, app/provider assumptions, simpler context packaging, skipped merge-back coverage | Reject wholesale port |
| Keep Mako storage/rendering; adopt explicit bindings and transfers | Preserves external-session support and content fidelity while making control durable | Requires a deliberate migration of every existing continuation entry point | Recommended hybrid |

The hybrid should use the following records and behavior:

- A stable app conversation ID owns user intent and canonical history. Provider-thread bindings carry native ID/path, provider instance, connection generation and context coverage. Runtime connection state is separate from the native thread's resumability.
- A transfer records operation ID, source conversation/revision and completed source point, target binding, context manifest and status. Context records distinguish selected, delivered and confirmed-covered material. “The provider read this whole file” cannot be proven merely by a prompt asking it to do so.
- A switch first durably accepts intent, establishes a stable source boundary and prepares context/destination. It then dispatches under explicit ownership. If a provider cannot prepare an idle destination separately, expose that capability and preserve a recoverable source record. Never start two writers in the same workspace to fake atomicity. If dispatch outcome is uncertain, recover by receipt/status rather than retrying the prompt blindly.
- The context package has a short current-task/decision summary plus exact referenced history, tool artifacts and attachment resources. Bind the manifest to an immutable source revision and digests. Use a delta when returning to a compatible provider thread; invalidate coverage after rewind, edits or divergence. Budget loss stays visible. Local file grants or remote uploads must make referenced resources reachable to the target.
- Forks record an exact completed source point before provider allocation. The user can browse an idle fork without spending tokens. Merge-back delivers an explicit, attributable result delta with a receipt; it does not silently merge files or mark the source task complete.
- A delegated task adds parent conversation/run, child conversation/run and a scoped authority record. Child completion has its own idempotent delivery ID. Child failure/cancellation remains distinct from parent completion. Sibling workspace-write conflicts need policy even though Mako has no worktree-manager UI.
- UI keeps one conversation row across switches, presents linked provider history, and shows transfer progress/failure in the exchange. Native imports are identified as imported history. Child tasks get status/result links; users can inspect exactly what was transferred or omitted. These are projections from host records, not a second renderer-owned execution system.

A smaller record model does not require copying T3's 7,512-line `Orchestrator.ts` or changing Mako to its framework. Borrow the invariants and replay scenarios. Keep provider adapters independently registered and the sessions package pure. Durable acceptance and provider execution are separate facts in either architecture.

## Acceptance sequence

1. Fix and reverse the three historical probes into desired-behavior tests. Preserve structured attachments in live switches and native queues. Correlate destination creation by explicit ID, never folder/time.
2. Route existing reply, move, live handoff and fork actions through one host-owned command model. Remove the renderer native string queue and heuristic pending-launch identity when migrated. Keep immediate optimistic painting separate from authoritative acceptance.
3. Prove A → B → A keeps one conversation and resumes A with the correct missing history. Add failed startup, lost reply, native-store lag, changed source revision and unavailable-resume scenarios.
4. Prove exact portable content delivery within declared budgets, including a large tool artifact and image across local and remote targets. Test the provider input, not just emitter read-back.
5. Add lazy forks and child tasks with replay tests for root/child termination, canceled delivery, crash recovery, permission ceiling and repeated client request IDs. Require live-adapter validation before claiming provider parity.

The claim we can make now is a justified design recommendation and reproduced defects. These probes have not repaired those defects, and the broader hybrid has not been implemented in this follow-up.
