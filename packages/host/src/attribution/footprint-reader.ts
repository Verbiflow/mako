import type { ActivityMark, FootprintBasis, FootprintEntry, ReportedCall, TrackerFileStat, TrackerPorts } from "@mako/protocol"
import { contentRef, READ_LIMIT, secretPath } from "./content.js"
import {
  classify,
  container,
  Exclusions,
  FolderRules,
  parent,
  staticNoise,
  strength,
  type ExclusionRule,
  type FootprintInput,
  type FootprintTurn,
  type RuleFolder,
  type TurnEvidence,
} from "./footprint.js"
import type { JournalStore } from "./journal-store.js"
import { within } from "./paths.js"
import { otherAppsData } from "../base/other-apps-data.js"
import { rootLinks } from "./ports.js"

/*
 * Reads each turn's footprint when it ends. Every path the rules can keep
 * lies at or under one of the turn's own claims: a path its calls named, a
 * path its commands' output mentioned, or a folder it ran in outside every
 * checkout. So the system's history is read only under the claims that are
 * folders, and a claim that is a file is asked for its times; the home
 * folder's churn is never read (40 turns on one Mac once read 751,000 of its
 * paths, serially across every Thread, to keep no row). A turn with no claim
 * folder reads no history at all. Each turn reads on its own: in short
 * segments while it runs (`SEGMENT_MS`), each claim folder from where its
 * last read stood, and once more when it ends, before the rules decide.
 */

export interface FootprintOptions {
  home: string
  /**
   * The folders too broad to stand for a turn: the home folder and the
   * temporary folders. A claim at or above one is no claim, and nothing is
   * read from one as a whole.
   */
  roots: readonly string[]
  /** The harnesses' stores and Mako's data: never a footprint, named or not. */
  stores(): readonly string[] | Promise<readonly string[]>
  /** Folders of other sessions on this machine that were active since `since`, not `thread`'s own, with whose they are. */
  others?(thread: string, since: number): readonly { folder: string; why: string }[] | Promise<readonly { folder: string; why: string }[]>
  /** Native ids of every other session on this machine, lowercase, not `thread`'s own, with whose they are. */
  sessions?(thread: string): ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>
  /** Links whose targets the history reports, as [link, target]; the file system's top-level links by default. */
  links?: readonly (readonly [string, string])[]
  /**
   * Each path's verdict as a turn's read decides it, for a replay or a test;
   * the host passes none. Only paths under the turn's claims are read, and
   * those a read left out under a checkout or a store are only counted.
   */
  explain?(turn: { thread: string; turn: string }, path: string, verdict: PathVerdict): void
  /** How often a running turn's claim folders are read, for a test that can't wait `SEGMENT_MS`. */
  segmentMs?: number
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
 * never loses a name, and what the history reported under its claims.
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
  /** Where the history stood when the turn started: a folder first claimed later is read from here. */
  mark: Promise<string | null>
  /**
   * Each claim folder with the mark its next read starts at; null when that
   * mark couldn't be taken. A read runs to the history's present, not to
   * the next mark, so a change between the two can be read twice: a path
   * seen again, never a write lost.
   */
  folders: Map<string, Promise<string | null>>
  /** Claims already looked at, so a read while the turn runs stats only the new ones. */
  seen: Set<string>
  /** The stores, asked for once a turn: each asking crosses to the host process. */
  stores?: Promise<readonly string[]>
  /** The turn's reads, one after another, so its last is in before it is decided. */
  reads: Promise<void>
  /** The next read while the turn runs. */
  timer?: ReturnType<typeof setTimeout>
  /** Paths the reads left out under a checkout or a store inside a claim folder, and what the rules left out. */
  exclusions: Exclusions
  ignored: number
  complete: boolean
  readMs: number
}

/** Paths a trail holds at most of each kind. */
const MAX_NAMED = 4096
/** Changed paths a trail holds at most; past them its footprint is marked incomplete. */
const MAX_PATHS = 50_000
/** A finished turn's names still explain other Threads' paths this long. */
const KEEP_ENDED_MS = 120_000
/**
 * While a turn runs its claim folders are read at least this often, as well
 * as at its end. FSEvents replays every event on the volume since a mark:
 * on a busy Mac a minute is a few hundred milliseconds of fseventsd, an hour
 * five seconds, and past about two hours a read fails. Short segments, each
 * folder read from where its last read stood, keep every read small.
 */
