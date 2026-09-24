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
are not CLI adoption or failure evidence. The initial request for a specific example is superseded by the direct session
review below; the user asked us to find the evidence ourselves. Do not count this
conversation's development commands as ordinary agent discovery.

## Session evidence checked directly on September 24

The user asked us to find examples ourselves. Read-only searches covered 147
conversation databases under Mako's default and dev profiles, excluding this
investigation's active conversation. The search examined tool names and inputs
in saved blocks and imported base entries; keywords in output alone were not
counted. It produced 1,030 candidate records in 21 databases **before manual
classification**. These are search candidates, not usage counts: source edits,
searches, inherited history and duplicate conversations are present. No failure
rate or CLI/MCP comparison can be derived from that count.

The following concrete records were checked with their complete stored tool
inputs/outputs. None of the cited block IDs had pending `block_appends` rows.
Database block IDs are local evidence locators; these private databases are not
repository artifacts. The exact host build is not recorded in these rows, so
attribute them only to the observed tool contract, not a guessed release.

| Session / provider | Observed behavior | Implication for the current MCP |
| --- | --- | --- |
| `1fcfc788-e429-4707-9de8-d5258d3aa854`, Claude, double-tab-bar task; blocks 56, 61, 63, 67 | Opening the dev browser failed with “Connect this browser first.” The agent guessed `browser.connect`, got `browser is not defined`, fetched help, then used the documented advanced connect route. Screenshot input subsequently rejected `target.kind`. | Old MCP discovery succeeded, but connection instructions and target contracts caused recovery work. First-use docs now name `control.connectBrowser(id)` and typed handles own screenshot targeting. Preserve this exact disconnected-browser job as a fresh-agent acceptance case. |
| `af856bab-cfc4-430f-a1d5-50cd04eb713f`, Cursor, “app doesn't feel snappy”; block 1076 | Sent `{code: ...}` to `mako_control_exec`, which required `source`; the tool correctly rejected it before dispatch. | This is an old MCP argument mismatch, not evidence of CLI misuse. Current `js` takes `code`, waits for completion and has no cell-collection contract. Test continuation from old context as well as fresh startup. |
| Same Cursor session; blocks 2410, 2457–2458 | Listing tabs while disconnected failed; later `select({name: /.../})` rejected `name`, followed by another observations help call. Eight explicit help calls are present across the long session, not eight before its first action. | Current docs explain connection and consistent string `role`/`name` queries; regex matching remains unsupported. Measure help cost per task/turn instead of counting a whole evolving session as onboarding. |
| `4a327b69-78cb-4ac6-bee6-7557fa707fd5`, Cursor, client-error investigation; blocks 77, 79–80 | Saved a target through `checkpoint`, then assumed `(await recall()).remember.target`; the read failed. The next call copied the previous exact target receipt and observed it. | Old explicit state bookkeeping was confusing. Persistent bindings now handle ordinary calls; reset/compaction acceptance must still prove exact-target recovery. This record does not show an uncertain input being replayed. |

These examples used `mako_control_exec`/`mako_control_help`, the retired MCP
contract. They establish real usability problems predating the newest integration.
They do **not** establish that a CLI migration caused a regression or that the
new MCP has solved every problem. Some tool records label an error-containing
result `completed`; future metrics must inspect result envelopes and independent
outcomes, not just the provider's status label. Likewise, error text inside a
successful UI observation is page content, not a tool failure.

The newly installed MCP did work in this resumed conversation: automatic docs,
explicit Aside extension connection, background scratch-page observation/cleanup,
and depth-limited native Ghostty observation. This is prompted live access proof,
not an unprompted discovery benchmark. Its app/tab inventories also returned
installed-but-stopped apps and non-selectable browser targets; measure the context
cost before changing defaults or hiding potentially useful diagnostic information.

Next acceptance jobs should cover disconnected-browser recovery, continuation
with an obsolete API in history, reset/compaction target recovery, and ordinary
UI work that does not name a tool. Keep endpoint invocation evidence, exact
outcome checks and output-byte measurements. Existing provider trials remain
separate from these historical sessions. No additional session identifiers are
needed from the user to continue the investigation.

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
