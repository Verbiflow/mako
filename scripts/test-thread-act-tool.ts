import assert from "node:assert/strict"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentAsk } from "@mako/host/contracts/agent-asks"
import type { JsonValue } from "@mako/host/contracts/json"
import { agentAskLine, agentAskWords } from "@mako/host/contracts/agent-asks"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { AUTOMATION_TOOL, HARNESS_TOOL, SETTINGS_TOOL, THREAD_ACT_TOOL, type ThreadActResult } from "@mako/host/contracts/thread-tools"
import { AgentAskGate, AutomationTool, HarnessTool, registerThreadTools, SettingsTool, ThreadActTool, ThreadMoveAnswerSchema } from "@mako/host/conversations"
import { z } from "zod"
import { automationInput, harnessInput, settingsInput, threadActInput } from "../packages/client/src/thread"

/** `thread`: Rename, Archive and Restore through the host calls the app's menu makes, asking below full access. */
const agent = (session: string) => ({ kind: "agent" as const, session })
const person = { kind: "person" as const }
const ActSchema = z.object({ action: z.enum(["rename", "archive", "restore"]), title: z.string().optional(), clientKey: z.string() })
const operationOf = (call: { args: unknown[] } | undefined) => z.object({ id: z.string() }).parse(call?.args[0]).id

function world(tier: "full" | "auto" = "full", fails = false, archiveAnswer: JsonValue = { revision: 1, keys: [] }) {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const kept = new Map<string, AgentAsk[]>()
  const asks = {
    open: (id: string) => kept.get(id) ?? [],
    raise: (id: string, ask: AgentAsk) => void kept.set(id, [...(kept.get(id) ?? []), ask]),
    settle: (id: string, ask: string) => {
      const found = kept.get(id)?.find((each) => each.id === ask)
      if (found) kept.set(id, (kept.get(id) ?? []).filter((each) => each !== found))
      return found
    },
  }
  const gate = new AgentAskGate(asks)
  const tool = new ThreadActTool({
    conversationOf: (session) => (session === "s-mine" ? "mine" : undefined),
    threadOf: (id) => (id === "mine" ? "thread-mine" : undefined),
    tier: () => tier,
    invoke: async (channel, args) => {
      calls.push({ channel, args })
      if (fails) throw new Error("That Thread no longer exists")
      return channel === "mako:thread-archive" ? archiveAnswer : undefined
    },
    gate,
  })
  const run = async (_id: string, want: Parameters<ThreadActTool["run"]>[1]) => void (await tool.run("mine", want))
  gate.runs = { rename: run, archive: run, restore: run }
  return { tool, gate, calls, kept, asks, setFailure: (value: boolean) => { fails = value }, setArchiveAnswer: (value: JsonValue) => { archiveAnswer = value } }
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
  // A returned failure leaves the exact durable choice answerable, including on a recreated owner.
  for (const action of ["archive", "restore", "rename"] as const) {
    const refused = { revision: 1, keys: [], cloud: { kind: "refused", reason: "Its machine still has unsaved work." } }
    const current = world("auto", action === "rename", refused)
    const result = await current.tool.act(agent("s-mine"), { action, title: "Kept title", clientKey: `retry-${action}` })
    assert.ok("ask" in result)
    const original = structuredClone(current.gate.open("mine")[0]!)
    await assert.rejects(current.gate.answer("mine", result.ask, true), action === "rename" ? /no longer exists/ : /unsaved work/)
    assert.deepEqual(current.gate.open("mine"), [original], `${action}: failure retains the same ask, timestamp and operation`)
    const changed = await current.tool.act(agent("s-mine"), { action, title: "Kept title", clientKey: "new-call-key" })
    assert.ok("ask" in changed && changed.ask === result.ask, "another tool call still finds that exact choice")
    current.setFailure(false)
    current.setArchiveAnswer({ revision: 2, keys: [] })
    const recovered = new AgentAskGate(current.asks)
    recovered.runs = current.gate.runs
    await recovered.answer("mine", result.ask, true)
    assert.equal(current.calls.length, 2, "an explicit retry invokes the action again")
    assert.deepEqual(current.calls[1], current.calls[0], "the retry uses the exact same operation and arguments")
    assert.deepEqual(recovered.open("mine"), [], "success settles that ask")
    await new AgentAskGate(current.asks).answer("mine", result.ask, true)
    assert.equal(current.calls.length, 2, "a successful duplicate stays settled after recreation")
  }
}

