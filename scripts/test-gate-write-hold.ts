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
} finally {
  rmSync(root, { recursive: true, force: true })
}
