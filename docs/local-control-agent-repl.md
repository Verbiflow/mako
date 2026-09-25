# Unified agent MCP implementation

September 24, 2026. [LC-29](local-control-map.md#lc-29--agent-discovery-and-mcp-integration)
owns acceptance and rollout. This implements the user's revised decision: Mako
agents use MCP over a typed SDK; the basic CLI remains available to external
callers. The earlier CLI-only integration decision is superseded.

## One engine

`@mako/control-runtime/mcp` exports `createControlMcpServer` and `controlAgent`.
An embedded Node caller can pass its existing runtime directly. Desktop Mako
passes a typed request to the task's existing worker over its private socket.
Neither path runs CLI commands or constructs a second control session.

The session owns target generations, leases, observation refs, native guards,
recordings and cleanup. The worker owns JavaScript bindings and shared `state`.
The same action implementations run through either interface. A test opens a page
through MCP, observes it through the shell protocol, then attempts an MCP action
using the old ref: the engine rejects it before browser input. Another test
verifies exact Unicode/whitespace across both interfaces.

The MCP adapter borrows the task. Closing its transport does not close targets;
task teardown still does. Mako's HTTP listener checks the binding grant and routes
cancellation notifications to the original request, including when the notification
arrives over a separate stateless HTTP transport. Revocation aborts active requests.

## Agent contract

The server advertises two tools: `js({code,timeout_ms?,title?})` and `js_reset({})`.
There are no status/help/exec tool variants or numeric continuation tickets.

- `js` supports top-level await, persistent lexical bindings and dynamic Node
  imports. Its last expression emits compact JSON; `console.log` emits additional
  values and `emitImage` explicitly emits images.
- First use emits core documentation plus discovery/handle guidance. Browser and
  native action sections arrive when that route is first used. Documentation
  writes are serialized and not repeated on every call.
- `control.help({topic})` returns focused help in the caller's execution syntax;
  native schema and pinned CDP help remain available. `control.status()` reports
  readiness without requesting permission. `control.rewriteDocumentation()`
  restores previously used sections after context loss.
- Ordinary errors preserve bindings and already-emitted evidence. Cancellation,
  deadline expiry or worker loss resets the worker; an earlier action may have
  completed. No action is replayed. Both interfaces share the program queue.
- Explicit reset clears program bindings and `state`, preserving task targets and
  recordings. `await handle.recording(id)` recovers an existing recording from its
  exact receipt without starting another capture.
- Images retain their pixels. The four-image count and 24 MiB total base64 budget
  spill overflow to complete files, keeping the worker reply below its 32 MiB
  limit. Text reads do not capture screenshots.

The JavaScript implementation uses V8 REPL evaluation inside the existing worker,
not a source-code rewriter. It opens no inspector network listener. Node's default
VM import loader preserves `import()`; Node labels that hook experimental in its
[Node 24 documentation](https://github.com/nodejs/node/blob/v24.0.0/doc/api/vm.md#support-of-dynamic-import-in-compilation-apis).
It was exercised under Node 24.19 and the existing candidate's Electron executable,
including imports, bindings and ordinary-error recovery. Runtime upgrades must run
these checks. The worker remains trusted local code, not an OS sandbox.

## Comparison with the retired MCP

Source comparison: `ed95552^:packages/control-runtime/src/computer-tools-main.ts`.
This is a capability inventory, not a matched model-performance benchmark.

| Earlier public MCP | Current route |
| --- | --- |
| Separate status tool | `await control.status()` |
| Separate full/focused help tool | First-use docs plus `control.help(...)` |
| Async-function source, persistent `state` | Top-level await, persistent bindings, shared `state` |
| Long-running numeric cells to collect | One cancellable call awaiting completion, bounded by its deadline |
| Explicit images and lossless artifact spill | Retained; total inline image bytes also bounded |
| Checkpoint/recall and artifact helpers | Retained in the worker |
| Browser/native handles, raw native calls, CDP, screenshots and recording | Same SDK and engine implementations |
| MCP server owns session lifetime | Task supervisor owns it; MCP borrows it |

Codex app-server, Claude SDK, Cursor SDK and the ACP launch path receive the new
endpoint. The production startup note advertises MCP first. The real-provider
acceptance harness now wires that endpoint and asks for the fixture outcome
without naming a CLI or MCP tool. Fresh Codex and Claude browser/native trials
now pass for the scope below. Cursor and Grok ACP repeats also pass; Cursor’s native JavaScript mistakes remain recorded below.

## Validation and limits

Completed locally:

- `test-control-repl.ts`: actual MCP client/server plus the worker/socket engine;
  persistent variables/imports, focused docs, exact values, explicit images,
  error evidence, shared refs/state, reset, timeout, cancellation, late callbacks,
  queue ordering, image overflow and owner cleanup.
- `test-control-owner.ts`: real loopback HTTP and desktop worker; cross-request
  bindings, MCP cancellation, lost-worker cleanup and revoked-token refusal.
- Existing browser-program, native-engine, MCP projection and conversation
  lifecycle regressions; SDK tests for recovering only the exact recording.
- Packed npm consumer imports and TypeScript declarations, relocated engine
  identity, direct MCP/SDK use without Electron, cleanup and secret canaries.
- Electron host typecheck and full lint. Lint has five existing React Compiler
  warnings and no errors; anti-slop passes.

The fixture's first discovery result is about 4 KiB including documentation;
repeat discovery is 210 bytes. Warm MCP → private socket → worker discovery calls
were a few milliseconds on this Mac. This is a local smoke measurement with a
synthetic browser inventory, not native capture latency, model context usage or
an equal-or-better task benchmark. Logs and the engine identity are preserved in
`docs/audits/2026-09-24/local-control-agent-repl/` (ignored).

No new third-party dependency was added. Signed candidate `3c1d563e25a9bd78`
contains the MCP implementation and the review's discovery/scope guidance fixes.
It also includes the ACP negotiation and idle-worker crash fixes below. Its
control code matches the tested source. It replaces the older `0d02dc53d0a315ff`
candidate for this rollout. Build `3c1d563e25a9bd78` is installed. The initial
post-install check failed because the deployment process reused cached ASAR
headers after replacing the bundle. The installation itself succeeded. The
metadata reader now invalidates that archive's cache before reading; an atomic
replacement regression test reproduces the old failure and passes the fix.
[Installed acceptance](#september-24-installed-acceptance-and-recovery) records
current checks. The [live receipt](local-control-mcp-deployment.json) retains the
historical failure and now records `installed-validated`.

Remaining platform/provider cells are owned by Wayfinder LC-29. Native
focus/input/compositor gaps remain in LC-24/25. This checkpoint does not establish
overall ChatGPT parity or complete usability superiority over the old MCP.

## September 24 re-review and fresh-agent acceptance

The browser test still explicitly coached the CLI despite the accepted MCP
design. It now supplies the task and browser choice only; normal production
startup and the tool description must establish discovery. Both tests require
actual `mako-control` MCP calls. Browser completion requires exactly one correct
submission with trusted input/click events, a screenshot and closing the created
tab. Native completion is independently read from an AppKit fixture; a second
user turn checks exact Unicode and surrounding spaces while foreground sampling
continues. These are real installed provider runs through source Mako launch code
and a frozen control worker, not mocked model responses.

| Provider/model | Browser, regular Aside profile | Native, two user turns |
| --- | --- | --- |
| Codex / `gpt-6-astra` | Passed: 9 MCP calls, 53.4 s, zero tool errors | Passed: 12 MCP calls, exact values, target never sampled foreground |
| Claude / `claude-fable-5-1` | Repeat passed: 7 MCP calls, 44.1 s, zero tool errors | Repeat passed: 4 MCP calls, exact values, target never sampled foreground |
| Cursor / `auto-smart` | Repeat passed: 13 MCP calls, 70.6 s, zero tool errors | Repeat completed: 18 MCP calls, three recovered JavaScript errors, exact values, target never sampled foreground |
| Grok ACP / `grok-4.7` | Not run in this review | Repeat passed: 6 actual endpoint calls, exact values, target never sampled foreground |

Preserved failures matter:

- ACP prepared the control server but omitted it from the negotiated session’s
  server list. Grok could not discover it and fell back to the CLI. The negotiated
  list now includes the same typed HTTP endpoint when the provider supports HTTP.
  The original test falsely counted a tool-search title as MCP use; acceptance now
  counts actual requests received by the endpoint. The original Grok run is a
  discovery failure despite its correct UI outcome.
- Cursor’s first native run lost the entire task session after a JavaScript error
  left a promise outstanding. A later worker error arrived after per-call error
  listeners had been removed, so Node terminated the desktop session owner.
  Lifetime error/exit listeners now invalidate only that program worker. A
  controlled delayed-error reproduction loses the session on `1226a367de0c1b11`
  and preserves it after the fix. HTTP ownership and final packaged tests prove
  the existing tab survives and fresh documentation returns. No actions replay.
  Cursor’s repeat finished both native turns; its three variable/reference coding
  mistakes recovered without session loss. This is not a zero-error native run.

- Claude's first browser job finished correctly but used `within:[{role:'form'}]`
  without the required name. It observed after the refusal and did not repeat the
  completed writes. The zero-error gate failed. Help now explicitly requires both
  observed role and name and recommends an unscoped read when no named scope was
  observed. Strict targeting was retained; no guessed scope was accepted.
- Claude's first native follow-up hit the test runner's permission allowlist while
  inspecting the JSON fixture file with a shell command. The initial UI job had
  passed. The follow-up now supplies its exact JSON string directly; the repeated
  test still independently checks the same background UI outcome. This was an
  acceptance-runner limitation, not a native delivery failure.
- Initial native discovery enumerated apps despite a supplied pid. Entry guidance
  now names `control.windows(pid)` for that case. A help template also accidentally
  removed the prose word “return” in REPL mode; that wording is corrected.

Call counts include discovery and verification. These few runs do not establish a
statistical improvement, and their different models are not a matched comparison.
Provider snapshots encode tool output differently, so persisted byte counts must
not be compared as model tokens. No token-efficiency superiority is claimed.

Candidate `3c1d563e25a9bd78` passed signature/package checks (1,100 frozen files,
693 resolved host imports), CLI/shared-state checks, and direct plus LaunchServices
startup/reopen. `scripts/test-packaged-control-mcp.mjs` then exercised the actual
packaged HTTP MCP endpoint, private worker and installed Aside extension together:
scoped exact Unicode save, a confirmation interruption followed by inspection and
acceptance without click replay, unchanged Billing form, explicit screenshot,
reset and an idle worker fault preserving the tab, and cleanup. The same task session completed an exact
native value edit, verification and window screenshot without fronting its fixture.
The expected dialog interruption returned in 369 ms in this run. This is candidate
acceptance using the installed extension, not a claim that the default desktop host
has already switched builds.

Regression checks: persistent REPL/HTTP cancellation and ownership tests pass;
full lint has five existing React Compiler warnings and no errors. Reproducible
entry points are `test-provider-e2e.mjs <provider> --control --browser` and
`test-packaged-control-mcp.mjs <Mako.app>`. Logs and sanitized summaries are in
`docs/audits/2026-09-24/local-control-mcp-review/` (ignored); no credentials or
raw user browser content belong in tracked evidence.

## September 24 installed acceptance and recovery

All checks here target installed build `3c1d563e25a9bd78`, engine
`0d964cac9bc5b939d3ce8e7e2adcbb6732c4fc409dfcbc0f0331d8cf713c748c`.
The fix is in deployment tooling; no desktop reinstall or input-engine change is
needed. `@electron/asar` caches file headers by archive pathname. A long-lived
installer first read the old `/Applications/Mako.app` archive, replaced that
bundle, then read the new manifest with the old header offsets. A fresh process
passed because it had no stale cache. `scripts/local-app-metadata.mjs` now clears
only the selected archive's cache before extracting the manifest; signer
selection and startup verification share that reader. The original temporary
deployment script uses it too. Signature verification and expected-build checks
remain mandatory. No parse error is swallowed or treated as success.

Completed checks:

- `node scripts/test-update-local.mjs`: atomic archive replacement with changed
  file offsets, plus existing signer, install ordering and failure checks.
- `node scripts/test-local-package.mjs /Applications/Mako.app`: installed package
  and signer; `verifyStarted('/Applications/Mako.app')`: actual shared host build.
- `node scripts/test-packaged-control-cli.mjs /Applications/Mako.app`: installed
  SDK/MCP/CLI state, engine identity and cleanup.
- `node scripts/test-packaged-control-mcp.mjs /Applications/Mako.app`: real
  installed ASAR → HTTP MCP → worker → Aside regular-profile extension and native
  AppKit. Exact spaced Unicode, scoped form targeting, unchanged Billing field,
  one trusted save, confirmation interruption, screenshots, reset and idle-worker
  fault recovery all pass. Closing/reconnecting MCP preserves task state. A
  cancelled call reaches the independently acknowledged fixture action exactly
  once, clears bindings and preserves the target; its delayed second action never
  runs. Documentation restoration preserves checkpointed facts and the target.
- The same MCP check drops its browser connection explicitly. The old generation
  is rejected. Reconnection returns a new generation and confirms that the
  temporary tab was removed; it does not reopen the tab or replay its save.
- `node scripts/test-installed-control-agent.mjs codex gpt-6-astra`: a new task
  through the default installed host discovers MCP without the prompt naming a
  tool. A completed real Codex compaction retains its native session; the next
  turn restores SDK documentation and verifies another exact native value.
  The initial two-turn run used 5 then 7 MCP calls and 691 foreground samples,
  none showing the fixture. Exact native tool input independently confirms
  `control.rewriteDocumentation()`. The runner now counts returned documentation,
  since Mako's saved tool blocks omit inputs; missing input is not zero refreshes.

The extended default-host run also passed: three completed exact-value turns,
one deliberately interrupted turn, confirmed provider compaction, documentation
restoration, and the same native provider session throughout. Cancelling after
the field changed prevented the delayed Verify action for more than 30 seconds.
The resumed task observed the state and verified a new exact value. There were
1,006 foreground samples, none showing the fixture. Completed turns took
28.3 / 22.1 / 15.9 seconds including model time; those are single-run measurements,
not latency benchmarks. The first
runner attempt used an invalid hard-coded Codex mode (`full-access`) and failed
before any model turn; the runner now selects the provider's declared full-access
mode and reports startup failures immediately. Keep that failure as runner
evidence, not a product failure or a successful trial.

These are scoped acceptance results, not a performance superiority claim. Model
compaction coverage is Codex/macOS; other providers and Linux still need their own
runs. SDK recovery checks do not imply arbitrary service-worker/browser restart
retention. Japanese IME remains deferred by the user. Source lint and targeted
checks accompany the change; unrelated concurrent edits are outside this review.

Evidence and preserved runner failures: `docs/audits/2026-09-24/local-control-installed-acceptance/` (ignored). The [deployment receipt](local-control-mcp-deployment.json) is now `installed-validated`. This closes the Mac/Aside + Codex installed-acceptance milestone; streaming/recording is next, with other provider/platform cells still tracked.
