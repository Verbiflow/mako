import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import { APEX_WORD, decisionWords, FIN_WORD, reportAsk, reportPhase, waitingWords, type Notice, type Report } from "../contracts/agents.js"
import { appendFinReports, FIN_REPORTS_MAX, type FinReportCard } from "../contracts/fin-reports.js"
import { FROM_AGENTS } from "../contracts/children.js"
import { WAKE_COALESCE_MS } from "../contracts/children.js"
import { SessionIdSchema, type Actor } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"

export { DIGEST_WAITS, FROM_AGENTS, fromAgent, WAKE_COALESCE_MS, WAKES_PER_MINUTE } from "../contracts/children.js"

/** A result the Apex waited for goes after this: the Apex asked for it, so only what settles with it joins it. */
export const RESULT_COALESCE_MS = 250
/** The most of a waited-for result its wake carries; `agents_read` gives the rest. */
const RESULT_CHARS = 8_000
/** What a decision's report says beside its question, at most: the rest is `agents_read`'s. */
const DECISION_CHARS = 600

export type { Notice } from "../contracts/agents.js"

/** What an Apex's conversation can take now; `paused`: it's a Fin its Apex stopped, which hears its own Fins once resumed. */
export type ParentReady = "steer" | "queue" | "idle" | "paused" | "gone"

/** A digest waiting in an Apex's queue, unsent: its request and the notices it carries (`LiveRequest.digest`). */
export interface OpenDigest {
  id: string
  notices: readonly Notice[]
  /** What it carries beside them (`takeLines`), which every rewrite of it keeps. */
  lines?: readonly string[]
}

export interface AgentWakesDeps {
  /** What the Apex's conversation is doing: busy at a step a message joins, busy until its turn's end, idle, stopped, or not here. */
  ready(conversation: string): ParentReady
  /** The digests waiting unsent in the Apex's queue, oldest first: the newest is the one a new notice joins. */
  unsent(conversation: string): OpenDigest[]
  /** Whether a digest in the Apex's queue, sent or not, carries this notice: its receipt, read again after a crash. */
  carried(conversation: string, notice: string): boolean
  /**
   * Puts the digest in the Apex's queue under `request`, as the agent `actor`'s words: held until `at` when given (the
   * burst's window), paused when the Apex is a stopped Fin. The minute's budget is the queue's, as it sends. A request taken once already is
   * the same one.
   */
  admit(conversation: string, request: string, text: string, notices: readonly Notice[], actor: Extract<Actor, { kind: "agent" }>, hold: { at: number } | "paused" | undefined, lines?: readonly string[]): void
  /** The unsent digest `request` says `text` now, carrying `notices` and `lines`; false when it went meanwhile. */
  rewrite(conversation: string, request: string, text: string, notices: readonly Notice[], lines?: readonly string[]): boolean
  /** Joins the digest to the running turn at its next step, resolving whether the harness took it; false when no turn could take one. */
  steer(conversation: string, id: string, text: string): Promise<boolean> | false
  /** The request named before it's sent, and the reports marked heard once it was (`ThreadStore`). */
  assign(reports: readonly string[], request: string): void
  delivered(reports: readonly string[], at: number): void
  /** The digest's last line: how the Apex's Fins stand now. */
  counts(conversation: string): string
  /** What rides the next digest and wakes nobody by itself (a Fin's move): handed over once, to go in that digest. */
  takeLines?(conversation: string): string[]
  /** Lines no digest ended up carrying, for the next one. */
  giveLines?(conversation: string, lines: readonly string[]): void
  /** Whether a notice still says how its Fin stands: an end the host inferred for a Fin that works again doesn't. */
  current?(notice: Notice): boolean
  now?(): number
}

/**
 * The Apex's side of a report (6.6): a producer into the Apex's own queue,
 * which keeps every digest durably, sends it once and in order, and retries
 * what its harness can't take for now (`delivery-queue.md`, step 2). A notice
 * joins the digest still unsent in the Apex's queue, or starts one: held
 * `WAKE_COALESCE_MS` for an idle Apex so a burst is one wake, `RESULT_COALESCE_MS`
 * for a result the Apex waited for (`settledOnly`), which also goes first and
 * in full; queued for a busy Apex's turn end; steered into the running turn
 * at its next step where the harness takes that, and admitted when it
 * doesn't; paused for a stopped Fin until it's resumed. Past
 * `WAKES_PER_MINUTE` a digest waits for the minute's budget, which the queue
 * keeps as it sends (`LiveDispatch`). Its reports are
 * heard once it's in the queue: the queue, not this, delivers it.
 */
