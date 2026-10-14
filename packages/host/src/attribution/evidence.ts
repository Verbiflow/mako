import type { ActivityMark, Attribution, Author, ChangeKind, MakoWrite, ReportedCall, ReportedEffect } from "@mako/protocol"
import { diffLines, splitLines } from "./line-diff.js"
import { applyPatch } from "./patch.js"
import { within } from "./paths.js"
import { readOnlyCommand } from "./read-only.js"
import { WorkingSets } from "./working-set.js"
import { distinct } from "./written.js"

/*
 * Who made a change, from what the tracker knows: Mako's own writes, the
 * effects tool calls reported, the paths calls in flight named, and which
 * Threads had anything running. `attribute` is a pure function of a change
 * and this evidence, so the same journal and evidence always give the same
 * author, and a test can state the whole ladder.
 */

/** A change this long before a call or turn was heard to start still counts: the host stamps a start when its batch flushes, 16 ms on. */
export const LEAD_MS = 100
/** A change this long after a call ended is still its own: FSEvents and the harness's report both lag. */
export const TRAIL_MS = 3_000
/** A call this far in when a change lands has run long enough that the person may be working alongside it. */
const STANDING_MS = 120_000
/** Mako's own writes, which it marks around the operation, lag less. */
const MAKO_TRAIL_MS = 1_500
/** Candidates named in an ambiguous author, at most. */
const MAX_CANDIDATES = 16

export interface Interval {
  kind: "turn" | "call" | "background"
  id: string
  thread: string
  session: string
  turn?: string
  checkout?: string
  cwd?: string
  label?: string
  named: string[]
  /** The Session's native record. */
  record?: string
  /** A call that only reads. */
  readOnly?: boolean
  /** Background work that runs on its own (a command, a monitor). */
  standing?: boolean
  start: number
  /** Null while it runs. */
  end: number | null
}

export interface MakoInterval {
  write: MakoWrite
  start: number
  end: number | null
}

/** What a change looks like to the rules: where, what, when, and its text on each side when known. */
export interface ObservedChange {
  /** Absolute. */
  path: string
  /** A rename's old path, absolute. */
  from?: string
  kind: ChangeKind
  changedAt: number
  /** Events were lost: the change happened some time in this stretch, so no call can be pinned on it. */
  lost?: { from: number; to: number }
  /** Text before and after, for checking a reported patch or content; undefined when not text. */
  before?: string | null
  after?: string | null
  /** The tracked root the path is in, absolute: a folder holding all of it names none of its files. */
  root?: string
  /** An agent this host doesn't run was working where the change was heard, in a few words: timing can't name a Thread then. */
  outsider?: string
}

export const authorOf = (interval: Pick<Interval, "thread" | "session" | "turn">, call?: string, work?: string): Author => {
  const author: Author = { thread: interval.thread, session: interval.session }
  if (interval.turn) author.turn = interval.turn
  if (call) author.call = call
  if (work) author.work = work
  return author
}

const key = (session: string, id: string) => `${session}\u0000${id}`

/** Turns, calls, background work, reported effects and Mako's writes, in memory for the stretch attribution looks at. */
export class Evidence {
  /** Every interval by session and id. */
  private readonly intervals = new Map<string, Interval>()
  private readonly reports = new Map<string, ReportedCall>()
  private readonly writes = new Set<MakoInterval>()
  /** When a call's reported effect on a path proved a change, by call and path: one effect explains one change. */
  private readonly proofs = new Map<string, number>()
  /** Where each Thread's work has been, over its whole history: never pruned with the rest. */
  readonly worked: WorkingSets

  constructor(worked = new WorkingSets()) {
    this.worked = worked
  }

  mark(mark: ActivityMark): Interval {
    this.worked.add(mark.thread, { cwd: mark.cwd, named: mark.named ?? [] })
    const id = key(mark.session, `${mark.kind}:${mark.id}`)
    let interval = this.intervals.get(id)
    if (!interval) {
      interval = {
        kind: mark.kind,
        id: mark.id,
        thread: mark.thread,
        session: mark.session,
        turn: mark.turn ?? (mark.kind === "turn" ? mark.id : undefined),
        checkout: mark.checkout,
        cwd: mark.cwd,
        label: mark.label,
        named: mark.named ?? [],
        record: mark.record,
        start: mark.at,
        end: null,
      }
      this.intervals.set(id, interval)
    }
    if (mark.named) interval.named = [...new Set([...interval.named, ...mark.named])]
    if (mark.checkout) interval.checkout = mark.checkout
    if (mark.cwd) interval.cwd = mark.cwd
    if (mark.label) interval.label = mark.label
    if (mark.record) interval.record = mark.record
    if (mark.readOnly) interval.readOnly = true
    if (mark.standing) interval.standing = true
    if (mark.edge === "start") interval.start = Math.min(interval.start, mark.at)
    else interval.end = Math.max(mark.at, interval.start)
    return interval
  }

