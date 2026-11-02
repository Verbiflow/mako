import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

/**
 * The cases of `eval:orch-tools`, in T3 Code's MCP tool-use schema rewritten
 * for Mako's `agents_*`: one fake Thread per line of `cases.ndjson`, each
 * graded on what the agent called, what its shell ran and what it said. Tool
 * names are bare (`agents_start`); `native_spawn` is the harness's own spawn
 * tool, whatever it's called there.
 */

/** A call a case expects or forbids: the tool, and argument values matched as regexes (strings) or exactly. */
const ExpectedCall = z.object({ tool: z.string(), args: z.record(z.string(), z.json()).optional() })
export type ExpectedCall = z.infer<typeof ExpectedCall>

const PriorTurn = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  toolCalls: z.array(z.object({ tool: z.string(), input: z.json(), result: z.json() })).optional(),
})

export const AREAS = ["route", "stay-native", "dont-spawn", "no-polling", "headless-shell", "place", "native-child"] as const

/** The budget each area counts toward, per harness and model: route ≥ 90%, don't spawn ≥ 95%, no polling ≥ 95%, stay native ≥ 85%. */
export const BUDGET = {
  route: { areas: ["route", "headless-shell", "place"], floor: 0.9 },
  "don't spawn": { areas: ["dont-spawn", "native-child"], floor: 0.95 },
  "no polling": { areas: ["no-polling"], floor: 0.95 },
  "stay native": { areas: ["stay-native"], floor: 0.85 },
} as const satisfies Record<string, { areas: readonly (typeof AREAS)[number][]; floor: number }>

export const OrchCase = z.object({
  id: z.string(),
  area: z.enum(AREAS),
  /** `bad` reproduces a mistake, `guard` protects what's right, `control` is ordinary work. */
  kind: z.enum(["bad", "guard", "control"]),
  pattern: z.string(),
  /** The real mistake, in a sentence. */
  experience: z.string(),
  setup: z.object({
    /** `top`: the person's own Thread; `lead`: one with children; `delegated-child`: one another Thread started; `native-subagent`: a harness's own child. */
    role: z.enum(["top", "lead", "delegated-child", "native-subagent"]),
    /** Only on these harnesses, for cases whose right answer depends on what the harness can do. */
    harness: z.array(z.string()).optional(),
    priorTurns: z.array(PriorTurn).optional(),
    /** Facts the shell's answers keep to. */
    world: z.record(z.string(), z.json()).optional(),
    /** Regexes on a shell command, answered with `output` instead of the default. */
    shellMocks: z.array(z.object({ match: z.string(), output: z.string() })).optional(),
  }),
  prompt: z.string(),
  expect: z.object({
    /** Each needs a matching call. */
    calls: z.array(ExpectedCall).optional(),
    /** No call may match any. */
    callsMustNot: z.array(ExpectedCall).optional(),
    /** None of these tools is called. */
    notCalls: z.array(z.string()).optional(),
    minCalls: z.record(z.string(), z.number()).optional(),
    maxCalls: z.record(z.string(), z.number()).optional(),
    /** The last step with calls includes this tool, and the turn ends there. */
    endsTurnAfter: z.string().optional(),
    /** Regexes no shell command may match. */
    shellMustNot: z.array(z.string()).optional(),
    /** Regexes on the agent's text; a leading `(?i)` makes one case-insensitive. */
    textMust: z.array(z.string()).optional(),
    textMustNot: z.array(z.string()).optional(),
  }),
  source: z.record(z.string(), z.json()).optional(),
})
export type OrchCase = z.infer<typeof OrchCase>

export const CASES_FILE = join(import.meta.dirname, "cases.ndjson")

export function loadCases(file = CASES_FILE): OrchCase[] {
  const cases = readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    const parsed = OrchCase.safeParse(JSON.parse(line))
    if (!parsed.success) throw new Error(`${file}:${index + 1}: ${parsed.error.message}`)
    return parsed.data
  })
  const ids = new Set<string>()
  for (const { id } of cases) {
    if (ids.has(id)) throw new Error(`${file}: case ${id} twice`)
    ids.add(id)
  }
  return cases
}

/** Whether a case runs on `harness`. */
export const runsOn = (orchCase: OrchCase, harness: string) => !orchCase.setup.harness || orchCase.setup.harness.includes(harness)

/** A call's arguments as the model sent them; anything but an object reads as none. */
export const ToolArgs = z.record(z.string(), z.json()).catch({})
export type ToolArgs = z.infer<typeof ToolArgs>

/** A call by bare name. */
export interface Call {
  tool: string
  args: ToolArgs
}

/** What one sample did, as the runners read it: every call by bare name, in steps, its shell commands, its text. */
export interface Sample {
  /** The calls of each model step that made any, in order. */
  steps: Call[][]
  shell: string[]
  text: string
  /** The turn ended (the model stopped calling tools) rather than running out of steps. */
  ended: boolean
}

