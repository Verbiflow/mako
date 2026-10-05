import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  isTurnStart,
  liveToolFinished,
  type LiveBlock,
  type LiveUpdate,
} from "./contracts/live-content.js"
import {
  MAX_INTERRUPTED_CALLS,
  type Interruption,
  type InterruptedCall,
  type LiveRequest,
} from "./contracts/live-conversations.js"

/**
 * A turn cut short by a crash or a dropped connection leaves the agent
 * without part of its own work: calls that never returned, and calls that
 * returned after its last step, whose results it never read. Some harnesses
 * then label the cut-off calls "interrupted by the user" when the session
 * resumes. The host records what it saw of those calls when the turn ends,
 * and the next prompt, whoever sends it, carries the account once.
 */

/** Longest result saved for the agent to read; longer ones keep both ends. */
const MAX_SAVED_RESULT = 512 * 1024

/**
 * The order in which a running turn's steps and results reached the host.
 * The agent acts on every result that arrived before its latest step (a
 * reply, thinking, or a new call); one that arrived after it has not been
 * read. Blocks keep the order calls started in, not the order they
 * finished in, so this is kept as the updates arrive.
 */
export class TurnSteps {
  private clock = 0
  private lastStep = 0
  private readonly started = new Set<string>()
  private readonly returned = new Map<string, number>()

  observe(update: LiveUpdate): void {
    switch (update.kind) {
      case "text":
      case "thinking":
      case "proposed-plan":
        if (update.text) this.lastStep = ++this.clock
        return
      case "tool":
        if (!this.started.has(update.id)) {
          this.started.add(update.id)
          this.lastStep = ++this.clock
        }
        this.result(update.id, update.status, update.unfinished)
        return
      case "tool-update":
        if (update.status) this.result(update.id, update.status, update.unfinished)
        return
    }
  }

  /** Whether the call returned after the agent's latest step. */
  unseen(id: string): boolean {
    const at = this.returned.get(id)
    return at !== undefined && at > this.lastStep
  }

  private result(id: string, status: string, unfinished: true | undefined): void {
    if (unfinished || !liveToolFinished(status) || this.returned.has(id)) return
    this.returned.set(id, ++this.clock)
  }
}

/** The request's turn: its prompt's block onward, or the last turn when the prompt was never shown. */
function turnBlocks(blocks: readonly LiveBlock[], requestId: string): readonly LiveBlock[] {
  let start = blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
  if (start < 0) {
    start = blocks.length - 1
    while (start >= 0 && !isTurnStart(blocks[start])) start--
  }
  return blocks.slice(start + 1)
}

/**
 * Closes the calls still running in the request's turn. Nothing will report
 * on them now: the process running them is gone, or the host lost it.
 */
export function closeCutOffCalls(blocks: readonly LiveBlock[], requestId: string, note: string): LiveUpdate[] {
  return turnBlocks(blocks, requestId).flatMap((block) =>
    block.type === "tool" && !liveToolFinished(block.status)
      ? [{ kind: "tool-update" as const, id: block.id, status: "failed", output: note, unfinished: true as const }]
      : []
  )
}

/** What a row closed by `closeCutOffCalls` says, for the user reading the transcript. */
export function cutOffNote(interruption: Interruption, error: string | undefined): string {
  switch (interruption.reason) {
    case "host-quit":
      return "Mako quit while this call was running, so it never returned a result."
    case "host-crashed":
      return "Mako closed unexpectedly while this call was running, so it never returned a result."
    default:
      return `This call was still running when the turn was cut short, so it never returned a result${error ? `: ${error.replace(/[.\s]+$/, "")}.` : "."}`
  }
}

/**
 * What the agent has no account of in the request's turn. Unseen results
 * are written in full under `directory`; without `steps` (a host that died
 * mid-turn kept none) only the calls that never returned are known.
 */
