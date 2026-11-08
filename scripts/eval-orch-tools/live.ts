import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { admitted } from "../fixtures/admitted-start.ts"
import { routeShellCall } from "@mako/host/contracts/native-calls"
import { primerText } from "@mako/host/contracts/primer"
import { apexesAnswer, caseCallThread, priorTurns, ToolArgs, turnText, type OrchCase, type Sample } from "./cases.ts"
import { bareName, isShell, makoTool, shellCommand } from "./names.ts"
import type { StubMako } from "./stub-mako.ts"

/**
 * One sample on a real harness: Mako's own driver (sealed, so it runs on the
 * scratch home's sign-in alone), the `mako` stub as its conversation server,
 * and the case's Thread as the prompt, in a scratch project. No agent the
 * agent asks for starts: each harness is in its asking mode, a request that
 * names an agent CLI or `nohup` is refused (and kept for grading) and the
 * rest approved, and the other agent CLIs are stubs first on `PATH` that
 * print and exit. Cursor has no asking mode; the stubs are what stands
 * between it and a real run.
 */

const execFileAsync = promisify(execFile)

/** The harnesses whose driver routes each shell call (`NativeCallsCapability` per-call): a command routing denies there never ran. */
const ROUTED_CALLS = new Set(["claude", "cursor", "grok", "devin", "codex", "opencode"])

/** Each harness's mode that asks before a command runs; Cursor has only full access. */
export const ASKING_MODE = new Map([["claude", "default"], ["codex", "access:ask"], ["opencode", "access:ask"], ["grok", "access:ask"], ["devin", "accept-edits"]])
const AGENT_CLIS = ["claude", "codex", "cursor-agent", "grok", "opencode", "devin", "nohup"]
const AGENT_CLI = new RegExp(`(^|[\\s;&|(\`'"/])(${AGENT_CLIS.join("|")})\\b`)

/**
 * The folder of stubs that stand in for every agent CLI a command could
 * start, but `harness`'s own: its driver launches it from `PATH`, and its
 * asking mode is what refuses a command that would.
 */
export async function agentCliStubs(root: string, harness: string): Promise<string> {
  const bin = join(root, `stub-bin-${harness}`)
  await mkdir(bin, { recursive: true })
  for (const cli of AGENT_CLIS.filter((name) => name !== harness)) {
    const file = join(bin, cli)
    await writeFile(file, `#!/bin/sh\necho "${cli}: not run in the eval"\n`)
    await chmod(file, 0o755)
  }
  return bin
}

const updates = (events: readonly LiveDriverEvent[]) => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])

/** A tool update's input as arguments: its JSON, or a command given as plain text. */
function toolArgs(input: string): ToolArgs {
  try {
    return ToolArgs.parse(JSON.parse(input))
  } catch {
    return { command: input }
  }
}

/** The case's Thread as one prompt. A harness with no instruction slot gets the blocks ahead of the message, as the host's note does. */
function prompt(orchCase: OrchCase, primer: boolean, note: boolean): string {
  const prior = priorTurns(orchCase).map((turn) => `${turn.role === "user" ? "The person" : "You"}: ${turn.text}${turn.toolCalls?.length ? ` [${turn.toolCalls.map((call) => `${call.tool} → ${JSON.stringify(call.result)}`).join("; ")}]` : ""}`)
  const asked = turnText(orchCase)
  const body = prior.length ? `Earlier in this Thread:\n${prior.join("\n")}\n\n${asked}` : asked
  if (!primer || !note) return body
  const blocks = primerText({ role: orchCase.setup.role === "apex" ? "apex" : "thread", noRecipe: orchCase.setup.thread?.recipe === "none", computer: true })
  return `${blocks}\n\n${body}`
}

