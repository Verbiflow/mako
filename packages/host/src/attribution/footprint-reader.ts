import type { ActivityMark, FootprintBasis, FootprintEntry, ReportedCall, TrackerPorts } from "@mako/protocol"
import { contentRef, READ_LIMIT, secretPath } from "./content.js"
import {
  classify,
  container,
  Exclusions,
  FolderRules,
  noiseFolders,
  readIgnore,
  staticNoise,
  strength,
  type ExclusionRule,
  type FootprintInput,
  type FootprintTurn,
  type RuleFolder,
  type TurnEvidence,
} from "./footprint.js"
import type { JournalStore } from "./journal-store.js"
import { NoiseBaseline } from "./noise-baseline.js"
import { within } from "./paths.js"
import { rootLinks } from "./ports.js"

/*
 * Reads each turn's footprint when it ends, and learns the machine's own
 * churn while nothing runs. Everything is read from the system's history
 * after the fact, so nothing runs per event: while turns run, in short
 * segments each read once for every turn open across it (`SEGMENT_MS`), and
 * while the machine is idle, a minute-long sample after each of a few gaps
 * (`IDLE_GAPS_MS`). Reads happen in the reader (the host's history child),
 * with every folder a rule takes whole for all the turns a segment serves
 * left out there and only counted.
 */

export interface FootprintOptions {
  home: string
  /** Where footprints are read from: the home folder and the temporary folder. */
  roots: readonly string[]
  /** The harnesses' stores and Mako's data: never a footprint, named or not. */
  stores(): readonly string[]
  /** Folders of other sessions on this machine that were active since `since`, not `thread`'s own, with whose they are. */
  others?(thread: string, since: number): readonly { folder: string; why: string }[]
  /** Native ids of every other session on this machine, lowercase, not `thread`'s own, with whose they are. */
  sessions?(thread: string): ReadonlyMap<string, string>
  /** Links whose targets the history reports, as [link, target]; the file system's top-level links by default. */
  links?: readonly (readonly [string, string])[]
  /**
   * Each path's verdict as a turn's read decides it, for a replay or a test;
   * the host passes none. Paths the history read left out under a rule
   * folder never reach the reader, so only their counts are known.
   */
  explain?(turn: { thread: string; turn: string }, path: string, verdict: PathVerdict): void
}

/** What became of one changed path: kept with a basis, or left out by a rule. */
export type PathVerdict = { kept: FootprintBasis } | { rule: ExclusionRule; group: string; why?: string }

export interface FootprintReaderDeps {
  ports: TrackerPorts
  store: JournalStore
  /** Every tracked root, absolute. */
  tracked(): readonly string[]
  options: FootprintOptions
  log(message: string, facts: Readonly<Record<string, string | number | boolean>>): void
}

/**
 * What a turn's calls said, gathered as they report, so pruned evidence
 * never loses a name, and what the history reported in the segments it
 * was open across.
 */
interface Trail {
  thread: string
  session: string
  turn: string
  start: number
  end?: number
  named: Map<string, "read" | "write">
  mentioned: Set<string>
  cwds: Set<string>
  paths: Set<string>
  writers: Map<string, readonly number[]>
  /**
   * Paths each segment's read left out under a rule folder, by rule. A read
   * runs to the history's present, not to its segment's end, and the next
   * segment starts at the cut, so a trail open across a cut can count the
   * changes made between the cut and that read twice: a read's wait, never
   * a turn's own write lost.
   */
  exclusions: Exclusions
  ignored: number
  complete: boolean
  readMs: number
}

/** The history since `mark`, read once for every turn open across it. */
interface Segment {
  mark: Promise<string | null>
  trails: Trail[]
  timer: ReturnType<typeof setTimeout>
}