export class AgentWakes {
  private readonly deps: AgentWakesDeps
  private readonly heard = new Set<string>()
  /** Notices a steer carries until the harness answers it: heard if it took them, else admitted. */
  private readonly steering = new Set<string>()
  /** Notices waiting for their Apex's conversation to be read in (`noticeWhen`). */
  private reading = 0
  /** Conversations with a digest admitted, for `pending`. */
  private readonly digests = new Set<string>()
  private stopped = false

  constructor(deps: AgentWakesDeps) {
    this.deps = deps
  }

  /** A notice for `conversation`, the Apex's, under Apex `apex`; one already heard, waiting or carried changes nothing. */
  notice(conversation: string, _apex: string, notice: Notice): void {
    if (this.stopped || this.heard.has(notice.id) || this.steering.has(notice.id)) return
    // Its receipt: a digest in the queue carries it already (a host that died between the digest and the store's
    // receipt wrote the one and not the other), so it's heard, never sent twice.
    if (this.deps.carried(conversation, notice.id)) {
      this.heardNow([notice])
      return
    }
    hostLog("agents", "notice", { notice: notice.id, report: notice.report.id, status: notice.report.status, conversation, ...(notice.settledOnly && { settledOnly: true }) })
    if (this.deps.current && !this.deps.current(notice)) {
      this.heardNow([notice])
      hostLog("agents", "stale end not reported", { conversation, reports: notice.report.id })
      return
    }
    const ready = this.deps.ready(conversation)
    // Kept unheard in the store: the host that has the Apex sends them on its start.
    if (ready === "gone") return
    // A running turn that takes a message at its next step hears this now; a result waits for the turn's end.
    if (ready === "steer" && !notice.settledOnly && !notice.wake) return this.steerIn(conversation, notice)
    const open = this.deps.unsent(conversation).at(-1)
    if (open) return this.join(conversation, open, notice)
    this.start(conversation, [notice], ready)
  }

  /**
   * What the Apex's unsent digests say is read again: a notice no longer current (an end the host inferred for a Fin
   * that works again) leaves each of them, so no digest says a Fin ended while it works. Asked as a Fin's state moves.
   */
  refresh(conversation: string): void {
    if (!this.deps.current) return
    for (const open of this.deps.unsent(conversation)) {
      const rest = open.notices.filter((notice) => this.deps.current!(notice))
      if (rest.length === open.notices.length) continue
      this.narrow(conversation, open, rest)
      hostLog("agents", "stale end not reported", { conversation, reports: open.notices.filter((notice) => !rest.includes(notice)).map((notice) => notice.report.id).join(" ") })
    }
  }

  /** The Apex's turn ended: its queue sends what waits next, said as its Fins stand now (`refresh`). */
  settled(conversation: string): void {
    this.refresh(conversation)
  }

  /** Takes back a notice its Apex heard another way (a `wait` start that answers its result), from whichever unsent digest has it; false when none does. */
  withdraw(conversation: string, id: string): boolean {
    let found = false
    for (const open of this.deps.unsent(conversation)) {
      if (!open.notices.some((notice) => notice.id === id)) continue
      found = true
      this.narrow(conversation, open, open.notices.filter((notice) => notice.id !== id))
    }
    if (found) this.heard.add(id)
    return found
  }

  /** The digest's words: its notices, then what rides with them, then how the Fins stand. */
  private words(conversation: string, notices: readonly Notice[], lines: readonly string[]): string {
    return digest(notices, [...lines, this.deps.counts(conversation)].join("\n"))
  }

  /** `open` keeps only `rest`, and all it carried; with nothing left it's gone, and its lines wait for the next digest. */
  private narrow(conversation: string, open: OpenDigest, rest: readonly Notice[]): void {
    const lines = open.lines ?? []
    const rewritten = this.deps.rewrite(conversation, open.id, rest.length ? this.words(conversation, rest, lines) : "", rest, lines)
    if (rewritten && !rest.length && lines.length) this.deps.giveLines?.(conversation, lines)
  }

