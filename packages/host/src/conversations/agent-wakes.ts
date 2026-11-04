import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import { reportPhase, type Report } from "../contracts/agents.js"
import { FROM_AGENTS } from "../contracts/children.js"
import { SessionIdSchema, type Actor } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"

export { FROM_AGENTS, fromAgent } from "../contracts/children.js"

/** An idle Apex waits this long after a notice for the others of its burst, then wakes once for all of them. */
export const WAKE_COALESCE_MS = 2_000
/** A result the Apex waited for goes after this: the Apex asked for it, so only what settles with it joins it. */
export const RESULT_COALESCE_MS = 250
/** The most of a waited-for result its wake carries; `agents_read` gives the rest. */
const RESULT_CHARS = 8_000
/** Wakes an Apex takes in a minute; notices past them wait for the next wake. */
export const WAKES_PER_MINUTE = 6
const MINUTE_MS = 60_000

/** `notice:{child}:{reportId}`: a report its Apex's owner hears, under an ID a resend repeats. */
export interface Notice {
  id: string
  report: Report
  /** The Fin as the digest names it: `"name" (Harness)`. */
  label: string
  /** The Fin's own Session, which the wake's request names as its actor: an agent's words, never the person's. */
  from: string
  /** The request already named to carry it, by a host that stopped before it was sent (`ThreadStore.assignWake`). */
  wake?: string
  /** The result of a `wait` start whose window ended first: it starts the Apex's next turn, in full, and is never steered into a running one. */
  settledOnly?: true
}

/** What an Apex's conversation can take now. */
export type ParentReady = "steer" | "queue" | "idle" | "gone"

export interface AgentWakesDeps {
  /** What the Apex's conversation is doing: busy at a step a message joins, busy until its turn's end, idle, or not here. */
  ready(conversation: string): ParentReady
  /** Starts a turn with the digest, under `request`: a request taken once already is taken again as the same one. */
  wake(conversation: string, request: string, text: string, actor: Extract<Actor, { kind: "agent" }>): void
  /** Joins the digest to the running turn at its next step, resolving whether the harness took it; false when no turn could take one. */
  steer(conversation: string, id: string, text: string): Promise<boolean> | false
  /** The request named before it's sent, and the reports marked heard once it was (`ThreadStore`). */
  assign(reports: readonly string[], request: string): void
  delivered(reports: readonly string[], at: number): void
  /** The digest's last line: how the Apex's Fins stand now. */
  counts(conversation: string): string
  /** Whether a notice still says how its Fin stands: an end the host inferred for a Fin that works again doesn't. */
  current?(notice: Notice): boolean
  now?(): number
}

interface Waiting {
  /** The Apex whose wake budget it spends. */
  apex: string
  notices: Notice[]
  timer?: NodeJS.Timeout
  /** Waits for the Apex's turn to end (`settled`). */
  forTurnEnd?: true
  /** A steer this turn didn't take: the rest go at its end, as a turn of their own. */
  unsteerable?: true
}

/**
 * The Apex's side of a report (6.6): the notices its Fins' owners
 * send it, coalesced, and delivered the one way its harness takes them now.
 * An idle Apex waits `WAKE_COALESCE_MS` after a burst's first notice and
 * then starts ONE turn with the digest; an Apex busy on a harness whose
 * steer lands at a step gets them at its next step; one whose steer would
 * interrupt (Cursor) gets them as a message queued for its turn's end. A
 * result the Apex waited for (`settledOnly`) is never steered: it goes
 * once the Apex is idle, after `RESULT_COALESCE_MS`, first and in full.
 * Wakes past `WAKES_PER_MINUTE` for an Apex wait, decisions first. Nothing
 * polls: a timer runs only while notices wait.
 */
export class AgentWakes {
  private readonly deps: AgentWakesDeps
  private readonly waiting = new Map<string, Waiting>()
  private readonly heard = new Set<string>()
  /** Notices a steer carries until the harness answers it: heard if it took them, else waiting again. */
  private readonly steering = new Set<string>()
  private readonly wakes = new Map<string, number[]>()
  private stopped = false

