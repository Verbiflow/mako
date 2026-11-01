import { z } from "zod"
import { ContinueStateSchema, CONTINUE_WAIT_MS, type ContinuePhase, type ContinueRefusal, type ContinueState, type ListedContinue } from "@mako/protocol/continues"

/**
 * Continue in the cloud as the device it's pressed on carries the press (`@mako/protocol/continues`): one loop for a
 * browser's page and a Mac's host alike, so every device asks, waits and ends the same way, and one reading of each
 * continue a device pressed or heard of, which its Diagnostics show.
 */

/** An answer of the account's continue routes as its client got it: the status and the JSON. Nothing back is thrown. */
export type ContinueAnswer = { status: number; body: unknown }

/** One ask of a continue route, sent under `correlationId`; `first`: the press itself, which the page shows as busy. */
export type ContinueAsk = (ask: { method: "GET" | "POST"; path: string; correlationId: string; first: boolean }) => Promise<ContinueAnswer>

/** The route a continue of `session` is pressed (POST) and followed (GET) at, by its op. */
export function continuePath(session: string, op?: string): string {
  const base = `/v1/sessions/${encodeURIComponent(session)}/continue`
  return op ? `${base}/${encodeURIComponent(op)}` : base
}

/** How long a press waits before asking again after a continue's answer was lost: soon, then less and less often. */
export const CONTINUE_ASK_AGAIN_MS = [2_000, 5_000, 10_000, 30_000] as const

/** What one ask came to: the continue as it stands, a refusal that ends it, or an answer lost (asked again). */
export type ContinueAsked = { kind: "state"; state: ContinueState } | { kind: "refused"; status: number; reason: string } | { kind: "lost"; reason: string }

/** One ask as the press heard it: when, how, under which correlation ID, how long it took, and what it came to. */
export type ContinueHeard = { at: number; method: "GET" | "POST"; correlationId: string; ms: number; asked: ContinueAsked }

/** How a press ended: the account's last word (continued, failed with why), or put away before it had one. */
export type ContinueEnd = { kind: "continued"; state: ContinueState } | { kind: "failed"; reason: string; state?: ContinueState } | { kind: "stopped" }

/**
 * Carries a press of Continue in the cloud through, by its op ID, to the account's last word. It's pressed (POST) until
 * the account says how it stands, since a press is the same continue however often it's made, so one whose answer was
 * lost (the network went, a 5xx) is pressed again rather than read, which would find nothing of a press that never
 * landed; then it's followed (GET, held open while the machine arrives) until it's continued or failed. A refusal
 * (4xx, but a timeout or a limit) ends it, with the account's words. After a lost answer it waits a little longer each
 * time, and stops once `goOn` says the person put it away or pressed again. `holdMs`: how long a follow is held open
 * at most, within the asker's own time for a request.
 */
export async function carryContinue(input: {
  session: string
  op: string
  ask: ContinueAsk
  heard?: (heard: ContinueHeard) => void
  goOn?: () => boolean
  wait?: (ms: number) => Promise<void>
  correlation?: () => string
  now?: () => number
  holdMs?: number
}): Promise<ContinueEnd> {
  const now = input.now ?? Date.now
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const at = continuePath(input.session, input.op)
  let pressed = false
  let lost = 0
  for (let first = true; ; first = false) {
    const method = pressed ? "GET" : "POST"
    const correlationId = (input.correlation ?? (() => crypto.randomUUID()))()
    const started = now()
    const asked = await askOnce(input.ask, { method, path: pressed ? `${at}?wait=${Math.min(input.holdMs ?? CONTINUE_WAIT_MS, CONTINUE_WAIT_MS)}` : at, correlationId, first })
    input.heard?.({ at: started, method, correlationId, ms: now() - started, asked })
    if (asked.kind === "refused") return { kind: "failed", reason: asked.reason }
    if (asked.kind === "state") {
      pressed = true
      lost = 0
      if (asked.state.phase === "continued") return { kind: "continued", state: asked.state }
      if (asked.state.phase === "failed") return { kind: "failed", reason: asked.state.reason ?? "It didn't continue in the cloud.", state: asked.state }
      // Making or arriving: asked again at once, held open by the account while the machine arrives.
      continue
    }
    await wait(CONTINUE_ASK_AGAIN_MS[Math.min(lost++, CONTINUE_ASK_AGAIN_MS.length - 1)]!)
    if (input.goOn && !input.goOn()) return { kind: "stopped" }
  }
}