  /** Whether a steer carrying this notice hasn't been answered yet. */
  steered(id: string): boolean {
    return this.steering.has(id)
  }

  /** Whether a digest waits unsent in this Apex's queue: a turn of its own is coming. */
  waits(conversation: string): boolean {
    return this.deps.unsent(conversation).length > 0
  }

  /** How many digests wait unsent, every Apex's, and steers unanswered: Diagnostics shows it. */
  /**
   * A notice for an Apex whose conversation is being read in first (`Agents.noticeOf`): it's under way until `ready`
   * settles, and is noticed then if it says the conversation was read. Counted as pending meanwhile, so nothing that
   * waits for the wakes to settle (a stop, Diagnostics, a test's `settle`) takes the wait for none.
   */
  noticeWhen(ready: Promise<boolean>, conversation: string, apex: string, notice: Notice): void {
    this.reading += 1
    void ready.then((read) => {
      if (read && !this.stopped) this.notice(conversation, apex, notice)
    }, (error: Error) => hostWarn("agents", "an Apex's conversation couldn't be read in for a notice; it waits unheard", { notice: notice.id, error: errorMessage({ error }) }))
      .finally(() => { this.reading -= 1 })
  }

  pending(): number {
    let count = this.steering.size + this.reading
    for (const conversation of this.digests) {
      const unsent = this.deps.unsent(conversation).length
      if (unsent) count += unsent
      else this.digests.delete(conversation)
    }
    return count
  }