  report(call: ReportedCall): void {
    if (call.status !== "refused") this.worked.add(call.thread, { named: [], effects: call.effects.filter((effect) => !seen(effect)) })
    const id = key(call.session, call.call)
    const known = this.reports.get(id)
    this.reports.set(id, known ? { ...known, ...call, effects: call.effects.length ? call.effects : known.effects } : call)
  }

  makoStart(write: MakoWrite, at: number): MakoInterval {
    const interval = { write, start: at, end: null }
    this.writes.add(interval)
    return interval
  }

  /** The change at `changedAt` on `path` came out `exact` for `author`'s call. */
  proved(author: Author, path: string, changedAt: number): void {
    if (!author.call) return
    const id = `${key(author.session, author.call)}\u0000${path}`
    this.proofs.set(id, Math.min(changedAt, this.proofs.get(id) ?? changedAt))
  }

  /** When this call's effect on `path` proved a change, if it did. */
  provedAt(session: string, call: string, path: string): number | undefined {
    return this.proofs.get(`${key(session, call)}\u0000${path}`)
  }

  /** A call's span: its report's times, else its activity marks. */
  callSpan(report: ReportedCall): { start: number; end: number | null } | undefined {
    const marked = this.intervals.get(key(report.session, `call:${report.call}`))
    const start = report.startedAt ?? marked?.start
    if (start === undefined) return undefined
    const end = report.endedAt ?? marked?.end ?? (report.status === "running" ? null : start)
    return { start, end }
  }

  calls(): IterableIterator<ReportedCall> {
    return this.reports.values()
  }

  all(): IterableIterator<Interval> {
    return this.intervals.values()
  }

  makoWrites(): IterableIterator<MakoInterval> {
    return this.writes.values()
  }

  /** The Sessions with anything running at `at`: those whose folder holds `path`, else every one. */
  sessionsAt(at: number, path: string): Set<string> {
    const inside = new Set<string>()
    const all = new Set<string>()
    for (const interval of this.intervals.values()) {
      if (!spans(interval.start, interval.end, at)) continue
      all.add(interval.session)
      const folder = interval.checkout ?? interval.cwd
      if (folder && within(folder, path)) inside.add(interval.session)
    }
    return inside.size ? inside : all
  }

  /** Whether anything that could still change an author is running or just ended. */
  quietSince(at: number, now: number): boolean {
    for (const report of this.reports.values()) {
      const span = this.callSpan(report)
      if (span && span.start <= at + TRAIL_MS && (span.end === null || span.end + TRAIL_MS > now)) return false
    }
    for (const interval of this.intervals.values())
      if (interval.kind === "call" && interval.start <= at + TRAIL_MS && (interval.end === null || interval.end + TRAIL_MS > now)) return false
    return true
  }

  /** Forget what ended before `before`, which no unsettled change can reach. */
  prune(before: number): void {
    for (const [id, interval] of this.intervals) if (interval.end !== null && interval.end + TRAIL_MS < before) this.intervals.delete(id)
    for (const [id, report] of this.reports) {
      const span = this.callSpan(report)
      if (!span || (span.end !== null && span.end + TRAIL_MS < before)) this.reports.delete(id)
    }
    for (const id of this.proofs.keys()) if (!this.reports.has(id.slice(0, id.lastIndexOf("\u0000")))) this.proofs.delete(id)
    for (const write of this.writes) if (write.end !== null && write.end + MAKO_TRAIL_MS < before) this.writes.delete(write)
  }
}

const spans = (start: number, end: number | null, at: number, lead = LEAD_MS, trail = TRAIL_MS) =>
  start - lead <= at && (end === null || at <= end + trail)
const overlaps = (start: number, end: number | null, from: number, to: number) => start - LEAD_MS <= to && (end === null || end + TRAIL_MS >= from)

/** A file the harness only saw change while the call ran: any process's write in that stretch is listed the same way. */
const seen = (effect: ReportedEffect) => "seen" in effect && effect.seen === true