async function askOnce(ask: ContinueAsk, request: Parameters<ContinueAsk>[0]): Promise<ContinueAsked> {
  let answer: ContinueAnswer
  try {
    answer = await ask(request)
  } catch (error) {
    return { kind: "lost", reason: error instanceof Error ? error.message : String(error) }
  }
  if (answer.status >= 200 && answer.status < 300) {
    const state = ContinueStateSchema.safeParse(answer.body)
    return state.success ? { kind: "state", state: state.data } : { kind: "lost", reason: "The account's answer wasn't a continue." }
  }
  const reason = problemWords(ContinueProblemSchema.safeParse(answer.body).data, answer.status)
  if (answer.status >= 500 || answer.status === 408 || answer.status === 429) return { kind: "lost", reason }
  return { kind: "refused", status: answer.status, reason }
}

/** What a continue route's refusal says, as much of its problem document as a person reads. */
export const ContinueProblemSchema = z.object({ title: z.string(), detail: z.string() }).partial()

/** A problem document's words: its title, and its detail after it. */
export function problemWords(problem: z.infer<typeof ContinueProblemSchema> | undefined, status: number): string {
  const title = problem?.title ?? `The account answered ${status}`
  return problem?.detail ? `${title}: ${problem.detail}` : title
}

/** Where a continue stands as a device knows it: the account's phase, or `asking` before its first answer. */
export type ContinueReadingPhase = "asking" | ContinuePhase

/**
 * A continue as one device's Diagnostics show it: pressed here (`here`) or heard of in the account's list, its op, the
 * Thread it carries and where (the cloud Thread, its machine once the account says it), where it stands and why it
 * failed, when this device heard each phase first, the account's own times, and the last asks with their correlation
 * IDs, which the gateway's log is read by.
 */
export type ContinueReading = {
  op: string
  session: string
  thread?: string
  title?: string
  from?: string
  by?: string
  cloudThread?: string
  machine?: string
  phase: ContinueReadingPhase
  reason?: string
  here: boolean
  /** When this device heard each phase first, in epoch ms; `asking`: when it was pressed here. */
  heard: Partial<Record<ContinueReadingPhase, number>>
  /** The account's word on when it was pressed, and when it last changed. */
  at?: string
  changedAt?: string
  /** The latest asks, newest last. */
  asks: Array<{ at: number; method: "GET" | "POST"; correlationId: string; ms: number; outcome: string }>
}

const KEPT_CONTINUES = 12
const KEPT_ASKS = 8

/** Each continue a device pressed or heard of, kept in memory and small, on a Mac's host and in a browser alike. */
export class ContinueRecorder {
  readonly #now: () => number
  readonly #continues = new Map<string, ContinueReading>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Pressed here, under `op`, for `session` of the Thread named. */
  pressed(op: string, session: string, named: { thread?: string; title?: string } = {}): void {
    this.#put({ op, session, ...named, phase: "asking", here: true, heard: { asking: this.#now() }, asks: [] })
  }

