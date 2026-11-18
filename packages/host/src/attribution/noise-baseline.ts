import { container, parent, type NoiseVerdict } from "./footprint.js"
import { within } from "./paths.js"

/*
 * What this Mac changes on its own, learned rather than listed. A path that
 * changes while no Thread of this host runs, or that is left weak in turns
 * of several unrelated Threads, is the machine's churn: a sync daemon's
 * index, an editor's state, another agent's scratch folder. Each is learned
 * under two keys, the file's template (its path with ids, hashes and
 * numbers as `*`, so `claude-1f2e-cwd` and `claude-a9b0-cwd` are one) and,
 * deep enough to be specific, its folder; a folder several of whose
 * subfolders churn is churn as a whole. Scores decay, so what stops
 * changing is forgotten and a folder a Thread starts using is not held
 * against it for long.
 */

/** A learned key as stored. `idle` and `weak` are decayed scores as of `at`. */
export interface NoiseRow {
  key: string
  kind: "template" | "folder"
  idle: number
  weak: number
  /** The last few Threads that left it weak, newest last. */
  threads: string[]
  at: number
}

/** What a path is learned under: its template, and its folder's when the folder is specific enough. */
export interface NoiseKeys {
  template: string
  folder?: string
}

/** Where the baseline keeps its rows; the journal's SQLite in the host, a map in tests. */
export interface NoiseStore {
  noise(): NoiseRow[]
  saveNoise(rows: readonly NoiseRow[]): void
  dropNoise(keys: readonly string[]): void
}

export interface BaselineOptions {
  /** Where footprints are read from: a folder key is only learned two levels below one. */
  roots: readonly string[]
  now(): number
  /** A score halves in this long. Default three days. */
  halfLifeMs?: number
  /** Rows kept at most; the weakest go first. Default 20,000. */
  maxRows?: number
}

const HALF_LIFE_MS = 3 * 86_400_000
const MAX_ROWS = 20_000
/** Keys learned from one window at most: a storm teaches its folders, not every file in it. */
const MAX_KEYS_PER_WINDOW = 2_000
/** Threads remembered per key. */
const THREADS_KEPT = 4
/** A template seen changing in one idle window is churn; a folder needs two. */
const IDLE_TEMPLATE = 0.9
const IDLE_FOLDER = 1.8
/**
 * A folder whose subfolders churn while no Thread runs is churn as a whole
 * once this many distinct ones have, their scores summing to at least
 * `BREADTH_SCORE`: three in one window is a burst, not a habit.
 */
const BREADTH = 3
const BREADTH_SCORE = 3.5
/** The broad folders are worked out again after a learning or this long, as scores decay. */
const BREADTH_FRESH_MS = 60_000
/** Left weak by this many different Threads. */
const WEAK_THREADS = 3
/** Below this a key is forgotten. */
const FORGET = 0.05

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** A hex run of 4 or more holding a digit (`1f2e`, `9b0c41d2`): an id, not a word. */
const HEX = /(?<![0-9a-z])(?=[0-9a-f]*\d)[0-9a-f]{4,}(?![0-9a-z])/gi
const DIGITS = /\d+/g

/** A path with its ids, hashes and numbers as `*`: what a program writes again under another name. */
export function template(path: string): string {
  return path.replace(UUID, "*").replace(HEX, "*").replace(DIGITS, "*")
}

/** How deep `folder` lies below the footprint root holding it; -1 when none holds it. */
function depth(folder: string, roots: readonly string[]): number {
  const root = roots.find((item) => within(item, folder))
  if (!root) return -1
  return folder === root ? 0 : folder.slice(root.length + 1).split("/").length
}

/** A folder that is churn because many of its subfolders are. */
interface BroadFolder {
  folders: number
  score: number
}

export class NoiseBaseline {
  private readonly rows = new Map<string, NoiseRow>()
  private readonly store: NoiseStore
  private readonly options: BaselineOptions
  private broadCache?: { at: number; folders: Map<string, BroadFolder> }

