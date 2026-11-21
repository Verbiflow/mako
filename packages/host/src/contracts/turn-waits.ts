import { z } from "zod"
import { SHIVER_WORD } from "./agents.js"

/**
 * A turn's wait: what a Thread's agent asked Mako to wake it with when its turn ends (`wait` on the `mako` server).
 * It names the Fins, pull requests and app checks it waits on, a time it waits until, or both, the time then being
 * the longest it waits; with several, `any` wakes on the first and `all` on the last. It's kept in the Thread store
 * from the moment it's armed (`turn_waits`), so a host that stops keeps it, and fires once: the store's claim takes
 * it from armed to fired in one write, and its note goes under one request the live queue takes once.
 */

/** The longest a wait waits: seven days, the horizon a timer or a clock time may name. */
export const WAIT_HORIZON_MAX_S = 7 * 24 * 60 * 60
/** The most things one wait names. */
export const WAIT_ITEMS_MAX = 16
/** How late a wait's time may fire and still read as on time; past it the note says the host was asleep or off. */
export const WAIT_LATE_MS = 60_000
/**
 * The wait Mako arms itself when an Apex's turn ends with its Fins at work and none of its own armed: a check-in an
 * hour on, the backstop to their reports (each still wakes it as ever), so nobody has to say "check on the Fins".
 */
export const SHIVER_WAIT = `Waiting for the ${SHIVER_WORD}`
/** `SHIVER_WAIT` as builds before the Shiver wrote it: a check-in they armed keeps these words in its stored record. */
const CREW_WAIT = "Waiting for the crew"
export const SHIVER_WAIT_S = 60 * 60
/**
 * How far the check-in backs off: each one that found the Shiver still at work with no report since doubles the next
 * (1 h, 2 h, 4 h, 8 h, then 8 h on), so a Fin on a long, healthy job doesn't wake its Apex every hour. A report, or a
 * turn anyone but the check-in started, brings it back to an hour.
 */
export const SHIVER_STEPS_MAX = 3

/** The check-in's interval at a step of its backoff, in seconds. */
export function shiverWaitSeconds(step: number): number {
  return SHIVER_WAIT_S * 2 ** Math.min(Math.max(0, step), SHIVER_STEPS_MAX)
}

export const TurnWaitItemSchema = z.lazy(() => z.discriminatedUnion("kind", [
  /** A Fin of this Thread: its next report, or its end. `fin` is its Thread, `name` how the note names it. */
  z.object({ kind: z.literal("fin"), fin: z.string().min(1).max(200), name: z.string().min(1).max(200) }),
  /** A pull request by its `pullKey`, until its checks settle, a review lands or it merges; merged or closed ends any. */
  z.object({ kind: z.literal("pull"), pull: z.string().min(1).max(300), until: z.enum(["checks", "review", "merge"]).optional() }),
  /** This Thread's app check of a tier: the run going now, or the next one. */
  z.object({ kind: z.literal("check"), tier: z.enum(["quick", "full"]), target: z.string().min(1).max(32).optional() }),
]))
export type TurnWaitItem = z.infer<typeof TurnWaitItemSchema>

/** An item's key in its wait: what `met` names it by. */
export function turnWaitItemKey(item: TurnWaitItem): string {
  if (item.kind === "fin") return `fin:${item.fin}`
  if (item.kind === "pull") return `pull:${item.pull}`
  return `check:${item.tier}${item.target ? `:${item.target}` : ""}`
}

/** How an item reads in a note and on the person's waiting line. */
export function turnWaitItemWords(item: TurnWaitItem): string {
  if (item.kind === "fin") return `fin:${item.name}`
  if (item.kind === "pull") return item.until ? `${item.pull} ${item.until}` : item.pull
  return `the ${item.tier} check${item.target ? ` of ${item.target}` : ""}`
}

