import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import { APEX_WORD, decisionWords, FIN_WORD, reportAsk, reportPhase, reportWord, UNFINISHED_WORDS, waitingWords, type Notice, type Report } from "../contracts/agents.js"
import { appendFinReports, FIN_REPORTS_MAX, type FinReportCard } from "../contracts/fin-reports.js"
import { FROM_AGENTS } from "../contracts/children.js"
import { collisionLine, FOCUS_MS, HOLD_RESULTS_MS, quietLine, WAKE_COALESCE_MS } from "../contracts/children.js"
import { SessionIdSchema, type Actor } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"

export { DIGEST_WAITS, FROM_AGENTS, fromAgent, HOLD_RESULTS_MS, WAKE_COALESCE_MS, WAKES_PER_MINUTE } from "../contracts/children.js"

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
  /** Held for the Fins still at work (`HOLD_RESULTS_MS`): when its first result was held (`RequestWake.since`). */
  held?: number
}

export interface AgentWakesDeps {
  /** What the Apex's conversation is doing: busy at a step a message joins, busy until its turn's end, idle, stopped, or not here. */
  ready(conversation: string): ParentReady
  /** When the Apex's last digest went to its harness (`LiveRequest.digest.sentAt`), if one has: the next waits out its window from then. */
  lastSent?(conversation: string): number | undefined
  /** Whether a `wait` start is still waiting on this notice's Fin: its answer will carry the result (`withdraw`). */
  awaited?(notice: Notice): boolean
  /** Whether the Apex's conversation is moving to another harness or account for now (a usage limit's move). */
  moving?(conversation: string): boolean
  /** Whether a Fin of the Apex other than `but` is working, starting or queued to start: a result that asks nothing waits for those. */
  working?(conversation: string, but?: string): boolean
  /** Whether the turn the Apex runs is its Fins' news alone, a digest's own: a result is held through it as while it's idle. */
  onNews?(conversation: string): boolean
  /** Whether a wait its Apex armed names this notice's Fin (a turn wait): its result is what that wait is for. */
  waitedFor?(notice: Notice): boolean
  /** The digests waiting unsent in the Apex's queue, oldest first: the newest is the one a new notice joins. */
  unsent(conversation: string): OpenDigest[]
  /** Whether a digest in the Apex's queue, sent or not, carries this notice: its receipt, read again after a crash. */
  carried(conversation: string, notice: string): boolean
  /**
   * Puts the digest in the Apex's queue under `request`, as the agent `actor`'s words: held until `at` when given (the
   * burst's window, or with `since` the Fins still at work), paused when the Apex is a stopped Fin. The minute's budget
   * is the queue's, as it sends. A request taken once already is the same one.
   */
  admit(conversation: string, request: string, text: string, notices: readonly Notice[], actor: Extract<Actor, { kind: "agent" }>, hold: { at: number; since?: number } | "paused" | undefined, lines?: readonly string[]): void
  /**
   * The unsent digest `request` says `text` now, carrying `notices` and `lines`; false when it went meanwhile. `free`:
   * one held for the Fins still at work is held no longer, and goes now.
   */
  rewrite(conversation: string, request: string, text: string, notices: readonly Notice[], lines?: readonly string[], free?: boolean): boolean
  /** Joins the digest to the running turn at its next step, resolving whether the harness took it; false when no turn could take one. */
  steer(conversation: string, id: string, text: string): Promise<boolean> | false
  /**
   * Steers the queued digest `request` itself into the running turn (the journal's `steer-queued`), so it's taken from
   * the queue exactly once, in the same write, and one the harness refuses stays where it was queued; false when no turn
   * could take it.
   */
  steerQueued?(conversation: string, id: string, request: string, text: string): Promise<boolean> | false
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
  /** How long a working Apex's turn runs before what waits for its end is steered in once (`FOCUS_MS`); a test shortens it. */
  focusMs?: number
  /** How long results that ask nothing wait for the Fins still at work (`HOLD_RESULTS_MS`); a test shortens it. */
  holdMs?: number
}