  /** An ask of a continue pressed here, as it came back. */
  heard(op: string, heard: ContinueHeard): void {
    const reading = this.#continues.get(op)
    if (!reading) return
    const outcome = heard.asked.kind === "state" ? heard.asked.state.phase : heard.asked.kind === "refused" ? `refused ${heard.asked.status}` : "lost"
    reading.asks.push({ at: heard.at, method: heard.method, correlationId: heard.correlationId, ms: heard.ms, outcome })
    if (reading.asks.length > KEPT_ASKS) reading.asks.splice(0, reading.asks.length - KEPT_ASKS)
    if (heard.asked.kind === "state") this.#state(reading, heard.asked.state)
    else if (heard.asked.kind === "refused") this.#phase(reading, "failed", heard.asked.reason)
  }

  readings(): ContinueReading[] {
    return [...this.#continues.values()].map((reading) => ({ ...reading, heard: { ...reading.heard }, asks: [...reading.asks] })).reverse()
  }

  #put(reading: ContinueReading): ContinueReading {
    this.#continues.delete(reading.op)
    this.#continues.set(reading.op, reading)
    while (this.#continues.size > KEPT_CONTINUES) this.#continues.delete(this.#continues.keys().next().value!)
    return reading
  }

  #state(reading: ContinueReading, state: ContinueState): void {
    reading.thread = state.thread
    if (state.threadTitle) reading.title = state.threadTitle
    reading.from = state.from
    reading.by = state.by
    reading.cloudThread = state.cloudThread
    if (state.machine) reading.machine = state.machine
    reading.at = state.at
    reading.changedAt = state.changedAt
    this.#phase(reading, state.phase, state.reason)
  }

  #phase(reading: ContinueReading, phase: ContinueReadingPhase, reason: string | undefined): void {
    stepReading(reading, phase, reason, this.#now())
  }
}

/** A reading moved on to `phase`: the account's word stands once it ended, so an older answer heard late changes nothing. */
function stepReading(reading: ContinueReading, phase: ContinueReadingPhase, reason: string | undefined, at: number | undefined): void {
  if (reading.phase === "continued" || (reading.phase === "failed" && phase !== "continued")) return
  reading.phase = phase
  if (at !== undefined) reading.heard[phase] ??= at
  if (phase === "failed" && reason) reading.reason = reason
}

/** A Session's row as the account's list says it, with the continue it carries, if any (`ListedSession.continued`). */
type ListedRow = { session: string; thread: string; threadTitle?: string; continued?: ListedContinue }

/**
 * The continues a device's Diagnostics show: those it pressed (`recorded`, newest first), each moved on to what the
 * account's list says of it since, then those the list says another device pressed, from the list alone.
 */
export function continueReadings(recorded: readonly ContinueReading[], rows: Iterable<ListedRow>): ContinueReading[] {
  const readings = recorded.map((reading) => ({ ...reading, heard: { ...reading.heard } }))
  const byOp = new Map(readings.map((reading) => [reading.op, reading]))
  for (const row of rows) {
    const listed = row.continued
    if (!listed) continue
    let reading = byOp.get(listed.op)
    if (!reading) {
      reading = { op: listed.op, session: row.session, thread: row.thread, ...(row.threadTitle && { title: row.threadTitle }), phase: listed.phase, ...(listed.reason && { reason: listed.reason }), here: false, heard: {}, asks: [] }
      byOp.set(listed.op, reading)
      readings.push(reading)
    }
    reading.from = listed.from
    reading.by = listed.by
    reading.cloudThread = listed.cloudThread
    reading.at ??= listed.at
    stepReading(reading, listed.phase, listed.reason, undefined)
  }
  return readings
}

/**
 * A continue in one line, as Diagnostics show it and copy it: where it stands, its op, where it went, how long each
 * phase took as this device heard it, and the last ask's correlation ID.
 */
export function describeContinue(reading: ContinueReading): string {
  const parts = [`${reading.phase}${reading.here ? "" : " (pressed elsewhere)"}`, `op ${reading.op}`]
  if (reading.cloudThread) parts.push(`to ${reading.cloudThread}${reading.machine ? ` on ${reading.machine}` : ""}`)
  const times = continueTimings(reading)
  if (times.length) parts.push(times.map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(", "))
  const last = reading.asks.at(-1)
  if (last) parts.push(`last ask ${last.method} ${last.outcome} in ${last.ms} ms · ${last.correlationId}`)
  if (reading.reason) parts.push(reading.reason)
  return parts.join(" · ")
}