  constructor(deps: AgentWakesDeps) {
    this.deps = deps
  }

  /** A notice for `conversation`, the Apex's, under Apex `apex`; one already heard or waiting changes nothing. */
  notice(conversation: string, apex: string, notice: Notice): void {
    if (this.stopped || this.heard.has(notice.id) || this.steering.has(notice.id)) return
    const held = this.waiting.get(conversation)
    if (held?.notices.some((waiting) => waiting.id === notice.id)) return
    const waiting = held ?? { apex, notices: [] }
    waiting.notices.push(notice)
    this.waiting.set(conversation, waiting)
    hostLog("agents", "notice", { notice: notice.id, report: notice.report.id, status: notice.report.status, conversation, ...(notice.settledOnly && { settledOnly: true }) })
    if (waiting.forTurnEnd) return
    if (notice.settledOnly && waiting.timer) {
      clearTimeout(waiting.timer)
      waiting.timer = undefined
    }
    if (!waiting.timer) this.after(conversation, waiting, notice.settledOnly ? RESULT_COALESCE_MS : WAKE_COALESCE_MS)
  }

  /** The Apex's turn ended: what waited for it, and the results it waited for, go now, as a wake once it's idle. */
  settled(conversation: string): void {
    const waiting = this.waiting.get(conversation)
    if (!waiting) return
    waiting.unsteerable = undefined
    if (waiting.timer || (!waiting.forTurnEnd && !waiting.notices.some((notice) => notice.settledOnly))) return
    waiting.forTurnEnd = undefined
    this.after(conversation, waiting, coalesceMs(waiting.notices))
  }

  /** Takes back a notice its Apex heard another way (a `wait` start that answers its result); false when none waits. */
  withdraw(conversation: string, id: string): boolean {
    const waiting = this.waiting.get(conversation)
    const before = waiting?.notices.length ?? 0
    if (!waiting || !before) return false
    waiting.notices = waiting.notices.filter((notice) => notice.id !== id)
    this.heard.add(id)
    if (!waiting.notices.length) {
      clearTimeout(waiting.timer)
      this.waiting.delete(conversation)
    }
    return waiting.notices.length < before
  }

  /** Whether notices wait for this Apex's conversation: a turn of its own is coming. */
  waits(conversation: string): boolean {
    return Boolean(this.waiting.get(conversation)?.notices.length)
  }

  /** How many notices wait, across every Apex: Diagnostics shows it. */
  pending(): number {
    let count = this.steering.size
    for (const waiting of this.waiting.values()) count += waiting.notices.length
    return count
  }