export const SEGMENT_MS = 120_000
/** Excluded groups kept per turn. */
const GROUPS_KEPT = 40
const LOG_EVERY_MS = 10_000

const trailKey = (session: string, turn: string) => `${session}\u0000${turn}`

export class FootprintReader {
  private readonly deps: FootprintReaderDeps
  private readonly trails = new Map<string, Trail>()
  private readonly reads = new Map<Promise<void>, Trail | undefined>()
  private unlogged: FootprintTurn[] = []
  private logged = 0
  private closed = false
  private readonly links: readonly (readonly [string, string])[]

  constructor(deps: FootprintReaderDeps) {
    this.deps = deps
    this.links = deps.options.links ?? rootLinks()
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
    if (mark.kind === "turn" && mark.edge === "start") {
      const key = trailKey(mark.session, mark.id)
      clearTimeout(this.trails.get(key)?.timer)
      const trail: Trail = {
        thread: mark.thread, session: mark.session, turn: mark.id, start: mark.at, named: new Map(), mentioned: new Set(), cwds: new Set(),
        paths: new Set(), writers: new Map(), mark: this.deps.ports.events.mark().catch(() => null), folders: new Map(), seen: new Set(),
        reads: Promise.resolve(), exclusions: new Exclusions(), ignored: 0, complete: true, readMs: 0,
      }
      if (mark.cwd) trail.cwds.add(this.canonical(mark.cwd))
      this.trails.set(key, trail)
      this.arm(trail)
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
      this.track(this.cut(trail).then(() => this.decide(trail)), trail)
    }
  }

  /**
   * A read under way, for `settled`; a failure is logged, never thrown. `deciding` is the ended turn whose footprint the
   * read writes: the one read a wait scoped to that turn's folders stands behind.
   */
  private track(work: Promise<unknown>, deciding?: Trail): void {
    const done: Promise<void> = work
      .then(() => undefined, (error: Error) => this.deps.log("a footprint could not be read", { error: error.message }))
      .finally(() => this.reads.delete(done))
    this.reads.set(done, deciding)
  }

  /** The turn's next read while it runs, a segment from now. */
  private arm(trail: Trail): void {
    if (this.closed) return
    trail.timer = setTimeout(() => {
      if (trail.end === undefined && !this.closed) this.track(this.cut(trail))
    }, this.deps.options.segmentMs ?? SEGMENT_MS)
    trail.timer.unref?.()
  }

  /**
   * End the turn's segment: read its claim folders after the reads it
   * already has under way, and start the next segment while it still runs.
   * Resolves once this read is in. Turns never wait on each other's reads.
   */
  private cut(trail: Trail): Promise<void> {
    clearTimeout(trail.timer)
    trail.timer = undefined
    const last = trail.end !== undefined
    if (!last) this.arm(trail)
    trail.reads = trail.reads.then(() => this.read(trail, last)).catch((error: Error) => {
      trail.complete = false
      this.deps.log("a footprint segment could not be read", { error: error.message })
    })
    return trail.reads
  }

  /** Everything the turn said that a path of its footprint can lie at or under. */
  private claims(trail: Trail): string[] {
    return [...trail.named.keys(), ...trail.mentioned, ...this.ownFolders(trail)]
  }

  private stores(trail: Trail): Promise<readonly string[]> {
    return (trail.stores ??= Promise.resolve().then(() => this.deps.options.stores()))
  }

  /** The checkouts and stores: what they hold is never a footprint, so it is never a claim and never read. */
  private async held(trail: Trail): Promise<RuleFolder[]> {
    const tracked = this.deps.tracked().map((folder): RuleFolder => ({ folder, rule: "tracked", why: "a tracked checkout" }))
    const stores = (await this.stores(trail)).map((folder): RuleFolder => ({ folder, rule: "store", why: "a harness's store or Mako's data" }))
    return [...tracked, ...stores]
  }

