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
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import { type ControlProgramRequest } from "@mako/control/program"
import {
  cuaEmbeddedPid,
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../electron/cua-embedded.js"
import { resolveExecutable } from "../electron/executable.js"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.js"
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
  transport: "mcp" | "direct-sdk"
  surface: "legacy" | "unified"
  images: boolean
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
    transport: "mcp",
    surface: "unified",
    images: true,
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
      case "--transport":
        options.transport = z
          .enum(["mcp", "direct-sdk"])
          .parse(next(index++, flag))
        break
      case "--surface":
        options.surface = z
          .enum(["legacy", "unified"])
          .parse(next(index++, flag))
        break
      case "--no-images":
        options.images = false
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
    jsonObjectArrays: z
      .record(
        z.string(),
        z
          .object({
            includes: z.array(z.string()).optional(),
            minItems: z.number().int().nonnegative().optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict()
type Expectation = z.infer<typeof expectationSchema>
const oracleResultSchema = z
  .object({
    state: z.boolean(),
    expect: expectationSchema.optional(),
    evidence: z.json().optional(),
  })
  .strict()

const appTaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** `{pid}` and `{window_id}` are substituted with the resolved target. */
    prompt: z.string().min(1),
    expect: expectationSchema.optional(),
    /**
     * Independent verification program run after the model. It must return
     * {state:boolean, expect?:Expectation, evidence?:JSON}; the attempt passes
     * only when state is true and the reply satisfies its live expectation.
     */
    oracle: z.string().optional(),
    /** A program run before each attempt, with `state.target` preset. */
    reset: z.string().optional(),
  })
  .refine((task) => task.expect !== undefined || task.oracle !== undefined, {
    message: "a task needs expect or oracle",
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

export function replySatisfies(
  reply: string,
  expectation: Expectation
): boolean {
  for (const pattern of expectation.all ?? [])
    if (!new RegExp(pattern, "i").test(reply)) return false
  if (expectation.jsonArrayIncludes) {
    const match = /\[[^\]]*\]\s*$/.exec(reply.replace(/```\s*$/, "").trimEnd())
    if (!match) return false
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(match[0]))
    if (!parsed.success) return false
    const got = parsed.data.map((entry) => String(entry).toLowerCase())
    for (const wanted of expectation.jsonArrayIncludes)
      if (!got.includes(wanted.toLowerCase())) return false
  }
  if (expectation.jsonObjectArrays) {
    const parsed = lastJsonObject(reply)
    if (!parsed) return false
    for (const [key, expected] of Object.entries(
      expectation.jsonObjectArrays
    )) {
      const array = z.array(z.unknown()).safeParse(parsed[key])
      if (!array.success) return false
      if (
        expected.minItems !== undefined &&
        array.data.length < expected.minItems
      )
        return false
      const got = array.data.map((entry) => String(entry).toLowerCase())
      for (const wanted of expected.includes ?? [])
        if (!got.includes(wanted.toLowerCase())) return false
    }
  }
  return true
}

function lastJsonObject(reply: string): Record<string, JsonValue> | undefined {
  const text = reply.replace(/```\s*$/, "").trimEnd()
  let index = text.lastIndexOf("{")
  while (index >= 0) {
    let value: JsonValue
    try {
      value = z.json().parse(JSON.parse(text.slice(index)))
    } catch {
      index = text.lastIndexOf("{", index - 1)
      continue
    }
    const candidate = z.record(z.string(), z.json()).safeParse(value)
    if (candidate.success) return candidate.data
    index = text.lastIndexOf("{", index - 1)
  }
  return undefined
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
  /** Judges the reply against independent application state. */
  check(reply: string): Promise<{ success: boolean; evidence: JsonValue }>
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
  | {
      role: "system" | "user"
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | {
                type: "image_url"
                image_url: { url: string; detail: "high" }
              }
          >
    }
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
    throw new Error(
      "--live needs --endpoint and --model (or MAKO_BENCH_ENDPOINT and MAKO_BENCH_MODEL)"
    )
  const host = new URL(options.endpoint).hostname
  const azure = host.endsWith(".openai.azure.com")
  const auth = options.auth ?? (azure ? "api-key" : "bearer")
  const key =
    process.env.MAKO_BENCH_API_KEY ??
    (azure ? process.env.AZURE_OPENAI_API_KEY : undefined) ??
    (host.endsWith("fireworks.ai")
      ? process.env.FIREWORKS_API_KEY
      : undefined) ??
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
        mimeType: z.string().optional(),
      })
      .loose()
  ),
})

interface Surface {
  instructions: string
  tools: ChatTool[]
  call(
    name: string,
    args: JsonObject
  ): Promise<z.infer<typeof toolResultSchema>>
  exec(
    request: string | ControlProgramRequest
  ): Promise<z.infer<typeof toolResultSchema>>
  close(): Promise<void>
}

async function openSurface(
  root: string,
  cuaTransport: Options["transport"],
  surface: Options["surface"]
): Promise<Surface> {
  const socket = await ensureCuaEmbedded(
    join(root, "driver"),
    "dev.mako.benchmark"
  )
  if (!socket)
    throw new Error("the native driver is not installed or did not start")
  const entry = join(process.cwd(), "dist-electron", "computer-tools-main.js")
  await access(entry).catch(() => {
    throw new Error(
      "The production computer server is not built. Run npm run build:electron before the benchmark."
    )
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      entry,
      "--socket",
      socket,
      "--driver",
      resolveExecutable("cua-driver"),
      ...(surface === "legacy" ? ["--driver-test"] : []),
    ],
    env: {
      ...getDefaultEnvironment(),
      MAKO_TASK_ID: `agent-benchmark-${randomUUID()}`,
      MAKO_CUA_TRANSPORT: cuaTransport,
    },
    stderr: "pipe",
  })
  const client = new Client({
    name: "mako-control-agent-benchmark",
    version: "1",
  })
  await client.connect(transport)
  const { tools } = await client.listTools()
  const execName =
    surface === "unified" ? "mako_control_exec" : "mako_computer_exec"
  const exec = tools.find((tool) => tool.name === execName)
  if (!exec) throw new Error(`the server offers no ${execName}`)
  const call = async (name: string, args: JsonObject) =>
    toolResultSchema.parse(
      await client.callTool({ name, arguments: args }, undefined, {
        timeout: 90_000,
      })
    )
  return {
    instructions: client.getInstructions() ?? "",
    tools: tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      },
    })),
    call,
    exec: async (request) => {
      const source = z.string().safeParse(request)
      return toolResultSchema.parse(
        await client.callTool(
          {
            name: execName,
            arguments: source.success ? { source: source.data } : request,
          },
          undefined,
          { timeout: 90_000 }
        )
      )
    },
    close: async () => {
      await client.close()
      await transport.close()
    },
  }
}

