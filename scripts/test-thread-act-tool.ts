import assert from "node:assert/strict"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentAsk } from "@mako/host/contracts/agent-asks"
import type { JsonValue } from "@mako/host/contracts/json"
import { agentAskLine, agentAskWords } from "@mako/host/contracts/agent-asks"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { SETTINGS_TOOL, THREAD_ACT_TOOL, type ThreadActResult } from "@mako/host/contracts/thread-tools"
import { AgentAskGate, registerThreadTools, SettingsTool, ThreadActTool, ThreadMoveAnswerSchema } from "@mako/host/conversations"
import { z } from "zod"
import { settingsInput, threadActInput } from "../packages/client/src/thread"

/** `thread`: Rename, Archive and Restore through the host calls the app's menu makes, asking below full access. */
const agent = (session: string) => ({ kind: "agent" as const, session })
const person = { kind: "person" as const }
const ActSchema = z.object({ action: z.enum(["rename", "archive", "restore"]), title: z.string().optional(), clientKey: z.string() })
const operationOf = (call: { args: unknown[] } | undefined) => z.object({ id: z.string() }).parse(call?.args[0]).id

function world(tier: "full" | "auto" = "full", fails = false, archiveAnswer: JsonValue = { revision: 1, keys: [] }) {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const kept = new Map<string, AgentAsk[]>()
  const gate = new AgentAskGate({
    open: (id) => kept.get(id) ?? [],
    raise: (id, ask) => void kept.set(id, [...(kept.get(id) ?? []), ask]),
    settle: (id, ask) => {
      const found = kept.get(id)?.find((each) => each.id === ask)
      if (found) kept.set(id, (kept.get(id) ?? []).filter((each) => each !== found))
      return found
    },
  })
  const tool = new ThreadActTool({
    conversationOf: (session) => (session === "s-mine" ? "mine" : undefined),
    threadOf: (id) => (id === "mine" ? "thread-mine" : undefined),
    tier: () => tier,
    invoke: async (channel, args) => {
      if (fails) throw new Error("That Thread no longer exists")
      calls.push({ channel, args })
      return channel === "mako:thread-archive" ? archiveAnswer : undefined
    },
    gate,
  })
  const run = async (_id: string, want: Parameters<ThreadActTool["run"]>[1]) => void (await tool.run("mine", want))
  gate.runs = { rename: run, archive: run, restore: run }
  return { tool, gate, calls, kept }
}

{
  // On full access it happens now, through the app's own calls, under one operation per key.
  const { tool, calls } = world()
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "rename", title: "  Ship the importer ", clientKey: "k" }), { outcome: "renamed", title: "Ship the importer" })
  await tool.act(agent("s-mine"), { action: "rename", title: "Ship the importer", clientKey: "k" })
  assert.equal(calls[0]?.channel, "mako:thread-rename")
  assert.deepEqual(calls[0]?.args.slice(1), ["thread-mine", "Ship the importer"])
  assert.equal(calls[0]?.args[0], calls[1]?.args[0], "a repeat with the key is the same operation")
  assert.equal((await tool.act(agent("s-mine"), { action: "archive", clientKey: "a" })) && calls.at(-1)?.channel, "mako:thread-archive")
  assert.deepEqual(calls.at(-1)?.args, [{ id: operationOf(calls.at(-1)), target: { kind: "live", id: "mine" }, archived: true }])
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "restore", clientKey: "r" }), { outcome: "restored" })
  assert.deepEqual(calls.at(-1)?.args, [{ id: operationOf(calls.at(-1)), target: { kind: "live", id: "mine" }, archived: false }])
}

