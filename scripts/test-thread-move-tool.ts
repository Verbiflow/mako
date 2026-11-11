import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { HostJobs } from "@mako/host/base/host-jobs"
import { unwatchedWork } from "@mako/host/base/event-loop"
import type { AccessTier } from "@mako/host/contracts/access"
import type { AgentCaller } from "@mako/host/contracts/agents"
import type { ThreadHandOff } from "@mako/host/contracts/cloud-threads"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import type { AgentAsk } from "@mako/host/contracts/agent-asks"
import { THREAD_MOVE_TOOL, type ThreadsMoveResult } from "@mako/host/contracts/thread-tools"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { declareThreadMoveMethods, registerThreadTools, ThreadMoveAnswerSchema, ThreadMoveTool, type HostMoves, type ThreadMoveToolDeps, type ThreadPlace } from "@mako/host/conversations/thread-move-tool"
import { HostMethods } from "@mako/host/transport/methods"
import { startWebHost } from "@mako/host/transport/server"
import { z } from "zod"

/**
 * `thread_move` and `mako thread move` (`npm run test:thread-move-tool`): an agent's move of its own Thread goes
 * through the host's own moves, as the app presses them. Full access moves now: a Thread in its own worktree hands
 * off (its running turn paused and continued in the cloud), one in the main checkout waits for its turn to end and
 * goes without a handoff, onto its own branch first. Below full access the person is asked, and only their Allow
 * moves it. The person's own call names a conversation and waits for the move's end, back from the cloud and Continue
 * in the cloud included. The in-Thread server, `mako mcp` and `mako thread move` answer alike.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const agent = (session: string): AgentCaller => ({ kind: "agent", session })
const refusalOf = (result: ThreadsMoveResult) => ("refused" in result ? result.refused : undefined)

interface Conversation {
  session: string
  place: ThreadPlace
  tier?: AccessTier
  busy?: boolean
  worktree?: boolean
}

function world(conversations: Record<string, Conversation>, options: { refusal?: string; machine?: boolean; signedOut?: boolean; kept?: Map<string, AgentAsk[]> } = {}) {
  const calls: Array<{ kind: "move"; id: string; move: string; handOff?: ThreadHandOff } | { kind: "back" | "continue"; id: string; move: string }> = []
  // What `LiveAsks` keeps in each conversation's control: a new tool over the same map is a host after a restart.
  const kept = options.kept ?? new Map<string, AgentAsk[]>()
  const moves: HostMoves = {
    move: async (id, move, handOff) => {
      calls.push({ kind: "move", id, move, ...(handOff && { handOff }) })
      return { kind: "moved", cloudThread: "t-cloud" }
    },
    refusal: async () => options.refusal,
    bringBack: async (id, move) => {
      calls.push({ kind: "back", id, move })
      return { kind: "back" }
    },
    continue: async (id, op) => {
      calls.push({ kind: "continue", id, move: op })
      return { kind: "continued", cloudThread: "t-continued" }
    },
  }
  const gate = new AgentAskGate({
    open: (id) => kept.get(id) ?? [],
    raise: (id, ask) => void kept.set(id, [...(kept.get(id) ?? []), ask]),
    settle: (id, ask) => {
      const found = kept.get(id)?.find((each) => each.id === ask)
      if (found) kept.set(id, (kept.get(id) ?? []).filter((each) => each !== found))
      return found
    },
  })
  const deps: ThreadMoveToolDeps = {
    conversationOf: (session) => Object.entries(conversations).find(([, conversation]) => conversation.session === session)?.[0],
    place: (id) => conversations[id]?.place,
    tier: (id) => conversations[id]?.tier,
    busy: (id) => conversations[id]?.busy === true,
    ownWorktree: (id) => conversations[id]?.worktree === true,
    machine: options.machine === true,
    moves: () => (options.signedOut ? undefined : moves),
    gate,
    handOffAfterMs: 0,
  }
  const tool = new ThreadMoveTool(deps)
  gate.runs = { move: (id, want) => tool.allowed(id, want) }
  return { tool, gate, calls, kept, conversations }
}

{
  // Full access, its own worktree: a handoff now, after the answer; a repeated key is the same move.
  const { tool, calls } = world({ a: { session: "s-a", place: "here", tier: "full", worktree: true, busy: true } })
  const first = await tool.move(agent("s-a"), { to: "cloud", clientKey: "k" })
  assert.equal("outcome" in first && first.outcome, "handing-off")
  assert.equal(calls.length, 0, "the handoff waits for the answer to reach the agent")
  await tick()
  assert.deepEqual(calls, [{ kind: "move", id: "a", move: "move" in first ? first.move : "", handOff: { why: "asked" } }], "it hands off through the host's move, its turn going along")
  const again = await tool.move(agent("s-a"), { to: "cloud", clientKey: "k" })
  assert.equal("move" in again && again.move, "move" in first && first.move, "the same key names the same move, which the host joins")
}

{
  // Full access in the main checkout: nothing while its turn runs, then a move without a handoff (onto its own branch first).
  const { tool, calls, conversations } = world({ b: { session: "s-b", place: "here", tier: "full", busy: true } })
  const answer = await tool.move(agent("s-b"), { to: "cloud", clientKey: "k" })
  assert.equal("outcome" in answer && answer.outcome, "after-turn")
  assert.equal(tool.pending("b"), true)
  tool.settled("b")
  await tick()
  assert.equal(calls.length, 0, "a running turn holds it")
  conversations.b!.busy = false
  tool.settled("b")
  await tick()
  assert.deepEqual(calls.map((call) => ({ kind: call.kind, id: call.id, handOff: "handOff" in call ? call.handOff : undefined })), [{ kind: "move", id: "b", handOff: undefined }])
  assert.equal(tool.pending("b"), false)
}

{
  // Below full access: the person is asked, once; Keep here moves nothing, Move to the cloud moves it.
  const { tool, gate, calls, kept, conversations } = world({ c: { session: "s-c", place: "here", tier: "auto", worktree: true } })
  const askOf = (result: ThreadsMoveResult) => ("ask" in result ? result.ask : "")
  const asked = await tool.move(agent("s-c"), { to: "cloud", clientKey: "k1" })
  assert.equal("outcome" in asked && asked.outcome, "asked")
  const repeat = await tool.move(agent("s-c"), { to: "cloud", clientKey: "k2" })
  assert.equal(askOf(repeat), askOf(asked), "a second call finds the same ask")
  assert.equal(kept.get("c")?.length, 1)
  assert.equal(kept.get("c")?.[0]?.want.kind, "move")
  assert.equal(tool.pending("c"), true)
  await gate.answer("c", askOf(asked), false)
  await tick()
  assert.equal(calls.length, 0, "kept here")
  assert.equal(kept.get("c")?.length, 0)
  await gate.answer("c", askOf(asked), true)
  await tick()
  assert.equal(calls.length, 0, "a repeat of an answer finds nothing")
  const again = await tool.move(agent("s-c"), { to: "cloud", clientKey: "k3" })
  await gate.answer("c", askOf(again), true)
  await tick()
  assert.deepEqual(calls.map((call) => call.kind), ["move"], "allowed, it moves")

  // The ask is the conversation's: an answer after a restart moves it, under the move it was asked for.
  const third = await tool.move(agent("s-c"), { to: "cloud", clientKey: "k4" })
  const restarted = world(conversations, { kept })
  await restarted.gate.answer("c", askOf(third), true)
  await tick()
  assert.deepEqual(restarted.calls.map((call) => call.kind), ["move"], "a new host answers what the last one asked")

  // The person moving it by hand retires the ask; one that outlives the move moves nothing.
  const fourth = await tool.move(agent("s-c"), { to: "cloud", clientKey: "k5" })
  gate.retire("c", "move")
  assert.equal(kept.get("c")?.length, 0)
  const fifth = await tool.move(agent("s-c"), { to: "cloud", clientKey: "k6" })
  assert.notEqual(askOf(fifth), askOf(fourth))
  conversations.c!.place = "cloud"
  const moves = calls.length
  await gate.answer("c", askOf(fifth), true)
  await tick()
  assert.equal(calls.length, moves, "an ask answered once the Thread left moves nothing")
}

{
  // What the move would refuse is said at once, and nobody is asked.
  const { tool, kept } = world({ d: { session: "s-d", place: "here", tier: "ask", worktree: true } }, { refusal: "Moving to the cloud needs this Mac signed in to Mako Cloud." })
  assert.deepEqual(await tool.move(agent("s-d"), { to: "cloud", clientKey: "k" }), { refused: "kept-here", why: "Moving to the cloud needs this Mac signed in to Mako Cloud." })
  assert.equal(kept.get("d"), undefined)
}

{
  // Refusals, each typed.
  const { tool, calls } = world({ e: { session: "s-e", place: "here", tier: "full" }, f: { session: "s-f", place: "cloud" } })
  assert.equal(refusalOf(await tool.move(agent("s-e"), { to: "back", clientKey: "k" })), "already-there")
  assert.equal(refusalOf(await tool.move(agent("s-e"), { to: "cloud", conversation: "f", clientKey: "k" })), "not-yours")
  assert.equal(refusalOf(await tool.move(agent("nobody"), { to: "cloud", clientKey: "k" })), "no-thread")
  assert.equal(refusalOf(await tool.move({ kind: "person" }, { to: "cloud", clientKey: "k" })), "no-thread", "the person names a conversation")
  assert.equal(refusalOf(await tool.move({ kind: "person" }, { to: "cloud", conversation: "f", clientKey: "k" })), "already-there")
  assert.equal(calls.length, 0)
  const signedOut = world({ g: { session: "s-g", place: "here", tier: "full" } }, { signedOut: true })
  assert.equal(refusalOf(await signedOut.tool.move(agent("s-g"), { to: "cloud", clientKey: "k" })), "unavailable")
  const machine = world({ h: { session: "s-h", place: "here", tier: "full" } }, { machine: true })
  const back = await machine.tool.move(agent("s-h"), { to: "back", clientKey: "k" })
  assert.equal("outcome" in back && back.outcome, "asked", "a cloud Thread's agent asks, on any access: its machine can't reach its Mac")
  assert.deepEqual(machine.kept.get("h")?.map((ask) => ask.want), [{ kind: "back" }])
  assert.deepEqual(machine.calls, [], "nothing moves on the agent's word alone")
  await machine.tool.move(agent("s-h"), { to: "back", clientKey: "k2" })
  assert.equal(machine.kept.get("h")?.length, 1, "asked once")
  assert.equal(refusalOf(await machine.tool.move(agent("nobody"), { to: "back", clientKey: "k" })), "from-the-mac")
  assert.equal(refusalOf(await machine.tool.move(agent("s-h"), { to: "cloud", clientKey: "k" })), "already-there")
}

{
  // The person's own call: each of the app's three moves, waited for.
  const { tool, calls } = world({ here: { session: "s-1", place: "here", busy: true }, away: { session: "s-2", place: "cloud" }, off: { session: "s-3", place: "device" } })
  assert.deepEqual(await tool.move({ kind: "person" }, { to: "cloud", conversation: "here", clientKey: "p1" }), { outcome: "moved", cloudThread: "t-cloud" })
  assert.deepEqual(calls.at(-1), { kind: "move", id: "here", move: calls.at(-1)?.move, handOff: { why: "asked" } }, "a working Thread hands off, as Hand off does")
  assert.deepEqual(await tool.move({ kind: "person" }, { to: "back", conversation: "away", clientKey: "p2" }), { outcome: "back" })
  assert.equal(calls.at(-1)?.kind, "back")
  assert.deepEqual(await tool.move({ kind: "person" }, { to: "cloud", conversation: "off", clientKey: "p3" }), { outcome: "continued", cloudThread: "t-continued" })
  assert.equal(calls.at(-1)?.kind, "continue", "another device's Thread continues in the cloud")
}

// Every door: the in-Thread server, `mako mcp` and `mako thread move`, against one host's socket.
const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const root = mkdtempSync(join(tmpdir(), "mako-thread-move-"))
const run = promisify(execFile)
const doors = world({ mine: { session: "s-mine", place: "here", tier: "full", worktree: true }, theirs: { session: "s-theirs", place: "cloud" } })
const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
declareThreadMoveMethods(methods, () => doors.tool)
const socket = join(root, "host.sock")
const jobs = new HostJobs()
const host = await startWebHost(socket, (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId), async () => new Response(null, { status: 404 }), undefined, undefined, undefined, undefined, undefined, jobs)
const clients: Client[] = []
const ToolResultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() })
const answerOf = async (client: Client, args: Record<string, string>) => {
  const result = ToolResultSchema.parse(await client.callTool({ name: "thread_move", arguments: args }))
  const text = result.content[0]!.text
  return { isError: result.isError === true, answer: ThreadMoveAnswerSchema.parse(JSON.parse(result.isError ? text.split("\n").slice(1).join("\n") : text)), first: text.split("\n")[0] }
}
try {
  assert.equal(hostCallReplay(THREAD_MOVE_TOOL.channel), THREAD_MOVE_TOOL.replay, "mako:threads-move replays as its definition says")
  const inThread = new McpServer({ name: "mako", version: "1.0.0" })
  registerThreadTools(inThread, { invoke: async (channel, args) => ThreadMoveAnswerSchema.parse(decodeRuntimeValue(await methods.invoke(channel, args))), caller: () => agent("s-mine") })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await inThread.connect(serverSide)
  const thread = new Client({ name: "in-thread", version: "1.0.0" })
  await thread.connect(clientSide)
  clients.push(thread)
  const stdio = new Client({ name: "mako-mcp", version: "1.0.0" })
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--socket", socket], env: { ...getDefaultEnvironment(), MAKO_SESSION_ID: "s-mine" }, stderr: "pipe" }))
  clients.push(stdio)

  const listed = (await thread.listTools()).tools.find((tool) => tool.name === "thread_move")
  assert.ok(listed, "the in-Thread server lists thread_move")
  assert.deepEqual(Object.keys(listed.inputSchema.properties ?? {}).sort(), ["clientKey", "to"], "an agent names where and its key; never another conversation")
  assert.deepEqual([...(listed.inputSchema.required ?? [])].sort(), ["clientKey", "to"])
  assert.ok(THREAD_MOVE_TOOL.mcp.description.length < 700, "its description stays short")
  const overStdio = (await stdio.listTools()).tools.find((tool) => tool.name === "thread_move")
  assert.deepEqual(JSON.parse(JSON.stringify(overStdio)), JSON.parse(JSON.stringify(listed)), "mako mcp lists the same tool, schema and words")

  const viaThread = await answerOf(thread, { to: "cloud", clientKey: "same" })
  const viaStdio = await answerOf(stdio, { to: "cloud", clientKey: "same" })
  assert.equal(viaThread.answer.outcome, "handing-off")
  assert.deepEqual(viaStdio, viaThread, "mako mcp answers the same key with the same move")
  const command = async (env: Record<string, string>, ...args: string[]) => {
    const { stdout } = await run(process.execPath, [cli, "thread", "move", ...args, "--socket", socket, "--json"], { env: { ...process.env, ...env } }).catch((error: { stdout?: string; code?: number }) => {
      if (error.code === 1 && error.stdout) return { stdout: error.stdout }
      throw error
    })
    return ThreadMoveAnswerSchema.parse(JSON.parse(stdout))
  }
  assert.deepEqual(await command({ MAKO_SESSION_ID: "s-mine" }, "cloud", "--key", "same"), viaThread.answer, "and so does mako thread move, from the Thread's shell")
  const refusal = await answerOf(thread, { to: "back", clientKey: "r" })
  assert.equal(refusal.isError, true)
  assert.equal(refusal.first, "refused: already-there", "a refusal is named first")
  assert.deepEqual(await command({ MAKO_SESSION_ID: "s-mine" }, "back"), refusal.answer, "mako thread move exits 1 with the same refusal")
  const { MAKO_SESSION_ID: _session, ...personal } = process.env
  const back = await run(process.execPath, [cli, "thread", "move", "back", "--conversation", "theirs", "--socket", socket, "--json"], { env: personal })
  assert.deepEqual(ThreadMoveAnswerSchema.parse(JSON.parse(back.stdout)), { outcome: "back" }, "from the person's own shell it brings a named cloud Thread back")
  await tick()
  console.log("thread move tool: ok")
} finally {
  for (const client of clients) await client.close().catch(() => undefined)
  await host.close()
  jobs.stop()
  rmSync(root, { recursive: true, force: true })
}