{
  // Matching choices share one in-flight outcome; another choice cannot silently become a grant or a refusal.
  const { gate, calls, tool } = world("auto")
  const asked = await tool.act(agent("s-mine"), { action: "archive", clientKey: "concurrent" })
  assert.ok("ask" in asked)
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let runs = 0
  gate.runs.archive = async (id, want) => { runs += 1; entered.resolve(); await finish.promise; await tool.run(id, want) }
  const first = gate.answer("mine", asked.ask, true)
  await entered.promise
  const duplicate = gate.answer("mine", asked.ask, true)
  assert.equal(gate.open("mine").length, 1, "an in-flight allow has not consumed the durable ask")
  await assert.rejects(gate.answer("mine", asked.ask, false), /answer.*under way/i)
  const distinct = gate.ask("mine", { kind: "rename", op: "other-operation", title: "Another title" })
  await gate.answer("mine", distinct.id, true)
  assert.equal(calls.length, 1, "another ask is not blocked by this action")
  finish.resolve()
  await Promise.all([first, duplicate])
  assert.equal(runs, 1, "concurrent allows invoke once")
  assert.equal(calls.length, 2)
  await gate.answer("mine", asked.ask, true)
  assert.equal(calls.length, 2, "a successful duplicate invokes nothing")
  assert.deepEqual(gate.open("mine"), [])
  const kept = gate.ask("mine", { kind: "archive", op: "kept-operation" })
  await Promise.all([gate.answer("mine", kept.id, false), gate.answer("mine", kept.id, true)])
  assert.equal(runs, 1, "a refusal taken first never becomes permission")
}

