# Composable Local Control commands

Historical CLI-only source and signed-candidate acceptance passed for browser and native computer use. The
idle installation and installed checks are tracked in the
[deployment receipt](local-control-cli-deployment.json); see
[Wayfinder LC-20](local-control-map.md#lc-20--shared-engine-and-composable-cli).
The [architecture contract](local-control-architecture.md) owns the boundaries;
the [issue ledger](local-control-agent-issues.md) tracks the original agent failures.

## Current integration

Mako agents now primarily use the persistent JavaScript MCP adapter. The CLI is
an optional composable interface for external callers; both borrow the same task
engine. The previous CLI-only delivery decision below is superseded by
[LC-29](local-control-map.md#lc-29--cli-discovery-and-agent-adherence). Its tests
remain evidence for the underlying engine, not acceptance of the new MCP adapter.

## Earlier CLI-only migration

The September 24 source now starts task-owned desktop workers independently of
MCP. Codex, ACP providers, Claude SDK and Cursor SDK receive an exact CLI shim on
PATH, a private session descriptor and short command-first instructions. Browser
credentials travel to the worker over IPC; they are absent from the shim and
provider control environment. Public Local Control MCP registration, adapter,
package export and launcher are removed. The Cua executable's private MCP
transport and unrelated Mako MCP integrations remain.

Command help is offline: `mako-control --help`, `shot --help`, `record --help` and
`help shot` describe arguments, outputs, examples and failure semantics. Add
`--json` for structured help. `api --topic examples` and `api --domain Page
--method navigate` load focused JavaScript/backend reference from the session.
All browser and native actions still use the shared engine's targeting,
observations, route checks, assertions and recording implementation.

Source acceptance covers separate CLI processes, lossless state, cancellation
without replay, recording waiter cancellation, code/session mismatch, explicit
shutdown, killed workers and killed parents. The managed MCP regression confirms
Local Control is absent while other integrations remain. Fresh Codex, Claude and Cursor browser jobs and a Codex native AppKit job also
passed. The [acceptance record](local-control-cli-evidence.md) retains
failed attempts and limits, including Cursor’s eight help calls. The signed candidate also passes packaged CLI startup and 40 regular-profile Aside
jobs. These results do not establish installed-host rollout or fresh-agent acceptance on every provider.
Streaming work remains paused until those migration release gates are closed.

## Dialog interruption

A click/key operation that opens a modal can return `dialog-open/unknown` before
its acknowledgement. Never repeat the input. Inspect `tab.dialog({})`, answer
explicitly, then observe the exact tab before continuing. Answering a dialog does
not itself prove the original action succeeded. Page focus restoration waits for
the dialog to close; task teardown still resets or detaches.

## One session across commands

[`createControlSession`](../packages/control-runtime/src/control-session.ts) owns the runtime, target
references, recovery state, native policy, recordings and cleanup.
[`startDesktopControlSession`](../packages/control-runtime/src/desktop-session.ts) owns the desktop worker and task CLI.
The [CLI](../packages/control-runtime/src/control-cli.ts) uses that same session through a private Unix
socket. It does not start another browser, input engine or reference cache for
each command. Separate CLI processes share script `state`, exact target leases and recordings.

An ordinary command closes only its request connection. Explicit stop, task
teardown, deadline or supervisor death closes the engine. The socket directory is
0700; its descriptor and socket are 0600. The client rejects foreign ownership,
symlinks, stale sessions, protocol mismatches and mismatched engine code identities.
A descriptor chooses a session; it is not a bearer credential. This is a same-user
local interface, not a sandbox between mutually untrusted processes sharing a UID.
Untrusted cloud jobs still need the VM/container boundary.

## Use it

In a built checkout, run `node /absolute/mako/packages/control-runtime/dist/control-cli.js`.
The standalone package provides `mako-control`. The installed Mac app also contains the CLI:

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/Mako.app/Contents/MacOS/Mako \
  /Applications/Mako.app/Contents/Resources/app.asar/node_modules/@mako/control-runtime/dist/control-cli.js \
  status --session-file "$session_file"
```

A global `mako-control` shell alias is not installed automatically. Use a CLI
from the same build as the session: mismatched engines refuse explicitly.

On Mac, the task supervisor supplies `mako-control` and `MAKO_CONTROL_SESSION_FILE`
automatically. Its absolute command path is also in the task instructions for
shells that replace PATH. The permission-owning host stays in charge. On Linux, a trusted job
configuration can start the existing non-Electron supervisor:

```sh
session_file=$(mako-control session start --config job.json | jq -r .sessionFile)
mako-control browsers --session-file "$session_file" | jq '.browsers[]'
mako-control connect --browser "$browser_id" --session-file "$session_file"
mako-control open --browser "$browser_id" --url https://example.com \
  --session-file "$session_file" > target.json
mako-control observe --target-file target.json --session-file "$session_file"
mako-control shot --target-file target.json --role button --name Save --format png \
  --output 'Save button.png' --session-file "$session_file" > capture.json
mako-control exec --source-file workflow.js --session-file "$session_file"
mako-control session stop --session-file "$session_file"
```

Use the browser ID from discovery; selection never silently substitutes another
browser. `tabs --browser ID` returns `{kind:"pages",browser,pages}`;
`claim --browser ID --tab ID` returns an exact target. `apps` and `windows --pid PID`
use the native backend. `open --input options.json` accepts the existing browser
open options, including `disposition:"window"`, `background`, context and lifetime.
A failed navigation retains the created target in `{target,navigation}` and exits
nonzero. Inspect that target rather than repeating the open.

`--input`, `--target-file` and `--source-file` accept `-` for stdin; only one input
may consume it. For example, `cat target.json | mako-control observe --target-file -
--session-file "$session_file"` preserves the exact generation and lease.

| Command | Input and output |
| --- | --- |
| `observe` | Exact target plus optional read scope in `--input`; returns structured observation. Does not capture images. |
| `act` | Exact target plus a closed operation in `--input`, such as `{ "kind":"set-text", "ref":"…", "text":"Hello" }`; returns dispatch evidence. |
| `shot` | Requires `--output`. `--format png\|jpeg` selects the encoding; the filename alone does not. Optional `--role`/`--name` or `{selector:{role,name,within},options:{…}}` through `--input`. Writes actual image bytes and returns path, SHA-256, byte count, dimensions and coordinate metadata. Existing files require `--overwrite`. |
| `record start` | Exact target, optional `--directory`, `--name`, `--fps`, `--max-side` or structured recording options; returns a receipt containing the target and recording ID. |
| `record stop --input receipt.json --wait` | Waits for finalization; returns the final receipt. `finished` and `video` establish a completed artifact. Failed/interrupted artifacts exit nonzero. `record status` reads the same receipt ID. |
| `exec --source-file workflow.js` | Trusted JavaScript using the existing control API. Waits for completion without MCP cells. Returns an array of result/log/artifact blocks; explicit images are saved to files. Script state survives commands. The existing script deadline still applies. |
| `diagnostics` | Last 100 shared-engine commands and last 100 socket requests, with IDs, timing, target identity and outcome. Does not record arguments, source, page contents or image bytes. |
| `COMMAND --help` / `help COMMAND` | Offline signatures, result contracts, examples and exit codes. `--json` returns structured command help. |
| `api --topic TOPIC` | Focused JavaScript API help; `--tool ACTION` reads a native schema; `--domain DOMAIN --method METHOD` reads CDP help. |

One JSON result goes to stdout; failures go to stderr as JSON. No automatic
reconnection or replay occurs. Screenshot files use exclusive temporary files,
fsync and atomic publication. Images never appear as base64 on ordinary stdout.
Large explicit script values keep the existing lossless artifact receipts.

Exit codes: **2** invalid request; **3** unavailable/stale session or target,
including observation required; **4** unknown outcome; **5** rejected operation or
failed/interrupted artifact; **130** cancellation. Zero for an action establishes
dispatch, not the intended UI state. Use `handle.expect(...)` to verify it.
A broken result pipe may occur after an action completed; it returns unknown,
never a reason to repeat the program. Cancellation of a script resets its worker
state. The isolated Linux supervisor additionally tears down that job on script
cancellation, preserving its stronger held-input cleanup policy.

## Updates and diagnostics

The handshake identifies the protocol, exact session and shared engine code.
The code digest covers the local engine dependency graph and compiled
`@mako/control`; a graph regression test catches missing modules. It is a
compatibility check, not binary signing or attestation of the native driver.
Updating a CLI does not update an active engine. Replace idle sessions explicitly;
never retry against a new session after a lost reply.

Diagnostics are bounded metadata. Shared command timings include queueing and
backend work; socket timings include request processing. They do not yet separate
all backend stages or measure rendered viewer latency. Backend/artifact counters
remain in their existing owners.

## Verification and remaining release gates

`npm run test:control-cli` checks actual separate shell processes sharing a task
session: stdin, paths containing spaces, retained Unicode state, image artifacts,
no implicit screenshots, closed output pipes, cancellation without replay,
reconciliation, build/session mismatch and shutdown. It also cancels a recording
waiter while capture shutdown is held, verifies one shutdown across repeated stop
calls, finalizes the same recording and runs another tab plus four concurrent
shell programs while finalization is pending. BrowserService regressions
cover profile cookie ownership and raw browser administration. Native-driver regression fixtures call the engine directly; public workflow probes launch the CLI.

`scripts/test-control-cli-linux.mjs` runs against real Chromium in the reviewed
Linux runtime image. It verifies form state and one Save, scoped capture, a
recording with an interleaved clipped screenshot, playable final output and
supervisor cleanup. The eleven existing Linux lifecycle scenarios also passed
after extraction. This iteration ran on ARM64; previous native Intel evidence is
not a substitute for rerunning the new CLI package on x64 before release.

`scripts/test-control-cli-native-linux.mjs` exercises real GTK through separate
CLI processes: exact Unicode, independently counted Save, full/resized PNG and
JPEG files, refused unsupported pointer/60 fps operations, four concurrent scripts,
playable native video and process cleanup. ARM64 passed; the x64 workflow now
includes both browser and native CLI jobs but has not been run for this build.
See [native media and interruption evidence](audits/2026-09-23/local-control-cli-media.md).

Installation, fresh-agent usability on the installed host, latest native x64 CLI
acceptance, sustained workloads and viewer latency remain release gates. `watch --jsonl` and human takeover are deferred. Neither is required
to share the browser/computer engine; neither has been silently implemented here.