export async function liveSample(input: {
  harness: string; driver: ProviderLiveDriver; stub: StubMako; orchCase: OrchCase; routing: "on" | "off"
  /** Off is the launch before the primer: the show line only, over HTTP, with no `fin` agent. */
  primer?: boolean
  /** Claude: `false` serves `mako` over HTTP. */
  inProcessMako?: boolean
  env: NodeJS.ProcessEnv; project: string; model?: string
  /** How long a turn may run before the sample counts as an error: 180 s unless the run says (`--turn-seconds`). */
  turnSeconds?: number
}): Promise<Sample & { seconds: number }> {
  const { harness, driver, stub, orchCase, routing, env, project } = input
  const primer = input.primer !== false
  const id = randomUUID()
  const events: LiveDriverEvent[] = []
  const refused: string[] = []
  let quiet = Date.now()
  const began = Date.now()
  const emit = (event: LiveDriverEvent) => {
    events.push(event)
    quiet = Date.now()
    if (event.type !== "live-permission") return
    const request = event.request
    const asked = `${request.title} ${request.detail ?? ""}`
    const refuse = AGENT_CLI.test(asked)
    const option = request.options.find((candidate) => (refuse ? /reject|deny|decline/i : /allow|approve|accept/i).test(`${candidate.kind ?? ""} ${candidate.optionId}`))
    if (refuse) refused.push(asked)
    // A refusal with no option to refuse by stays unanswered: the turn times out rather than run it.
    if (option) void Promise.resolve(driver.permission(id, request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
  }
  const status = () => events.findLast((event) => event.type === "live-session")?.session.status
  try {
    const mode = ASKING_MODE.get(harness)
    // The project's branch is the one the case's Thread works on: main in the main checkout, the Thread's own in its worktree.
    await execFileAsync("git", ["-C", project, "checkout", "-q", "-f", orchCase.setup.thread?.place === "main" ? "main" : "mako/thread-work"]).catch(() => undefined)
    const grant = stub.grant(id, apexesAnswer(orchCase))
    if (routing === "on") stub.routes(id, caseCallThread(orchCase, project))
    if (orchCase.setup.answers) stub.answers(id, orchCase.setup.answers)
    await driver.start(project, admitted(harness, {
      conversationId: id, emit, ...mode && { modeId: mode }, ...input.model && { tuning: { model: input.model } },
      conversationTools: grant, primer, ...input.inProcessMako === false && { inProcessMako: false },
      mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }),
      ...routing === "on" && { nativeRouting: () => ({ role: orchCase.setup.role === "apex" ? "apex" as const : "thread" as const }), nativeCalls: () => caseCallThread(orchCase, project) },
    }, { env }))
    await driver.prompt(id, prompt(orchCase, primer, !driver.makoInstructions), [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const seconds = input.turnSeconds ?? 180
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline && !(status() !== "running" && status() !== "starting" && Date.now() - quiet > 5000)) await delay(250)
    if (Date.now() >= deadline) throw new Error(`the turn didn't settle in ${seconds} s`)
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
  }
  // A turn its harness failed before the model did anything (a usage limit, a sign-in) grades nothing: it's an error, left out of every rate.
  const failed = events.findLast((event) => event.type === "live-session" && event.session.status === "failed")
  if (failed?.type === "live-session" && !updates(events).some((update) => update.kind === "tool" || update.kind === "text"))
    throw new Error(`the turn failed before the model acted: ${failed.session.error ?? "no reason given"}`)
  // A tool's later updates (its status, its output) repeat its id: the call is the last of them that names it.
  const named = new Map<string, { raw: string; args: ToolArgs }>()
  for (const update of updates(events)) if (update.kind === "tool" && update.name) named.set(update.id, { raw: update.name, args: update.input === undefined ? named.get(update.id)?.args ?? {} : toolArgs(update.input) })
  const tools = [...named.values()]
  const makoArgs = [...stub.calls(id)]
  const steps = tools.map(({ raw, args }) => {
    const tool = bareName(harness, raw)
    // Cursor names every MCP call `mcp`: the stub's calls, in order, say which.
    if (tool === "mcp" && makoArgs.length) return [makoArgs.shift()!]
    const recorded = makoTool(tool) ? makoArgs.findIndex((call) => call.tool === tool) : -1
    const known = recorded === -1 ? undefined : makoArgs.splice(recorded, 1)[0]
    return [{ tool, args: known?.args ?? args }]
  })
  // A call the stub answered that the transcript didn't name still counts.
  for (const call of makoArgs) steps.push([call])
  const texts = new Map<string, string>()
  for (const update of updates(events)) {
    if (update.kind !== "text") continue
    const key = update.id ?? ""
    texts.set(key, update.replace ? update.text : (texts.get(key) ?? "") + update.text)
  }
  const shell = [...tools.filter(({ raw }) => isShell(harness, raw)).map(({ args }) => shellCommand(args)), ...refused]
  const routes = routing === "on" && ROUTED_CALLS.has(harness)
  return {
    steps,
    shell,
    ran: routes ? shell.filter((command) => routeShellCall(caseCallThread(orchCase, project), { command, cwd: project }).kind !== "deny") : shell,
    text: [...texts.values()].join("\n"),
    ended: status() !== "failed",
    seconds: Math.round((Date.now() - began) / 1000),
  }
}