  /**
   * Look at the turn's claims: a folder becomes a claim folder, read from
   * the turn's start, and at the turn's end a file whose times say it
   * changed since the start joins the changed paths. Left alone, without a
   * stat: a container, anything a checkout or a store holds, another app's
   * data (macOS would ask the person), and what a claim folder already
   * holds, which that folder's history reports. While the turn runs only
   * claims not yet looked at are; at its end every one that is no folder is
   * looked at again, for a file's times and for a folder made since.
   */
  private async look(trail: Trail, last: boolean, held: FolderRules): Promise<void> {
    const { home, roots } = this.deps.options
    const fresh = new Set(this.claims(trail).filter((path) => !trail.folders.has(path) && (last || !trail.seen.has(path))))
    const since = BigInt(trail.start) * 1_000_000n
    const changed = (stat: TrackerFileStat) => stat.mtimeNs >= since || stat.ctimeNs >= since
    // Shortest first, so a folder is known before the claims inside it.
    for (const path of [...fresh].sort((a, b) => a.length - b.length)) {
      trail.seen.add(path)
      if (container(path, roots) || otherAppsData(path, home) || held.find(path) || holds(trail.folders, path)) continue
      const stat = await this.deps.ports.fs.stat(path)
      if (stat?.kind === "directory") trail.folders.set(path, trail.mark)
      else if (last && stat?.kind === "file" && changed(stat)) this.changed(trail, path)
    }
  }

  private changed(trail: Trail, path: string): void {
    if (trail.paths.size < MAX_PATHS) trail.paths.add(path)
    else if (!trail.paths.has(path)) trail.complete = false
  }