/** Paths kept per turn that only its window links to it, at most. */
export const MAX_WEAK = 200
/** Paths a trail holds at most of each kind. */
const MAX_NAMED = 4096
/** Changed paths a trail holds at most; past them its footprint is marked incomplete. */
const MAX_PATHS = 50_000
/** A finished turn's names still explain other Threads' paths this long. */
const KEEP_ENDED_MS = 120_000
/**
 * While any turn runs the history is read at least this often, as well as
 * at every turn's start and end. FSEvents replays every event on the volume
 * since a mark: on a busy Mac a minute is a few hundred milliseconds of
 * fseventsd, an hour five seconds, and past about two hours the home
 * folder's read fails. Short segments, each read once for every turn open
 * across it, keep every read small and never repeat one.
 */
export const SEGMENT_MS = 120_000
/**
 * The wait before each idle sample, the last repeating: a night with
 * nothing running costs a sample every two hours, and a short pause between
 * turns one. Each sample reads `IDLE_SAMPLE_MS` of history, never the whole
 * stretch: the baseline needs what churns, not every change.
 */
export const IDLE_GAPS_MS = [30_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const
export const IDLE_SAMPLE_MS = 60_000
/** Excluded groups kept per turn. */
const GROUPS_KEPT = 40
const LOG_EVERY_MS = 10_000

const trailKey = (session: string, turn: string) => `${session}\u0000${turn}`

export class FootprintReader {
  readonly baseline: NoiseBaseline
  private readonly deps: FootprintReaderDeps
  private readonly trails = new Map<string, Trail>()
  /** Turns and background work running now, of any Thread: none means the machine's churn is its own. */
  private readonly running = new Set<string>()
  /** Where the idle stretch's history read starts, and the timer of its next step. */
  private idle?: { mark: Promise<string | null>; at: number; timer: ReturnType<typeof setTimeout> }
  private segment?: Segment
  /** Segment reads, one after another, so a turn's last is in before it is decided. */
  private segments: Promise<void> = Promise.resolve()
  private readonly reads = new Set<Promise<void>>()
  private unlogged: FootprintTurn[] = []
  private logged = 0
  private closed = false
  private readonly links: readonly (readonly [string, string])[]

  constructor(deps: FootprintReaderDeps) {
    this.deps = deps
    this.links = deps.options.links ?? rootLinks()
    this.baseline = new NoiseBaseline(deps.store, { roots: deps.options.roots, now: () => deps.ports.clock.now() })
    this.idleBegan()
  }

  /** A path a call gave, as the history reports it: `/tmp/out.txt` is `/private/tmp/out.txt` on macOS. */
  private canonical(path: string): string {
    for (const [link, target] of this.links) if (within(link, path)) return target + path.slice(link.length)
    return path
  }

  private now(): number {
    return this.deps.ports.clock.now()
  }

  activity(mark: ActivityMark): void {
    if (this.closed) return
    const running = `${mark.session}\u0000${mark.kind}\u0000${mark.id}`
    if (mark.kind !== "call") {
      if (mark.edge === "start") this.running.add(running)
      else this.running.delete(running)
    }
    if (mark.kind === "turn" && mark.edge === "start") {
      this.idleEnded()
      const trail: Trail = {
        thread: mark.thread, session: mark.session, turn: mark.id, start: mark.at, named: new Map(), mentioned: new Set(), cwds: new Set(),
        paths: new Set(), writers: new Map(), exclusions: new Exclusions(), ignored: 0, complete: true, readMs: 0,
      }
      if (mark.cwd) trail.cwds.add(this.canonical(mark.cwd))
      this.trails.set(trailKey(mark.session, mark.id), trail)
      this.track(this.cut(trail))
      return
    }
    const trail = this.trailOf(mark.session, mark.kind === "turn" ? mark.id : mark.turn)
    if (trail && mark.kind !== "turn") {
      for (const path of mark.named ?? []) this.name(trail, path, "read")
      for (const path of mark.mentioned ?? []) if (trail.mentioned.size < MAX_NAMED) trail.mentioned.add(this.canonical(path))
      if (mark.cwd && mark.kind === "call") trail.cwds.add(this.canonical(mark.cwd))
    }
    if (mark.kind === "turn" && mark.edge === "end" && trail && trail.end === undefined) {
      trail.end = mark.at
      this.track(this.cut().then(() => this.decide(trail)))
    }
    if (!this.running.size) this.idleBegan()
  }

  /** A read under way, for `settled`; a failure is logged, never thrown. */
  private track(work: Promise<unknown>): void {
    const done: Promise<void> = work
      .then(() => undefined, (error: Error) => this.deps.log("a footprint could not be read", { error: error.message }))
      .finally(() => this.reads.delete(done))
    this.reads.add(done)
  }

  /**
   * End the open segment, read it for every turn open across it, and start
   * the next for those still open and `joining`. Resolves once the ended
   * segment is read.
   */
  private cut(joining?: Trail): Promise<void> {
    const ended = this.segment
    if (ended) clearTimeout(ended.timer)
    const open = [...(ended?.trails ?? []), ...(joining ? [joining] : [])].filter((trail) => trail.end === undefined)
    this.segment = undefined
    if (open.length && !this.closed) {
      const timer = setTimeout(() => this.track(this.cut()), SEGMENT_MS)
      timer.unref?.()
      this.segment = { mark: this.deps.ports.events.mark().catch(() => null), trails: open, timer }
    }
    if (ended)
      this.segments = this.segments.then(() => this.readSegment(ended)).catch((error: Error) => {
        for (const trail of ended.trails) trail.complete = false
        this.deps.log("a footprint segment could not be read", { error: error.message })
      })
    return this.segments
  }

  /** One segment's history for its turns, leaving out in the reader only the folders every one of them would. */
  private async readSegment(segment: Segment): Promise<void> {
    const mark = await segment.mark
    if (!mark) {
      for (const trail of segment.trails) trail.complete = false
      return
    }
    const writersKnown = Boolean(this.deps.ports.processes)
    const each = segment.trails.map((trail) => new Map(readIgnore(this.folders(trail.thread, trail.start, [...trail.cwds]), this.evidence(trail), writersKnown).map((item) => [item.folder, item])))
    const [first, ...rest] = each
    const shared = first ? [...first.keys()].filter((folder) => rest.every((folders) => folders.has(folder))) : []
    const started = performance.now()
    const found = await this.history(mark, shared)
    const ms = performance.now() - started
    segment.trails.forEach((trail, index) => {
      trail.complete &&= found.complete
      trail.readMs += ms
      for (const path of found.paths) {
        if (trail.paths.size < MAX_PATHS) trail.paths.add(path)
        else if (!trail.paths.has(path)) trail.complete = false
      }
      for (const [path, pids] of found.writers) trail.writers.set(path, pids)
      found.ignored.forEach((count, at) => {
        const item = each[index]?.get(shared[at] ?? "")
        if (!item || !count) return
        trail.ignored += count
        trail.exclusions.add(item.rule, item.folder, count, item.why)
      })
    })
  }

  private evidence(trail: Trail): TurnEvidence {
    return { named: trail.named, mentioned: trail.mentioned, cwds: this.ownFolders(trail) }
  }

  reported(call: ReportedCall): void {
    const trail = this.trailOf(call.session, call.turn)
    if (!trail) return
    for (const effect of call.effects) {
      if (effect.kind === "command") {
        for (const path of effect.named ?? []) this.name(trail, path, "write")
        if (effect.cwd) trail.cwds.add(this.canonical(effect.cwd))
      } else if (effect.kind === "rename") {
        this.name(trail, effect.from, "write")
        this.name(trail, effect.to, "write")
      } else this.name(trail, effect.path, effect.kind === "read" ? "read" : "write")
    }
  }

  /** The trail of a Session's turn: the one named, else the one running. */
  private trailOf(session: string, turn: string | undefined): Trail | undefined {
    if (turn) return this.trails.get(trailKey(session, turn))
    let open: Trail | undefined
    for (const trail of this.trails.values()) if (trail.session === session && trail.end === undefined) open = trail
    return open
  }

  private name(trail: Trail, given: string, access: "read" | "write"): void {
    const path = this.canonical(given)
    const known = trail.named.get(path)
    if (known === "write" || (!known && trail.named.size >= MAX_NAMED)) return
    trail.named.set(path, access)
  }

  /** Every history read under way, for `settled`. */
  async settled(): Promise<void> {
    while (this.reads.size) await Promise.all(this.reads)
  }

  close(): void {
    this.closed = true
    if (this.idle) clearTimeout(this.idle.timer)
    this.idle = undefined
    if (this.segment) clearTimeout(this.segment.timer)
    this.segment = undefined
  }

  /** The folders rules take whole for a turn of `thread`, in the rules' order. */
  private folders(thread: string, since: number, own: readonly string[]): RuleFolder[] {
    const { home, roots } = this.deps.options
    const tracked = this.deps.tracked().map((folder): RuleFolder => ({ folder, rule: "tracked", why: "a tracked checkout" }))
    const stores = this.deps.options.stores().map((folder): RuleFolder => ({ folder, rule: "store", why: "a harness's store or Mako's data" }))
    // Another session's folder never takes the Thread's own: a session in `~/work` says nothing about `~/work/api` the Thread runs in.
    const others = (this.deps.options.others?.(thread, since) ?? [])
      .filter((item) => !container(item.folder, roots) && !own.some((folder) => within(item.folder, folder)))
      .map((item): RuleFolder => ({ folder: item.folder, rule: "other-session", why: item.why }))
    const learned = this.baseline.folders().map((folder): RuleFolder => ({ folder, rule: "baseline", why: "learned: it changes while no Thread runs" }))
    return [...tracked, ...stores, ...others, ...noiseFolders(home), ...learned]
  }

  /** What changed under each root since `mark`, with `ignore` folders left out in the reader and counted, in their order. */
  private async history(mark: string, ignore: readonly string[]): Promise<{ paths: Set<string>; writers: Map<string, readonly number[]>; complete: boolean; ignored: number[] }> {
    const paths = new Set<string>()
    const writers = new Map<string, readonly number[]>()
    let complete = true
    const ignored = ignore.map(() => 0)
    for (const root of this.deps.options.roots) {
      const found = await this.deps.ports.events.since(mark, root, { ignore }).catch(() => null)
      if (!found) {
        complete = false
        continue
      }
      complete &&= found.complete
      for (const path of found.paths) paths.add(path)
      for (const [path, pids] of found.writers ?? []) writers.set(path, pids)
      found.ignored?.forEach((count, index) => {
        if (index < ignored.length) ignored[index]! += count
      })
    }
    return { paths, writers, complete, ignored }
  }

  /** A turn's footprint from what its segments gathered: every path through the rules, the kept ones saved. */
  private async decide(trail: Trail): Promise<void> {
    const end = trail.end ?? this.now()
    const evidence = this.evidence(trail)
    const folders = this.folders(trail.thread, trail.start, [...trail.cwds])
    const exclusions = trail.exclusions
    const started = performance.now()
    const processes = this.deps.ports.processes
    const input: FootprintInput = {
      home: this.deps.options.home,
      roots: this.deps.options.roots,
      folders,
      turn: evidence,
      others: this.othersNamed(trail),
      sessions: this.deps.options.sessions?.(trail.thread),
      writers: trail.writers,
      ours: processes ? (pid) => processes.session(pid) === trail.session : undefined,
      baseline: (path) => this.baseline.verdict(path),
    }
    const rules = new FolderRules(folders)
    const at = this.now()
    const entries: FootprintEntry[] = []
    const bases = new Map<FootprintBasis, number>()
    const weakPaths: string[] = []
    const entry = async (path: string, access: "read" | "write", basis: FootprintBasis): Promise<"kept" | "gone" | "folder"> => {
      const stat = await this.deps.ports.fs.stat(path)
      if (stat && stat.kind !== "file") return "folder"
      if (!stat && basis === "window") return "gone"
      const secret = secretPath(path)
      const kept: FootprintEntry = { thread: trail.thread, session: trail.session, turn: trail.turn, path, access, evidence: strength(basis), basis, at, secret }
      if (access === "write" && stat) {
        kept.size = stat.size
        // Only what evidence links to the turn is carried, so only that is hashed.
        if (basis !== "window" && !secret && stat.size <= READ_LIMIT) {
          const bytes = await this.deps.ports.fs.read(path)
          if (bytes) kept.ref = contentRef(bytes)
        }
      }
      entries.push(kept)
      bases.set(basis, (bases.get(basis) ?? 0) + 1)
      return "kept"
    }
    const explain = this.deps.options.explain
    const decided = (path: string, verdict: PathVerdict) => explain?.({ thread: trail.thread, turn: trail.turn }, path, verdict)
    for (const path of [...trail.paths].sort()) {
      const verdict = classify(path, input, rules)
      if (!verdict.kept) {
        exclusions.add(verdict.rule, verdict.group, 1, verdict.why)
        decided(path, { rule: verdict.rule, group: verdict.group, why: verdict.why })
        continue
      }
      if (verdict.basis === "window" && weakPaths.length >= MAX_WEAK) {
        exclusions.add("capped", parentOf(path))
        decided(path, { rule: "capped", group: parentOf(path) })
        continue
      }
      const outcome = await entry(path, verdict.access, verdict.basis)
      if (outcome === "gone") {
        exclusions.add("gone", parentOf(path))
        decided(path, { rule: "gone", group: parentOf(path) })
      } else if (outcome === "kept") {
        if (verdict.basis === "window") weakPaths.push(path)
        decided(path, { kept: verdict.basis })
      }
    }
    // Paths its calls named that didn't change: read, or written to what they already held.
    for (const [path, access] of trail.named) {
      if (trail.paths.has(path)) continue
      const folder = rules.find(path)
      if (folder?.rule === "tracked" || folder?.rule === "store" || staticNoise(path, this.deps.options.home, this.deps.options.roots)) continue
      if ((await this.deps.ports.fs.stat(path))?.kind !== "file") continue
      await entry(path, access, "named")
    }
    this.deps.store.transaction(() => {
      for (const kept of entries) this.deps.store.addFootprint(kept)
    })
    if (weakPaths.length) this.baseline.weak(trail.thread, weakPaths)
    const summary: FootprintTurn = {
      thread: trail.thread, session: trail.session, turn: trail.turn, start: trail.start, end,
      read: trail.paths.size, ignored: trail.ignored, complete: trail.complete,
      kept: { strong: entries.length - weakPaths.length, weak: weakPaths.length },
      bases: Object.fromEntries(bases),
      excluded: Object.fromEntries(exclusions.byRule),
      groups: exclusions.top(GROUPS_KEPT),
      ms: { read: round(trail.readMs), classify: round(performance.now() - started) },
    }
    this.deps.store.saveFootprintTurn(summary)
    this.logTurn(summary)
    this.forgetEnded()
  }

  /**
   * The folders the turn ran in that stand for it: its Session's folder and
   * its commands', when no checkout holds them and they're not the home or
   * temporary folder itself.
   */
  private ownFolders(trail: Trail): Set<string> {
    const tracked = this.deps.tracked()
    const own = new Set<string>()
    for (const folder of trail.cwds) {
      if (container(folder, this.deps.options.roots) || tracked.some((root) => within(root, folder))) continue
      own.add(folder)
    }
    return own
  }

  /** What other Threads' calls named or their output mentioned while this turn ran. */
  private othersNamed(trail: Trail): Set<string> {
    const end = trail.end ?? this.now()
    const named = new Set<string>()
    for (const other of this.trails.values()) {
      if (other.thread === trail.thread || other.start > end || (other.end !== undefined && other.end < trail.start)) continue
      for (const path of other.named.keys()) named.add(path)
      for (const path of other.mentioned) named.add(path)
    }
    return named
  }

  private forgetEnded(): void {
    const before = this.now() - KEEP_ENDED_MS
    for (const [key, trail] of this.trails) if (trail.end !== undefined && trail.end < before) this.trails.delete(key)
  }

  /* --------------------------------------------------------- the idle baseline */

  /**
   * Nothing runs: mark where the history stands and, after each gap, sample
   * one stretch of it while nothing still runs. A turn starting mid-sample
   * drops it.
   */
  private idleBegan(sample = 0): void {
    if (this.idle || this.closed) return
    const idle: NonNullable<FootprintReader["idle"]> = {
      mark: this.deps.ports.events.mark().catch(() => null),
      at: this.now(),
      timer: setTimeout(() => {
        if (this.idle !== idle) return
        idle.mark = this.deps.ports.events.mark().catch(() => null)
        idle.at = this.now()
        idle.timer = setTimeout(() => {
          if (this.idle !== idle) return
          this.idle = undefined
          this.track(this.sampleIdle(idle.mark, idle.at))
          if (!this.running.size) this.idleBegan(sample + 1)
        }, IDLE_SAMPLE_MS)
        idle.timer.unref?.()
      }, IDLE_GAPS_MS[Math.min(sample, IDLE_GAPS_MS.length - 1)]),
    }
    idle.timer.unref?.()
    this.idle = idle
  }

  private idleEnded(): void {
    if (!this.idle) return
    clearTimeout(this.idle.timer)
    this.idle = undefined
  }

  /** Sample now, for a simulation that moves its clock instead of waiting. */
  async sampleIdleNow(): Promise<number> {
    const idle = this.idle
    if (!idle) return 0
    this.idleEnded()
    if (!this.running.size) this.idleBegan()
    return this.sampleIdle(idle.mark, idle.at)
  }

  /** Learn what changed in an idle stretch that no other rule explains. */
  private async sampleIdle(started: Promise<string | null>, since: number): Promise<number> {
    const mark = await started
    if (!mark || this.closed) return 0
    const readStarted = performance.now()
    const folders = this.folders("", since, [])
    const ignore = readIgnore(folders, { named: new Map(), mentioned: new Set(), cwds: new Set() }, false)
    const history = await this.history(mark, ignore.map((item) => item.folder))
    const rules = new FolderRules(folders)
    const input: FootprintInput = {
      home: this.deps.options.home, roots: this.deps.options.roots, folders, turn: { named: new Map(), mentioned: new Set(), cwds: new Set() }, others: new Set(), sessions: this.deps.options.sessions?.(""),
    }
    const unexplained: string[] = []
    for (const path of history.paths) if (classify(path, input, rules).kept) unexplained.push(path)
    const learned = this.baseline.idle(unexplained)
    this.deps.log("noise learned", { read: history.paths.size, ignored: history.ignored.reduce((total, count) => total + count, 0), unexplained: unexplained.length, keys: learned, rows: this.baseline.size, ms: round(performance.now() - readStarted) })
    return learned
  }

  /* --------------------------------------------------------- logs */

  /** One line at most every ten seconds, summing the turns read since. */
  private logTurn(turn: FootprintTurn): void {
    this.unlogged.push(turn)
    const now = this.now()
    if (now - this.logged < LOG_EVERY_MS) return
    this.logged = now
    const batch = this.unlogged
    this.unlogged = []
    const sum = (pick: (item: FootprintTurn) => number) => batch.reduce((total, item) => total + pick(item), 0)
    this.deps.log("footprints read", {
      turns: batch.length,
      read: sum((item) => item.read),
      ignored: sum((item) => item.ignored),
      strong: sum((item) => item.kept.strong),
      weak: sum((item) => item.kept.weak),
      capped: sum((item) => item.excluded.capped ?? 0),
      maxReadMs: Math.max(...batch.map((item) => item.ms.read)),
      maxClassifyMs: Math.max(...batch.map((item) => item.ms.classify)),
    })
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100
const parentOf = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")))