{
  const { gate } = world("auto")
  const ask = gate.ask("mine", { kind: "archive", op: "same-operation" })
  const entered = Promise.withResolvers<void>()
  const failure = Promise.withResolvers<void>()
  let runs = 0
  gate.runs.archive = async () => { runs += 1; entered.resolve(); await failure.promise }
  const first = gate.answer("mine", ask.id, true)
  await entered.promise
  const duplicate = gate.answer("mine", ask.id, true)
  const rejected = Promise.all([assert.rejects(first, /refused/), assert.rejects(duplicate, /refused/)])
  failure.reject(new Error("refused"))
  await rejected
  assert.equal(runs, 1)
  assert.deepEqual(gate.open("mine"), [ask], "every matching answer sees the failure without consuming the ask")
  delete gate.runs.archive
  await assert.rejects(gate.answer("mine", ask.id, true), /can't answer/)
  assert.deepEqual(gate.open("mine"), [ask], "a missing action is not success")
  gate.runs.archive = () => { runs += 1 }
  await gate.answer("mine", ask.id, true)
  assert.equal(runs, 2)
  assert.deepEqual(gate.open("mine"), [])
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
  const original = structuredClone(gate.open("mine"))
  answers.set("mako:handoff-settings-set", { onSleep: false, unavailable: "This Mako doesn't hand agents to the cloud." })
  await assert.rejects(gate.answer("mine", "ask" in asked ? asked.ask : "", true), /doesn't hand agents/)
  assert.deepEqual(gate.open("mine"), original, "a refused setting keeps its exact ask")
  answers.clear()
  await gate.answer("mine", "ask" in asked ? asked.ask : "", true)
  await gate.answer("mine", "ask" in asked ? asked.ask : "", true)
  assert.deepEqual(calls, [{ channel: "mako:handoff-settings-set", args: [true] }, { channel: "mako:handoff-settings-set", args: [true] }], "one failed attempt and one successful retry, with no duplicate")
  assert.deepEqual(gate.open("mine"), [])
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

{
  // `harness`: a read at any access; Install and Update through the calls Settings makes, asked below full access.
  const calls: string[][] = []
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
  let hold: Promise<void> = Promise.resolve()
  let answer: JsonValue = { versions: true }
  const deps = {
    conversationOf: (session: string) => (session === "s-mine" ? "mine" : undefined),
    tier: () => tier,
    invoke: async (channel: string, args: unknown[]) => {
      calls.push([channel, ...z.array(z.union([z.string(), z.boolean()])).parse(args).map(String)])
      if (args[0] === "nope") throw new Error("nope does not install through Mako")
      await hold
      return answer
    },
    gate,
    startedAfterMs: 20,
  }
  const tool = new HarnessTool({ ...deps, machine: false })
  gate.runs = { harness: (_id, want) => tool.allowed(want.action, want.harness) }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "read", clientKey: "h1" }), { outcome: "read", harnesses: { versions: true } })
  const asked = await tool.act(agent("s-mine"), { action: "install", harness: "codex", clientKey: "h2" })
  assert.equal("outcome" in asked && asked.outcome, "asked")
  assert.equal(calls.length, 1, "nothing installed on the agent's word alone")
  assert.equal(agentAskLine(kept.get("mine")![0]!.want), "Wants to install codex")
  await gate.answer("mine", "ask" in asked ? asked.ask : "", true)
  assert.deepEqual(calls.at(-1), ["mako:harness-install", "codex"])
  tier = "full"
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h3" }), { outcome: "finished", action: "update", harness: "grok" })
  hold = new Promise(() => undefined)
  // The tool's timer never keeps a host alive; this one keeps the test's process up to hear it.
  const alive = setInterval(() => undefined, 10)
  const long = await tool.act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h4" })
  clearInterval(alive)
  assert.equal("outcome" in long && long.outcome, "started", "an install that outlasts the call says it's under way")
  hold = Promise.resolve()
  assert.equal(await tool.act(agent("s-mine"), { action: "install", harness: "nope", clientKey: "h5" }).then((answer) => "refused" in answer && answer.refused), "failed", "one refused at once says so")
  // The host answers a failed install or update as a receipt, not a rejection: the agent hears it failed, in its words.
  answer = { result: { at: 1, outcome: "failed", message: "npm error EACCES" } }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h6" }), { refused: "failed", why: "npm error EACCES" })
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "install", harness: "grok", clientKey: "h7" }), { refused: "failed", why: "npm error EACCES" })
  answer = { result: { at: 1, outcome: "failed" } }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h8" }), { refused: "failed", why: "Updating grok failed." })
  // One that failed after the call said it started: `read` hands the receipt on, which `next` tells the agent to do.
  const late = Promise.withResolvers<void>()
  hold = late.promise
  answer = { result: { at: 2, outcome: "failed", message: "disk full" } }
  const running = setInterval(() => undefined, 10)
  const started = await tool.act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h9" })
  clearInterval(running)
  assert.equal("outcome" in started && started.outcome, "started")
  late.resolve()
  hold = Promise.resolve()
  answer = { grok: { result: { at: 2, outcome: "failed", message: "disk full" } } }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "read", clientKey: "h10" }), { outcome: "read", harnesses: { grok: { result: { at: 2, outcome: "failed", message: "disk full" } } } })
  // A repeat with the same key is the same action: it gets the first outcome and installs nothing again.
  answer = { result: { at: 3, outcome: "installed" } }
  const before = calls.length
  const first = await tool.act(agent("s-mine"), { action: "install", harness: "devin", clientKey: "once" })
  assert.deepEqual(first, { outcome: "finished", action: "install", harness: "devin", result: "installed" })
  answer = { result: { at: 4, outcome: "failed", message: "already installed" } }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "install", harness: "devin", clientKey: "once" }), first, "a replay answers the first outcome")
  assert.equal(calls.length, before + 1, "and runs nothing")
  // Allowed below full access, a failure reaches the person's answer instead of passing as done.
  tier = "auto"
  answer = { result: { at: 5, outcome: "failed", message: "npm error EACCES" } }
  const failing = await tool.act(agent("s-mine"), { action: "update", harness: "devin", clientKey: "allowed" })
  const original = structuredClone(gate.open("mine"))
  await assert.rejects(gate.answer("mine", "ask" in failing ? failing.ask : "", true), /EACCES/)
  assert.deepEqual(gate.open("mine"), original, "a refused harness action keeps its exact ask")
  answer = { result: { at: 6, outcome: "updated" } }
  const attempts = calls.length
  await Promise.all([gate.answer("mine", "ask" in failing ? failing.ask : "", true), gate.answer("mine", "ask" in failing ? failing.ask : "", true)])
  assert.equal(calls.length, attempts + 1, "matching retries install once")
  assert.deepEqual(gate.open("mine"), [])
  tier = "full"
  // What it came to is said: installed, updated, or already there.
  answer = { result: { at: 3, outcome: "unchanged" } }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h11" }), { outcome: "finished", action: "update", harness: "grok", result: "unchanged" })
  answer = { versions: true }
  assert.equal(await tool.act(agent("s-mine"), { action: "install", clientKey: "h12" }).then((answer) => "refused" in answer && answer.refused), "no-harness")
  assert.equal(await new HarnessTool({ ...deps, machine: true }).act(agent("s-mine"), { action: "update", harness: "grok", clientKey: "h13" }).then((answer) => "refused" in answer && answer.refused), "cloud-machine")
  assert.equal(hostCallReplay(HARNESS_TOOL.channel), HARNESS_TOOL.replay)
  assert.ok(HARNESS_TOOL.mcp.description.length < 700, "its description stays short")
}

