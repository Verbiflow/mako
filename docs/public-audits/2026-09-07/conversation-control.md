# Conversation control: implementation and real-provider evidence

Implemented in the working tree based on `e059a54`, September 7, 2026. This replaces the earlier report that stopped at transport fixtures. No upstream T3 code was imported.

## Paid end-to-end results

All six installed providers executed real model requests through Mako. Each provider had to use its file tool to read a random value from a disposable workspace and return that value. The value was not included in its prompt.

| Provider | Actual file tool | Result |
| --- | --- | --- |
| Claude Code | Read File | Passed |
| Codex | Shell `cat proof.txt` | Passed |
| Cursor | Read File | Passed |
| Grok | Read `proof.txt` | Passed |
| Devin | Read file | Passed |
| OpenCode | read | Passed |

[Machine-readable evidence](paid-provider-evidence.json) contains the native session IDs, random values, commands, and full evidence-directory locations. The runner writes snapshots and receipts before shutting down its disposable Electron host.

The following tests also used actual providers and model responses:

| Behavior | What the test verified | Result |
| --- | --- | --- |
| Claude → Codex → Claude | Same conversation identity; correct recalled value after deleting the original file; compatible Claude connection reused | Passed |
| Model MCP invocation | Claude actually called `mako_conversation_capabilities` | Passed |
| Delegation | Codex actually called `mako_delegate_task`; Claude edited its separate workspace; the parent file remained unchanged; Codex received and reported the child's result | Passed |
| Restart continuation | Destroyed the coordinator and provider process, reopened journals, resumed the same verified native Codex ID, recalled the value without replaying portable history | Passed |
| Native fork | Forked an older completed Codex turn into a distinct native session; excluded a later replacement value; supplied no portable base history; distinct source turns retained distinct native run IDs | Passed |
| Transferred attachments | Deleted original PNG/text files; the destination counted four red and two blue squares and retrieved a random value at the end of a 340,057-byte retained text file | Passed |
| Direct attachments | Codex received an inline PNG and text attachment through normal prompt acceptance, counted the squares, and read the random value | Passed |
| Remote execution and files | Real headless worker and conversation executor over authenticated HTTP; 2,161,054 attachment bytes streamed; actual Codex image/file inspection; model-generated output uploaded byte-for-byte; duplicate upload stored once; invalid token and wrong device rejected | Passed |

The remote test uses a local HTTP gateway and the relay memory-store implementation. It exercises actual network bodies, short-lived signed tenant/device tokens, the worker, the desktop artifact client, provider execution, events, and upload receipts. It does not deploy to or certify the production Azure/Slack service. Backend and relay regression suites run separately.

The first runs exposed two environment problems. OpenCode initially lacked working provider authentication; it passed after the user's sign-in, using `openai/gpt-5.6-sol`. The shell's Codex 0.147.0 could not parse the current Codex configuration. Mako now checks configuration compatibility before creating an app-server thread and can select an already-installed compatible desktop binary. Codex 0.153.4 passed again with the normal PATH, without a test PATH override or changes to the user's configuration. `CODEX_EXECUTABLE` remains an explicit override.

The paid tests also found and drove fixes for Codex MCP approval confirmations, inline attachment staging, non-image attachment delivery, native run ID reset between turns, and the no-base continuation flag.

## Implemented behavior

A Mako conversation keeps its UUID across provider switches. Provider bindings retain native identity, launch settings, and context coverage. Acceptance is durable and idempotent. A queued switch waits for the active turn; destination startup or activation failure preserves the source. Inactive-provider events cannot complete the active request. At most four connections remain resident.

A compatible live binding receives missing context. A dormant native binding can also resume when the provider supports resume, the complete native file fingerprint still matches, and the provider activity probe reports no matching active session. Missing files, changed contents, unavailable probes, thrown probe errors, and absent capabilities fall back to a full captured-context handoff. This is a check of observed native state, not a lock imposed on external applications.

Forks save their selected completed point before allocating a provider. Codex contributes exact `thread/fork` support with `lastTurnId`; other providers retain the portable fork path. Merge-back supplies the fork result to the parent's next request and does not merge workspace files.