function pattern(source: string): RegExp {
  return source.startsWith("(?i)") ? new RegExp(source.slice(4), "i") : new RegExp(source)
}

const Text = z.string()

function matches(call: Call, expected: ExpectedCall): boolean {
  if (call.tool !== expected.tool) return false
  return Object.entries(expected.args ?? {}).every(([key, want]) => {
    const value = call.args[key]
    const regex = Text.safeParse(want)
    if (!regex.success) return JSON.stringify(value) === JSON.stringify(want)
    if (value === undefined) return false
    const text = Text.safeParse(value)
    return pattern(regex.data).test(text.success ? text.data : JSON.stringify(value))
  })
}

/** Every check a case makes on one sample, by name, with what failed; none is a pass. */
export function grade(orchCase: OrchCase, sample: Sample): string[] {
  const { expect } = orchCase
  const calls = sample.steps.flat()
  const count = (tool: string) => calls.filter((call) => call.tool === tool).length
  const failures: string[] = []
  for (const expected of expect.calls ?? [])
    if (!calls.some((call) => matches(call, expected))) failures.push(`calls ${expected.tool}${expected.args ? ` ${JSON.stringify(expected.args)}` : ""}`)
  for (const forbidden of expect.callsMustNot ?? [])
    if (calls.some((call) => matches(call, forbidden))) failures.push(`callsMustNot ${forbidden.tool} ${JSON.stringify(forbidden.args ?? {})}`)
  for (const tool of expect.notCalls ?? []) if (count(tool)) failures.push(`notCalls ${tool}`)
  for (const [tool, least] of Object.entries(expect.minCalls ?? {})) if (count(tool) < least) failures.push(`minCalls ${tool} ${count(tool)} < ${least}`)
  for (const [tool, most] of Object.entries(expect.maxCalls ?? {})) if (count(tool) > most) failures.push(`maxCalls ${tool} ${count(tool)} > ${most}`)
  if (expect.endsTurnAfter) {
    const last = sample.steps.at(-1) ?? []
    if (!sample.ended || !last.some((call) => call.tool === expect.endsTurnAfter)) failures.push(`endsTurnAfter ${expect.endsTurnAfter}`)
  }
  for (const source of expect.shellMustNot ?? []) {
    const command = sample.shell.find((line) => pattern(source).test(line))
    if (command !== undefined) failures.push(`shellMustNot ${source}: ${command.slice(0, 120)}`)
  }
  for (const source of expect.textMust ?? []) if (!pattern(source).test(sample.text)) failures.push(`textMust ${source}`)
  for (const source of expect.textMustNot ?? []) if (pattern(source).test(sample.text)) failures.push(`textMustNot ${source}`)
  return failures
}

/** One case's verdict from its samples: two, and a third when they disagree. */
export function needsThird(passes: boolean[]): boolean {
  return passes.length === 2 && passes[0] !== passes[1]
}

export interface CaseResult {
  id: string
  area: OrchCase["area"]
  kind: OrchCase["kind"]
  harness: string
  model: string
  routing: "on" | "off"
  passes: boolean[]
  failures: string[][]
  seconds: number
  tokens: { input: number; output: number }
  usd?: number
  error?: string
  /** What each sample did, for reading a failure back. */
  samples?: Sample[]
}

/** Each budget line's pass rate over a run's results, with the floor; a case passes on most of its samples. */
export function budget(results: readonly CaseResult[]) {
  return Object.entries(BUDGET).map(([line, { areas, floor }]) => {
    const counted = results.filter((result) => !result.error && areas.some((area) => area === result.area))
    const passed = counted.filter((result) => result.passes.filter(Boolean).length * 2 > result.passes.length).length
    const rate = counted.length ? passed / counted.length : undefined
    return { line, floor, passed, of: counted.length, rate, met: rate === undefined || rate >= floor }
  })
}

/** What a baseline's `results.jsonl` line says of a case: enough to tell which passed every sample. */
export const BaselineResult = z.object({ id: z.string(), harness: z.string(), model: z.string(), routing: z.enum(["on", "off"]), passes: z.array(z.boolean()), error: z.string().optional() })
export type BaselineResult = z.infer<typeof BaselineResult>

/** Cases that passed every baseline sample and fail now (T3's rule: none allowed). */
export function regressions(baseline: readonly BaselineResult[], results: readonly CaseResult[]): string[] {
  const perfect = new Set(baseline.filter((result) => !result.error && result.passes.length && result.passes.every(Boolean)).map((result) => `${result.harness}:${result.model}:${result.routing}:${result.id}`))
  return results.filter((result) => perfect.has(`${result.harness}:${result.model}:${result.routing}:${result.id}`) && !result.passes.every(Boolean)).map((result) => `${result.harness} ${result.model} routing ${result.routing}: ${result.id}`)
}
