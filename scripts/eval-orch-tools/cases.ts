import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { frontDoorNote, type AgentsApexes, type FrontDoorChild } from "@mako/host/contracts/agent-tools"
import { finPolicyNote } from "@mako/host/contracts/fin-tuning"
import type { Report } from "@mako/host/contracts/agents"
import { apexAsk } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { controlLine, controlNote } from "@mako/host/control/launch"
import type { CallThread } from "@mako/host/contracts/native-calls"
import { AppKeySchema, type ThreadEnvironment } from "@mako/host/contracts/thread-environments"
import { threadEnvironmentInstructions } from "@mako/host/workspaces/thread-environment"
import { digest } from "@mako/host/conversations/agent-wakes"
import { briefText } from "@mako/host/contracts/children"
import { namedUuid } from "@mako/host/conversations/cloud-moves"

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

export const AREAS = ["route", "stay-native", "dont-spawn", "no-polling", "headless-shell", "place", "native-child", "front-door", "answer", "deliver", "worktree", "pull-request", "app", "browser", "move", "report"] as const

/** The budget each area counts toward, per harness and model: route (moving the Thread itself too) ≥ 90%, front door and answering ≥ 90%, don't spawn ≥ 95%, no polling ≥ 95%, stay native ≥ 85%, Mako's own tools for worktrees, pull requests, the app and the browser ≥ 90%, a Fin's report saying how it went and who must act ≥ 90%. */
export const BUDGET = {
  route: { areas: ["route", "headless-shell", "place", "move"], floor: 0.9 },
  "front door": { areas: ["front-door", "answer", "deliver"], floor: 0.9 },
  "don't spawn": { areas: ["dont-spawn", "native-child"], floor: 0.95 },
  "no polling": { areas: ["no-polling"], floor: 0.95 },
  "stay native": { areas: ["stay-native"], floor: 0.85 },
  "mako tools": { areas: ["worktree", "pull-request", "app", "browser"], floor: 0.9 },
  reports: { areas: ["report"], floor: 0.9 },
} as const satisfies Record<string, { areas: readonly (typeof AREAS)[number][]; floor: number }>

/** One of an Apex's Fins, in minutes ago rather than clock times, so a case reads the same on any day. */
const EvalChild = z.object({
  name: z.string(),
  harness: z.string(),
  state: z.enum(["working", "idle", "blocked", "done", "failed", "stopped"]),
  /** Its phase while it works, its question while it waits, its reason once ended. */
  line: z.string().optional(),
  topic: z.string(),
  branch: z.string().optional(),
  report: z.object({ status: z.enum(["progress", "blocked", "done", "failed"]), line: z.string(), minutesAgo: z.number() }).optional(),
  direct: z.object({ line: z.string(), minutesAgo: z.number() }).optional(),
})
type EvalChild = z.infer<typeof EvalChild>

/** A Fin's ask that wakes its Apex: its harness's approval or question, or a question in its report with options. */
const EvalAsk = z.object({
  name: z.string(),
  kind: z.enum(["approval", "question", "report"]),
  line: z.string(),
  options: z.array(z.string()).optional(),
  recommended: z.number().int().nonnegative().optional(),
})
type EvalAsk = z.infer<typeof EvalAsk>

/** A Fin's report that it finished, as `agents_report` takes one. */
const EvalFinished = z.object({
  name: z.string(),
  status: z.enum(["done", "failed"]),
  summary: z.string(),
  artifacts: z.array(z.object({ kind: z.enum(["branch", "commit", "pull-request", "file", "screenshot", "test-run", "link"]), ref: z.string(), label: z.string().optional() })).optional(),
})

/** Another of the person's Apexes, as `agents_list` with `scope: apexes` answers it (`OtherApex`), less its Thread. */
const EvalApex = z.object({
  title: z.string(),
  harness: z.string(),
  working: z.boolean(),
  step: z.string().optional(),
  folder: z.string().optional(),
  branch: z.string().optional(),
  fins: z.object({ needs: z.number(), working: z.number(), queued: z.number(), idle: z.number().default(0), failed: z.number(), done: z.number() }),
  digest: z.object({ fins: z.array(z.object({ name: z.string(), line: z.string() })), more: z.number().optional(), said: z.string().optional() }),
})