Child tasks receive separate Git worktrees containing the current working files, or bounded directory snapshots for non-Git workspaces. Tests verify staged, unstaged, and untracked content, independent sibling edits, unchanged parent files/index/HEAD, and receipt reuse. These workspaces prevent ordinary relative-path edits from colliding; provider permission settings still govern access. Child completion, permission waits, cancellation, recovery, and parent delivery use durable IDs. Model delegation remains restricted in provider-specific parent modes whose permission ordering Mako cannot establish.

Native capture gathers every available page under one stable source checkpoint and rejects missing, changing, or non-progressing pages. Local handoff bundles keep every captured turn; large tool fields use complete sidecars. Native emitters preserve complete tool inputs and outputs in content-addressed files instead of the former 600/2,000-character clipping. Path-based prompt and transfer attachments are retained at acceptance, including while queued. Source deletion and duplicate receipt tests cover both paths.

Provider readers still enforce bounded record and translation limits for multi-gigabyte native stores. Their explicit source-truncation notices remain truthful: Mako cannot reconstruct bytes a provider reader did not capture. A retained resource demonstrates availability; the model tests above demonstrate actual use of the tested images and file contents, rather than claiming every model reads every byte.

Remote jobs now use the same `LiveConversations` controller as the desk. Canonical references survive provider switches, completed job receipts do not re-execute, remote permissions apply only to the executing job, and canceling queued remote work does not interrupt an unrelated local turn. Reasoning, plans, tools, text, and permissions project into relay events. Downloads enforce measured byte limits and close their readers; uploads retain workspace containment and idempotent artifact receipts. Executor failures produce failed completions.

The native CLI queue remains host-owned SQLite state with retained attachments and explicit uncertain recovery. The renderer string queue, direct resume IPC, and provider/folder/time lineage guessing were removed. The shared composer, rail aliases, common timeline, provenance, fork/child controls, and context inspection all project host state.

The MCP endpoint uses the official SDK and Streamable HTTP. Credentials are ephemeral, scoped to a running provider binding, and absent from IPC/journals. Recognized Codex MCP confirmation forms expose an explicit Allow once action; unsupported forms remain unaccepted.

## Regression and browser verification

`npm run verify:sessions` covers typechecking, native-store integrity and fidelity, giant-record bounds, followers, the live coordinator and SQLite receipts, deterministic race tests, provider composition, Codex framing and approvals, workspace/git behavior, stage layout, performance, lint, and production build. Additional commands are `npm run test:mcp`, `npm run relay:test`, and `npm run backend:test`.

Focused regressions cover unchanged/changed/missing/active native checkpoints; all 503 ordered native entries across pages; full native-emitter tool sidecars; queued attachment deletion and duplicate acceptance; remote identity, receipts, permissions, plans/reasoning, and cancellation; and isolated child workspaces. The existing live projection test preserves 499 of 500 exchange identities during a streaming update.

Browser checks used the actual renderer with `?mock`: Claude → Codex → Claude in one conversation, provenance, child creation, lazy fork opening and continuation, and merge-back. Those checks found and fixed a browser-incompatible import and the formerly locked live provider picker. The later provider/relay work is covered by the real runs and regressions above.

Final `verify:sessions`, `test:mcp`, `relay:test`, `backend:test`, and `git diff --check` passed. See [captured verification output](conversation-control-verification.txt). Oxlint reported zero warnings and errors. ESLint has two existing TanStack Virtual / React Compiler warnings; production builds also report existing bundle-size/dynamic-import advisories.

## Reproduce the paid runs

These commands execute real models and consume provider usage:

```sh
npm run build:electron
MAKO_E2E_MODELS='{"opencode":"openai/gpt-5.6-sol"}' node scripts/test-provider-e2e.mjs --flows --fork --restart --attachments --direct-attachments --delegate --remote
```

Pass provider IDs to restrict the initial provider checks. `MAKO_E2E_MODEL` selects one model for a restricted run; `MAKO_E2E_MODELS` selects models by provider. Each run prints its evidence directory. The test grants only the fixture's file reads, explicit delegation, and the selected child's fixture write; it does not enable blanket approval bypass.