/** Who or what ended a wait that didn't fire. */
export const TurnWaitCancelSchema = z.enum([
  /** The agent's own `wait` cancel. */
  "agent",
  /** The person's Stop waiting. */
  "person",
  /** The Thread was stopped. */
  "stop",
  /** The Thread was archived. */
  "archive",
  /** The Thread moved to another host; its agent is told on arrival to arm it again there. */
  "move",
  /** A newer wait of the same Thread took its place. */
  "replaced",
])
export type TurnWaitCancel = z.infer<typeof TurnWaitCancelSchema>

export const TurnWaitSchema = z.lazy(() => z.object({
  /** `namedUuid(conversation, clientKey)`: the same call again finds it. */
  id: z.string().min(1).max(200),
  thread: z.string().min(1).max(200),
  conversation: z.string().min(1).max(200),
  /** A few words the person reads while it waits: "Waiting for CI on #412". */
  description: z.string().min(1).max(120),
  items: z.array(TurnWaitItemSchema).max(WAIT_ITEMS_MAX),
  returnWhen: z.enum(["any", "all"]),
  /** When its time is up, epoch ms: the wait's whole point when it names nothing, its longest otherwise. */
  endsBy: z.number().optional(),
  createdAt: z.number(),
  /** The items met so far, by key, each with when and what happened, kept as each is so `all` survives a restart. */
  met: z.record(z.string(), z.object({ at: z.number(), words: z.string().max(400) })),
  state: z.enum(["armed", "fired", "cancelled"]),
  /** Once fired: when, why, the note and the request it goes as. */
  fired: z.object({
    at: z.number(),
    why: z.enum(["met", "time"]),
    /** It fired this long after its time, the host asleep or off meanwhile. */
    lateMs: z.number().optional(),
    request: z.string().min(1).max(200),
    text: z.string().max(4_000),
  }).optional(),
  /** When the note reached the conversation's queue. */
  delivered: z.object({ at: z.number() }).optional(),
  /** When and by whom it ended without firing, or, fired, before its note went (then never sent). */
  cancelled: z.object({ at: z.number(), by: TurnWaitCancelSchema }).optional(),
  /** Mako's own Shiver check-in (`SHIVER_WAIT`), not the agent's `wait`: absent for the agent's. Its note is written as it's due. */
  armedBy: z.literal("mako").optional(),
  /**
   * The Shiver check-in's step of its backoff (`shiverWaitSeconds`): 0 is an hour. Stored in `turn_waits.record` under
   * its name from before the Shiver, kept so stored waits and older builds read the same.
   */
  crewStep: z.number().int().min(0).max(16).optional(),
}))
export type TurnWait = z.infer<typeof TurnWaitSchema>

/** What the person's waiting line says, or nothing once the wait isn't armed: it clears by itself. */
export interface TurnWaitLine {
  wait: string
  description: string
  /** Each item and whether it's met, in the order the wait named them. */
  items: { words: string; met: boolean }[]
  returnWhen: "any" | "all"
  endsBy?: number
}

/** What a wait is said to wait for: Mako's own check-in, armed by a build before the Shiver, in today's words. */
export function turnWaitDescription(wait: Pick<TurnWait, "description" | "armedBy">): string {
  return wait.armedBy === "mako" && wait.description === CREW_WAIT ? SHIVER_WAIT : wait.description
}

export function turnWaitLine(wait: TurnWait): TurnWaitLine | undefined {
  if (wait.state !== "armed") return undefined
  return {
    wait: wait.id,
    description: turnWaitDescription(wait),
    items: wait.items.map((item) => ({ words: turnWaitItemWords(item), met: wait.met[turnWaitItemKey(item)] !== undefined })),
    returnWhen: wait.returnWhen,
    ...(wait.endsBy !== undefined && { endsBy: wait.endsBy }),
  }
}

/** Whether a wait's items are met as it asked: any one, or every one. A wait naming none is met only by its time. */
export function turnWaitMet(wait: Pick<TurnWait, "items" | "returnWhen" | "met">): boolean {
  if (!wait.items.length) return false
  const met = wait.items.map((item) => wait.met[turnWaitItemKey(item)] !== undefined)
  return wait.returnWhen === "all" ? met.every(Boolean) : met.some(Boolean)
}

