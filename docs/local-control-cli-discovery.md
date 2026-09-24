# CLI discovery and adherence investigation

The user reports that agents became worse at finding and using Local Control
after the public MCP migration. This investigation distinguishes capability
discovery, API learning and correct execution. The report is not yet a measured
MCP-versus-CLI regression. [Wayfinder LC-29](local-control-map.md#lc-29--agent-discovery-and-mcp-integration)
owns the work and acceptance gates.

## Baseline before the revised MCP decision

At the start of this investigation, source and signed candidate `0d02dc53d0a315ff` have no Local Control skill
and no public Local Control MCP adapter. `electron/control-launch.ts` prepends the
task CLI to PATH, sets its session file and supplies a short `<mako-local-control>`
prompt paragraph. It says to read `--help`, use composable commands or `exec`,
verify results and avoid replaying unknown outcomes. `live-conversations.ts`
adds it to each outgoing request using that request's active binding.

The environment is wired through Codex app-server, Claude SDK, Cursor SDK and
shared ACP launch paths. This establishes source wiring, not what every resumed,
compacted, child-agent or installed session actually receives. The owner test
checks that the command appears in the instructions and that the environment and
worker cleanup are correct. It does not measure whether an agent selects the CLI
or obeys the instructions on a task where the user did not name Local Control.

The installed desktop remains `345bfd91c64009c6`. Its archive lacks
`control-launch.js`, retains the runtime's `./mcp` export and `mako-control-mcp`
binary, and injects browser credentials into the older `mako-control` server.
That is a different integration from the current candidate. Reported experiences
must be tied to their actual host/provider/build before attributing them to the
CLI migration. No installer was run during this investigation.

A read-only Mako session-database check also found that a keyword match on
`mako-control` can merely be a Docker image name in shell output. Such matches
are not CLI adoption or failure evidence. The user was asked for a specific
example; none was supplied before this initial report. Do not count this
conversation's development commands as ordinary agent discovery.

## Measured documentation cost

An isolated task session with no browser or native driver configured returned:

| Entry | Output bytes |
| --- | ---: |
| Injected prompt note, including this task's absolute command | 399 |
| Root text `--help` | 2,486 |
| Root JSON `--help --json` | 9,735 |
| `exec --help` | 1,554 |
| Full `api` | 10,187 |
| `api --topic examples` | 2,116 |

These are bytes, not token estimates. This single run took about 105–385 ms per
command including process startup. The root JSON catalog includes every command's
details, so it is not a compact alternative to root text help. No device input,
image or provider/model request was needed to measure these outputs.

The prior fresh-agent trials first needed 18 browser help calls and 16 logged
native help calls plus initial help. After help changes, separate trials used two
browser help calls and three native calls including one repeat for logging.
Those were successful isolated jobs, but the agents were explicitly given a CLI
and task. They do not establish spontaneous discovery during normal provider use.
See [original review](local-control-cli-review.md) and
[revised-help trials](local-control-cli-modal.md).

## What the audited OpenAI implementation does

The existing `codex-cu-layers-3-4-deep-dive.md` describes this layer. Its findings
were checked against local shipped files on September 24: `@oai/cua` 0.2.5,
`@oai/cua-repl` 0.1.0, `@oai/sky` 0.7.1, and the cached
`unified-computer-use` plugin 26.915.31945.

1. **A visible tool advertises the capability.** The unified plugin registers the
   `cua_repl` MCP server. The model-facing operation executes persistent JavaScript;
   it is not a CLI-only interface or a separate MCP operation for every UI action.
2. **The tool description gives exact entry points.** Platform-specific
   instructions say which one call to make first for an app, named browser,
   existing tab or inventory, then to read the returned documentation. These
   are instructions to the agent; this audit does not claim a code-level grammar
   that enforces every first-call rule.
3. **Documentation arrives with initialization and selection.**
   `create_tinysky_alt.js` emits the core document on initialization, caches
   browser documentation and emits browser additions as a browser is selected.
   It serializes documentation writes. The agent does not have to independently
   discover a sequence of help topics before it sees the API contract.
4. **There is an explicit recovery step for lost context.** The tool description
   directs resumed/compacted tasks to call `cua.rewriteDocumentation()`.
   The implementation retains the applicable documents and re-emits them,
   avoiding duplicate rewrites for the same request metadata.
5. **The older route has a skill.** The shipped
   `sky/docs/skills/oai_sky_lib/macos/SKILL.md` supplies a trigger description,
   initialization, workflow, exact API signatures and verification guidance for
   `node_repl` plus `@oai/sky`. The checked unified plugin directory itself
   contains a manifest and MCP configuration, not a `SKILL.md`. These are
   different entry routes; do not describe them as a single universal stack.
6. **Lifecycle is host-owned.** The unified plugin hooks Stop, Interrupt and
   SubagentStop to its turn-ended operation. This helps the driver clean up;
   it is separate from how the model learns the API.

Relevant files under
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/`:
`cua-repl/instructions/{macos,linux,windows}/`,
`cua/docs/tinysky-alt-core-cua-repl.md`,
`cua/dist/lib/js/oai_js_cua/src/tinysky_alt/{create_tinysky_alt,documentation}.js`,
and the older sky skill above. Source hashes are retained in the ignored audit.
The core unified document alone is 13,229 bytes, before confirmation policy and
browser additions. Automatic delivery is a discovery advantage to test, not
proof that the reference always uses fewer tokens.

This establishes the local audited Codex/ChatGPT-bundled implementation. It does
not establish the exact discovery prompt, skill injection, backend or memory
behavior of every hosted ChatGPT/cloud deployment. No further reference material
is needed to start improving Mako's discovery. If a cloud-specific comparison is
required, the missing evidence is its first model-visible tool/skill inventory,
first-call instructions/result, and post-compaction instructions with secrets and
page contents removed.

## Accepted design: SDK, CLI and persistent JS MCP

On September 24 the user replaced the earlier CLI-only Mako integration decision
with the current unified-REPL approach. The skill-plus-CLI recommendation is
superseded. This does not revive the old status/help/exec MCP contract.

- `@mako/control` owns typed handles, operations and the trusted program worker.
- `@mako/control-runtime` owns the task engine and adapters. CLI and MCP call the
  same session directly; MCP never shells out to the CLI. External Node consumers
  can import the packages without Electron.
- Mako advertises a small browser/computer JavaScript MCP surface, with precise
  initial discovery examples, automatic first-use documentation, focused help,
  and a documentation refresh operation for resumed or compacted context.
- Ordinary JavaScript bindings and top-level await persist. Explicit reset clears
  program bindings, not app/browser state, leases or recordings. Cancellation and
  deadlines stop the worker, invalidate program state and report uncertainty;
  neither adapter replays input. The host owns task cleanup.
- CLI commands retain composable JSON, stdin and file artifacts. MCP returns
  explicitly requested images as images with existing output bounds. Reading text
  does not capture a screenshot. Target-specific support comes from capabilities,
  not guesses about the app.

The adapter, shared-worker execution and provider wiring are implemented locally.
See [implementation evidence](local-control-agent-repl.md) for the completed tests
and remaining fresh-agent and release gates. Keep the old source/candidate/installed measurements above
as historical evidence; they do not describe the new adapter as deployed.

Validate through normal startup, where the user asks for a result and does not
name a control tool. Compare matched jobs/builds for first correct action, help
bytes, malformed calls, wrong-tool use, verification omissions, uncertain retries
and independently correct completion. Include resume/compaction and provider
adapters. Better instructions and subprocess tests alone do not establish parity.