  dispose(): void {
    this.stopped = true
    for (const waiting of this.waiting.values()) clearTimeout(waiting.timer)
    this.waiting.clear()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private after(conversation: string, waiting: Waiting, ms: number): void {
    waiting.timer = setTimeout(() => {
      waiting.timer = undefined
      this.flush(conversation)
    }, ms)
    waiting.timer.unref()
  }

  private flush(conversation: string): void {
    const waiting = this.waiting.get(conversation)
    if (!waiting?.notices.length || this.stopped) return
    const stale = this.deps.current ? waiting.notices.filter((notice) => !this.deps.current!(notice)) : []
    if (stale.length) {
      this.deps.delivered(stale.map((notice) => notice.report.id), this.now())
      for (const notice of stale) this.heard.add(notice.id)
      waiting.notices = waiting.notices.filter((notice) => !stale.includes(notice))
      hostLog("agents", "stale end not reported", { conversation, reports: stale.map((notice) => notice.report.id).join(" ") })
      if (!waiting.notices.length) {
        this.waiting.delete(conversation)
        return
      }
    }
    const ready = this.deps.ready(conversation)
    if (ready === "gone") {
      // Kept unheard in the store: the host that has the Apex sends them on its start.
      this.waiting.delete(conversation)
      return
    }
    if (ready === "queue" || (ready === "steer" && waiting.unsteerable)) {
      waiting.forTurnEnd = true
      return
    }
    const steerable = waiting.notices.filter((notice) => !notice.settledOnly)
    // Results alone wait for the turn's end (`settled`), while what can be steered still is.
    if (ready === "steer" && !steerable.length) return
    const batch = nextBatch(ready === "steer" ? steerable : waiting.notices)
    const ids = batch.map((notice) => notice.report.id)
    const request = batch[0]!.wake ?? namedUuid(`wake:${conversation}:${ids.join("\n")}`)
    const text = digest(batch, this.deps.counts(conversation))
    if (ready === "steer") {
      const steer = this.deps.steer(conversation, namedUuid(`steer:${request}`), text)
      if (!steer) {
        waiting.forTurnEnd = true
        return
      }
      waiting.notices = waiting.notices.filter((notice) => !batch.includes(notice))
      for (const notice of batch) this.steering.add(notice.id)
      void steer.then((took) => this.steered(conversation, waiting.apex, batch, request, took))
      return
    }
    const now = this.now()
    const recent = (this.wakes.get(waiting.apex) ?? []).filter((at) => now - at < MINUTE_MS)
    this.wakes.set(waiting.apex, recent)
    if (recent.length >= WAKES_PER_MINUTE) return this.after(conversation, waiting, recent[0]! + MINUTE_MS - now)
    try {
      if (!batch[0]!.wake) this.deps.assign(ids, request)
      this.deps.wake(conversation, request, text, { kind: "agent", session: SessionIdSchema.parse(batch[0]!.from) })
    } catch (error) {
      hostWarn("agents", "a wake could not start; its notices wait for the next", { conversation, error: errorMessage({ error }) })
      return this.after(conversation, waiting, WAKE_COALESCE_MS)
    }
    recent.push(now)
    this.sent(conversation, waiting, batch, request, "turn")
  }

  /** The harness answered a steer: what it took is heard; what it didn't goes as the Apex's next turn, never dropped. */
  private steered(conversation: string, apex: string, batch: readonly Notice[], request: string, took: boolean): void {
    for (const notice of batch) this.steering.delete(notice.id)
    if (this.stopped) return
    const waiting = this.waiting.get(conversation) ?? { apex, notices: [] }
    this.waiting.set(conversation, waiting)
    if (took) return this.sent(conversation, waiting, batch, request, "steer")
    hostLog("agents", "steer not taken; its notices go as the next turn", { conversation, request, notices: batch.length })
    waiting.notices = [...batch, ...waiting.notices]
    waiting.unsteerable = true
    if (!waiting.timer && !waiting.forTurnEnd) this.after(conversation, waiting, WAKE_COALESCE_MS)
  }

  private sent(conversation: string, waiting: Waiting, batch: readonly Notice[], request: string, how: "turn" | "steer"): void {
    const ids = batch.map((notice) => notice.report.id)
    this.deps.delivered(ids, this.now())
    for (const notice of batch) this.heard.add(notice.id)
    waiting.notices = waiting.notices.filter((notice) => !batch.includes(notice))
    const results = batch.filter((notice) => notice.settledOnly).length
    hostLog("agents", "wake", { conversation, request, how, coalesced: batch.length, ...(results && { results }), waiting: waiting.notices.length })
    if (!waiting.notices.length) {
      this.waiting.delete(conversation)
      return
    }
    // The rest go once this wake's turn ends.
    waiting.forTurnEnd = true
  }
}

/**
 * The notices one delivery carries: those a stopped host already named a
 * request for go again alone under it, so a turn the Apex took before the
 * stop is taken as the same turn; the rest go together, decisions first.
 */
function nextBatch(notices: readonly Notice[]): Notice[] {
  const named = notices.find((notice) => notice.wake)?.wake
  if (named) return notices.filter((notice) => notice.wake === named)
  return notices.filter((notice) => !notice.wake)
}

const DECIDES = new Set<Report["status"]>(["blocked", "needs-input"])

/** The digest in its fixed shape: the results waited for, in full; then decisions; then what finished; then how the rest stand. */
export function digest(notices: readonly Notice[], counts: string): string {
  const results = notices.filter((notice) => notice.settledOnly)
  const decisions = notices.filter((notice) => !notice.settledOnly && DECIDES.has(notice.report.status))
  const finished = notices.filter((notice) => !notice.settledOnly && (notice.report.status === "done" || notice.report.status === "failed"))
  const lines = [FROM_AGENTS]
  if (results.length) {
    lines.push(results.length === 1 ? "The result you waited for:" : `The ${results.length} results you waited for:`)
    for (const { label, report } of results) {
      const summary = report.summary.trim() || (report.status === "done" ? "It finished." : "It failed.")
      const text = summary.length > RESULT_CHARS ? `${summary.slice(0, RESULT_CHARS)}… (agents_read gives the rest)` : summary
      lines.push(`  • ${label} ${report.status}:`, ...text.split("\n").map((line) => `    ${line}`))
      for (const artifact of report.artifacts ?? []) lines.push(`    ${artifact.kind}: ${artifact.ref}${artifact.label ? ` (${artifact.label})` : ""}`)
    }
  }
  if (decisions.length) {
    lines.push(`${decisions.length} ${decisions.length === 1 ? "needs" : "need"} a decision:`)
    for (const { label, report } of decisions) {
      lines.push(`  • ${label} is ${report.status === "blocked" ? "blocked" : "asking"}: ${report.question ?? reportPhase(report) ?? "it asks for a decision."}`)
      if (report.options?.length)
        lines.push(`    options: ${report.options.map((option, index) => `${option.label}${index === report.recommended ? " (recommended)" : ""}`).join(" · ")}`)
    }
    lines.push("  agents_answer answers each, or leaves it to the person with person: true.")
  }
  if (finished.length) {
    lines.push(`${finished.length} finished:`)
    for (const { label, report } of finished) {
      lines.push(`  • ${label} ${report.status}: ${finishedLine(report)}`)
      for (const artifact of report.artifacts ?? []) lines.push(`    ${artifact.kind}: ${artifact.ref}${artifact.label ? ` (${artifact.label})` : ""}`)
    }
  }
  lines.push(counts)
  lines.push(results.length && !decisions.length && !finished.length
    ? "Go on with it: reply to the person, start more work, or end your turn."
    : "agents_read gives a report in full. Reply to the person, start more work, or end your turn.")
  return lines.join("\n")
}

/**
 * A finished report as its digest line says it: its first paragraph past any heading, on one line, at most
 * `FINISHED_CHARS`, and how much more `agents_read` gives when there is more.
 */
export function finishedLine(report: Report): string {
  const summary = report.summary.trim()
  if (!summary) return report.status === "done" ? "it finished." : "it failed."
  const paragraphs = summary.split(/\n\s*\n/).map((paragraph) => paragraph.split("\n").filter((line) => !/^\s*(#{1,6}\s|[-*_]{3,}\s*$)/.test(line)).join("\n").trim()).filter(Boolean)
  const first = (paragraphs[0] ?? summary).replace(/\s+/g, " ")
  if (paragraphs.length <= 1 && first.length <= FINISHED_CHARS) return first
  const shown = first.length > FINISHED_CHARS ? `${first.slice(0, FINISHED_CHARS - 1).trimEnd()}…` : first
  return `${shown} (+${Math.max(1, summary.length - shown.length).toLocaleString("en-US")} chars)`
}
/** The most of a finished report's first paragraph its digest line carries. */
const FINISHED_CHARS = 480

/** The window before a delivery: short once a result the Apex waited for is among what waits. */
function coalesceMs(notices: readonly Notice[]): number {
  return notices.some((notice) => notice.settledOnly) ? RESULT_COALESCE_MS : WAKE_COALESCE_MS
}