const readOnlyReports = new WeakMap<ReportedCall, boolean>()
/** A reported call that only read: reads, and command lines that only inspect. */
function readOnlyReport(report: ReportedCall): boolean {
  let found = readOnlyReports.get(report)
  if (found === undefined) {
    found = report.effects.length > 0 && report.effects.every((effect) => effect.kind === "read" || seen(effect) || (effect.kind === "command" && readOnlyCommand(effect.command)))
    readOnlyReports.set(report, found)
  }
  return found
}

/** Which effect, if any, a reported call's effects claim for this change, and whether the content proves it. */
export function claim(effects: readonly ReportedEffect[], change: ObservedChange): { effect: "create" | "modify" | "write" | "delete" | "rename"; proven: boolean } | undefined {
  for (const effect of effects) {
    if (seen(effect)) continue
    switch (effect.kind) {
      case "create":
      case "write": {
        if (effect.path !== change.path || (change.kind !== "create" && change.kind !== "modify")) break
        const proven = effect.content !== undefined && change.after === effect.content
        // A harness's add-file over a path that exists overwrites it: its whole content proves that, and nothing less does.
        if (effect.kind === "create" && change.kind !== "create") {
          if (proven) return { effect: "write", proven }
          break
        }
        return { effect: effect.kind, proven }
      }
      case "modify":
        if (effect.path !== change.path || change.kind !== "modify") break
        return { effect: "modify", proven: change.before !== undefined && change.before !== null && change.after !== undefined && provenModify(effect, change.before, change.after) }
      case "delete":
        if (effect.path === change.path && change.kind === "delete") return { effect: "delete", proven: true }
        break
      case "rename":
        if (change.kind === "rename" && effect.to === change.path && effect.from === change.from) return { effect: "rename", proven: true }
        if ((change.kind === "delete" && effect.from === change.path) || (change.kind === "create" && effect.to === change.path)) return { effect: "rename", proven: true }
        break
      case "read":
      case "command":
        break
    }
  }
  return undefined
}

/** Whether the reported patch or edits, applied to `before`, give exactly `after`. */
function provenModify(effect: Extract<ReportedEffect, { kind: "modify" }>, before: string, after: string | null): boolean {
  if (after === null) return false
  if (effect.patch !== undefined && applyPatch(before, effect.patch) === after) return true
  if (!effect.edits?.length) return false
  let text = before
  for (const edit of effect.edits) {
    if (!text.includes(edit.old)) return false
    text = edit.all ? text.split(edit.old).join(edit.new) : text.replace(edit.old, () => edit.new)
  }
  return text === after
}

/**
 * How a call names this path: the path itself, or a folder holding it below the call's checkout and below
 * the path's tracked root. A command run at a repository's root (its cwd, after a `cd` into one repository
 * of a project folder) names none of that repository's files by its folder alone.
 */
function naming(interval: Interval | undefined, report: ReportedCall | undefined, change: ObservedChange): "target" | "command" | undefined {
  const checkout = interval?.checkout ?? report?.checkout
  const paths = [change.path, ...(change.from ? [change.from] : [])]
  const broad = (named: string) => Boolean((checkout && within(named, checkout)) || (change.root && within(named, change.root)))
  const names = (named: string) => paths.some((path) => path === named) ? "target" : paths.some((path) => within(named, path) && !broad(named)) ? "command" : undefined
  let found: "target" | "command" | undefined
  const consider = (named: string) => {
    const by = names(named)
    if (by === "target" || (by && !found)) found = by
  }
  for (const named of interval?.named ?? []) consider(named)
  for (const effect of report?.effects ?? []) {
    if (effect.kind === "command") {
      for (const named of effect.named ?? []) consider(named)
      if (effect.cwd) consider(effect.cwd)
    } else if (effect.kind !== "read" && effect.kind !== "rename" && !seen(effect)) consider(effect.path)
  }
  return found
}

/**
 * A command whose text holds lines the change added, a block two writers
 * wouldn't type alike: a heredoc, a script's string, an inline replace. It
 * wrote them, though it named no path.
 */
function echoed(report: ReportedCall, change: ObservedChange): "content" | undefined {
  const commands = report.effects.flatMap((effect) => (effect.kind === "command" ? [effect.command] : []))
  if (!commands.length) return undefined
  return addedBlocks(change).some((block) => commands.some((command) => command.includes(block))) ? "content" : undefined
}