/** How long each phase lasted as this device heard it, in order: from each one's first word to the next one's. */
export function continueTimings(reading: Pick<ContinueReading, "heard">): Array<[ContinueReadingPhase, number]> {
  const order: ContinueReadingPhase[] = ["asking", "making", "arriving"]
  const end = reading.heard.continued ?? reading.heard.failed
  const timings: Array<[ContinueReadingPhase, number]> = []
  for (const [index, phase] of order.entries()) {
    const began = reading.heard[phase]
    if (began === undefined) continue
    const next = order.slice(index + 1).map((later) => reading.heard[later]).find((at) => at !== undefined) ?? end
    if (next !== undefined) timings.push([phase, Math.max(0, next - began)])
  }
  return timings
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

/**
 * The refusals a person can do something about, which every device says beside a Thread whose device is off (it was
 * working or waiting, its branch isn't pushed, its device's Mako is older); the rest are said nowhere.
 */
export function continueRefusalShown(why: ContinueRefusal): boolean {
  return why === "working" || why === "waiting" || why === "no-repository" || why === "older-device"
}

/** A continue's steps in the order they're taken, each in its words, as every device shows its progress. */
export const CONTINUE_STEPS = [
  { kind: "making", words: "Getting a cloud machine ready" },
  { kind: "arriving", words: "Cloning its branch and resuming" },
] as const

/** A continue's step in a few words. */
export function continueStepWords(step: "asking" | "making" | "arriving"): string {
  return step === "asking" ? "Asking your account…" : CONTINUE_STEPS.find((each) => each.kind === step)!.words
}

/** What a continue's step means while `device` is off and the account carries it. */
export function continueStepDetail(step: "asking" | "making" | "arriving", device: string): string {
  if (step === "arriving") return `A cloud machine clones its branch as pushed and picks up its sessions where they left off. A message that waited for ${device} runs there, once.`
  return `${device} is off, so your account carries it: a cloud Thread made at the same folder, with its sessions as ${device} last sent them.`
}

/** A continue whose answer `here` (this page, this Mac) lost on the way: the account carries it on, and it's asked again. */
export function continueLostDetail(here: string, reason: string): string {
  return `${here} lost the answer on the way (${reason}). Your account carries it on all the same, and ${here.toLowerCase()} asks how it went until it hears.`
}

/** A continue's title, by how it ended, if it has. */
export function continueTitle(end: "continued" | "failed" | undefined): string {
  return end === "failed" ? "Couldn't continue in the cloud" : end === "continued" ? "Continued in the cloud" : "Continuing in the cloud"
}

/** What a continue that ended continued says, `device` being the one it went on from. */
export function continuedWords(device: string): string {
  return `It goes on in a cloud machine; ${device} lets it go.`
}

/** What a continue takes, before the press, in the words every device's confirmation says. */
export const continueWords = {
  /** The device it goes on from, which is off, and when it was last seen, in words. */
  carried: (device: string, seen?: string) => `${device} is asleep or offline${seen ? ` (seen ${seen})` : ""}. Your account carries this Thread to a cloud machine, at the same folder, and it goes on there.`,
  branch: (device: string) => `As pushed to GitHub. Changes on ${device} that weren't pushed stay there.`,
  waiting: (waiting: number) => (waiting === 1 ? "The message waiting for it runs there, once." : `The ${waiting} messages waiting for it run there, once, in order.`),
  letsGo: (device: string) => `When ${device} is back, it lets the Thread go. Bring it back any time.`,
  behind: (device: string) => `The last turns you read may not have reached your account before ${device} went quiet. The cloud goes on from what it sent; anything after stays in ${device}'s history.`,
} as const