{
  // Below full access the person is asked, once for the same thing; allowed, it happens as the agent asked; refused, nothing does.
  const { tool, gate, calls, kept } = world("auto")
  const asked = await tool.act(agent("s-mine"), { action: "rename", title: "One", clientKey: "k1" })
  const again = await tool.act(agent("s-mine"), { action: "rename", title: "One", clientKey: "k2" })
  const askOf = (result: ThreadActResult) => ("ask" in result ? result.ask : "")
  assert.equal("outcome" in asked && asked.outcome, "asked")
  assert.equal(askOf(again), askOf(asked))
  const other = await tool.act(agent("s-mine"), { action: "rename", title: "Two", clientKey: "k3" })
  assert.notEqual(askOf(other), askOf(asked), "another title is another ask")
  assert.equal(calls.length, 0, "nothing happened on the agent's word alone")
  await gate.answer("mine", askOf(other), false)
  await gate.answer("mine", askOf(asked), true)
  assert.deepEqual(calls.map((call) => call.args.slice(1)), [["thread-mine", "One"]])
  await gate.answer("mine", askOf(asked), true)
  assert.equal(calls.length, 1, "a repeat of an answer finds nothing")
  assert.equal(kept.get("mine")?.length, 0)
  const archive = await tool.act(agent("s-mine"), { action: "archive", clientKey: "k4" })
  assert.equal(agentAskLine(kept.get("mine")![0]!.want), "Wants to archive this Thread")
  assert.equal(agentAskWords(kept.get("mine")![0]!.want, "Codex").title, "Codex wants to archive this Thread")
  await gate.answer("mine", askOf(archive), true)
  assert.equal(calls.at(-1)?.channel, "mako:thread-archive")
}