/** A program's return value, the last text block, parsed as JSON. */
function returned(result: z.infer<typeof toolResultSchema>): JsonValue {
  const text = result.content
    .filter((block) => block.type === "text")
    .at(-1)?.text
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
  tool: string
  arguments: string
  ms: number
  bytes: number
  imageBytes: number
  images: number
  isError: boolean
  source: string
  /** The first 300 characters of a failed call's text, for the post-mortem. */
  error?: string
}

interface Row {
  model: string
  transport: Options["transport"]
  surface: Options["surface"]
  images: boolean
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
  oracle: JsonValue
  reply: string
  error?: string
}

async function attempt(
  surface: Surface,
  model: ModelClient,
  task: Attempt,
  run: number,
  maxTurns: number,
  images: boolean,
  transport: Options["transport"],
  surfaceMode: Options["surface"]
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
      const { message, usage, ms } = await model.chat(messages, surface.tools)
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
      const visualParts: Array<
        | { type: "text"; text: string }
        | {
            type: "image_url"
            image_url: { url: string; detail: "high" }
          }
      > = []
      for (const call of message.tool_calls) {
        calls++
        // Preserve the actual request. Replacing malformed arguments with
        // {source:""} concealed precisely the contract failures being measured.
        const source = call.function.arguments || "{}"
        const callStarted = performance.now()
        let result: z.infer<typeof toolResultSchema>
        try {
          const args = z.record(z.string(), z.json()).parse(JSON.parse(source))
          result = await surface.call(call.function.name, args)
        } catch (failure) {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: String(
                  failure instanceof Error ? failure.message : failure
                ),
              },
            ],
          }
        }
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
          imageBytes: result.content.reduce(
            (total, block) =>
              total +
              (block.type === "image"
                ? Math.floor((block.data?.length ?? 0) * 0.75)
                : 0),
            0
          ),
          images: result.content.filter((block) => block.type === "image")
            .length,
          isError: result.isError === true,
          source: source.slice(0, 400),
          tool: call.function.name,
          arguments: source,
        }
        if (record.isError) record.error = text.slice(0, 300)
        toolLog.push(record)
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: text || "(no text)",
        })
        for (const block of images ? result.content : []) {
          if (block.type !== "image" || !block.data) continue
          if (visualParts.length === 0)
            visualParts.push({
              type: "text",
              text: "Visual evidence returned by the computer-control tool:",
            })
          visualParts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.mimeType ?? "image/png"};base64,${block.data}`,
              detail: "high",
            },
          })
        }
      }
      if (visualParts.length > 0)
        messages.push({ role: "user", content: visualParts })
    }
    if (turns >= maxTurns && !reply) error = `no reply within ${maxTurns} turns`
  } catch (failure) {
    error = String(failure instanceof Error ? failure.message : failure).slice(
      0,
      300
    )
  }
  const wallMs = Math.round(performance.now() - started)
  const seen = await sampler.stop()
  const frontmostSeen = [...seen.keys()]
  const driverPid = cuaEmbeddedPid()
  const forbiddenFront = new Set(
    [task.target.pid, driverPid].filter(
      (pid): pid is number => pid !== undefined && pid !== baseline
    )
  )
  const oracle = error
    ? { success: false, evidence: { skipped: "agent failed" } }
    : await task.check(reply)
  const success = !error && oracle.success
  const sum = (pick: (turn: TurnRecord) => number) =>
    perTurn.reduce((total, turn) => total + pick(turn), 0)
  const row: Row = {
    model: model.name,
    transport,
    surface: surfaceMode,
    images,
    task: task.id,
    run,
    success,
    frontKept: frontmostSeen.every((pid) => !forbiddenFront.has(pid)),
    userSwitched: frontmostSeen.filter(
      (pid) => pid !== baseline && !forbiddenFront.has(pid)
    ),
    frontmostSeen,
    wallMs,
    modelMs,
    turns,
    calls,
    promptTokens: sum((turn) => turn.prompt),
    cachedTokens: sum((turn) => turn.cached),
    completionTokens: sum((turn) => turn.completion),
    maxTurnPrompt: perTurn.reduce(
      (most, turn) => Math.max(most, turn.prompt),
      0
    ),
    perTurn,
    toolLog,
    oracle: oracle.evidence,
    reply: reply.slice(0, 400),
  }
  if (error) row.error = error
  return row
}

// ── fixture tasks ────────────────────────────────────────────────────────

/**
 * Four tasks on an Electron window behind the user's: read the field
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
  const visualProof = `VISUAL-${randomUUID().slice(0, 8).toUpperCase()}`
  const fixture = await startElectronFixture({
    root,
    name: "bench-fixture",
    title: "Mako control fixture",
    initial,
    visual: visualProof,
  })
  const status = z
    .object({ pid: z.number(), input: z.string(), value: z.string() })
    .loose()
  const started = status.parse(await fixture.started())
  const windowsSchema = z.array(
    z
      .object({
        window_id: z.number(),
        title: z.string().optional(),
        kind: z.string().optional(),
      })
      .loose()
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
      `state.target = ${JSON.stringify(target)};
       const lines = await view(state.target);
       const field = lines.find(l => /TextField "Proof"/.test(l));
       if (!field) throw new Error('no Proof field: ' + lines.join(' | '));
       return await fill(field.split(' ')[0], ${JSON.stringify(initial)})`
    )
    if (result.isError)
      throw new Error(
        `fixture reset failed: ${JSON.stringify(returned(result))}`
      )
    await fixture.until(
      async () => status.parse(await fixture.state()).input === initial,
      "fixture reset to its initial text"
    )
  }
  const fieldIs = async (expected: string, output?: string) => {
    try {
      await fixture.until(
        async () => {
          const state = status.parse(await fixture.state())
          return (
            state.input === expected &&
            (output === undefined || state.value === output)
          )
        },
        "fixture shows the task's result",
        3000
      )
      return true
    } catch {
      return false
    }
  }
  // A write task carries a per-attempt value so a stale result never passes.
  const writeTask = (
    id: string,
    prefix: string,
    instruction: (text: string) => string,
    replyCheck: (reply: string, expected: string) => boolean
  ): Attempt => {
    let expected = ""
    return {
      id,
      target,
      prompt: () => `${where} ${instruction(expected)}`,
      reset: async () => {
        expected = `${prefix}-${randomUUID().slice(0, 8)}`
        await reset()
      },
      check: async (reply) => {
        const state = await fieldIs(expected, expected)
        const replyMatched = replyCheck(reply, expected)
        return {
          success: state && replyMatched,
          evidence: { expected, replyMatched, state },
        }
      },
    }
  }
  const tasks: Attempt[] = [
    {
      id: "fixture-read",
      target,
      prompt: () =>
        `${where} Without clicking anything, tell me the exact current text of its Proof field on the last line of your reply.`,
      reset,
      check: async (reply) => {
        const state = await fieldIs(initial)
        return {
          success: state && reply.includes(initial),
          evidence: { expected: initial, state },
        }
      },
    },
    writeTask(
      "fixture-fill",
      "fill",
      (text) =>
        `Put exactly the text "${text}" into its Proof field (replacing whatever is there) and press its "Verify proof" button. Reply "done" when the result shows the text.`,
      (reply) => /\bdone\b/i.test(reply)
    ),
    writeTask(
      "fixture-replace",
      "replaced",
      (text) =>
        `Its Proof field already has text. Replace that text with exactly "${text}" and press "Verify proof", then reply with the text the result line shows.`,
      (reply, expected) => reply.includes(expected)
    ),
    {
      id: "fixture-visual",
      target,
      prompt: () =>
        `${where} Do not click anything. The bordered card near the bottom is painted pixels and is absent from accessibility text. Read its exact code and reply with only that code.`,
      reset,
      check: async (reply) => {
        const state = await fieldIs(initial)
        return {
          success: state && reply.includes(visualProof),
          evidence: {
            expected: visualProof,
            replyMatched: reply.includes(visualProof),
            state,
          },
        }
      },
    },
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

async function applicationTasks(
  file: TaskFile,
  surface: Surface
): Promise<Attempt[]> {
  const pid = await pidForBundle(file.target.bundle_id)
  const windows = z
    .array(
      z
        .object({
          window_id: z.number(),
          title: z.string().optional(),
          kind: z.string().optional(),
        })
        .loose()
    )
    .parse(returned(await surface.exec(`return await windows(${pid})`)))
  const wanted = file.target.window_title
    ? new RegExp(file.target.window_title)
    : undefined
  // windows() lists the on-screen titled documents first, largest first.
  const document = windows.find(
    (row) => !wanted || wanted.test(row.title ?? "")
  )
  if (!document)
    throw new Error(
      `${file.target.bundle_id} has no matching window among ${JSON.stringify(windows)}`
    )
  const target = { pid, window_id: document.window_id }
  const behind = file.behind ?? null
  return file.tasks.map((task) => ({
    id: task.id,
    target,
    prompt: () =>
      task.prompt
        .replaceAll("{pid}", String(pid))
        .replaceAll("{window_id}", String(document.window_id)),
    reset: async () => {
      if (behind) {
        await runCommand(
          "osascript",
          ["-e", `tell application id ${JSON.stringify(behind)} to activate`],
          { timeout: 5000 }
        )
        await new Promise((resolveWait) => setTimeout(resolveWait, 700))
      }
      if (task.reset) {
        const result = await surface.exec(
          `state.target = ${JSON.stringify(target)}; ${task.reset}`
        )
        if (result.isError)
          throw new Error(
            `reset for ${task.id} failed: ${JSON.stringify(returned(result))}`
          )
      }
    },
    check: async (reply) => {
      let expectation = task.expect
      let state = true
      let evidence: JsonValue = { source: "static expectation" }
      if (task.oracle) {
        const result = await surface.exec(
          `state.target = ${JSON.stringify(target)}; ${task.oracle}`
        )
        if (result.isError)
          return {
            success: false,
            evidence: {
              oracle_error: JSON.stringify(returned(result)).slice(0, 500),
            },
          }
        const checked = oracleResultSchema.parse(returned(result))
        state = checked.state
        expectation = checked.expect ?? expectation
        evidence = checked.evidence ?? { source: "live oracle" }
      }
      const replyMatched =
        expectation !== undefined && replySatisfies(reply, expectation)
      return {
        success: state && replyMatched,
        evidence: { state, replyMatched, detail: evidence },
      }
    },
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
  const audit = {
    jsonObjectArrays: {
      pages: { includes: ["General", "Account"] },
      observations: { minItems: 2 },
    },
  }
  if (
    !replySatisfies(
      'Audit:\n```json\n{"pages":["Account","General"],"observations":["a","b"]}\n```',
      audit
    )
  )
    throw new Error("jsonObjectArrays should read a final fenced object")
  if (replySatisfies('{"pages":["General"],"observations":["one"]}', audit))
    throw new Error("jsonObjectArrays should enforce members and minimums")
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
  await writeFile(out, "")
  const surface = await openSurface(root, options.transport, options.surface)
  const administration =
    options.surface === "legacy"
      ? surface
      : await openSurface(root, options.transport, "legacy")
  await administration.exec(
    "await computer.start_session({capture_scope: 'window'}); return 1"
  )
  let stopFixture = () => {}
  try {
    const attempts: Attempt[] = []
    const wantsFixture =
      !options.only || [...options.only].some((id) => id.startsWith("fixture-"))
    if (wantsFixture) {
      const fixture = await fixtureTasks(root, administration)
      stopFixture = fixture.stop
      attempts.push(...fixture.tasks)
    }
    if (taskFile)
      attempts.push(...(await applicationTasks(taskFile, administration)))
    const selected = attempts.filter(
      (task) => !options.only || options.only.has(task.id)
    )
    if (!selected.length) throw new Error("no task selected")
    console.log(
      `Model ${model.name}; surface ${options.surface}; transport ${options.transport}; images ${options.images ? "forwarded" : "withheld"}; ${selected.length} task(s) × ${options.runs} run(s); tool description ${Buffer.byteLength(JSON.stringify(surface.tools))} bytes, instructions ${Buffer.byteLength(surface.instructions)} bytes; rows → ${out}`
    )
    const rows: Row[] = []
    for (const task of selected) {
      for (let run = 1; run <= options.runs; run++) {
        const row = await attempt(
          surface,
          model,
          task,
          run,
          options.maxTurns,
          options.images,
          options.transport,
          options.surface
        )
        rows.push(row)
        await appendFile(out, `${JSON.stringify(row)}\n`)
        console.log(
          `${task.id.padEnd(16)} #${run} ${row.success ? "PASS" : "FAIL"} front:${row.frontKept ? "kept" : `FRONTED ${row.frontmostSeen.join(",")}`}${row.userSwitched.length ? ` (user switched to ${row.userSwitched.join(",")})` : ""} wall=${(row.wallMs / 1000).toFixed(1)}s model=${(row.modelMs / 1000).toFixed(1)}s turns=${row.turns} calls=${row.calls} prompt=${row.promptTokens} (cached ${row.cachedTokens}, max/turn ${row.maxTurnPrompt}) out=${row.completionTokens}${row.error ? ` ERR ${row.error}` : ""}`
        )
      }
    }
    console.log(`\n${summarize(rows)}`)
    console.log(
      `\nRows: ${out}\nArtifacts: ${process.env.MAKO_CONTROL_ARTIFACTS}`
    )
  } finally {
    stopFixture()
    if (administration !== surface) await administration.close()
    await surface.close()
    stopCuaEmbedded()
  }
}