  constructor(store: NoiseStore, options: BaselineOptions) {
    this.store = store
    this.options = options
    for (const row of store.noise()) this.rows.set(row.key, row)
  }

  private get halfLife(): number {
    return this.options.halfLifeMs ?? HALF_LIFE_MS
  }

  /** A score decayed to `at`. */
  private decayed(score: number, from: number, at: number): number {
    return at <= from ? score : score * 0.5 ** ((at - from) / this.halfLife)
  }

  /** The keys a path is learned under: its template and, two levels or more below a root, its folder. */
  keys(path: string): NoiseKeys {
    const folder = parent(path)
    const deep = !container(folder, this.options.roots) && depth(folder, this.options.roots) >= 2
    return { template: template(path), folder: deep ? template(folder) : undefined }
  }

  /** What changed in a window no Thread of this host ran in: the machine's own churn. */
  idle(paths: Iterable<string>): number {
    return this.learn(paths, (row) => (row.idle += 1))
  }

  /** Paths left weak in a turn of `thread`: once several Threads have, they're churn too. */
  weak(thread: string, paths: Iterable<string>): number {
    return this.learn(paths, (row) => {
      row.weak += 1
      row.threads = [...row.threads.filter((item) => item !== thread), thread].slice(-THREADS_KEPT)
    })
  }

  private learn(paths: Iterable<string>, bump: (row: NoiseRow) => void): number {
    const at = this.options.now()
    const touched = new Map<string, NoiseRow>()
    const touch = (key: string, kind: NoiseRow["kind"]) => {
      if (touched.has(key) || touched.size >= MAX_KEYS_PER_WINDOW) return
      const known = this.rows.get(key)
      const row: NoiseRow = known
        ? { ...known, idle: this.decayed(known.idle, known.at, at), weak: this.decayed(known.weak, known.at, at), at }
        : { key, kind, idle: 0, weak: 0, threads: [], at }
      bump(row)
      touched.set(key, row)
    }
    // Folders first: a storm of files in one folder teaches the folder before the cap is reached.
    const list = [...paths]
    for (const path of list) {
      const folder = this.keys(path).folder
      if (folder) touch(folder, "folder")
    }
    for (const path of list) touch(this.keys(path).template, "template")
    if (!touched.size) return 0
    for (const [key, row] of touched) this.rows.set(key, row)
    this.store.saveNoise([...touched.values()])
    this.trim(at)
    this.broadCache = undefined
    return touched.size
  }

  /**
   * Folders two levels or more below a root whose distinct subfolders
   * changed while no Thread ran, by `BREADTH` and `BREADTH_SCORE`: a sync
   * tool that rewrites one project's index now and another's later is
   * churn as a whole, not only where it was last seen.
   */
  private broad(): Map<string, BroadFolder> {
    const at = this.options.now()
    if (this.broadCache && at - this.broadCache.at < BREADTH_FRESH_MS) return this.broadCache.folders
    const roots = this.options.roots.map(template)
    const below = new Map<string, Map<string, number>>()
    for (const row of this.rows.values()) {
      if (row.kind !== "folder") continue
      const idle = this.decayed(row.idle, row.at, at)
      const root = roots.find((item) => within(item, row.key))
      if (idle < IDLE_TEMPLATE || !root) continue
      // Each folder above the row, two levels or more below its root, hears from the subfolder the row is in.
      let end = row.key.indexOf("/", root.length + 1)
      for (end = row.key.indexOf("/", end + 1); end > 0; end = row.key.indexOf("/", end + 1)) {
        const folder = row.key.slice(0, end)
        const next = row.key.indexOf("/", end + 1)
        const sub = row.key.slice(end + 1, next < 0 ? undefined : next)
        const subs = below.get(folder) ?? new Map<string, number>()
        subs.set(sub, Math.max(subs.get(sub) ?? 0, idle))
        below.set(folder, subs)
      }
    }
    const folders = new Map<string, BroadFolder>()
    for (const [folder, subs] of below) {
      let score = 0
      for (const value of subs.values()) score += value
      if (subs.size >= BREADTH && score >= BREADTH_SCORE) folders.set(folder, { folders: subs.size, score })
    }
    this.broadCache = { at, folders }
    return folders
  }