  dispose(): void {
    this.stopped = true
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * A notice joins the digest still unsent; one that went meanwhile leaves it to start the next. Its three writes (the
   * digest, the store's claim, its receipt) are each idempotent and read again on recovery (`carried`).
   */
  private join(conversation: string, open: OpenDigest, notice: Notice): void {
    // A digest carries at most `FIN_REPORTS_MAX`; past that the notice starts the next one.
    if (open.notices.length >= FIN_REPORTS_MAX) return this.start(conversation, [notice], this.deps.ready(conversation))
    const notices = [...open.notices, notice]
    const fresh = this.deps.takeLines?.(conversation) ?? []
    const lines = [...open.lines ?? [], ...fresh]
    const alone = () => {
      if (fresh.length) this.deps.giveLines?.(conversation, fresh)
      this.start(conversation, [notice], this.deps.ready(conversation))
    }
    let text: string
    try {
      text = this.words(conversation, notices, lines)
    } catch (error) {
      hostWarn("agents", "a digest could not be written with this notice; it starts its own", { conversation, error: errorMessage({ error }) })
      return alone()
    }
    if (!this.deps.rewrite(conversation, open.id, text, notices, lines)) return alone()
    hostLog("agents", "digest joined", { conversation, request: open.id, notice: notice.id })
    this.deps.assign([notice.report.id], open.id)
    hostLog("agents", "digest join assigned", { conversation, request: open.id, notice: notice.id })
    this.heardNow([notice])
    hostLog("agents", "wake", { conversation, request: open.id, how: "joined", coalesced: notices.length })
  }

  /** A digest of its own in the Apex's queue, held for its burst's window. */
  private start(conversation: string, notices: Notice[], ready: ParentReady): void {
    const now = this.now()
    const request = notices[0]!.wake ?? namedUuid(`wake:${conversation}:${notices.map((notice) => notice.report.id).join("\n")}`)
    const window = notices.some((notice) => notice.settledOnly) ? RESULT_COALESCE_MS : WAKE_COALESCE_MS
    const hold = ready === "paused" ? "paused" : ready === "idle" ? { at: now + window } : undefined
    const lines = this.deps.takeLines?.(conversation) ?? []
    try {
      if (!notices[0]!.wake) this.deps.assign(notices.map((notice) => notice.report.id), request)
      hostLog("agents", "digest start assigned", { conversation, request, notices: notices.length })
      this.deps.admit(conversation, request, this.words(conversation, notices, lines), notices, { kind: "agent", session: SessionIdSchema.parse(notices[0]!.from) }, hold, lines)
    } catch (error) {
      // The Apex's conversation refused it for now (a switch or a move under way): asked again after the window.
      hostWarn("agents", "a digest could not be queued yet; it's asked again", { conversation, error: errorMessage({ error }) })
      if (lines.length) this.deps.giveLines?.(conversation, lines)
      const timer = setTimeout(() => { for (const notice of notices) this.notice(conversation, "", notice) }, WAKE_COALESCE_MS)
      timer.unref?.()
      return
    }
    hostLog("agents", "digest admitted", { conversation, request })
    this.digests.add(conversation)
    this.heardNow(notices)
    hostLog("agents", "wake", { conversation, request, how: "queued", coalesced: notices.length, ...(hold && { hold: hold === "paused" ? "paused" : new Date(hold.at).toISOString() }) })
  }

  /** Into the running turn at its next step; what the harness doesn't take goes as a digest of its own. */
  private steerIn(conversation: string, notice: Notice): void {
    const request = namedUuid(`wake:${conversation}:${notice.report.id}`)
    const lines = this.deps.takeLines?.(conversation) ?? []
    const back = () => { if (lines.length) this.deps.giveLines?.(conversation, lines) }
    const took = this.deps.steer(conversation, namedUuid(`steer:${request}`), this.words(conversation, [notice], lines))
    if (!took) {
      back()
      return this.start(conversation, [notice], this.deps.ready(conversation))
    }
    this.steering.add(notice.id)
    void took.then((answered) => {
      this.steering.delete(notice.id)
      if (this.stopped) return
      if (answered) {
        this.heardNow([notice])
        hostLog("agents", "wake", { conversation, request, how: "steer", coalesced: 1 })
        return
      }
      hostLog("agents", "steer not taken; its notice goes as the next turn", { conversation, request })
      back()
      const open = this.deps.unsent(conversation).at(-1)
      if (open) this.join(conversation, open, notice)
      else this.start(conversation, [notice], this.deps.ready(conversation))
    })
  }

  private heardNow(notices: readonly Notice[]): void {
    this.deps.delivered(notices.map((notice) => notice.report.id), this.now())
    for (const notice of notices) this.heard.add(notice.id)
  }
}

const DECIDES = new Set<Report["status"]>(["blocked", "needs-input"])

/** The digest in its fixed shape: the results waited for, in full; other Apexes' replies, in full; then decisions; then what finished; then how the rest stand. */
export function digest(notices: readonly Notice[], counts: string): string {
  const results = notices.filter((notice) => notice.settledOnly)
  const replies = notices.filter((notice) => notice.reply)
  const fins = notices.filter((notice) => !notice.settledOnly && !notice.reply)
  const asks = fins.filter((notice) => DECIDES.has(notice.report.status))
  const decided = fins.filter((notice) => notice.decision)
  const decisions = [...asks.filter((notice) => notice.report.for !== "person"), ...decided.filter((notice) => notice.decision === "lead")]
  const persons = [...asks.filter((notice) => notice.report.for === "person"), ...decided.filter((notice) => notice.decision === "person")]
  const finished = fins.filter((notice) => !notice.decision && (notice.report.status === "done" || notice.report.status === "failed"))
  const handoffs = fins.filter((notice) => notice.report.status === "progress" && notice.report.handoff)
  const lines = [FROM_AGENTS]
  // Every entry the digest writes has its twin here, from the same record, in the same order.
  const cards: FinReportCard[] = []
  if (results.length) {
    lines.push(results.length === 1 ? "The result you waited for:" : `The ${results.length} results you waited for:`)
    for (const notice of results) {
      const { label, report, decision } = notice
      const summary = report.summary.trim() || (report.status === "done" ? "It finished." : "It failed.")
      const text = summary.length > RESULT_CHARS ? `${summary.slice(0, RESULT_CHARS)}… (agents_read gives the rest)` : summary
      lines.push(`  • ${label} ${report.status}:`, ...text.split("\n").map((line) => `    ${line}`))
      cards.push(card(notice, opening(report.summary) || (report.status === "done" ? "It finished." : "It failed.")))
      for (const artifact of report.artifacts ?? []) lines.push(`    ${artifact.kind}: ${artifact.ref}${artifact.label ? ` (${artifact.label})` : ""}`)
      if (decision && report.question) lines.push(`    ${decisionWords({ question: report.question, on: decision, ask: reportAsk(report) })}`)
    }
  }
  if (replies.length) {
    lines.push(replies.length === 1 ? `Another ${APEX_WORD}'s reply to your message:` : `${replies.length} other ${APEX_WORD}es' replies to your messages:`)
    for (const notice of replies) {
      const { label, report } = notice
      cards.push(card(notice, opening(report.summary)))
      const said = report.summary.trim()
      const text = said.length > RESULT_CHARS ? `${said.slice(0, RESULT_CHARS)}… (+${(said.length - RESULT_CHARS).toLocaleString("en-US")} chars)` : said
      lines.push(`  • ${label} ${report.status === "done" ? "replied" : "failed"}:`, ...text.split("\n").map((line) => `    ${line}`))
    }
    lines.push("  Don't reply to a reply unless it asks you something.")
  }
  if (decisions.length) {
    lines.push(`${decisions.length} ${decisions.length === 1 ? "needs" : "need"} a decision:`)
    for (const notice of decisions) {
      const { label, report } = notice
      if (notice.decision) {
        lines.push(`  • ${label} ${decidedLine(report, "lead")}`)
        cards.push(card(notice, report.question ?? reportPhase(report) ?? "it leaves a decision."))
        artifactLines(lines, report)
        continue
      }
      const asked = report.question ?? reportPhase(report) ?? "it asks for a decision."
      const waiting = waitingWords(report.waitingOn)
      lines.push(`  • ${label} is ${report.status === "blocked" ? "blocked" : "asking"}: ${asked}${waiting ? ` · ${waiting}` : ""}`)
      cards.push(card(notice, asked))
      // What it said beside the question: why it asks, as a cut turn's what cut it and what it had in flight.
      const said = report.summary.replace(/\s+/g, " ").trim()
      if (report.question && said && said !== report.question.trim()) lines.push(`    ${said.length > DECISION_CHARS ? `${said.slice(0, DECISION_CHARS - 1)}…` : said}`)
      if (report.options?.length)
        lines.push(`    options: ${report.options.map((option, index) => `${option.label}${index === report.recommended ? " (recommended)" : ""}`).join(" · ")}`)
    }
    lines.push("  agents_answer answers each, or leaves it to the person with person: true.")
  }
  if (persons.length) {
    lines.push(`${persons.length} ${persons.length === 1 ? "waits" : "wait"} on the person:`)
    for (const notice of persons) {
      const { label, report } = notice
      if (!notice.decision) {
        const asked = report.question ?? reportPhase(report) ?? "it waits on the person."
        lines.push(`  • ${label}: ${asked}`)
        cards.push(card(notice, asked))
        continue
      }
      // An escalated decision is still the Apex's to answer; one the Fin left to the person, or its spawn hears only as a result, is theirs.
      const why = report.told
        ? "Mako asked the person too, since you didn't answer it in time: they can answer it from their Inbox. You may still answer it with agents_answer; the first answer is the one it hears."
        : "It's the person's: they answer it from their Inbox. Don't answer it."
      lines.push(`  • ${label} ${decidedLine(report, "person")}. ${why}`)
      cards.push(card(notice, report.question ?? reportPhase(report) ?? "it leaves a decision."))
      artifactLines(lines, report)
    }
  }
  if (finished.length) {
    lines.push(`${finished.length} finished:`)
    for (const notice of finished) {
      const { label, report } = notice
      lines.push(`  • ${label} ${report.status}: ${finishedLine(report)}`)
      cards.push(card(notice, opening(report.summary) || (report.status === "done" ? "It finished." : "It failed.")))
      artifactLines(lines, report)
    }
  }
  if (handoffs.length) {
    lines.push(`${handoffs.length} ${handoffs.length === 1 ? "hands" : "hand"} work to another ${FIN_WORD}:`)
    for (const notice of handoffs) {
      const { label, report } = notice
      const handoff = report.handoff!
      const said = (handoff.text ?? report.summary).trim()
      const text = said.length > RESULT_CHARS ? `${said.slice(0, RESULT_CHARS)}… (agents_read gives the rest)` : said
      lines.push(`  • ${label} → ${handoff.to}${handoff.text ? " (a message it couldn't send)" : ""}:`, ...text.split("\n").map((line) => `    ${line}`))
      cards.push(card(notice, opening(report.summary)))
    }
    lines.push(`  agents_send to each passes it on.`)
  }
  lines.push(counts)
  lines.push((results.length || replies.length) && !decisions.length && !persons.length && !finished.length && !handoffs.length
    ? "Go on with it: reply to the person, start more work, or end your turn."
    : "agents_read gives a report in full. Reply to the person, start more work, or end your turn.")
  return appendFinReports(lines.join("\n"), cards)
}

/** A notice's report as the person's card of it reads, with the line its digest entry gave it. */
function card(notice: Notice, line: string): FinReportCard {
  const { report } = notice
  return {
    report: report.id,
    fin: report.child,
    name: notice.fin.name,
    ...(notice.fin.harness && { harness: notice.fin.harness }),
    ...(notice.reply && { apex: true as const }),
    status: report.status,
    line: line.slice(0, 4_000),
    ...(report.options?.length && { options: report.options }),
    ...(report.recommended !== undefined && { recommended: report.recommended }),
    ...(report.artifacts?.length && { artifacts: report.artifacts }),
    ...(report.for === "person" && { forPerson: true as const }),
    ...(notice.decision && { decides: notice.decision }),
    ...(waitingWords(report.waitingOn) && { waiting: waitingWords(report.waitingOn) }),
  }
}

/** A summary's paragraphs, less its headings and rules. */
function paragraphsOf(summary: string): string[] {
  return summary.trim().split(/\n\s*\n/).map((paragraph) => paragraph.split("\n").filter((line) => !/^\s*(#{1,6}\s|[-*_]{3,}\s*$)/.test(line)).join("\n").trim()).filter(Boolean)
}

/** A summary's first paragraph past any heading, on one line, whole. */
function opening(summary: string): string {
  return (paragraphsOf(summary)[0] ?? summary.trim()).replace(/\s+/g, " ")
}

function artifactLines(lines: string[], report: Report): void {
  for (const artifact of report.artifacts ?? []) lines.push(`    ${artifact.kind}: ${artifact.ref}${artifact.label ? ` (${artifact.label})` : ""}`)
}

/**
 * A done report's decision as its digest line says it (`decisionWords`), with how much of its report
 * `agents_read` gives: "done; decide: Merge #371? (Merge · Leave open, recommends Merge) (+412 chars: agents_read)".
 */
export function decidedLine(report: Report, on: "lead" | "person"): string {
  const decided = decisionWords({ question: report.question ?? reportPhase(report) ?? "it leaves a decision.", on, ask: reportAsk(report) })
  const waiting = waitingWords(report.waitingOn)
  const words = waiting ? `${decided} · ${waiting}` : decided
  const more = report.summary.trim().length
  return more ? `${words} (+${more.toLocaleString("en-US")} chars: agents_read)` : words
}

/**
 * A finished report as its digest line says it: its first paragraph past any heading, on one line, at most
 * `FINISHED_CHARS`, and how much more `agents_read` gives when there is more.
 */
export function finishedLine(report: Report): string {
  const summary = report.summary.trim()
  if (!summary) return report.status === "done" ? "it finished." : "it failed."
  return firstParagraph(summary)
}

/** Words as a line of a digest carries them: the first paragraph past any heading, at most `FINISHED_CHARS`, and how much more there is. */
export function firstParagraph(text: string): string {
  const summary = text.trim()
  const paragraphs = paragraphsOf(summary)
  const first = opening(summary)
  if (paragraphs.length <= 1 && first.length <= FINISHED_CHARS) return first
  const shown = first.length > FINISHED_CHARS ? `${first.slice(0, FINISHED_CHARS - 1).trimEnd()}…` : first
  return `${shown} (+${Math.max(1, summary.length - shown.length).toLocaleString("en-US")} chars)`
}
/** The most of a finished report's first paragraph its digest line carries. */
const FINISHED_CHARS = 480