/** A change's added stretches distinct enough to tell writers apart, each as one string; a change is re-attributed often, so this runs once. */
const blocks = new WeakMap<ObservedChange, string[]>()
function addedBlocks(change: ObservedChange): string[] {
  let found = blocks.get(change)
  if (found) return found
  found = []
  // A created file's `before` is null; undefined on either side means it isn't text.
  if (change.before !== undefined && change.after !== undefined && change.after !== null) {
    const after = splitLines(change.after)
    for (const hunk of diffLines(splitLines(change.before ?? ""), after)) {
      const added = after.slice(hunk.b, hunk.b + hunk.added)
      if (added.length && distinct(added)) found.push(added.join("").replace(/\r?\n$/, ""))
    }
  }
  blocks.set(change, found)
  return found
}

const NAMING_RANK = { effect: 3, content: 3, target: 2, command: 1 } as const

/** At most this many, the newest first, deduplicated by Session. */
function candidates(found: readonly Author[]): Author[] {
  const seen = new Map<string, Author>()
  for (const author of found) seen.set(`${author.thread}\u0000${author.session}`, author)
  return [...seen.values()].slice(0, MAX_CANDIDATES)
}

const PREFERENCE = { call: 0, background: 1, turn: 2 } as const

/**
 * Which of one Thread's intervals a change at `at` is better put on: one
 * still open then over one it only trails, then a call over background work
 * over a turn, then the later.
 */
function closer(interval: Interval, than: Interval, at: number): boolean {
  const open = (item: Interval) => item.end === null || item.end >= at
  if (open(interval) !== open(than)) return open(interval)
  if (PREFERENCE[interval.kind] !== PREFERENCE[than.kind]) return PREFERENCE[interval.kind] < PREFERENCE[than.kind]
  return interval.start > than.start
}

/**
 * The author of `change`, and how sure: Mako's own write, then an effect a
 * call reported (exact when the content proves it), then a call that named
 * the path, then the one Thread running in that checkout. Lost events cap it
 * at `window`: no call can be pinned on a change that could have happened
 * any time in the gap.
 */