  /** Forget what decayed away, and the weakest rows past the cap. */
  private trim(at: number): void {
    const gone = new Set<string>()
    for (const row of this.rows.values()) if (this.decayed(Math.max(row.idle, row.weak), row.at, at) < FORGET) gone.add(row.key)
    const max = this.options.maxRows ?? MAX_ROWS
    if (this.rows.size - gone.size > max) {
      const ranked = [...this.rows.values()].filter((row) => !gone.has(row.key)).sort((a, b) => this.strength(a, at) - this.strength(b, at))
      for (const row of ranked.slice(0, this.rows.size - gone.size - max)) gone.add(row.key)
    }
    if (!gone.size) return
    for (const key of gone) this.rows.delete(key)
    this.store.dropNoise([...gone])
  }

  private strength(row: NoiseRow, at: number): number {
    return this.decayed(row.idle, row.at, at) + this.decayed(row.weak, row.at, at)
  }

  /** Whether `path` is learned churn, and why. */
  verdict(path: string): NoiseVerdict | undefined {
    const at = this.options.now()
    const keys = this.keys(path)
    const row = this.rows.get(keys.template)
    if (row) {
      const idle = this.decayed(row.idle, row.at, at)
      if (idle >= IDLE_TEMPLATE) return { key: row.key, why: `changed while no Thread ran (score ${idle.toFixed(1)})` }
      if (row.threads.length >= WEAK_THREADS && this.decayed(row.weak, row.at, at) >= WEAK_THREADS * 0.5) return { key: row.key, why: `left unexplained in turns of ${row.threads.length} Threads` }
    }
    const folder = keys.folder ? this.rows.get(keys.folder) : undefined
    if (folder) {
      const idle = this.decayed(folder.idle, folder.at, at)
      if (idle >= IDLE_FOLDER) return { key: `${folder.key}/`, why: `its folder changed while no Thread ran (score ${idle.toFixed(1)})` }
      if (folder.threads.length >= WEAK_THREADS && this.decayed(folder.weak, folder.at, at) >= WEAK_THREADS * 0.5) return { key: `${folder.key}/`, why: `its folder was left unexplained in turns of ${folder.threads.length} Threads` }
    }
    const broad = this.broad()
    if (!broad.size) return undefined
    const above = template(parent(path))
    for (let end = above.length; end > 0; end = above.lastIndexOf("/", end - 1)) {
      const key = above.slice(0, end)
      const found = broad.get(key)
      if (found) return { key: `${key}/`, why: `${found.folders} of its folders changed while no Thread ran (score ${found.score.toFixed(1)})` }
    }
    return undefined
  }

  /** Learned folders that are churn now, as folders a history read can leave out (their templates without `*`). */
  folders(): string[] {
    const at = this.options.now()
    const out: string[] = []
    for (const row of this.rows.values())
      if (row.kind === "folder" && !row.key.includes("*") && this.decayed(row.idle, row.at, at) >= IDLE_FOLDER) out.push(row.key)
    for (const folder of this.broad().keys()) if (!folder.includes("*")) out.push(folder)
    return out
  }

  /** The folders that are churn as a whole, broadest first, for the debugging script. */
  broadFolders(): { folder: string; folders: number; score: number }[] {
    return [...this.broad()].map(([folder, found]) => ({ folder, ...found })).sort((a, b) => a.folder.length - b.folder.length)
  }

  /** The rows with their scores now, strongest first, for the debugging script. */
  list(limit = 50): (NoiseRow & { score: number })[] {
    const at = this.options.now()
    return [...this.rows.values()]
      .map((row) => ({ ...row, idle: this.decayed(row.idle, row.at, at), weak: this.decayed(row.weak, row.at, at), score: this.strength(row, at) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  get size(): number {
    return this.rows.size
  }
}