  /**
   * One read for a turn: each of its claim folders' history since that
   * folder's last read, with the checkouts and stores inside it left out in
   * the reader and counted. A turn with no claim folder reads nothing, and
   * takes no mark. A read that fails, or a mark that couldn't be taken,
   * leaves the footprint incomplete, and the folder goes on from the next mark.
   */
  private async read(trail: Trail, last: boolean): Promise<void> {
    if (!trail.folders.size && !this.claims(trail).length) return
    const held = await this.held(trail)
    await this.look(trail, last, new FolderRules(held))
    // A claim folder inside another is covered by the outer one's read.
    const folders = [...trail.folders.keys()].filter((folder) => !holds(trail.folders, parent(folder)))
    if (!folders.length) return
    const started = performance.now()
    const events = this.deps.ports.events
    // The next segment's mark is taken before this one is read, so nothing falls between the two.
    const next = last ? undefined : await events.mark().catch(() => null)
    for (const folder of folders) {
      const from = await trail.folders.get(folder)
      if (next !== undefined) trail.folders.set(folder, Promise.resolve(next))
      const inside = [...new Map(held.filter((item) => within(folder, item.folder)).map((item) => [item.folder, item])).values()]
      const found = from ? await events.since(from, folder, { ignore: inside.map((item) => item.folder) }).catch(() => null) : null
      if (!found) {
        trail.complete = false
        continue
      }
      trail.complete &&= found.complete
      for (const path of found.paths) this.changed(trail, path)
      for (const [path, pids] of found.writers ?? []) trail.writers.set(path, pids)
      found.ignored?.forEach((count, at) => {
        const item = inside[at]
        if (!item || !count) return
        trail.ignored += count
        trail.exclusions.add(item.rule, item.folder, count, item.why)
      })
    }
    trail.readMs += performance.now() - started
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

  /**
   * Every history read under way. With `folders`, only the footprints being written for turns that ran in or around
   * them: a count or a checkpoint of one checkout never waits on another Thread's read, which with many Threads at
   * work is always under way (27 scoped waits gave up after 15 s in 16 minutes, 2026-11-17).
   */
  async settled(folders?: readonly string[]): Promise<void> {
    const around = folders?.map((folder) => this.canonical(folder))
    const waited = () => [...this.reads].filter(([, deciding]) => !around || (deciding !== undefined &&
      [...deciding.cwds].some((cwd) => around.some((folder) => within(folder, cwd) || within(cwd, folder))))).map(([read]) => read)
    for (let reads = waited(); reads.length; reads = waited()) await Promise.all(reads)
  }

  close(): void {
    this.closed = true
    for (const trail of this.trails.values()) clearTimeout(trail.timer)
  }

  /**
   * A turn's footprint from what its reads gathered: every path through the
   * rules, the kept ones saved. The stores, the other sessions' folders and
   * their ids each cross to the host process, so each is asked for once.
   */
  private async decide(trail: Trail): Promise<void> {
    const end = trail.end ?? this.now()
    const evidence = this.evidence(trail)
    const { home, roots } = this.deps.options
    const own = [...trail.cwds]
    // Another session's folder never takes the Thread's own: a session in `~/work` says nothing about `~/work/api` the Thread runs in.
    const others = (await this.deps.options.others?.(trail.thread, trail.start) ?? [])
      .filter((item) => !container(item.folder, roots) && !own.some((folder) => within(item.folder, folder)))
      .map((item): RuleFolder => ({ folder: item.folder, rule: "other-session", why: item.why }))
    const folders = [...await this.held(trail), ...others]
    const exclusions = trail.exclusions
    const started = performance.now()
    const processes = this.deps.ports.processes
    const input: FootprintInput = {
      home,
      roots,
      folders,
      turn: evidence,
      others: this.othersNamed(trail),
      sessions: await this.deps.options.sessions?.(trail.thread),
      writers: trail.writers,
      ours: processes ? (pid) => processes.session(pid) === trail.session : undefined,
    }
    const rules = new FolderRules(folders)
    const at = this.now()
    const entries: FootprintEntry[] = []
    const bases = new Map<FootprintBasis, number>()
    const entry = async (path: string, access: "read" | "write", basis: FootprintBasis): Promise<"kept" | "folder"> => {
      const stat = await this.deps.ports.fs.stat(path)
      if (stat && stat.kind !== "file") return "folder"
      const secret = secretPath(path)
      const kept: FootprintEntry = { thread: trail.thread, session: trail.session, turn: trail.turn, path, access, evidence: strength(basis), basis, at, secret }
      if (access === "write" && stat) {
        kept.size = stat.size
        if (!secret && stat.size <= READ_LIMIT) {
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
    const turn = new Turn()
    // Another app's container is never stat-ed or read here, even when the turn's calls named it: macOS would ask the
    // person whether Mako may access that app's data, on every turn that touched it. The Fin's own call already read it.
    for (const path of [...trail.paths].sort()) {
      await turn.share()
      const sealed = otherAppsData(path, home)
      if (sealed) {
        exclusions.add("noise", sealed, 1, "another app's data")
        decided(path, { rule: "noise", group: sealed, why: "another app's data" })
        continue
      }
      const verdict = classify(path, input, rules)
      if (!verdict.kept) {
        exclusions.add(verdict.rule, verdict.group, 1, verdict.why)
        decided(path, { rule: verdict.rule, group: verdict.group, why: verdict.why })
        continue
      }
      // Only the turn's window links it: no row, no stat, no read, only a count.
      if (verdict.basis === "window") {
        exclusions.add("unclaimed", parent(path))
        decided(path, { rule: "unclaimed", group: parent(path) })
        continue
      }
      if (await entry(path, verdict.access, verdict.basis) === "kept") decided(path, { kept: verdict.basis })
    }
    // Paths its calls named that didn't change: read, or written to what they already held.
    for (const [path, access] of trail.named) {
      if (trail.paths.has(path) || otherAppsData(path, home)) continue
      const folder = rules.find(path)
      if (folder?.rule === "tracked" || folder?.rule === "store" || staticNoise(path, home, roots)) continue
      if ((await this.deps.ports.fs.stat(path))?.kind !== "file") continue
      await entry(path, access, "named")
    }
    this.deps.store.transaction(() => {
      for (const kept of entries) this.deps.store.addFootprint(kept)
    })
    const summary: FootprintTurn = {
      thread: trail.thread, session: trail.session, turn: trail.turn, start: trail.start, end,
      read: trail.paths.size, ignored: trail.ignored, complete: trail.complete,
      kept: { strong: entries.length, weak: 0 },
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
      unclaimed: sum((item) => item.excluded.unclaimed ?? 0),
      maxReadMs: Math.max(...batch.map((item) => item.ms.read)),
      maxClassifyMs: Math.max(...batch.map((item) => item.ms.classify)),
    })
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100

/** How long the rules hold the host's one thread before sockets and timers get a turn. */
const SLICE_MS = 8

/**
 * A turn's paths go through the rules a slice at a time: a busy temporary
 * folder once gave one turn 142,000 paths, classified in one 13-second run.
 */
class Turn {
  private started = performance.now()

  async share(): Promise<void> {
    if (performance.now() - this.started < SLICE_MS) return
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.started = performance.now()
  }
}
/** Whether `path` is one of `folders` or inside one: one lookup per folder on the way up. */
function holds(folders: ReadonlyMap<string, unknown>, path: string): boolean {
  if (!folders.size) return false
  for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) if (folders.has(end === path.length ? path : path.slice(0, end))) return true
  return false
}
