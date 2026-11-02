import "./lib/scratch-git.mjs"
// Grok's own goal against the real grok binary in a sealed HOME, driven with
// the messages Mako's Grok source sends and read through Mako's decoder. A
// stand-in model plays the worker, Grok's completion evaluator and its
// verifier panel, so the goal runs Grok's whole loop: rounds within one turn
// until the panel passes it, a new goal after a finished one, Stop, resume,
// replacing an unfinished goal, clear, and a goal set with a token budget.
// Grok's goal count stays at none for a stand-in's usage, so whether Grok
// stops at the budget takes a real model to show. Grok's planner is off and its
// side models use the stand-in, since a stand-in can't write Grok's plan.
//
// An Apex launches with workflows off, so its goal runs on Grok's
// `update_goal` driver instead: the worker marks it complete with that tool,
// and the panel passes it.
//
//   tsx scripts/test-grok-goal-live.ts [--apex]   (in npm run test:acp-registry)
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { acpReadable, acpWritable } from "@mako/host/harnesses/acp-stream"
import type { JsonObject } from "@mako/host/contracts/json"
import type { GoalObservation } from "@mako/host/contracts/live-goals"
import type { DriverGoalCommand } from "@mako/host/harnesses/live-driver"
import { acpClientCapabilities } from "@mako/host/harnesses/acp-source"
import { createGrokAcpSource } from "@mako/host/harnesses/grok/acp"
import { grokNotification } from "@mako/host/harnesses/grok/notifications"

const source = createGrokAcpSource()
const goals = source.goals
assert.ok(goals?.kind === "native", "Grok keeps its own goal")
const goalDelivery = (command: DriverGoalCommand) => goals.send(command)
const only = process.argv.includes("--apex") ? "apex" : undefined