{
  // Refusals are typed; an agent acts on its own Thread only, and the person's own shell names one.
  const { tool, calls } = world()
  assert.equal(await tool.act(agent("s-other"), { action: "archive", clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "no-thread")
  assert.equal(await tool.act(agent("s-mine"), { action: "archive", conversation: "theirs", clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "not-yours")
  assert.equal(await tool.act(agent("s-mine"), { action: "rename", title: "  ", clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "no-title")
  assert.equal(await tool.act(person, { action: "archive", clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "no-thread")
  assert.equal(calls.length, 0)
  assert.deepEqual(await tool.act(person, { action: "restore", conversation: "elsewhere", clientKey: "k" }), { outcome: "restored" })
  assert.deepEqual(await world("full", true).tool.act(agent("s-mine"), { action: "archive", clientKey: "k" }), { refused: "failed", why: "That Thread no longer exists" })
  // A cloud Thread's archive is its object's to refuse, which the host answers rather than throws.
  const stayed = world("full", false, { revision: 1, keys: [], cloud: { kind: "refused", thread: "t-1", reason: "Its machine still has unsaved work.", anyway: true } })
  assert.deepEqual(await stayed.tool.act(agent("s-mine"), { action: "archive", clientKey: "k" }), { refused: "failed", why: "Its machine still has unsaved work." })
  assert.deepEqual(await stayed.tool.act(agent("s-mine"), { action: "restore", clientKey: "r" }), { refused: "failed", why: "Its machine still has unsaved work." })
  // Allowed below full access, a refusal reaches the person's answer instead of passing as done.
  const asked = world("auto", false, { revision: 1, keys: [], cloud: { kind: "refused", thread: "t-1", reason: "Its machine still has unsaved work." } })
  const archiving = await asked.tool.act(agent("s-mine"), { action: "archive", clientKey: "k" })
  await assert.rejects(asked.gate.answer("mine", "ask" in archiving ? archiving.ask : "", true), /unsaved work/)
}

{
  // The door: the tool's schema is the host call's, less what an agent can't name.
  assert.equal(hostCallReplay(THREAD_ACT_TOOL.channel), THREAD_ACT_TOOL.replay)
  const server = new McpServer({ name: "mako", version: "1.0.0" })
  const { tool } = world()
  registerThreadTools(server, {
    invoke: async (_channel, args) => ThreadMoveAnswerSchema.parse(await tool.act(agent("s-mine"), ActSchema.parse(args[1]))),
    caller: () => agent("s-mine"),
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "in-thread", version: "1.0.0" })
  await client.connect(clientSide)
  const listed = (await client.listTools()).tools.find((each) => each.name === "thread")
  assert.ok(listed, "the server lists thread")
  assert.deepEqual(Object.keys(listed.inputSchema.properties ?? {}).sort(), ["action", "clientKey", "title"], "never another conversation")
  assert.ok(THREAD_ACT_TOOL.mcp.description.length < 700, "its description stays short")
  const answer = await client.callTool({ name: "thread", arguments: { action: "rename", title: "From the door", clientKey: "d" } })
  assert.match(JSON.stringify(answer.content), /renamed/)
  await client.close()
  await server.close()
}

assert.deepEqual({ ...threadActInput(["thread", "rename", "Ship", "it", "--key", "k"]) }, { action: "rename", clientKey: "k", title: "Ship it" })
assert.deepEqual({ ...threadActInput(["thread", "archive", "--conversation", "c", "--key", "k"]) }, { action: "archive", clientKey: "k", conversation: "c" })
assert.throws(() => threadActInput(["thread", "pin"]), /needs a command/)
assert.deepEqual({ ...settingsInput(["settings", "set", "harness-order", "codex,claude", "--key", "k"]) }, { action: "set", setting: "harness-order", value: ["codex", "claude"], clientKey: "k" })
assert.deepEqual({ ...settingsInput(["settings", "set", "hand-off-on-sleep", "false", "--key", "k"]) }, { action: "set", setting: "hand-off-on-sleep", value: false, clientKey: "k" })
assert.deepEqual({ ...settingsInput(["settings", "read", "--key", "k"]) }, { action: "read", clientKey: "k" })

{
  // `settings`: reads at any access; a change through the host call Settings makes, asked below full access.
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const kept = new Map<string, AgentAsk[]>()
  const gate = new AgentAskGate({
    open: (id) => kept.get(id) ?? [],
    raise: (id, ask) => void kept.set(id, [...(kept.get(id) ?? []), ask]),
    settle: (id, ask) => {
      const found = kept.get(id)?.find((each) => each.id === ask)
      if (found) kept.set(id, (kept.get(id) ?? []).filter((each) => each !== found))
      return found
    },
  })
  let tier: "full" | "auto" = "auto"
  let savedOrder = ["claude"]
  const answers = new Map<string, JsonValue>()
  const tool = new SettingsTool({
    conversationOf: (session) => (session === "s-mine" ? "mine" : undefined),
    tier: () => tier,
    invoke: async (channel, args) => {
      calls.push({ channel, args })
      const said = answers.get(channel)
      if (said !== undefined) return said
      if (channel === "mako:handoff-settings-set") return { onSleep: args[0] === true }
      if (channel === "mako:conversation-settings-set") return z.record(z.string(), z.json()).parse(args[0])
      if (channel === "mako:keep-awake-set") return { settings: { on: true, lidClosed: false, ...z.record(z.string(), z.boolean()).parse(args[0]) }, hold: { kind: "rest" } }
      if (channel === "mako:keep-awake") return { settings: { on: true, lidClosed: false }, hold: { kind: "rest" } }
      if (channel === "mako:harness-order") savedOrder = z.array(z.string()).parse(args[0])
      return channel === "mako:harness-order-saved" ? savedOrder : { saved: true }
    },
    gate,
  })
  gate.runs = { setting: async (_id, want) => void (await tool.run(want.setting)) }
  const read = await tool.call(agent("s-mine"), { action: "read", clientKey: "k" })
  assert.deepEqual(read, { outcome: "read", settings: { handOff: { saved: true }, conversations: { saved: true }, harnessOrder: ["claude"], keepAwake: { on: true, lidClosed: false } } })
  answers.clear()
  calls.length = 0
  const asked = await tool.call(agent("s-mine"), { action: "set", setting: "hand-off-on-sleep", value: true, clientKey: "k" })
  assert.equal("outcome" in asked && asked.outcome, "asked")
  assert.equal(calls.length, 0, "nothing changed on the agent's word alone")
  assert.equal(agentAskLine(kept.get("mine")![0]!.want), "Wants to turn on handing agents off when this Mac sleeps")
  await gate.answer("mine", "ask" in asked ? asked.ask : "", true)
  assert.deepEqual(calls, [{ channel: "mako:handoff-settings-set", args: [true] }])
  tier = "full"
  const cases: Array<[string, boolean | string | string[], string, unknown[]]> = [
    ["continue-after-restart", false, "mako:conversation-settings-set", [{ continueAfterRestart: false }]],
    ["harness-order", ["codex", "claude"], "mako:harness-order", [["codex", "claude"]]],
    ["commit-model", "auto", "mako:utility-choice", ["commit", "auto"]],
  ]
  for (const [setting, value, channel, args] of cases) {
    assert.deepEqual(await tool.call(agent("s-mine"), { action: "set", setting, value, clientKey: "k" }), { outcome: "set", setting, value })
    assert.ok(calls.some((call) => call.channel === channel && JSON.stringify(call.args) === JSON.stringify(args)), channel)
  }
  // Keeping this Mac awake while agents work, and with its lid closed, as Settings sets them.
  assert.deepEqual(await tool.call(agent("s-mine"), { action: "set", setting: "keep-awake", value: false, clientKey: "ka" }), { outcome: "set", setting: "keep-awake", value: false })
  assert.deepEqual(calls.at(-1), { channel: "mako:keep-awake-set", args: [{ on: false }] })
  assert.deepEqual(await tool.call(agent("s-mine"), { action: "set", setting: "keep-awake-lid-closed", value: true, clientKey: "kl" }), { outcome: "set", setting: "keep-awake-lid-closed", value: true })
  answers.set("mako:keep-awake-set", { settings: { on: false, lidClosed: false }, hold: { kind: "rest" }, unavailable: "This Mako doesn't keep a Mac awake." })
  assert.deepEqual(await tool.call(agent("s-mine"), { action: "set", setting: "keep-awake", value: true, clientKey: "kc" }), { refused: "failed", why: "This Mako doesn't keep a Mac awake." })
  answers.clear()
  // What the host kept is what's said: a host that can't hand off keeps it off, and says why.
  answers.set("mako:handoff-settings-set", { onSleep: false, unavailable: "This Mako doesn't hand agents to the cloud." })
  assert.deepEqual(await tool.call(agent("s-mine"), { action: "set", setting: "hand-off-on-sleep", value: true, clientKey: "k" }), { refused: "failed", why: "This Mako doesn't hand agents to the cloud." })
  // Kept, but it can't take effect yet: said beside the answer.
  answers.set("mako:handoff-settings-set", { onSleep: true, unavailable: "Sign in to Mako Cloud to hand agents to the cloud." })
  assert.deepEqual(await tool.call(agent("s-mine"), { action: "set", setting: "hand-off-on-sleep", value: true, clientKey: "k" }), { outcome: "set", setting: "hand-off-on-sleep", value: true, note: "Sign in to Mako Cloud to hand agents to the cloud." })
  answers.set("mako:conversation-settings-set", { continueAfterRestart: true })
  assert.equal(await tool.call(agent("s-mine"), { action: "set", setting: "continue-after-restart", value: false, clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "failed")
  answers.set("mako:harness-order-saved", ["claude"])
  assert.equal(await tool.call(agent("s-mine"), { action: "set", setting: "harness-order", value: ["codex", "claude"], clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "failed", "an order the host didn't keep isn't set")
  answers.clear()
  for (const bad of [{ setting: "telemetry", value: true }, { setting: "hand-off-on-sleep", value: "yes" }, { setting: "harness-order", value: [] }, {}])
    assert.equal(await tool.call(agent("s-mine"), { action: "set", clientKey: "k", ...bad }).then((answer) => "refused" in answer && answer.refused), "bad-value", JSON.stringify(bad))
  assert.equal(await tool.call(agent("nobody"), { action: "set", setting: "commit-model", value: "m", clientKey: "k" }).then((answer) => "refused" in answer && answer.refused), "no-thread")
  assert.equal(hostCallReplay(SETTINGS_TOOL.channel), SETTINGS_TOOL.replay)
  assert.ok(SETTINGS_TOOL.mcp.description.length < 700, "its description stays short")
}

console.log("thread tool: ok")