/**
 * A notice its Apex can act on at once: a question or decision that is the Apex's to answer, never the person's; work
 * a Fin hands it (`handoff`); a wait a Fin names on the Apex or the person (`awaits`).
 */
function asksApex(notice: Notice): boolean {
  const { status, for: owner, handoff, awaits } = notice.report
  return ((status === "blocked" || status === "needs-input") && owner !== "person") || notice.decision === "lead" || Boolean(handoff) || Boolean(awaits)
}

/**
 * A result that asks its Apex nothing: a done report with no question and no decision, which no `wait` start waited
 * for (`settledOnly`). A failure, an end without a result, a question, a handoff, a wait on someone, another Apex's
 * reply and Mako's own notices (a quiet Fin, an unanswered message, two changing one file) are none of them. What
 * starts `after` it Mako starts itself.
 */
function asksNothing(notice: Notice): boolean {
  const { report } = notice
  return report.status === "done" && !report.question?.trim() && !notice.decision && !notice.settledOnly && !notice.reply && !notice.quiet && !notice.unanswered && !notice.collision
}

/**
 * The Apex's side of a report (6.6): a producer into the Apex's own queue,
 * which keeps every digest durably, sends it once and in order, and retries
 * what its harness can't take for now (`delivery-queue.md`, step 2). A notice
 * joins the digest still unsent in the Apex's queue, or starts one. An idle
 * Apex hears the first at once: held two seconds for a burst that never came,
 * a lone report was two seconds its Apex stood idle (`npm run
 * bench:orch-wake-latency`). What follows joins one digest: while the Apex's
 * turn on the first runs, queued for that turn's end; once that turn is over,
 * held until `WAKE_COALESCE_MS` after the last digest went (`RESULT_COALESCE_MS`
 * for a result the Apex waited for, `settledOnly`, which also goes first and in
 * full). So a burst is two wakes, the first report's and everything else's,
 * never one a report. Nor one a result when they come minutes apart: once the
 * Apex heard one, a result that asks nothing is held in the unsent digest for
 * the Fins still at work, `HOLD_RESULTS_MS` at most, and what ends the hold
 * sends them together (`waitsForOthers`, `release`). Queued for a busy
 * Apex's turn end; steered into the running turn at its next step where the
 * harness takes that, and admitted when it doesn't; paused for a stopped Fin
 * until it's resumed. Past `WAKES_PER_MINUTE` a digest waits for the minute's
 * budget, which the queue keeps as it sends (`LiveDispatch`). Its reports are
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
  /** A working Apex's turn's focus timer: when it fires, what waits for the turn's end is steered in once. */
  private readonly focus = new Map<string, ReturnType<typeof setTimeout>>()
  /** Digests being steered into their Apex's turn: none joins or narrows one while it's out (`armFocus`). */
  private readonly focusing = new Set<string>()
  /** Notices of reports a previous host left unheard, until this host first queues them (`leftOver`). */
  private readonly leftOvers = new Set<string>()
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
    // A running turn that takes a message at its next step hears a question it can answer now. The rest waits for the
    // turn's end as one digest, so the Apex isn't steered by each report while it works, unless its turn runs long.
    if (ready === "steer" && !notice.settledOnly && !notice.wake) {
      if (asksApex(notice)) {
        // What was held for the others waits no longer: it goes at this turn's end, or with the ask if the turn refuses it.
        this.release(conversation, "a Fin asks")
        return this.steerIn(conversation, notice)
      }
      this.armFocus(conversation)
    }
    const open = this.open(conversation)
    if (open) return this.join(conversation, open, notice)
    this.start(conversation, [notice], ready)
  }

  /** The newest digest still unsent that a notice may join: not one being steered in (`focusing`). */
  private open(conversation: string): OpenDigest | undefined {
    return this.deps.unsent(conversation).filter((digest) => !this.focusing.has(digest.id)).at(-1)
  }

  /**
   * What the Apex's unsent digests say is read again: a notice no longer current (an end the host inferred for a Fin
   * that works again) leaves each of them, so no digest says a Fin ended while it works. Asked as a Fin's state moves.
   */
  refresh(conversation: string): void {
    let held = false
    for (const open of this.deps.unsent(conversation)) {
      if (this.focusing.has(open.id)) continue
      if (open.held !== undefined) held = true
      if (!this.deps.current) continue
      const rest = open.notices.filter((notice) => this.deps.current!(notice))
      if (rest.length === open.notices.length) continue
      this.narrow(conversation, open, rest)
      hostLog("agents", "stale end not reported", { conversation, reports: open.notices.filter((notice) => !rest.includes(notice)).map((notice) => notice.report.id).join(" ") })
    }
    // Results held for the Fins still at work have none to wait for once the last of them stopped working, however it did.
    if (held && !this.deps.working?.(conversation)) this.release(conversation, "none of its Fins is at work")
  }

  /**
   * Whether a result waits for the others, to go with theirs as one digest: it asks nothing (`asksNothing`), a Fin of
   * its Apex other than its own is still working, starting or queued, and no wait its Apex armed names it. Its own Fin
   * reads as working until the turn it reported from ends, so it isn't asked about.
   */
  private waitsForOthers(conversation: string, notice: Notice): boolean {
    return asksNothing(notice) && this.deps.working?.(conversation, notice.report.child) === true && !this.deps.waitedFor?.(notice)
  }

  /**
   * The results held for the Fins still at work go now, as one digest said as the tree stands: a Fin asked or failed,
   * none is at work any more, or a turn of the Apex's own ended. The person's message takes them along in the queue
   * (`foldQueued`), and their time (`HOLD_RESULTS_MS` from the first held) is the queue's to keep, across a restart too.
   */
  private release(conversation: string, why: string): void {
    for (const open of this.deps.unsent(conversation)) {
      if (open.held === undefined || this.focusing.has(open.id)) continue
      if (!this.deps.rewrite(conversation, open.id, this.words(conversation, open.notices, open.lines ?? []), open.notices, open.lines, true)) continue
      hostLog("agents", "held results go", { conversation, request: open.id, why, coalesced: open.notices.length, heldMs: this.now() - open.held })
    }
  }

  /**
   * Reports a previous host left unheard, about to be noticed again as this host starts (`Agents.resume`). Their digest
   * waits `WAKE_COALESCE_MS` even when it is an idle Apex's first: one may have reached its Apex already by a way whose
   * receipt this host reads back only as it takes the Apex up (a steer its harness had when that host died), and that
   * receipt takes it back from the digest while it waits, rather than the Apex hearing it twice.
   */
  leftOver(ids: Iterable<string>): void {
    for (const id of ids) this.leftOvers.add(id)
  }

  /**
   * The Apex's turn ended: its queue sends what waits next, said as its Fins stand now (`refresh`). `own`: the turn was
   * one of its own, not its Fins' news alone, so it hears what was held for the others now, where it stopped anyway.
   */
  settled(conversation: string, own = false): void {
    this.refresh(conversation)
    if (own) this.release(conversation, "a turn of its own ended")
  }

  /** Takes back a notice its Apex heard another way (a `wait` start that answers its result), from whichever unsent digest has it; false when none does. */
  withdraw(conversation: string, id: string): boolean {
    let found = false
    for (const open of this.deps.unsent(conversation)) {
      if (this.focusing.has(open.id) || !open.notices.some((notice) => notice.id === id)) continue
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
    for (const timer of this.focus.values()) clearTimeout(timer)
    this.focus.clear()
    this.leftOvers.clear()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * A notice joins the digest still unsent; one that went meanwhile leaves it to start the next. Its three writes (the
   * digest, the store's claim, its receipt) are each idempotent and read again on recovery (`carried`).
   */
  private join(conversation: string, open: OpenDigest, notice: Notice): void {
    // A digest held for the Fins still at work stays held only while what joins it waits for them too: a failure, a
    // question, a waited-for result or the last Fin's result frees it, and they go together.
    const free = open.held !== undefined && !this.waitsForOthers(conversation, notice)
    // A digest carries at most `FIN_REPORTS_MAX`; past that the notice starts the next one, held with it or going behind it.
    if (open.notices.length >= FIN_REPORTS_MAX) {
      if (free) this.release(conversation, "a report that isn't held")
      return this.start(conversation, [notice], this.deps.ready(conversation), free ? undefined : open.held)
    }
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
    if (!this.deps.rewrite(conversation, open.id, text, notices, lines, free)) return alone()
    hostLog("agents", "digest joined", { conversation, request: open.id, notice: notice.id, ...(open.held !== undefined && { held: !free }) })
    this.deps.assign([notice.report.id], open.id)
    hostLog("agents", "digest join assigned", { conversation, request: open.id, notice: notice.id })
    this.heardNow([notice])
    hostLog("agents", "wake", { conversation, request: open.id, how: "joined", coalesced: notices.length })
  }

  /** A digest of its own in the Apex's queue, held for its burst's window; `heldSince`: behind a full one held for the Fins still at work, until its time. */
  private start(conversation: string, notices: Notice[], ready: ParentReady, heldSince?: number): void {
    const now = this.now()
    const request = notices[0]!.wake ?? namedUuid(`wake:${conversation}:${notices.map((notice) => notice.report.id).join("\n")}`)
    const window = notices.some((notice) => notice.settledOnly) ? RESULT_COALESCE_MS : WAKE_COALESCE_MS
    // An idle Apex hears the first at once; the next waits out its window from when the last digest went, so what
    // comes after it while its turn on it runs (queued for that turn's end, `ready`) or soon after is one digest more,
    // not one a report. One that waits unsent and held already (it was full, so this notice starts the next) has the
    // same time, and goes ahead of this one in its queue.
    const last = this.deps.lastSent?.(conversation)
    const leftOver = notices.filter((notice) => this.leftOvers.delete(notice.id)).length > 0
    // A result a `wait` start still waits on is that call's to answer, a moment from now, which takes it back from the
    // digest (`withdraw`): held `RESULT_COALESCE_MS` so it doesn't also wake a Session of the Apex that is idle.
    const awaited = notices.some((notice) => notice.settledOnly && this.deps.awaited?.(notice))
    // An Apex on its way to another harness, its own run out, hears it there: sent at once, it meets the limit it is
    // leaving, and that knock stops the move.
    const moving = ready === "idle" && this.deps.moving?.(conversation) === true
    // Never past its window from now: a last digest that reads as sent later than now (a clock set back since) holds the
    // next no longer than the window, so a digest held for an idle Apex always goes.
    const due = Math.min(Math.max(last === undefined ? now : last + window, leftOver || moving ? now + WAKE_COALESCE_MS : 0, awaited ? now + RESULT_COALESCE_MS : 0), now + WAKE_COALESCE_MS)
    // The first result of a run goes as above, so an Apex hears at once that its Fins began to finish. Once it was woken
    // within `HOLD_RESULTS_MS`, a result that asks nothing is held for the Fins still at work, while it's idle or in a
    // turn its Fins' news started: every one a digest and a turn was twelve of each for twelve Fins over ten minutes.
    const bound = this.deps.holdMs ?? HOLD_RESULTS_MS
    // Asked in the order of what each costs: most reports are a first, or ask something, and read nothing more for this.
    const since = heldSince ?? (last !== undefined && now - last < bound && notices.every(asksNothing) &&
      (ready === "idle" || ((ready === "steer" || ready === "queue") && this.deps.onNews?.(conversation) === true)) &&
      notices.every((notice) => this.waitsForOthers(conversation, notice)) ? now : undefined)
    const hold = ready === "paused" ? "paused" : since !== undefined ? { at: since + bound, since } : ready === "idle" && due > now ? { at: due } : undefined
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

  /**
   * Once a turn has run `FOCUS_MS` past the first report it left waiting, what waits for its end is steered in, once, as
   * one digest: an Apex on a long turn still hears its Fins, at most once a stretch. What the harness doesn't take
   * stays for the turn's end.
   */
  private armFocus(conversation: string): void {
    if (this.focus.has(conversation)) return
    const timer = setTimeout(() => {
      this.focus.delete(conversation)
      if (this.stopped || this.deps.ready(conversation) !== "steer" || !this.deps.steerQueued) return
      const open = this.open(conversation)
      // One held for the Fins still at work isn't for this turn: what ends its hold sends it.
      if (!open?.notices.length || open.held !== undefined) return
      // The digest itself goes into the turn, taken from the queue in the journal's one write; what arrives meanwhile
      // starts a digest of its own, and one the harness refuses stays queued for the turn's end.
      this.focusing.add(open.id)
      // Said as the tree stands now, and stored so first: the steer takes the queued words exactly as they are, so the
      // digest is rewritten with these before it goes (a Fin that moved since the last notice changed the counts).
      const text = this.words(conversation, open.notices, open.lines ?? [])
      if (!this.deps.rewrite(conversation, open.id, text, open.notices, open.lines ?? [])) {
        this.focusing.delete(open.id)
        return
      }
      const took = this.deps.steerQueued(conversation, namedUuid(`steer:focus:${open.id}`), open.id, text)
      if (!took) {
        this.focusing.delete(open.id)
        return
      }
      void took.then((answered) => {
        this.focusing.delete(open.id)
        if (this.stopped) return
        hostLog("agents", "wake", { conversation, request: open.id, how: answered ? "focus-steer" : "focus-steer refused", coalesced: open.notices.length })
      })
    }, this.deps.focusMs ?? FOCUS_MS)
    timer.unref?.()
    this.focus.set(conversation, timer)
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
    for (const notice of notices) {
      this.heard.add(notice.id)
      this.leftOvers.delete(notice.id)
    }
  }
}

const DECIDES = new Set<Report["status"]>(["blocked", "needs-input"])

/** The digest in its fixed shape: the results waited for, in full; other Apexes' replies, in full; then decisions; then what finished; then how the rest stand. */
export function digest(notices: readonly Notice[], counts: string): string {
  const results = notices.filter((notice) => notice.settledOnly)
  const replies = notices.filter((notice) => notice.reply)
  const fins = notices.filter((notice) => !notice.settledOnly && !notice.reply && !notice.quiet && !notice.unanswered && !notice.collision)
  const quiets = notices.filter((notice) => notice.quiet && !notice.settledOnly && !notice.reply)
  const unanswered = notices.filter((notice) => notice.unanswered && !notice.settledOnly && !notice.reply)
  const collisions = notices.filter((notice) => notice.collision && !notice.settledOnly && !notice.reply)
  const asks = fins.filter((notice) => DECIDES.has(notice.report.status))
  const decided = fins.filter((notice) => notice.decision)
  const decisions = [...asks.filter((notice) => notice.report.for !== "person"), ...decided.filter((notice) => notice.decision === "lead")]
  const persons = [...asks.filter((notice) => notice.report.for === "person"), ...decided.filter((notice) => notice.decision === "person")]
  const ended = fins.filter((notice) => !notice.decision && (notice.report.status === "done" || notice.report.status === "failed"))
  // A Fin whose turn ended without a result hasn't finished: said apart, for its Apex to send on or take its reply.
  const finished = ended.filter((notice) => !notice.report.unfinished)
  const unfinished = ended.filter((notice) => notice.report.unfinished)
  const handoffs = fins.filter((notice) => notice.report.status === "progress" && notice.report.handoff)
  const awaiting = fins.filter((notice) => notice.report.status === "progress" && !notice.report.handoff && notice.report.awaits)
  // Progress that answers its Apex's messages (`answers`): the reply it was owed.
  const answering = fins.filter((notice) => notice.report.status === "progress" && !notice.report.handoff && !notice.report.awaits && notice.report.answers?.length)
  const lines = [FROM_AGENTS]
  // Every entry the digest writes has its twin here, from the same record, in the same order.
  const cards: FinReportCard[] = []
  if (results.length) {
    lines.push(results.length === 1 ? "The result you waited for:" : `The ${results.length} results you waited for:`)
    for (const notice of results) {
      const { label, report, decision } = notice
      const summary = report.summary.trim() || (report.status === "done" ? "It finished." : "It failed.")
      const text = summary.length > RESULT_CHARS ? `${summary.slice(0, RESULT_CHARS)}… (agents_read gives the rest)` : summary
      lines.push(`  • ${label} ${reportWord(report)}:`, ...text.split("\n").map((line) => `    ${line}`))
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
    lines.push("  Answer with agents_answer even if you already acted on it: left unanswered, it goes to the person.")
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
      lines.push(`  • ${label} ${reportWord(report)}: ${finishedLine(report)}`)
      cards.push(card(notice, opening(report.summary) || (report.status === "done" ? "It finished." : "It failed.")))
      artifactLines(lines, report)
    }
  }
  if (unfinished.length) {
    lines.push(`${unfinished.length} ${UNFINISHED_WORDS} (agents_send sends one on; or take its reply as its result):`)
    for (const notice of unfinished) {
      const { label, report } = notice
      lines.push(`  • ${label}: ${finishedLine(report)}`)
      if (notice.holds?.length) lines.push(`    Still waiting to start after it: ${notice.holds.join(", ")} (they start once it reports done; agents_stop on it drops them).`)
      cards.push(card(notice, opening(report.summary) || "Its turn ended without a result."))
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
  if (awaiting.length) {
    lines.push(`${awaiting.length} ${awaiting.length === 1 ? "waits" : "wait"} on someone else to act:`)
    for (const notice of awaiting) {
      const { label, report } = notice
      const waiting = waitingWords(report.waitingOn)
      lines.push(`  • ${label}: ${finishedLine(report)}${waiting ? ` · ${waiting}` : ""}`)
      cards.push(card(notice, opening(report.summary) || waiting || "it waits on someone else."))
      artifactLines(lines, report)
    }
    lines.push("  Nothing wakes it until that happens: ask for the review or tell the person, unless it's already under way.")
  }
  if (answering.length) {
    lines.push(`${answering.length} ${answering.length === 1 ? "answers" : "answer"} your message:`)
    for (const notice of answering) {
      const { label, report } = notice
      lines.push(`  • ${label}: ${finishedLine(report)}`)
      cards.push(card(notice, opening(report.summary) || "It answered your message."))
      artifactLines(lines, report)
    }
  }
  if (unanswered.length) {
    lines.push(`${unanswered.length} ${unanswered.length === 1 ? "hasn't" : "haven't"} answered your message:`)
    for (const notice of unanswered) {
      const owed = notice.unanswered!
      const words = `your message of ${new Date(owed.at).toISOString().slice(11, 16)} UTC, "${owed.line}", got no reply in ${owed.turns} of its turns, a reminder among them.`
      lines.push(`  • ${notice.label}: ${words}`)
      cards.push(card(notice, words))
    }
    lines.push("  agents_read shows what it said; agents_send asks again, or decide without it.")
  }
  if (quiets.length) {
    lines.push(`${quiets.length} ${quiets.length === 1 ? "has" : "have"} gone quiet while working:`)
    for (const notice of quiets) {
      const words = quietLine(notice.quiet!)
      lines.push(`  • ${notice.label} ${words}`)
      cards.push(card(notice, words))
    }
    lines.push(`  agents_read shows what each is doing. A long command may be fine; otherwise agents_send asks it (deliver: steer reaches the turn it runs, interrupt cuts it), or agents_stop stops it.`)
  }
  if (collisions.length) {
    lines.push(`${collisions.length} ${collisions.length === 1 ? "pair" : "pairs"} changed the same files in one folder:`)
    for (const notice of collisions) {
      const words = collisionLine(notice.collision!)
      lines.push(`  • ${notice.label} ${words}`)
      cards.push(card(notice, words))
    }
    lines.push(`  Neither was told. Keep them apart (a new ${FIN_WORD}'s workspace, or agents_send one to worktree_move) or have one wait for the other; nothing to do if you meant it.`)
  }
  lines.push(counts)
  lines.push((results.length || replies.length) && !decisions.length && !persons.length && !finished.length && !handoffs.length && !awaiting.length && !answering.length && !unanswered.length && !quiets.length && !collisions.length
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
    ...(report.unfinished && { unfinished: true as const }),
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

