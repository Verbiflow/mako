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
without naming a CLI or MCP tool. Those new model trials have not yet been run.

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

No new third-party dependency was added. The new source has not been installed
into the desktop app. Signed candidate `0d02dc53d0a315ff` predates it; invoking that
candidate's Electron executable against the new worker establishes runtime
compatibility, not acceptance of a newly packaged application.

Remaining: fresh-agent discovery/adherence and complete browser/native jobs through
normal provider startup, interrupted/resumed jobs, a rebuilt signed candidate,
installed extension/host acceptance and current Linux MCP execution. Existing
native focus/input/compositor gaps remain in LC-24/25. This checkpoint does not
establish overall ChatGPT parity or complete usability superiority over the old MCP.
