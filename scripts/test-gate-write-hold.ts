/**
 * A command hook's call held for its turn's checkpoint (`/calls/<pre|before>` on the conversation server):
 * - Mako's conversation server answers once the gate does, so a hook's call waits for the turn's hold;
 * - only calls that may write wait, and a call the gate denies never does (it never runs);
 * - a hold past the hooks' own timeout lets the call go first and counts it as an early write;
 * - a Codex launch holds writes only where none of the person's own Codex hooks or plugins run beside Mako's.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CALL_GATE_HOLD_MS, gateDenies, heldAnswer, hookMayWrite, HookCall } from "@mako/host/harnesses/call-gate"
import { codexPersonCodeRuns } from "@mako/host/harnesses/codex/person-code"
import { openCodePersonCodeRuns } from "@mako/host/harnesses/opencode/person-code"
import { GROK_CALL_HOOKS } from "@mako/host/harnesses/grok/call-hooks"
import { grokPersonCodeRuns } from "@mako/host/harnesses/grok/person-code"
import type { JsonObject } from "@mako/host/contracts/json"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"

async function settlesWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([pending.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
}

const root = mkdtempSync(join(tmpdir(), "mako-gate-write-"))
try {
  // Which calls wait: anything that may write, never a read; a denied call never runs, so it never waits.
  {
    for (const tool of ["Bash", "apply_patch", "exec", "edit", "write", "bash", "mcp__node_repl__js", "mcp__other__thing", undefined])
      assert.equal(hookMayWrite(HookCall.parse({ ...tool && { tool_name: tool } })), true, `${tool ?? "an unnamed tool"} may write`)
    for (const tool of ["Read", "Grep", "read", "glob", "grep", "list", "webfetch", "todowrite"])
      assert.equal(hookMayWrite(HookCall.parse({ tool_name: tool })), false, `${tool} only reads`)
    for (const command of ["ls -la", "git status", "rg TODO src | head"]) assert.equal(hookMayWrite(HookCall.parse({ tool_name: "Bash", tool_input: { command } })), false, `${command} only reads, so it goes at once`)
    for (const command of ["echo x > f", "npm install", "git commit -m x"]) assert.equal(hookMayWrite(HookCall.parse({ tool_name: "Bash", tool_input: { command } })), true, `${command} may write`)
    assert.equal(gateDenies({ decision: "block", reason: "no" }), true)
    assert.equal(gateDenies({}), false)
    assert.ok(CALL_GATE_HOLD_MS < 8_000, "Mako answers before the hooks give up (curl -m 8, OpenCode's 8 s abort)")
    console.log("PASS: calls that may write wait, reads and denied calls don't")
  }

  // The host's gate (`heldAnswer`): a call that runs and may write waits for its turn; a denied one, a `post`, a read don't.
  {
    const holds = new WriteHolds()
    const gate = Promise.withResolvers<void>()
    let early = 0
    holds.hold("b", { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
    const answer = (event: "pre" | "post" | "before", tool: string, given = {}) => heldAnswer(holds, event, HookCall.parse({ tool_name: tool }), given, "b")
    const deny = { decision: "block", reason: "routed" }
    assert.deepEqual(await answer("before", "Bash", deny), deny, "a denied call is answered at once: it never runs")
    assert.equal(await settlesWithin(answer("post", "apply_patch"), 50), true, "after the tool ran, nothing waits")
    assert.equal(await settlesWithin(answer("before", "Read"), 50), true, "a read goes at once")
    const patch = answer("before", "apply_patch")
    assert.equal(await settlesWithin(patch, 100), false, "a patch waits for its turn's checkpoint")
    gate.resolve()
    assert.equal(await settlesWithin(patch, 1_000), true)
    assert.equal(early, 1, "let go before the checkpoint held, it's an early write")
    console.log("PASS: the host's gate holds a call that runs and may write, nothing else")
  }

  // A hold past the deadline lets the call go and says it wrote early; one released in time doesn't.
  {
    const holds = new WriteHolds()
    let early = 0
    const gate = Promise.withResolvers<void>()
    holds.hold("b", { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
    const began = Date.now()
    await holds.beforeWrite("b", undefined, 100)
    assert.ok(Date.now() - began >= 95, "the call waited until the deadline")
    assert.equal(early, 1, "a call let go at the deadline before the checkpoint held is an early write")
    let frozen = false
    const late = Promise.withResolvers<void>()
    holds.hold("c", { until: late.promise, frozen: () => frozen, wrote: () => { early += 1 } })
    const waiting = holds.beforeWrite("c", undefined, 5_000)
    frozen = true
    late.resolve()
    await waiting
    assert.equal(early, 1, "a call let go once the checkpoint held wrote nothing early")
    console.log("PASS: a hold past the hooks' timeout lets go first and counts the write as early")
  }

  // The conversation server answers a hook's post only once its gate does: a held call waits there.
  {
    const release = Promise.withResolvers<void>()
    const bindings: string[] = []
    const tools = await startConversationMcp({ authorizeAgent: () => {} }, async () => null, [() => {}], async (_conversation, _event, _body, binding) => {
      bindings.push(binding)
      await release.promise
      return {}
    })
    try {
      const grant = tools.mint("binding-1", "conversation-1")
      assert.ok(grant.makoUrl)
      const posted = fetch(grant.makoUrl.replace(/\/mako$/, "/calls/before"), {
        method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool_name: "apply_patch", tool_input: {} }),
      })
      assert.equal(await settlesWithin(posted, 200), false, "the hook's call waits while the gate holds it")
      assert.deepEqual(bindings, ["binding-1"], "the gate hears the grant's binding")
      release.resolve()
      const answer = await posted
      assert.equal(answer.status, 200)
      assert.deepEqual(await answer.json(), {})
    } finally {
      release.resolve()
      await tools.close?.()
    }
    console.log("PASS: the conversation server answers a hook's call once its gate does, for the grant's binding")
  }

  // Whether the person's own Codex setup runs code beside Mako's hook, as Codex's app-server answers for the folder.
  {
    const answers = (hooks: JsonObject, config: JsonObject, plugins: JsonObject = { marketplaces: [] }) => ({
      hooks: async () => hooks, config: async () => config, plugins: async () => plugins,
    })
    const none = { data: [{ cwd: "/p", hooks: [], warnings: [], errors: [] }] }
    const plain = { config: { model: "gpt" }, origins: {}, layers: [{ name: "user", version: "1", config: { model: "gpt" } }] }
    const pluginsOff = { config: { features: { plugins: false } }, origins: {}, layers: [] }
    assert.equal(await codexPersonCodeRuns(answers(none, plain), "/p"), false, "nothing of the person's")
    assert.equal(await codexPersonCodeRuns(answers({ data: [{ cwd: "/p", hooks: [{ key: "k" }], warnings: [], errors: [] }] }, plain), "/p"), true, "a hook Codex would run")
    assert.equal(await codexPersonCodeRuns(answers({ data: [{ cwd: "/p", hooks: [], warnings: [], errors: [{ message: "bad" }] }] }, plain), "/p"), true, "a hook that failed to load may be anything")
    assert.equal(await codexPersonCodeRuns(answers(none, { ...plain, layers: [{ name: "project", version: "1", config: { mcp_servers: { theirs: { command: "node" } } } }] }), "/p"), true, "a process MCP server in a layer")
    assert.equal(await codexPersonCodeRuns(answers(none, { ...plain, layers: [{ name: "user", version: "1", config: { profiles: { work: { mcp_servers: { theirs: { command: "uvx" } } } } } }] }), "/p"), true, "one in a profile")
    assert.equal(await codexPersonCodeRuns(answers(none, { ...plain, layers: [{ name: "user", version: "1", config: { mcp_servers: { remote: { url: "https://x" } } } }] }), "/p"), false, "a remote MCP server starts no process here")
    assert.equal(await codexPersonCodeRuns(answers(none, plain, { marketplaces: [{ plugins: [{ installed: true, enabled: true }] }] }), "/p"), true, "an installed, enabled plugin")
    assert.equal(await codexPersonCodeRuns(answers(none, pluginsOff, { marketplaces: [{ plugins: [{ installed: true, enabled: true }] }] }), "/p"), false, "plugins turned off")
    assert.equal(await codexPersonCodeRuns(answers(none, plain, { marketplaces: [], marketplaceLoadErrors: [{ message: "x" }] }), "/p"), true, "a marketplace that didn't load")
    assert.equal(await codexPersonCodeRuns({ hooks: async () => { throw new Error("method not found") }, config: async () => plain, plugins: async () => ({ marketplaces: [] }) }, "/p"), true, "a Codex that can't say fails closed")
    assert.equal(await codexPersonCodeRuns(answers({ unexpected: true }, plain), "/p"), true, "an answer Mako can't read fails closed")
    console.log("PASS: a Codex launch holds writes only where Codex says none of the person's own code runs, and fails closed")
  }

  // Whether the person's own OpenCode setup runs code beside Mako's plugin, as OpenCode's server answers once its plugins are active.
  {
    const plugin = (source: JsonObject, status = "active") => ({ source, features: {}, state: { status } })
    const makoFile = "/private/tmp/mako-opencode-calls-abc/server.js"
    const builtin = plugin({ type: "builtin" }), mako = plugin({ type: "local", path: makoFile })
    const launch = { pluginFiles: ["/tmp/mako-opencode-calls-abc/server.js", makoFile], servers: [{ name: "mako", process: false }] }
    const documents = (...infos: JsonObject[]) => [{ type: "directory", path: "/Users/p/.config/opencode" }, ...infos.map((info) => ({ type: "document", info }))]
    const ask = (plugins: JsonObject[], servers: string[] = ["mako"], config: JsonObject[] = documents({ model: "x" })) => ({
      plugins: async () => ({ data: plugins }), servers: async () => ({ data: servers.map((name) => ({ name, status: { status: "connected" } })) }), config: async () => config,
    })
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako]), launch), false, "built-ins and Mako's own plugin")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako, plugin({ type: "package", target: "opencode-formatter" })]), launch), true, "a package plugin of the person's")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako, plugin({ type: "local", path: "/Users/p/.config/opencode/plugin/guard" })]), launch), true, "a local plugin of the person's")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako, plugin({ type: "local", path: "/Users/p/mako-opencode-calls-abc/server.js" })]), launch), true, "one named like Mako's but not Mako's file")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, plugin({ type: "builtin" }, "failed")]), launch), true, "a plugin that failed to load")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako], ["theirs"]), { ...launch, servers: [{ name: "theirs", process: true }] }), true, "a process MCP server of the launch's")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako], ["mako", "from-their-config"]), launch), true, "an MCP server Mako didn't add")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako], ["mako"], documents({ experimental: { hook: { file_edited: { "*.ts": [{ command: ["prettier", "--write"] }] } } } })), launch), true, "a config command hook")
    assert.equal(await openCodePersonCodeRuns(ask([builtin, mako], ["mako"], documents({ experimental: { hook: {} } })), launch), false, "an empty hook table runs nothing")
    assert.equal(await openCodePersonCodeRuns({ plugins: async () => { throw new Error("gone") }, servers: async () => ({ data: [] }), config: async () => [] }, launch), true, "an OpenCode that can't say fails closed")
    assert.equal(await openCodePersonCodeRuns(ask([{ unexpected: true }]), launch), true, "an answer Mako can't read fails closed")
    console.log("PASS: an OpenCode launch holds writes only where OpenCode says none of the person's own code runs, and fails closed")
  }

  // Grok: its hook waits for its shell, edits and Write; and a launch holds them only where Grok says, for a folder it
  // trusts, that none of the person's own code loads (`grok inspect --json`, 1.0.70's shape).
  {
    const writes = GROK_CALL_HOOKS.writes
    assert.ok(writes)
    const run = (toolName: string, hookEventName = "pre_tool_use") => ({ hookEventName, toolName, toolInput: {} })
    for (const tool of ["run_terminal_command", "search_replace", "hashline_edit", "write"]) assert.equal(writes.holds(run(tool), {}), true, `${tool} waits`)
    assert.equal(writes.holds(run("read_file"), {}), false, "a read doesn't")
    assert.equal(writes.holds(run("write", "post_tool_use"), {}), false, "after the tool ran, nothing waits")
    assert.equal(writes.holds(run("run_terminal_command"), { decision: "deny", reason: "no" }), false, "a denied call never runs")
    const meta = JSON.stringify(GROK_CALL_HOOKS.meta)
    for (const tool of ["search_replace", "hashline_edit", "write"]) assert.ok(meta.includes(tool), `Grok's pre-tool hook is registered for ${tool}`)
    const said = (fields: JsonObject) => async () => JSON.stringify({ grokVersion: "1.0.70", projectTrusted: true, hooks: [], plugins: [], mcpServers: [], lspServers: [], agents: [{ name: "plan", source: { type: "builtin" } }], ...fields })
    const launch = { servers: [{ name: "mako", process: false }] }
    assert.equal(await grokPersonCodeRuns(said({}), launch), false, "a trusted folder with nothing of the person's")
    assert.equal(await grokPersonCodeRuns(said({ projectTrusted: false }), launch), true, "an untrusted folder says nothing of what would load, so nothing is held")
    assert.equal(await grokPersonCodeRuns(said({ hooks: [{ event: "pre_tool_use", hookType: "command", target: "true", source: { type: "user", path: "/Users/p/.grok/hooks" } }] }), launch), true, "a hook of the person's")
    assert.equal(await grokPersonCodeRuns(said({ plugins: [{ name: "theirs" }] }), launch), true, "a plugin")
    assert.equal(await grokPersonCodeRuns(said({ mcpServers: [{ name: "theirs" }] }), launch), true, "an MCP server Grok loads itself")
    assert.equal(await grokPersonCodeRuns(said({ lspServers: [{ name: "tsserver" }] }), launch), true, "an LSP server")
    assert.equal(await grokPersonCodeRuns(said({}), { servers: [{ name: "theirs", process: true }] }), true, "a process MCP server of the launch's")
    assert.equal(await grokPersonCodeRuns(async () => { throw new Error("grok gone") }, launch), true, "a Grok that can't say fails closed")
    assert.equal(await grokPersonCodeRuns(async () => "not json", launch), true, "an answer Mako can't read fails closed")
    assert.equal(await grokPersonCodeRuns(said({ hooks: "none" }), launch), true, "an answer of another shape fails closed")
    console.log("PASS: a Grok launch holds writes only where Grok trusts the folder and says none of the person's own code loads, and fails closed")
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