export function attribute(change: ObservedChange, evidence: Evidence): Attribution {
  const at = change.changedAt
  const paths = [change.path, ...(change.from ? [change.from] : [])]
  if (!change.lost) {
    for (const write of evidence.makoWrites()) {
      if (!spans(write.start, write.end, at, LEAD_MS, MAKO_TRAIL_MS)) continue
      if (!write.write.paths.some((folder) => paths.some((path) => within(folder, path)))) continue
      return write.write.kind === "editor" ? { certainty: "person", via: "editor" } : { certainty: "mako", operation: write.write.operation }
    }
    // A call whose effect on this path explained an earlier change already: a later change there is someone else's write.
    const spent = (session: string, call: string) => (evidence.provedAt(session, call, change.path) ?? Infinity) < at
    const exact: { author: Author; effect: "create" | "modify" | "write" | "delete" | "rename"; start: number }[] = []
    const named: { author: Author; by: keyof typeof NAMING_RANK; start: number }[] = []
    for (const report of evidence.calls()) {
      if (report.status === "refused") continue
      const span = evidence.callSpan(report)
      if (!span || !spans(span.start, span.end, at)) continue
      const author = authorOf(report, report.call)
      const claimed = claim(report.effects, change)
      if (!claimed?.proven && spent(report.session, report.call)) continue
      if (claimed?.proven) exact.push({ author, effect: claimed.effect, start: span.start })
      else if (claimed) named.push({ author, by: "effect", start: span.start })
      else if (!readOnlyReport(report)) {
        const by = naming(undefined, report, change) ?? echoed(report, change)
        if (by) named.push({ author, by, start: span.start })
      }
    }
    for (const interval of evidence.all()) {
      if (interval.kind === "turn" || interval.readOnly || !spans(interval.start, interval.end, at)) continue
      if (interval.kind === "call" && spent(interval.session, interval.id)) continue
      const by = naming(interval, undefined, change)
      if (by) named.push({ author: authorOf(interval, interval.kind === "call" ? interval.id : undefined, interval.kind === "background" ? interval.id : undefined), by, start: interval.start })
    }
    const threads = (found: readonly { author: Author }[]) => new Set(found.map((item) => item.author.thread))
    if (exact.length) {
      if (threads(exact).size > 1) return { certainty: "ambiguous", candidates: candidates(exact.map((item) => item.author)), reason: "several-threads" }
      const latest = exact.reduce((best, item) => (item.start >= best.start ? item : best))
      return { certainty: "exact", author: latest.author, effect: latest.effect }
    }
    if (named.length) {
      if (threads(named).size > 1) return { certainty: "ambiguous", candidates: candidates(named.map((item) => item.author)), reason: "several-threads" }
      const best = named.reduce((top, item) => NAMING_RANK[item.by] > NAMING_RANK[top.by] || (NAMING_RANK[item.by] === NAMING_RANK[top.by] && item.start >= top.start) ? item : top)
      return { certainty: "named", author: best.author, by: best.by }
    }
  }
  const from = change.lost?.from ?? at
  const to = change.lost?.to ?? at
  const running = new Map<string, Interval>()
  for (const interval of evidence.all()) {
    // A call that only reads leaves its Thread running only as its turn is.
    if (interval.readOnly && !change.lost) continue
    if (!(change.lost ? overlaps(interval.start, interval.end, from, to) : spans(interval.start, interval.end, at))) continue
    const held = running.get(interval.thread)
    if (!held || closer(interval, held, to)) running.set(interval.thread, interval)
  }
  const nobody = (): Attribution => (change.outsider ? { certainty: "ambiguous", candidates: [], reason: "outside-mako" } : { certainty: "person", via: "no-activity" })
  if (!running.size) return nobody()
  const author = (interval: Interval) => authorOf(interval, interval.kind === "call" ? interval.id : undefined, interval.kind === "background" ? interval.id : undefined)
  const reaching = reachingThreads(change, evidence)
  const holding = [...running.values()].filter((interval) => {
    const folder = interval.checkout ?? interval.cwd
    return folder !== undefined && paths.some((path) => within(folder, path))
  })
  // A project folder holds several repositories: a Thread working from it counts for a change in one of them only through work there.
  const root = change.root
  const scoped = change.lost || !root ? holding : holding.filter((interval) => reaching.has(interval.thread) || (interval.checkout !== undefined && within(root, interval.checkout)))
  const inside = scoped.length ? scoped : holding
  if (inside.length === 1) {
    const interval = inside[0]!
    if (change.outsider && !change.lost) return { certainty: "ambiguous", candidates: [author(interval)], reason: "outside-mako" }
    const window: Extract<Attribution, { certainty: "window" }> = { certainty: "window", author: author(interval), during: interval.kind }
    if (interval.end !== null && to > interval.end) window.trailing = true
    if (interval.standing || (interval.kind === "call" && from - interval.start > STANDING_MS)) window.standing = true
    const reached = evidence.worked.reached(interval.thread, change.path, root)
    if (reached) window.reached = reached
    return window
  }
  if (inside.length > 1 || change.lost) {
    return { certainty: "ambiguous", candidates: candidates((inside.length ? inside : [...running.values()]).map(author)), reason: change.lost ? "lost-events" : "several-threads" }
  }
  // Threads working in other checkouts reach this one only through a call that went there.
  const outside = [...running.values()].filter((interval) => reaching.has(interval.thread))
  if (!outside.length) return nobody()
  return { certainty: "ambiguous", candidates: candidates(outside.map(author)), reason: "outside-checkout" }
}

/**
 * Threads with a call or background work running at the change whose folder or
 * named paths are inside the change's repository, or hold the path itself.
 */
function reachingThreads(change: ObservedChange, evidence: Evidence): Set<string> {
  const at = change.changedAt
  const reaches = (folder: string) => (change.root !== undefined && within(change.root, folder)) || within(folder, change.path)
  const found = new Set<string>()
  for (const interval of evidence.all()) {
    if (interval.kind === "turn" || interval.readOnly || !spans(interval.start, interval.end, at)) continue
    if ([interval.cwd, ...interval.named].some((folder) => folder !== undefined && reaches(folder))) found.add(interval.thread)
  }
  for (const report of evidence.calls()) {
    const span = evidence.callSpan(report)
    if (!span || !spans(span.start, span.end, at) || readOnlyReport(report)) continue
    const folders = report.effects.flatMap((effect) => effect.kind === "command" ? [effect.cwd, ...(effect.named ?? [])] : effect.kind === "rename" ? [effect.from, effect.to] : [effect.path])
    if (folders.some((folder) => folder !== undefined && reaches(folder))) found.add(report.thread)
  }
  return found
}
