import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import { reportPhase, type Report } from "../contracts/agents.js"
import { SessionIdSchema, type Actor } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"

/** An idle parent waits this long after a notice for the others of its burst, then wakes once for all of them. */
export const WAKE_COALESCE_MS = 2_000
/** Wakes a lead takes in a minute; notices past them wait for the next wake. */
export const WAKES_PER_MINUTE = 6
const MINUTE_MS = 60_000

/** The header every delivery an agent wrote starts with: the model reads it as an agent's words, never the person's. */
export const FROM_AGENTS = "[mako · from your agents, not the person]"
export function fromAgent(name: string): string {
  return `[mako · from ${name} (agent), not the person]`
}

/** `notice:{child}:{reportId}`: a report its parent's owner hears, under an ID a resend repeats. */
export interface Notice {
  id: string
  report: Report
  /** The child as the digest names it: `"name" (Harness)`. */
  label: string
  /** The child's own Session, which the wake's request names as its actor: an agent's words, never the person's. */
  from: string
  /** The request already named to carry it, by a host that stopped before it was sent (`ThreadStore.assignWake`). */
  wake?: string
}

/** What a parent's conversation can take now. */
export type ParentReady = "steer" | "queue" | "idle" | "gone"

export interface AgentWakesDeps {
  /** What the parent's conversation is doing: busy at a step a message joins, busy until its turn's end, idle, or not here. */
  ready(conversation: string): ParentReady
  /** Starts a turn with the digest, under `request`: a request taken once already is taken again as the same one. */
  wake(conversation: string, request: string, text: string, actor: Extract<Actor, { kind: "agent" }>): void
  /** Joins the digest to the running turn at its next step; false when the turn took no message. */
  steer(conversation: string, id: string, text: string): boolean
  /** The request named before it's sent, and the reports marked heard once it was (`ThreadStore`). */
  assign(reports: readonly string[], request: string): void
  delivered(reports: readonly string[], at: number): void
  /** The digest's last line: how the parent's children stand now. */
  counts(conversation: string): string
  now?(): number
}

interface Waiting {
  /** The lead whose wake budget it spends. */
  lead: string
  notices: Notice[]
  timer?: NodeJS.Timeout
  /** Waits for the parent's turn to end (`settled`). */
  forTurnEnd?: true
}

/**
 * The parent's side of a report (6.6): the notices its children's owners
 * send it, coalesced, and delivered the one way its harness takes them now.
 * An idle parent waits `WAKE_COALESCE_MS` after a burst's first notice and
 * then starts ONE turn with the digest; a parent busy on a harness whose
 * steer lands at a step gets them at its next step; one whose steer would
 * interrupt (Cursor) gets them as a message queued for its turn's end. Wakes
 * past `WAKES_PER_MINUTE` for a lead wait, decisions first. Nothing polls:
 * a timer runs only while notices wait.
 */
export class AgentWakes {
  private readonly deps: AgentWakesDeps
  private readonly waiting = new Map<string, Waiting>()
  private readonly heard = new Set<string>()
  private readonly wakes = new Map<string, number[]>()
  private stopped = false

  constructor(deps: AgentWakesDeps) {
    this.deps = deps
  }

  /** A notice for `conversation`, the parent's, under lead `lead`; one already heard or waiting changes nothing. */
  notice(conversation: string, lead: string, notice: Notice): void {
    if (this.stopped || this.heard.has(notice.id)) return
    const held = this.waiting.get(conversation)
    if (held?.notices.some((waiting) => waiting.id === notice.id)) return
    const waiting = held ?? { lead, notices: [] }
    waiting.notices.push(notice)
    this.waiting.set(conversation, waiting)
    hostLog("agents", "notice", { notice: notice.id, report: notice.report.id, status: notice.report.status, conversation })
    if (!waiting.timer && !waiting.forTurnEnd) this.after(conversation, waiting, WAKE_COALESCE_MS)
  }

  /** The parent's turn ended: what waited for it goes now, as a wake once it's idle. */
  settled(conversation: string): void {
    const waiting = this.waiting.get(conversation)
    if (!waiting?.forTurnEnd) return
    waiting.forTurnEnd = undefined
    if (!waiting.timer) this.after(conversation, waiting, WAKE_COALESCE_MS)
  }

  /** How many notices wait, across every parent: Diagnostics shows it. */
  pending(): number {
    let count = 0
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
    const ready = this.deps.ready(conversation)
    if (ready === "gone") {
      // Kept unheard in the store: the host that has the parent sends them on its start.
      this.waiting.delete(conversation)
      return
    }
    if (ready === "queue") {
      waiting.forTurnEnd = true
      return
    }
    const batch = nextBatch(waiting.notices)
    const ids = batch.map((notice) => notice.report.id)
    const request = batch[0]!.wake ?? namedUuid(`wake:${conversation}:${ids.join("\n")}`)
    const text = digest(batch, this.deps.counts(conversation))
    if (ready === "steer") {
      if (this.deps.steer(conversation, namedUuid(`steer:${request}`), text)) return this.sent(conversation, waiting, batch, request, "steer")
      waiting.forTurnEnd = true
      return
    }
    const now = this.now()
    const recent = (this.wakes.get(waiting.lead) ?? []).filter((at) => now - at < MINUTE_MS)
    this.wakes.set(waiting.lead, recent)
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

  private sent(conversation: string, waiting: Waiting, batch: readonly Notice[], request: string, how: "turn" | "steer"): void {
    const ids = batch.map((notice) => notice.report.id)
    this.deps.delivered(ids, this.now())
    for (const notice of batch) this.heard.add(notice.id)
    waiting.notices = waiting.notices.filter((notice) => !batch.includes(notice))
    hostLog("agents", "wake", { conversation, request, how, coalesced: batch.length, waiting: waiting.notices.length })
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
 * request for go again alone under it, so a turn the parent took before the
 * stop is taken as the same turn; the rest go together, decisions first.
 */
function nextBatch(notices: readonly Notice[]): Notice[] {
  const named = notices.find((notice) => notice.wake)?.wake
  if (named) return notices.filter((notice) => notice.wake === named)
  return notices.filter((notice) => !notice.wake)
}

const DECIDES = new Set<Report["status"]>(["blocked", "needs-input"])

/** The digest in its fixed shape: decisions first, then what finished, then how the rest stand. */
export function digest(notices: readonly Notice[], counts: string): string {
  const decisions = notices.filter((notice) => DECIDES.has(notice.report.status))
  const finished = notices.filter((notice) => notice.report.status === "done" || notice.report.status === "failed")
  const lines = [FROM_AGENTS]
  if (decisions.length) {
    lines.push(`${decisions.length} ${decisions.length === 1 ? "needs" : "need"} a decision:`)
    for (const { label, report } of decisions)
      lines.push(`  • ${label} is ${report.status === "blocked" ? "blocked" : "asking"}: ${report.question ?? reportPhase(report) ?? "it asks for a decision."}`)
  }
  if (finished.length) {
    lines.push(`${finished.length} finished:`)
    for (const { label, report } of finished) {
      const artifacts = report.artifacts?.length ? ` ${report.artifacts.map((artifact) => artifact.label ?? artifact.ref).join(", ")}.` : ""
      lines.push(`  • ${label} ${report.status}: ${reportPhase(report) ?? (report.status === "done" ? "it finished." : "it failed.")}${artifacts}`)
    }
  }
  lines.push(counts)
  lines.push("agents_read gives a report in full. Reply to the person, start more work, or end your turn.")
  return lines.join("\n")
}
