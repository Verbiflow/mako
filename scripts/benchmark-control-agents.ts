/**
 * Runs a model agent against the shipped computer-control surface and
 * measures what the surface costs it: turns, wall time, prompt tokens and
 * whether the user's frontmost application ever changed. The tool the model
 * sees is the server's own `mako_computer_exec` description and the system
 * prompt is the server's own instructions; nothing here shortens or
 * rewrites a result, so a regression in the reference, the helpers or the
 * spill shows up as extra turns or tokens in the table.
 *
 * Without `--live` the script checks its own task definitions (the reply
 * checkers against sample replies, a task file's shape) and exits. With
 * `--live` it needs the installed driver, Electron under `node_modules` for
 * the fixture tasks, and an OpenAI-compatible chat endpoint:
 *
 *   npx tsx scripts/benchmark-control-agents.ts --live \
 *     --endpoint https://<resource>.openai.azure.com/openai/v1 --model gpt-5.6-terra \
 *     [--tasks docs/audits/2026-09-14/conductor-agent-tasks.json] [--only settings,readchat] \
 *     [--runs 3] [--out results.jsonl]
 *
 * The key is `MAKO_BENCH_API_KEY`, else `AZURE_OPENAI_API_KEY` for an Azure
 * host, `FIREWORKS_API_KEY` for Fireworks, `OPENAI_API_KEY` otherwise; it is
 * sent as `api-key` to Azure and as a bearer elsewhere (`--auth` overrides).
 * Fixture tasks run against an Electron window this script starts behind
 * the user's; `--tasks` adds tasks on a real application by bundle id, which
 * is where the benchmark says something about a workload.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFile, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createComputerToolsServer } from "../electron/computer-tools-main.js"
import {
  cuaEmbeddedPid,
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../electron/cua-embedded.js"
import { resolveExecutable } from "../electron/executable.js"
import type { JsonValue } from "../electron/codex-app-json.js"
import {
  frontmostPid,
  sampleFrontmost,
  startElectronFixture,
} from "./lib/control-fixture.mjs"

const runCommand = promisify(execFile)

// ── arguments ────────────────────────────────────────────────────────────

interface Options {
  live: boolean
  endpoint: string | undefined
  model: string | undefined
  auth: "api-key" | "bearer" | undefined
  reasoning: string | undefined
  runs: number
  maxTurns: number
  tasksFile: string | undefined
  only: Set<string> | undefined
  out: string | undefined
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = {
    live: false,
    endpoint: process.env.MAKO_BENCH_ENDPOINT,
    model: process.env.MAKO_BENCH_MODEL,
    auth: undefined,
    reasoning: undefined,
    runs: 2,
    maxTurns: 12,
    tasksFile: undefined,
    only: undefined,
    out: undefined,
  }
  const next = (index: number, flag: string) => {
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    switch (flag) {
      case "--live":
        options.live = true
        break
      case "--endpoint":
        options.endpoint = next(index++, flag)
        break
      case "--model":
        options.model = next(index++, flag)
        break
      case "--auth": {
        const value = next(index++, flag)
        if (value !== "api-key" && value !== "bearer")
          throw new Error(`--auth is api-key or bearer, not ${value}`)
        options.auth = value
        break
      }
      case "--reasoning":
        options.reasoning = next(index++, flag)
        break
      case "--runs":
        options.runs = Number(next(index++, flag))
        break
      case "--max-turns":
        options.maxTurns = Number(next(index++, flag))
        break
      case "--tasks":
        options.tasksFile = next(index++, flag)
        break
      case "--only":
        options.only = new Set(next(index++, flag).split(","))
        break
      case "--out":
        options.out = next(index++, flag)
        break
      default:
        throw new Error(`unknown argument ${flag}`)
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error("--runs must be a positive integer")
  return options
}

// ── tasks ────────────────────────────────────────────────────────────────

/**
 * What a reply must contain. `all` are case-insensitive regular expressions
 * that must each match; `jsonArrayIncludes` reads the last JSON array in the
 * reply (a closing code fence is tolerated) and requires every string,
 * compared case-insensitively.
 */
const expectationSchema = z
  .object({
    all: z.array(z.string()).optional(),
    jsonArrayIncludes: z.array(z.string()).optional(),
  })
  .strict()
type Expectation = z.infer<typeof expectationSchema>

const appTaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** `{pid}` and `{window_id}` are substituted with the resolved target. */
    prompt: z.string().min(1),
    expect: expectationSchema,
    /** A program run before each attempt, with `state.target` preset. */
    reset: z.string().optional(),
  })
  .strict()

const taskFileSchema = z
  .object({
    target: z
      .object({
        bundle_id: z.string().min(1),
        /** Chooses among the application's document windows; the first otherwise. */
        window_title: z.string().optional(),
      })
      .strict(),
    /** The application to activate before each attempt, as the user's own; the current frontmost when absent. */
    behind: z.string().optional(),
    tasks: z.array(appTaskSchema).min(1),
  })
  .strict()
type TaskFile = z.infer<typeof taskFileSchema>

export function replySatisfies(reply: string, expectation: Expectation): boolean {
  for (const pattern of expectation.all ?? [])
    if (!new RegExp(pattern, "i").test(reply)) return false
  if (expectation.jsonArrayIncludes) {
    const match = /\[[^\]]*\]\s*$/.exec(
      reply.replace(/```\s*$/, "").trimEnd()
    )
    if (!match) return false
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(match[0]))
    if (!parsed.success) return false
    const got = parsed.data.map((entry) => String(entry).toLowerCase())
    for (const wanted of expectation.jsonArrayIncludes)
      if (!got.includes(wanted.toLowerCase())) return false
  }
  return true
}

interface Target {
  pid: number
  window_id: number
}

/** One attempt's task, with the target already resolved. */
interface Attempt {
  id: string
  /** Read after `reset`, so a write task can carry a per-attempt value. */
  prompt(): string
  target: Target
  /** Runs before the model's first turn; may throw to abort the attempt. */
  reset(): Promise<void>
  /** Judges the reply and, for fixture tasks, the fixture's own state. */
  check(reply: string): Promise<boolean>
}

// ── the model ────────────────────────────────────────────────────────────

const usageSchema = z
  .object({
    prompt_tokens: z.number().default(0),
    completion_tokens: z.number().default(0),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().default(0) })
      .loose()
      .optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().default(0) })
      .loose()
      .optional(),
  })
  .loose()

const toolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })
  .loose()

const assistantSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  })
  .loose()

const completionSchema = z
  .object({
    choices: z.array(z.object({ message: assistantSchema }).loose()).min(1),
    usage: usageSchema.optional(),
  })
  .loose()

const errorBodySchema = z.object({ error: z.unknown() }).loose()

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | z.infer<typeof assistantSchema>
  | { role: "tool"; tool_call_id: string; content: string }

interface ChatTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

interface ChatRequest {
  model: string
  messages: readonly ChatMessage[]
  tools: readonly ChatTool[]
  tool_choice: "auto"
  max_completion_tokens: number
  reasoning_effort?: string
}

interface ModelClient {
  name: string
  chat(
    messages: readonly ChatMessage[],
    tools: readonly ChatTool[]
  ): Promise<{
    message: z.infer<typeof assistantSchema>
    usage: z.infer<typeof usageSchema>
    ms: number
  }>
}

function modelClient(options: Options): ModelClient {
  if (!options.endpoint || !options.model)
    throw new Error("--live needs --endpoint and --model (or MAKO_BENCH_ENDPOINT and MAKO_BENCH_MODEL)")
  const host = new URL(options.endpoint).hostname
  const azure = host.endsWith(".openai.azure.com")
  const auth = options.auth ?? (azure ? "api-key" : "bearer")
  const key =
    process.env.MAKO_BENCH_API_KEY ??
    (azure ? process.env.AZURE_OPENAI_API_KEY : undefined) ??
    (host.endsWith("fireworks.ai") ? process.env.FIREWORKS_API_KEY : undefined) ??
    process.env.OPENAI_API_KEY
  if (!key)
    throw new Error(
      "no API key: set MAKO_BENCH_API_KEY (or the provider's own variable) in the environment"
    )
  const base = options.endpoint.replace(/\/$/, "")
  const model = options.model
  return {
    name: model,
    async chat(messages, tools) {
      const body: ChatRequest = {
        model,
        messages,
        tools,
        tool_choice: "auto",
        max_completion_tokens: 4000,
      }
      if (options.reasoning) body.reasoning_effort = options.reasoning
      const started = performance.now()
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth === "api-key"
            ? { "api-key": key }
            : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify(body),
      })
      const ms = Math.round(performance.now() - started)
      const json: unknown = await response.json()
      const failure = errorBodySchema.safeParse(json)
      if (!response.ok || (failure.success && failure.data.error !== undefined))
        throw new Error(
          `${model}: ${response.status} ${JSON.stringify(failure.success ? failure.data.error : json).slice(0, 300)}`
        )
      const completion = completionSchema.parse(json)
      return {
        message: completion.choices[0]!.message,
        usage: completion.usage ?? usageSchema.parse({}),
        ms,
      }
    },
  }
}

// ── the surface ──────────────────────────────────────────────────────────

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
      })
      .loose()
  ),
})

interface Surface {
  instructions: string
  tool: ChatTool
  exec(source: string): Promise<z.infer<typeof toolResultSchema>>
  close(): Promise<void>
}

async function openSurface(root: string): Promise<Surface> {
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.benchmark")
  if (!socket) throw new Error("the native driver is not installed or did not start")
  const server = createComputerToolsServer(
    {
      command: resolveExecutable("cua-driver"),
      args: ["mcp", "--embedded", "--socket", socket],
    },
    "agent-benchmark"
  )
  const client = new Client({ name: "mako-control-agent-benchmark", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  const exec = tools.find((tool) => tool.name === "mako_computer_exec")
  if (!exec) throw new Error("the server offers no mako_computer_exec")
  return {
    instructions: client.getInstructions() ?? "",
    tool: {
      type: "function",
      function: {
        name: exec.name,
        description: exec.description ?? "",
        parameters: exec.inputSchema,
      },
    },
    exec: async (source) =>
      toolResultSchema.parse(
        await client.callTool(
          { name: "mako_computer_exec", arguments: { source } },
          undefined,
          { timeout: 90_000 }
        )
      ),
    close: async () => {
      await client.close()
      await server.close()
      stopCuaEmbedded()
    },
  }
}

/** A program's return value, the last text block, parsed as JSON. */
function returned(result: z.infer<typeof toolResultSchema>): JsonValue {
  const text = result.content.filter((block) => block.type === "text").at(-1)?.text
  return text === undefined ? null : z.json().parse(JSON.parse(text))
}

// ── one attempt ──────────────────────────────────────────────────────────

interface TurnRecord {
  ms: number
  prompt: number
  cached: number
  completion: number
  reasoning: number
}

interface ToolRecord {
  ms: number
  bytes: number
  images: number
  isError: boolean
  source: string
  /** The first 300 characters of a failed call's text, for the post-mortem. */
  error?: string
}

interface Row {
  model: string
  task: string
  run: number
  success: boolean
  /** Neither the target application nor the driver was ever frontmost. */
  frontKept: boolean
  /** Other applications seen frontmost: the user working, not Mako. */
  userSwitched: number[]
  frontmostSeen: number[]
  wallMs: number
  modelMs: number
  turns: number
  calls: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  maxTurnPrompt: number
  perTurn: TurnRecord[]
  toolLog: ToolRecord[]
  reply: string
  error?: string
}

async function attempt(
  surface: Surface,
  model: ModelClient,
  task: Attempt,
  run: number,
  maxTurns: number
): Promise<Row> {
  await surface.exec(
    `state.target = ${JSON.stringify(task.target)}; state.last = undefined; return 1`
  )
  await task.reset()
  const baseline = await frontmostPid()
  const sampler = sampleFrontmost()
  const messages: ChatMessage[] = [
    { role: "system", content: surface.instructions },
    { role: "user", content: task.prompt() },
  ]
  const started = performance.now()
  const perTurn: TurnRecord[] = []
  const toolLog: ToolRecord[] = []
  let turns = 0
  let calls = 0
  let modelMs = 0
  let reply = ""
  let error: string | undefined
  try {
    while (turns < maxTurns) {
      turns++
      const { message, usage, ms } = await model.chat(messages, [surface.tool])
      modelMs += ms
      perTurn.push({
        ms,
        prompt: usage.prompt_tokens,
        cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
        completion: usage.completion_tokens,
        reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      })
      messages.push(message)
      if (!message.tool_calls?.length) {
        reply = message.content ?? ""
        break
      }
      for (const call of message.tool_calls) {
        calls++
        const parsedArguments = z
          .object({ source: z.string().default("") })
          .loose()
          .safeParse(JSON.parse(call.function.arguments || "{}"))
        const source = parsedArguments.success ? parsedArguments.data.source : ""
        const callStarted = performance.now()
        let result: z.infer<typeof toolResultSchema>
        try {
          result = await surface.exec(source)
        } catch (failure) {
          result = {
            isError: true,
            content: [{ type: "text", text: String(failure instanceof Error ? failure.message : failure) }],
          }
        }
        // Chat completions carry no images in a tool result; the model is
        // told one was there and how large, which is what a harness that
        // cannot show images would do.
        const text = result.content
          .map((block) =>
            block.type === "text"
              ? (block.text ?? "")
              : `[${block.type}: ${block.data?.length ?? 0} base64 characters]`
          )
          .join("\n")
        const record: ToolRecord = {
          ms: Math.round(performance.now() - callStarted),
          bytes: Buffer.byteLength(text),
          images: result.content.filter((block) => block.type === "image").length,
          isError: result.isError === true,
          source: source.slice(0, 400),
        }
        if (record.isError) record.error = text.slice(0, 300)
        toolLog.push(record)
        messages.push({ role: "tool", tool_call_id: call.id, content: text || "(no text)" })
      }
    }
    if (turns >= maxTurns && !reply) error = `no reply within ${maxTurns} turns`
  } catch (failure) {
    error = String(failure instanceof Error ? failure.message : failure).slice(0, 300)
  }
  const wallMs = Math.round(performance.now() - started)
  const seen = await sampler.stop()
  const frontmostSeen = [...seen.keys()]
  const makoPids = new Set([task.target.pid, cuaEmbeddedPid() ?? -1])
  const success = !error && (await task.check(reply))
  const sum = (pick: (turn: TurnRecord) => number) =>
    perTurn.reduce((total, turn) => total + pick(turn), 0)
  const row: Row = {
    model: model.name,
    task: task.id,
    run,
    success,
    frontKept: !frontmostSeen.some((pid) => makoPids.has(pid)),
    userSwitched: frontmostSeen.filter((pid) => pid !== baseline && !makoPids.has(pid)),
    frontmostSeen,
    wallMs,
    modelMs,
    turns,
    calls,
    promptTokens: sum((turn) => turn.prompt),
    cachedTokens: sum((turn) => turn.cached),
    completionTokens: sum((turn) => turn.completion),
    maxTurnPrompt: perTurn.reduce((most, turn) => Math.max(most, turn.prompt), 0),
    perTurn,
    toolLog,
    reply: reply.slice(0, 400),
  }
  if (error) row.error = error
  return row
}

// ── fixture tasks ────────────────────────────────────────────────────────

/**
 * Three tasks on an Electron window behind the user's: read the field
 * (judgement only, no action), write a value and verify it (act, confirm
 * by the fixture's own state), and replace a prefilled value (the keyboard
 * temptation: select-all and retype does not work on a backgrounded
 * renderer, fill does).
 */
async function fixtureTasks(
  root: string,
  surface: Surface
): Promise<{ tasks: Attempt[]; stop(): void }> {
  const initial = `initial-${randomUUID().slice(0, 6)}`
  const fixture = await startElectronFixture({
    root,
    name: "bench-fixture",
    title: "Mako control fixture",
    initial,
  })
  const status = z
    .object({ pid: z.number(), input: z.string(), value: z.string() })
    .loose()
  const started = status.parse(await fixture.started())
  const windowsSchema = z.array(
    z.object({ window_id: z.number(), title: z.string().optional(), kind: z.string().optional() }).loose()
  )
  const windows = windowsSchema.parse(
    returned(await surface.exec(`return await windows(${started.pid})`))
  )
  const document = windows[0]
  if (!document) throw new Error("the fixture has no window")
  const target = { pid: started.pid, window_id: document.window_id }
  const where = `A window titled "Mako control fixture" (pid ${target.pid}, window id ${target.window_id}) is open behind the app I'm working in; do not bring it to the front.`
  const reset = async () => {
    const result = await surface.exec(
      `const lines = await view(state.target);
       const field = lines.find(l => /TextField "Proof"/.test(l));
       if (!field) throw new Error('no Proof field: ' + lines.join(' | '));
       return await fill(field.split(' ')[0], ${JSON.stringify(initial)})`
    )
    if (result.isError) throw new Error(`fixture reset failed: ${JSON.stringify(returned(result))}`)
    await fixture.until(
      async () => status.parse(await fixture.state()).input === initial,
      "fixture reset to its initial text"
    )
  }
  const fieldIs = async (expected: string, output?: string) => {
    try {
      await fixture.until(async () => {
        const state = status.parse(await fixture.state())
        return state.input === expected && (output === undefined || state.value === output)
      }, "fixture shows the task's result", 3000)
      return true
    } catch {
      return false
    }
  }
  // A write task carries a per-attempt value so a stale result never passes.
  const writeTask = (id: string, prefix: string, instruction: (text: string) => string): Attempt => {
    let expected = ""
    return {
      id,
      target,
      prompt: () => `${where} ${instruction(expected)}`,
      reset: async () => {
        expected = `${prefix}-${randomUUID().slice(0, 8)}`
        await reset()
      },
      check: async () => fieldIs(expected, expected),
    }
  }
  const tasks: Attempt[] = [
    {
      id: "fixture-read",
      target,
      prompt: () => `${where} Without clicking anything, tell me the exact current text of its Proof field on the last line of your reply.`,
      reset,
      check: async (reply) => reply.includes(initial),
    },
    writeTask(
      "fixture-fill",
      "fill",
      (text) => `Put exactly the text "${text}" into its Proof field (replacing whatever is there) and press its "Verify proof" button. Reply "done" when the result shows the text.`
    ),
    writeTask(
      "fixture-replace",
      "replaced",
      (text) => `Its Proof field already has text. Replace that text with exactly "${text}" and press "Verify proof", then reply with the text the result line shows.`
    ),
  ]
  return { tasks, stop: () => fixture.stop() }
}

// ── application tasks ────────────────────────────────────────────────────

async function pidForBundle(bundleId: string): Promise<number> {
  const { stdout } = await runCommand(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import("AppKit"); const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)}); apps.count ? apps.objectAtIndex(0).processIdentifier : 0`,
    ],
    { timeout: 3000 }
  )
  const pid = Number(stdout.trim())
  if (!pid) throw new Error(`${bundleId} is not running`)
  return pid
}

async function applicationTasks(file: TaskFile, surface: Surface): Promise<Attempt[]> {
  const pid = await pidForBundle(file.target.bundle_id)
  const windows = z
    .array(z.object({ window_id: z.number(), title: z.string().optional(), kind: z.string().optional() }).loose())
    .parse(returned(await surface.exec(`return await windows(${pid})`)))
  const wanted = file.target.window_title ? new RegExp(file.target.window_title) : undefined
  // windows() lists the on-screen titled documents first, largest first.
  const document = windows.find((row) => !wanted || wanted.test(row.title ?? ""))
  if (!document)
    throw new Error(`${file.target.bundle_id} has no matching window among ${JSON.stringify(windows)}`)
  const target = { pid, window_id: document.window_id }
  const behind = file.behind ?? null
  return file.tasks.map((task) => ({
    id: task.id,
    target,
    prompt: () => task.prompt.replaceAll("{pid}", String(pid)).replaceAll("{window_id}", String(document.window_id)),
    reset: async () => {
      if (behind) {
        await runCommand("osascript", ["-e", `tell application id ${JSON.stringify(behind)} to activate`], { timeout: 5000 })
        await new Promise((resolveWait) => setTimeout(resolveWait, 700))
      }
      if (task.reset) {
        const result = await surface.exec(
          `state.target = ${JSON.stringify(target)}; ${task.reset}`
        )
        if (result.isError) throw new Error(`reset for ${task.id} failed: ${JSON.stringify(returned(result))}`)
      }
    },
    check: async (reply) => replySatisfies(reply, task.expect),
  }))
}

// ── the table ────────────────────────────────────────────────────────────

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0
}

function summarize(rows: readonly Row[]): string {
  const tasks = [...new Set(rows.map((row) => row.task))]
  const lines = [
    "| Task | Passed | Front kept | Turns (median) | Wall s (median) | Prompt tokens (median) | Cached | Max prompt/turn |",
    "|---|---|---|---|---|---|---|---|",
  ]
  for (const task of tasks) {
    const group = rows.filter((row) => row.task === task)
    const prompt = group.reduce((total, row) => total + row.promptTokens, 0)
    const cached = group.reduce((total, row) => total + row.cachedTokens, 0)
    lines.push(
      `| ${task} | ${group.filter((row) => row.success).length}/${group.length} | ${group.filter((row) => row.frontKept).length}/${group.length} | ${median(group.map((row) => row.turns))} | ${(median(group.map((row) => row.wallMs)) / 1000).toFixed(1)} | ${median(group.map((row) => row.promptTokens))} | ${prompt ? Math.round((cached / prompt) * 100) : 0}% | ${Math.max(...group.map((row) => row.maxTurnPrompt))} |`
    )
  }
  return lines.join("\n")
}

// ── main ─────────────────────────────────────────────────────────────────

function selfCheck(taskFile: TaskFile | undefined) {
  const settings = { jsonArrayIncludes: ["General", "Account"] }
  if (!replySatisfies('Pages: ["General","Account","Git"]', settings))
    throw new Error("jsonArrayIncludes should accept a superset")
  if (!replySatisfies('```json\n["general", "account"]\n```', settings))
    throw new Error("jsonArrayIncludes should tolerate a code fence and case")
  if (replySatisfies('["General"]', settings))
    throw new Error("jsonArrayIncludes should refuse a missing entry")
  if (replySatisfies("no array here", settings))
    throw new Error("jsonArrayIncludes should refuse a reply without an array")
  const line = { all: ["gpt-6 astra", "PONG"] }
  if (!replySatisfies("GPT-6 Astra — PONG GPT-6", line))
    throw new Error("all should match case-insensitively")
  if (replySatisfies("GPT-6 Astra — pong", line) !== true)
    throw new Error("all should be case-insensitive on every pattern")
  if (replySatisfies("Claude — PONG", line))
    throw new Error("all should require every pattern")
  console.log(
    `Agent benchmark self-check: reply checkers hold${taskFile ? `; ${taskFile.tasks.length} task(s) on ${taskFile.target.bundle_id} parse` : ""}. Run with --live to measure.`
  )
}

const options = parseArguments(process.argv.slice(2))
const taskFile = options.tasksFile
  ? taskFileSchema.parse(JSON.parse(await readFile(options.tasksFile, "utf8")))
  : undefined

if (!options.live) {
  selfCheck(taskFile)
} else {
  const model = modelClient(options)
  const root = await mkdtemp(join(tmpdir(), "mako-agent-bench-"))
  process.env.MAKO_CONTROL_ARTIFACTS ??= join(root, "artifacts")
  const out = options.out ?? join(root, "results.jsonl")
  const surface = await openSurface(root)
  await surface.exec("await computer.start_session({capture_scope: 'window'}); return 1")
  let stopFixture = () => {}
  try {
    const attempts: Attempt[] = []
    const wantsFixture =
      !options.only || [...options.only].some((id) => id.startsWith("fixture-"))
    if (wantsFixture) {
      const fixture = await fixtureTasks(root, surface)
      stopFixture = fixture.stop
      attempts.push(...fixture.tasks)
    }
    if (taskFile) attempts.push(...(await applicationTasks(taskFile, surface)))
    const selected = attempts.filter((task) => !options.only || options.only.has(task.id))
    if (!selected.length) throw new Error("no task selected")
    console.log(
      `Model ${model.name}; ${selected.length} task(s) × ${options.runs} run(s); tool description ${Buffer.byteLength(surface.tool.function.description)} bytes, instructions ${Buffer.byteLength(surface.instructions)} bytes; rows → ${out}`
    )
    const rows: Row[] = []
    for (const task of selected) {
      for (let run = 1; run <= options.runs; run++) {
        const row = await attempt(surface, model, task, run, options.maxTurns)
        rows.push(row)
        await appendFile(out, `${JSON.stringify(row)}\n`)
        console.log(
          `${task.id.padEnd(16)} #${run} ${row.success ? "PASS" : "FAIL"} front:${row.frontKept ? "kept" : `FRONTED ${row.frontmostSeen.join(",")}`}${row.userSwitched.length ? ` (user switched to ${row.userSwitched.join(",")})` : ""} wall=${(row.wallMs / 1000).toFixed(1)}s model=${(row.modelMs / 1000).toFixed(1)}s turns=${row.turns} calls=${row.calls} prompt=${row.promptTokens} (cached ${row.cachedTokens}, max/turn ${row.maxTurnPrompt}) out=${row.completionTokens}${row.error ? ` ERR ${row.error}` : ""}`
        )
      }
    }
    console.log(`\n${summarize(rows)}`)
    console.log(`\nRows: ${out}\nArtifacts: ${process.env.MAKO_CONTROL_ARTIFACTS}`)
  } finally {
    stopFixture()
    await surface.close()
  }
}