{
  // `automation`: a list at any access; Run now and the switch through Settings' calls, asked below full access.
  const calls: unknown[][] = []
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
  let runAnswer: JsonValue = { status: "completed" }
  // Whether the switch can turn on: a trigger Mako can't run here stays off.
  let switches = true
  const tool = new AutomationTool({
    conversationOf: (session) => (session === "s-mine" ? "mine" : undefined),
    tier: () => tier,
    invoke: async (channel, args) => {
      calls.push([channel, ...args])
      if (channel === "mako:automation-context") return { cwd: "/fixture/workspace", automations: [{ id: "nightly" }] }
      if (channel === "mako:run-automation") return runAnswer
      if (channel === "mako:automation-enabled") return [{ id: "nightly", enabled: args[1] === true && switches }]
      return channel === "mako:automations" ? [{ id: "nightly" }] : []
    },
    gate,
  })
  gate.runs = { automation: (id, want, ask) => tool.allowed(id, want, ask) }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "list", clientKey: "a1" }), { outcome: "listed", automations: [{ id: "nightly" }] })
  const asked = await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "a2" })
  assert.equal("outcome" in asked && asked.outcome, "asked")
  assert.ok(calls.every(([channel]) => channel === "mako:automations" || channel === "mako:automation-context"), "nothing ran on the agent's word alone")
  await gate.answer("mine", "ask" in asked ? asked.ask : "", true)
  assert.deepEqual(calls.at(-1), ["mako:run-automation", "nightly", JSON.stringify(["mine", "ask" in asked ? asked.ask : ""]), "/fixture/workspace"])
  tier = "full"
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "off", id: "nightly", clientKey: "a3" }), { outcome: "done", action: "off", id: "nightly" })
  assert.deepEqual(calls.at(-1), ["mako:automation-enabled", "nightly", false, "/fixture/workspace"])
  // A launch that failed, or a run that never began, is said: Run now answers with how it went.
  runAnswer = { status: "failed", error: "No harness can run it" }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "a4" }), { refused: "failed", why: "No harness can run it" })
  runAnswer = { status: "not-run", why: "It's running already." }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "a5" }), { refused: "failed", why: "It's running already." })
  runAnswer = { status: "completed" }
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "a6" }), { outcome: "done", action: "run", id: "nightly" })
  assert.equal(await tool.act(agent("s-mine"), { action: "on", clientKey: "a7" }).then((answer) => "refused" in answer && answer.refused), "no-automation")
  assert.equal(await tool.act(agent("s-mine"), { action: "run", id: "gone", clientKey: "a8" }).then((answer) => "refused" in answer && answer.refused), "no-automation", "a run of nothing never says done")
  // A replay under one key gets the first outcome and launches nothing, however long ago it finished.
  const runs = () => calls.filter(([channel]) => channel === "mako:run-automation").length
  const launched = runs()
  const once = await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "again" })
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "again" }), once)
  assert.equal(runs(), launched + 1, "the same key runs it once")
  // The switch says what it did: a trigger Mako can't run here stays off.
  switches = false
  assert.deepEqual(await tool.act(agent("s-mine"), { action: "on", id: "nightly", clientKey: "slack" }), { refused: "failed", why: "This automation's trigger can't run here, so it stays off." })
  switches = true
  // Allowed below full access, a failure reaches the person's answer instead of passing as done.
  tier = "auto"
  runAnswer = { status: "failed", error: "No harness can run it" }
  const failing = await tool.act(agent("s-mine"), { action: "run", id: "nightly", clientKey: "allowed" })
  const original = structuredClone(gate.open("mine"))
  await assert.rejects(gate.answer("mine", "ask" in failing ? failing.ask : "", true), /No harness/)
  assert.deepEqual(gate.open("mine"), original, "a returned automation failure keeps its exact ask")
  runAnswer = { status: "completed" }
  const attempts = runs()
  await Promise.all([gate.answer("mine", "ask" in failing ? failing.ask : "", true), gate.answer("mine", "ask" in failing ? failing.ask : "", true)])
  assert.equal(runs(), attempts + 1, "matching explicit retries launch once")
  await gate.answer("mine", "ask" in failing ? failing.ask : "", true)
  assert.equal(runs(), attempts + 1, "a successful duplicate launches nothing")
  assert.deepEqual(gate.open("mine"), [])
  tier = "full"
  assert.equal(hostCallReplay(AUTOMATION_TOOL.channel), AUTOMATION_TOOL.replay)
  assert.ok(AUTOMATION_TOOL.mcp.description.length < 700, "its description stays short")
}

assert.deepEqual({ ...automationInput(["automation", "on", "nightly", "--key", "k"]) }, { action: "on", clientKey: "k", id: "nightly" })
assert.deepEqual({ ...harnessInput(["harness", "update", "codex", "--key", "k"]) }, { action: "update", harness: "codex", clientKey: "k" })
assert.deepEqual({ ...harnessInput(["harness", "read", "--key", "k"]) }, { action: "read", clientKey: "k" })

console.log("thread tool: ok")