const NOTE_HEAD = "Mako: "

function clock(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * The note a wait fires with, as Mako's words: what it waited for, what happened to each thing it named, what's
 * still pending, and, when it fired late, that its time came while the host was asleep or off. Said to the agent
 * only: the person's line just clears.
 */
export function turnWaitNote(wait: TurnWait, why: "met" | "time", at: number): string {
  const lines: string[] = []
  const done = wait.items.filter((item) => wait.met[turnWaitItemKey(item)] !== undefined)
  const pending = wait.items.filter((item) => wait.met[turnWaitItemKey(item)] === undefined)
  const description = turnWaitDescription(wait)
  if (why === "met") lines.push(`${NOTE_HEAD}the wait "${description}" is over.`)
  else if (wait.items.length) lines.push(`${NOTE_HEAD}stopped waiting for "${description}": its time ran out at ${clock(wait.endsBy ?? at)}.`)
  else lines.push(`${NOTE_HEAD}the time you waited for has come: "${description}" (${clock(wait.endsBy ?? at)}).`)
  for (const item of done) lines.push(`- ${turnWaitItemWords(item)}: ${wait.met[turnWaitItemKey(item)]!.words}`)
  if (pending.length) lines.push(`Still pending: ${pending.map(turnWaitItemWords).join(", ")}.`)
  const late = wait.endsBy !== undefined && why === "time" ? at - wait.endsBy : 0
  if (late > WAIT_LATE_MS) lines.push(`It was due at ${clock(wait.endsBy!)}; this host was asleep or off until ${clock(at)}, so this comes late.`)
  return lines.join("\n")
}

const NOTE_STARTS = ["the wait \"", "stopped waiting for \"", "the time you waited for has come", "your wait \"", "an hour passed with ", "2 hours passed with ", "4 hours passed with ", "8 hours passed with "]

/** A turn wait's note read back from its words, as a saved transcript keeps it: its first line, and the rest. */
export function turnWaitWords(text: string): { line: string; detail?: string } | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith(NOTE_HEAD)) return undefined
  const [first = "", ...rest] = trimmed.slice(NOTE_HEAD.length).split("\n")
  if (!NOTE_STARTS.some((start) => first.startsWith(start))) return undefined
  const detail = rest.join("\n").trim()
  return { line: first.charAt(0).toUpperCase() + first.slice(1), ...(detail && { detail }) }
}

/** A Fin at work as the Shiver check-in reads it: its name, its line (`childLine`), and how long it has shown nothing. */
export interface ShiverFin {
  name: string
  line: string
  quietMs?: number
}

/** The Shiver check-in's note, as it's due: each Fin still at work, what it does, and how long it has been quiet. */
export function shiverWaitNote(fins: readonly ShiverFin[], quietFor: (ms: number) => string, waitedS = SHIVER_WAIT_S): string {
  const count = fins.length === 1 ? "one of your Fins" : `${fins.length} of your Fins`
  const hours = Math.round(waitedS / 3600)
  const waited = hours <= 1 ? "an hour" : `${hours} hours`
  return [
    `${NOTE_HEAD}${waited} passed with ${count} at work and no word from them. Mako checks in when your turn ends with Fins at work and no wait of yours armed, less often while they go on with nothing to report.`,
    ...fins.map((fin) => `- fin:${fin.name}: ${fin.line}${fin.quietMs !== undefined && quietFor(fin.quietMs) ? ` (quiet ${quietFor(fin.quietMs)})` : ""}`),
    "Read one with agents_read, or send it a word with agents_send. Their reports wake you as ever: end your turn to wait for them.",
  ].join("\n")
}

/** The note an agent gets on arrival when its Thread moved with a wait armed: the move cancelled it. */
export function turnWaitMovedNote(wait: Pick<TurnWait, "description" | "armedBy">): string {
  return `${NOTE_HEAD}your wait "${turnWaitDescription(wait)}" ended when this Thread moved here. If you still need it, call wait again.`
}