const installed = (() => {
  try {
    execFileSync("grok", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const MessageText = z.string()
  .or(z.array(z.looseObject({ text: z.string().optional() })).transform((parts) => parts.map((part) => part.text ?? "").join("")))
const ChatRequest = z.object({
  stream: z.boolean().optional(),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: MessageText.nullish() })),
})

const read = async (request: IncomingMessage) => {
  let body = ""
  for await (const chunk of request) body += chunk
  return body
}

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

type Verdict = "continue" | "complete"

/** What the evaluator says after each worker round: queued verdicts first, then `afterwards`. */
interface Evaluator {
  queue: Verdict[]
  afterwards: Verdict
}

const FIRST = "The file done.txt exists in the project and contains the word done"
const SECOND = "The file notes.txt lists three release notes"
const THIRD = "The changelog mentions the parser fix"

interface ToolCall {
  name: string
  arguments: JsonObject
}

/** What a session leaves to undo, last first. */
type Cleanup = () => void | Promise<void>
/** The stand-in's worker for a round: the tool it calls, given the tools offered and who spoke last. */
type RoundWorker = (tools: ReadonlySet<string>, lastRole: string | undefined) => ToolCall | undefined
/** How many rounds the stand-in has played, and the worker playing the next. */
interface Rounds {
  rounds: number
  worker?: RoundWorker
}

/** Grok in a sealed HOME against the stand-in, as Mako launches it for an ordinary Thread or an Apex. */
async function grokSession(root: string, after: Cleanup[], apex: boolean) {
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, ".grok"), { recursive: true })
  mkdirSync(project, { recursive: true })
  execFileSync("git", ["init", "-q", project])

  const evaluator: Evaluator = { queue: [], afterwards: "complete" }
  const offered = new Set<string>()
  const state: Rounds = { rounds: 0 }
  const models = createServer(async (request, res) => {
    if (request.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
      return
    }
    const body = ChatRequest.parse(JSON.parse(await read(request)))
    const system = body.messages.find((message) => message.role === "system")?.content ?? ""
    const last = body.messages.at(-1)?.content ?? ""
    const tools = new Set((body.tools ?? []).map((tool) => tool.function.name))
    let content = "Working on it."
    let call: ToolCall | undefined
    if (system.startsWith("You are the hidden completion evaluator")) {
      const verdict = evaluator.queue.shift() ?? evaluator.afterwards
      content = JSON.stringify(verdict === "continue"
        ? { decision: "continue", evidence: "The file is missing", next_step: "Create the file", blocker_key: "" }
        : { decision: "candidate_complete", evidence: "The file has the content", next_step: "Verify the file", blocker_key: "" })
    } else if (last.includes("adversarial verifier")) content = "Not Refuted"
    else if (system.startsWith("You are Grok released by xAI")) {
      state.rounds += 1
      for (const name of tools) offered.add(name)
      call = state.worker?.(tools, body.messages.at(-1)?.role)
    }
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${state.rounds}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`)
      // As OpenAI streams it with `include_usage`: a last chunk with the usage and no choices.
      res.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [], usage })}\n\n`)
      res.end("data: [DONE]\n\n")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "double", object: "chat.completion", created: 0, model: "double", usage, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }))
  })
  await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
  after.push(() => {
    models.close()
  })
  const port = z.object({ port: z.number() }).parse(models.address()).port
  writeFileSync(join(home, ".grok", "config.toml"), `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0",
    GROK_GOAL_PLANNER: "0", GROK_GOAL_USE_CURRENT_MODEL_ONLY: "1",
  }
  const launch = await source.launch({ appPath: "/app", execPath: process.execPath, cwd: project, env, access: "ask", nativeSpawnsOff: apex })
  assert.ok(launch)
  launch.configureEnvironment?.(env)
  const child = spawn(launch.command, launch.args, { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  after.push(() => {
    child.kill("SIGTERM")
    return exited
  })

  const reported: (GoalObservation | null)[] = []
  let commands: string[] = []
  const client: Client = {
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } }
    },
    async sessionUpdate({ update }) {
      if (update.sessionUpdate === "available_commands_update") commands = update.availableCommands.map((command) => command.name)
    },
    async extNotification(method: string, params: JsonObject) {
      const decoded = grokNotification(method, params)
      for (const notice of decoded?.notices ?? []) if (notice.kind === "goal") reported.push(notice.goal)
    },
  }
  const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
  await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(source) })
  const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] })
  await waitFor(() => commands.includes("goal"), "Grok never offered /goal; goal mode is on unless `goal.enabled` is off")

  /** Sends a command the way Mako does, each message as its own turn, and returns the last turn while it runs. */
  const send = (command: DriverGoalCommand) => {
    const delivery = goalDelivery(command)
    assert.equal(delivery.via, "message")
    if (delivery.via !== "message") throw new Error("Grok's goal takes messages")
    return delivery.texts.reduce<Promise<unknown>>(
      (previous, text) => previous.then(() => connection.prompt({ sessionId, prompt: [{ type: "text", text }] })),
      Promise.resolve())
  }
  return { evaluator, state, offered, reported, latest: () => reported.at(-1), send, cancel: () => connection.cancel({ sessionId }) }
}

type Session = Awaited<ReturnType<typeof grokSession>>

/** An ordinary Thread: the workflow driver runs the goal's rounds, evaluator and panel. */
async function ordinary({ evaluator, state, reported, latest, send, cancel }: Session) {
  evaluator.queue = ["continue"]
  evaluator.afterwards = "complete"
  await send({ kind: "set", objective: FIRST, replacing: false })
  assert.equal(state.rounds, 2, "Grok took a second round by itself, inside the same turn")
  assert.deepEqual(reported[0], { objective: FIRST, status: "active", turns: undefined, tokensUsed: 0, tokenBudget: undefined, seconds: 0, note: undefined })
  assert.ok(reported.some((goal) => goal?.status === "active" && goal.turns === 1 && goal.note === "The file is missing"), "after a round, the note says what the evaluator found left")
  assert.equal(latest()?.status, "complete", "the panel passed it")
  assert.equal(latest()?.turns, 2)
  assert.ok((latest()?.tokensUsed ?? 0) > 0, "Grok counts the goal's tokens")

  state.rounds = 0
  evaluator.afterwards = "continue"
  const working = send({ kind: "set", objective: SECOND, replacing: false })
  await waitFor(() => latest()?.objective === SECOND, "Grok didn't take a new goal after a finished one")
  await waitFor(() => state.rounds >= 2, "Grok didn't keep working on the goal")
  await cancel()
  await working
  await waitFor(() => latest()?.status === "paused", "Stop didn't pause the goal")
  assert.equal(latest()?.objective, SECOND)
  await send({ kind: "pause" })
  assert.equal(latest()?.status, "paused", "pausing after Stop leaves it paused")

  state.rounds = 0
  evaluator.afterwards = "complete"
  await send({ kind: "resume", objective: SECOND, from: "paused" })
  assert.ok(state.rounds >= 1, "resuming worked on the goal again")
  assert.equal(latest()?.objective, SECOND)
  assert.equal(latest()?.status, "complete")

  evaluator.afterwards = "continue"
  const unfinished = send({ kind: "set", objective: FIRST, replacing: false })
  await waitFor(() => latest()?.objective === FIRST && latest()?.status === "active", "the next goal didn't start")
  await cancel()
  await unfinished
  await waitFor(() => latest()?.status === "paused", "Stop didn't pause the goal")
  const before = reported.length
  evaluator.afterwards = "complete"
  await send({ kind: "set", objective: THIRD, replacing: true })
  assert.ok(reported.slice(before).includes(null), "Mako cleared the unfinished goal first")
  assert.equal(latest()?.objective, THIRD, "Grok took the replacement")
  assert.equal(latest()?.status, "complete")

  await send({ kind: "clear" })
  assert.equal(latest(), null, "a cleared goal reads as none")

  evaluator.afterwards = "continue"
  const budgeted = send({ kind: "set", objective: FIRST, tokenBudget: 50, replacing: false })
  await waitFor(() => latest()?.objective === FIRST && latest()?.tokenBudget === 50, "Grok didn't take the goal's budget")
  await cancel()
  await budgeted
  await send({ kind: "clear" })
  return "set, continued within the turn, verified complete, paused on Stop, resumed, replaced, cleared, and set with a token budget"
}

/** An Apex: no spawn tools, and the goal on `update_goal`, which the worker calls to mark it complete. */
async function asApex({ evaluator, state, offered, reported, latest, send }: Session) {
  let marked = false
  state.worker = (tools, lastRole) => {
    if (marked || !tools.has("update_goal") || lastRole === "tool") return undefined
    marked = true
    return { name: "update_goal", arguments: { message: "done.txt holds the word done", completed: true } }
  }
  evaluator.afterwards = "complete"
  await send({ kind: "set", objective: FIRST, replacing: false })
  assert.ok(marked, "the worker was offered update_goal")
  assert.ok(!offered.has("spawn_subagent") && !offered.has("workflow"), `an Apex offers no native spawn: ${[...offered].filter((name) => name === "spawn_subagent" || name === "workflow").join(", ")}`)
  assert.equal(reported[0]?.status, "active")
  await waitFor(() => latest()?.status === "complete", "the panel didn't pass the goal update_goal marked complete")
  assert.equal(latest()?.objective, FIRST)
  await send({ kind: "clear" })
  assert.equal(latest(), null, "a cleared goal reads as none")
  return "no spawn_subagent or workflow, set, marked complete with update_goal and passed, and cleared"
}

if (!installed) console.log("Grok goal: skipped, grok is not installed")
else {
  for (const [name, run, apex] of [["ordinary", ordinary, false], ["apex", asApex, true]] as const) {
    if (only && only !== name) continue
    const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-goal-live-")))
    const after: Cleanup[] = []
    try {
      const said = await run(await grokSession(root, after, apex))
      console.log(`Grok goal${apex ? " as an Apex" : ""}: ${said}, each read through Mako's decoder`)
    } finally {
      for (const done of after.reverse()) await done()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