export const OrchCase = z.object({
  id: z.string(),
  area: z.enum(AREAS),
  /** `bad` reproduces a mistake, `guard` protects what's right, `control` is ordinary work. */
  kind: z.enum(["bad", "guard", "control"]),
  pattern: z.string(),
  /** The real mistake, in a sentence. */
  experience: z.string(),
  setup: z.object({
    /** `top`: the person's own Thread; `apex`: one with Fins; `fin`: one another Thread started; `native-subagent`: a harness's own child. */
    role: z.enum(["top", "apex", "fin", "native-subagent"]),
    /** Only on these harnesses, for cases whose right answer depends on what the harness can do. */
    harness: z.array(z.string()).optional(),
    priorTurns: z.array(PriorTurn).optional(),
    /** Facts the shell's answers keep to. */
    world: z.record(z.string(), z.json()).optional(),
    /** The person's rules for Fins, each "<their words> → <where it goes>", as the note ahead of their message lists them (`finPolicyNote`). */
    rules: z.array(z.object({ when: z.string(), to: z.string() })).optional(),
    /** Where work no rule fits goes, in the note's words. */
    otherwise: z.string().optional(),
    /** Regexes on a shell command, answered with `output` instead of the default. */
    shellMocks: z.array(z.object({ match: z.string(), output: z.string() })).optional(),
    /** An Apex's Fins as they stand: the front-door note the host sends ahead of the person's message (`frontDoorNote`). */
    children: z.array(EvalChild).optional(),
    /** Asks of those Fins that wake the Apex: the case's agent reads the wake the host sends, after the person's message (`prompt`) as an earlier turn. */
    asks: z.array(EvalAsk).optional(),
    /** Where the Thread works and its project's recipe: the note ahead of the prompt says so as the host does (`threadEnvironmentInstructions`), and routing reads it (`CallThread`). */
    /** What the stub answers a Mako tool in this case, where its default (`FAMILY_ANSWERS`) would contradict the prompt. */
    answers: z.record(z.string(), z.string()).optional(),
    thread: z.object({
      place: z.enum(["main", "worktree"]),
      recipe: z.enum(["ready", "none"]),
      processes: z.array(z.string()).optional(),
    }).optional(),
    /** Reports of those Fins that finished, waking the Apex the same way. */
    finished: z.array(EvalFinished).optional(),
    /** The person's other Apexes, which the stub answers `agents_list` with `scope: apexes` with. */
    apexes: z.array(EvalApex).optional(),
  }),
  prompt: z.string(),
  expect: z.object({
    /** Each needs a matching call. */
    calls: z.array(ExpectedCall).optional(),
    /** No call may match any. */
    callsMustNot: z.array(ExpectedCall).optional(),
    /** At least one call matches one of these. */
    callsAny: z.array(ExpectedCall).optional(),
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
/** How a message reaches a working Fin (`agents_send`'s `deliver`): its own file, read after `CASES_FILE`. */
export const DELIVER_CASES_FILE = join(import.meta.dirname, "cases-deliver.ndjson")
/** Moving the Thread itself between this Mac and the cloud (`thread_move`): its own file, read last. */
export const MOVE_CASES_FILE = join(import.meta.dirname, "cases-move.ndjson")
/** Native-route habits, graded with the primer off and on. */
export const PRIMER_CASES_FILE = join(import.meta.dirname, "cases-primer.ndjson")

export function loadCases(files = [CASES_FILE, DELIVER_CASES_FILE, MOVE_CASES_FILE, PRIMER_CASES_FILE]): OrchCase[] {
  const cases = files.flatMap((file) => readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    const parsed = OrchCase.safeParse(JSON.parse(line))
    if (!parsed.success) throw new Error(`${file}:${index + 1}: ${parsed.error.message}`)
    return parsed.data
  }))
  const ids = new Set<string>()
  for (const { id } of cases) {
    if (ids.has(id)) throw new Error(`case ${id} twice`)
    ids.add(id)
  }
  return cases
}

const NOW = Date.UTC(2026, 10, 1, 18)
/** A `fin` case's agent, as its brief names it. */
export const FIN_NAME = "rename"
const minutesAgo = (minutes: number) => NOW - minutes * 60_000

function frontDoorChild(child: EvalChild): FrontDoorChild {
  const state: FrontDoorChild["state"] =
    child.state === "working" ? { kind: "working", ...(child.line && { phase: child.line }) }
      : child.state === "idle" ? { kind: "idle" }
        : child.state === "blocked" ? { kind: "blocked", on: "person", question: child.line ?? "It asks a question." }
          : { kind: "ended", outcome: child.state, ...(child.line && { reason: child.line }) }
  return {
    name: child.name, harness: child.harness, state, topic: child.topic,
    ...(child.branch && { branch: child.branch }),
    ...(child.report && { report: { status: child.report.status, line: child.report.line, at: minutesAgo(child.report.minutesAgo) } }),
    ...(child.direct && { direct: { line: child.direct.line, at: minutesAgo(child.direct.minutesAgo) } }),
  }
}

/** What a case's agent reads ahead of the person's message: the note an Apex with these Fins hears, as the host writes it. */
export function frontDoorText(orchCase: OrchCase): string | undefined {
  const { rules, otherwise, children } = orchCase.setup
  // The note's targets are words already, so each rule's `to` stands for its target.
  const policy = rules?.length || otherwise ? finPolicyNote({ rules: (rules ?? []).map((rule, index) => ({ id: `r${index}`, when: rule.when, target: { harness: rule.to } })), ...(otherwise && { otherwise: { harness: otherwise } }) }, (target) => target.harness) : []
  const lines = [...policy, ...(children?.length ? frontDoorNote(children.map(frontDoorChild), NOW) : [])]
  return lines.length ? controlNote(lines) : undefined
}

/** A report's IDs, the same each time a case is read, so the wake the harness got and the one it's checked against are one text. */
const reportIds = (name: string) => ({ id: namedUuid(`eval:report:${name}`), child: ThreadIdSchema.parse(namedUuid(`eval:child:${name}`)) })

function askReport(ask: EvalAsk, child: EvalChild): Report {
  return {
    ...reportIds(child.name),
    status: ask.kind === "report" ? "needs-input" : "blocked",
    summary: ask.kind === "report" ? child.topic : `It waits: ${ask.line}`,
    question: ask.kind === "report" ? ask.line : apexAsk(ask.line, ask.kind === "approval"),
    ...(ask.options && { options: ask.options.map((label) => ({ label })) }),
    ...(ask.recommended !== undefined && { recommended: ask.recommended }),
    ownerGeneration: 1,
    at: NOW,
  }
}

/** The wake a case's asks and finished reports send its Apex, as the host writes it (`digest`). */
export function wakeText(orchCase: OrchCase): string | undefined {
  const { asks = [], finished = [], children = [] } = orchCase.setup
  if (!asks.length && !finished.length) return undefined
  const childOf = (name: string) => {
    const child = children.find((each) => each.name === name)
    if (!child) throw new Error(`${orchCase.id}: ${name} reports, but isn't one of its children`)
    return child
  }
  const notices = [
    ...asks.map((ask) => ({ child: childOf(ask.name), report: askReport(ask, childOf(ask.name)) })),
    ...finished.map((done) => ({ child: childOf(done.name), report: finishedReport(done) })),
  ].map(({ child, report }) => ({ id: randomUUID(), report, label: `"${child.name}" (${child.harness})`, fin: { name: child.name, harness: child.harness }, from: randomUUID() }))
  const tally = (states: readonly EvalChild["state"][]) => children.filter((child) => states.includes(child.state)).length
  return digest(notices, `${tally(["working"])} working, ${tally(["blocked"])} blocked, ${tally(["done", "failed", "stopped"])} ended.`)
}

function finishedReport(done: z.infer<typeof EvalFinished>): Report {
  return { ...reportIds(done.name), status: done.status, summary: done.summary, ...(done.artifacts && { artifacts: done.artifacts }), ownerGeneration: 1, at: NOW }
}

/** The case's Thread before the turn it grades: its earlier turns, and the person's message when its Fins' wake is the turn. */
export function priorTurns(orchCase: OrchCase): z.infer<typeof PriorTurn>[] {
  const prior = orchCase.setup.priorTurns ?? []
  return orchCase.setup.asks?.length || orchCase.setup.finished?.length ? [...prior, { role: "user", text: orchCase.prompt }] : prior
}

const NOTE_FOLDERS = { main: "/Users/person/app", worktree: "/Users/person/.mako/worktrees/app-1/thread-work" }

/** The case's Thread as the host's note describes it: its ports and folder, and its recipe. */
function caseEnvironment(thread: NonNullable<OrchCase["setup"]["thread"]>): ThreadEnvironment {
  return {
    app: AppKeySchema.parse("folder-0123456789abcdef"),
    host: "thread-work.thread.localhost",
    port: 20540,
    ports: 10,
    dataDir: "/Users/person/.mako/thread-data/thread-work",
    recipe: thread.recipe === "ready" ? { kind: "ready", processes: (thread.processes ?? ["web"]).map((name, index) => ({ name, port: 20540 + index })), checks: ["quick", "full"] } : { kind: "none" },
    ...thread.recipe === "ready" && { values: { PORT: "20540" } },
  }
}

/** The note the host sends ahead of the case's prompt, for a case that says where its Thread works. */
export function threadNote(orchCase: OrchCase): string | undefined {
  const thread = orchCase.setup.thread
  if (!thread) return undefined
  const control = controlLine({ bin: "/Applications/Mako.app/Contents/Resources", command: "/Applications/Mako.app/Contents/Resources/mako-control", sessionFile: "/tmp/mako-control-session" })
  return controlNote([control, threadEnvironmentInstructions(caseEnvironment(thread))])
}

/** The case's Thread as routing reads it, in the scratch `project` the sample runs in. */
export function caseCallThread(orchCase: OrchCase, project: string): CallThread {
  const thread = orchCase.setup.thread
  return {
    folder: project,
    ...thread?.place === "worktree" && { worktree: project, main: NOTE_FOLDERS.main },
    ...thread && { recipe: thread.recipe === "ready" ? { kind: "ready", processes: thread.processes ?? ["web"] } : { kind: "none" } },
    computer: true,
  }
}

/** What the graded turn opens with: a Fin's brief, the wake its Fins send, or the person's message behind the note an Apex's Fins send ahead of it. */
export function turnText(orchCase: OrchCase): string {
  if (orchCase.setup.role === "fin") return briefText({ objective: orchCase.prompt }, FIN_NAME)
  const wake = wakeText(orchCase)
  if (wake) return wake
  const note = [threadNote(orchCase), frontDoorText(orchCase)].filter(Boolean).join("\n\n")
  return note ? `${note}\n\n${orchCase.prompt}` : orchCase.prompt
}

/** The other Apexes a case's stub lists, each under a Thread made from its title, so every sample reads the same. */
export function apexesAnswer(orchCase: OrchCase): AgentsApexes {
  return {
    apexes: (orchCase.setup.apexes ?? []).map((apex) => ({
      thread: namedUuid(`${orchCase.id}:${apex.title}`),
      ...apex,
      fins: { total: apex.fins.needs + apex.fins.working + apex.fins.queued + apex.fins.idle + apex.fins.failed + apex.fins.done, ...apex.fins },
    })),
  }
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
  /** The shell commands that ran: `shell` less those Mako's routing refused. */
  ran?: string[]
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
  if (expect.callsAny && !calls.some((call) => expect.callsAny!.some((expected) => matches(call, expected))))
    failures.push(`callsAny ${expect.callsAny.map((expected) => expected.tool).join(" | ")}`)
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
    const command = (sample.ran ?? sample.shell).find((line) => pattern(source).test(line))
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
  /** Whether the primer was in the launch. Absent on a result from before the switch: read as on. */
  primer?: "on" | "off"
  /** Claude serving `mako` over HTTP. Absent means the in-process server. */
  mako?: "http"
  /** Samples that didn't settle, left out of `passes`. */
  errored?: string[]
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
export const BaselineResult = z.object({ id: z.string(), harness: z.string(), model: z.string(), routing: z.enum(["on", "off"]), primer: z.enum(["on", "off"]).optional(), mako: z.literal("http").optional(), passes: z.array(z.boolean()), error: z.string().optional() })
export type BaselineResult = z.infer<typeof BaselineResult>

const armKey = (result: { harness: string; model: string; routing: string; id: string; primer?: string; mako?: string }) =>
  `${result.harness}:${result.model}:${result.routing}:${result.id}${result.primer === "off" ? ":primer-off" : ""}${result.mako === "http" ? ":mako-http" : ""}`

/** Cases that passed every baseline sample and fail now (T3's rule: none allowed). */
export function regressions(baseline: readonly BaselineResult[], results: readonly CaseResult[]): string[] {
  const perfect = new Set(baseline.filter((result) => !result.error && result.passes.length && result.passes.every(Boolean)).map(armKey))
  return results.filter((result) => perfect.has(armKey(result)) && !result.passes.every(Boolean)).map((result) => `${result.harness} ${result.model} routing ${result.routing}${result.primer === "off" ? " primer off" : ""}${result.mako === "http" ? " mako http" : ""}: ${result.id}`)
}