export function recordCutOffCalls(
  blocks: readonly LiveBlock[],
  requestId: string,
  steps: TurnSteps | undefined,
  directory: string
): Pick<Interruption, "calls" | "moreCalls"> {
  const calls: InterruptedCall[] = []
  let more = 0
  for (const block of turnBlocks(blocks, requestId)) {
    if (block.type !== "tool") continue
    const result = block.unfinished || !liveToolFinished(block.status)
      ? "none"
      : steps?.unseen(block.id)
        ? "unseen"
        : undefined
    if (!result) continue
    if (calls.length === MAX_INTERRUPTED_CALLS) {
      more++
      continue
    }
    const call: InterruptedCall = { id: block.id, title: oneLine(block.title), result }
    if (result === "unseen") {
      const file = saveResult(directory, calls.length, block)
      if (file) call.file = file
    }
    calls.push(call)
  }
  return more ? { calls, moreCalls: more } : { calls }
}

function saveResult(directory: string, index: number, block: Extract<LiveBlock, { type: "tool" }>): string | undefined {
  const output = block.output ?? ""
  const kept = output.length > MAX_SAVED_RESULT
    ? `${output.slice(0, MAX_SAVED_RESULT / 2)}\n\n… ${output.length - MAX_SAVED_RESULT} characters left out …\n\n${output.slice(-MAX_SAVED_RESULT / 2)}`
    : output
  const file = join(directory, `${index + 1}.md`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(file, `# ${oneLine(block.title)}\n\nStatus: ${block.status}\n\n${kept || "(no output)"}\n`, { mode: 0o600 })
    return file
  } catch {
    return undefined
  }
}

function oneLine(title: string): string {
  const line = title.replace(/\s+/g, " ").trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function cause(reason: Interruption["reason"]): string {
  switch (reason) {
    case "provider-exited":
      return "your process stopped"
    case "connection-lost":
      return "the connection to your runtime dropped"
    case "signed-out":
      return "your sign-in expired"
    case "host-crashed":
      return "Mako closed unexpectedly"
    case "host-quit":
      return "Mako quit"
    case "stopped":
      return "the user stopped it"
  }
}

/**
 * The account the next prompt carries of the latest turn before `current`,
 * when that turn was cut short and the agent has not been told. Returns the
 * request it tells about, so the caller can mark it told.
 */
export function pendingInterruption(
  requests: readonly LiveRequest[],
  current: string,
  now = Date.now()
): { requestId: string; account: string } | undefined {
  const index = requests.findIndex((request) => request.id === current)
  const previous = requests
    .slice(0, index < 0 ? requests.length : index)
    .filter((request) => request.status !== "queued" && request.status !== "held" && request.status !== "canceled")
    .at(-1)
  const interruption = previous?.interruption
  if (!previous || !interruption?.calls || interruption.told || interruption.reason === "stopped") return undefined
  // A continuation already says the turn was cut short; with no calls to
  // report, the account would only repeat it.
  if (!interruption.calls.length && requests[index]?.continues?.requestId === previous.id) return undefined
  return { requestId: previous.id, account: interruptionAccount(previous, interruption, now) }
}

function interruptionAccount(request: LiveRequest, interruption: Interruption, now: number): string {
  const calls = interruption.calls ?? []
  const why = request.error?.replace(/[.\s]+$/, "") || cause(interruption.reason)
  const lines = [
    `Your previous turn was cut short at ${moment(interruption.at, now)}: ${why}. Work you did before then is in place.`,
  ]
  const none = calls.filter((call) => call.result === "none")
  const unseen = calls.filter((call) => call.result === "unseen")
  if (none.length)
    lines.push(
      "These calls never returned a result. They may have done part of their work or none of it; check before you repeat them:",
      ...none.map((call) => `- ${call.title}`)
    )
  if (unseen.length)
    lines.push(
      "These calls returned after your last step, so you have not seen their results:",
      ...unseen.map((call) =>
        call.file ? `- ${call.title}: the full result is saved at ${call.file}` : `- ${call.title}: the result could not be saved; check its effect before you repeat it`
      )
    )
  if (interruption.moreCalls)
    lines.push(`${interruption.moreCalls} more ${interruption.moreCalls === 1 ? "call" : "calls"} from that turn ended the same way.`)
  if (none.length && interruption.reason !== "host-quit")
    lines.push("If a call from that turn is described as interrupted or cancelled by the user, that is wrong: the user did not stop it.")
  return lines.join("\n")
}

function moment(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString("en-GB", { hour12: false })
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`
}
