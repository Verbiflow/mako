import type { FootprintBasis } from "@mako/protocol"
import { z } from "zod"
import { within } from "./paths.js"

/*
 * A turn's footprint: what changed outside every tracked root while it ran,
 * read from the system's history, and which of those paths are the
 * Thread's. Most of a busy Mac's churn is explained by something Mako
 * already knows (a harness's store, another session's checkout, a cache,
 * what changes while no Thread runs), so each path is put through rules in
 * a fixed order and the first that decides says why: kept with a basis, or
 * left out by a rule. What no rule explains stays as `window`, the weak
 * list a person sees as a count. `classify` is pure, so a test can state
 * every rule and the debugging script shows the same reasons.
 */

/** Why a changed path is not the turn's footprint, in the order the rules run. */
export const EXCLUSION_RULES = [
  /** In a checkout the journal tracks: its changes are entries, not footprint. */
  "tracked",
  /** A harness's own store or Mako's data. */
  "store",
  /** The platform named the writer, and it isn't one of the Thread's processes. */
  "other-writer",
  /** A lock, a database journal or a temporary copy beside a file. */
  "bookkeeping",
  /** In the folder of another session that was active during the turn, or under another session's id. */
  "other-session",
  /** Another Thread's calls named it, and this one's didn't. */
  "other-thread",
  /** Caches, package stores, histories and the system's own churn. */
  "noise",
  /** Learned: it changes while no Thread runs, or across unrelated Threads. */
  "baseline",
  /** Gone at the turn's end and no call named it: a temporary file. */
  "gone",
  /** Past the weak list's cap. */
  "capped",
] as const
export type ExclusionRule = (typeof EXCLUSION_RULES)[number]

/** A folder some rule excludes as a whole, with who or what it belongs to. */
export interface RuleFolder {
  folder: string
  rule: ExclusionRule
  /** In a few words: `claude session 9f2c… in ~/work/api`. */
  why: string
}

/** What a learned baseline says about a path; undefined when it says nothing. */
export interface NoiseVerdict {
  key: string
  why: string
}

/** What the turn itself said: the paths its calls named and mentioned, and the folders it ran in. */
export interface TurnEvidence {
  /** Paths its calls named, with how: a read stays a read unless a call wrote it. */
  named: ReadonlyMap<string, "read" | "write">
  /** Paths its commands' output mentioned. */
  mentioned: ReadonlySet<string>
  /** Folders it and its commands ran in. */
  cwds: ReadonlySet<string>
}

export interface FootprintInput {
  home: string
  /** Where footprints are read from (the home folder, the temporary folder): never a folder a rule can take whole. */
  roots: readonly string[]
  /** Folders whose paths are excluded whole, by rule: tracked roots, stores, other sessions' folders, noise. */
  folders: readonly RuleFolder[]
  turn: TurnEvidence
  /** Paths and folders other Threads' calls named during the turn. */
  others: ReadonlySet<string>
  /** Other sessions' native ids, lowercase, with whose they are: a tool filing things under a session's id writes for that session. */
  sessions?: ReadonlyMap<string, string>
  /** Which processes wrote each path, where the platform says; `ours` says whether one is the Thread's. */
  writers?: ReadonlyMap<string, readonly number[]>
  ours?(pid: number): boolean
  /** The learned baseline. */
  baseline?(path: string): NoiseVerdict | undefined
}

export type Classified =
  | { path: string; kept: true; basis: FootprintBasis; access: "read" | "write" }
  | { path: string; kept: false; rule: ExclusionRule; group: string; why?: string }

/** Under the home folder: churn no turn means, unless one of its calls named the path. */
export const HOME_NOISE = [
  "Library",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".bun/install",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
  ".gradle",
  ".m2/repository",
  "go/pkg",
  ".local/share/Trash",
  ".local/state",
  ".zsh_sessions",
  ".Trash",
] as const
const HOME_NOISE_FILES = new Set([".zsh_history", ".bash_history", ".python_history", ".node_repl_history", ".lesshst", ".viminfo", ".DS_Store", ".CFUserTextEncoding"])
/** Anywhere outside the roots. */
const NOISE_PARTS = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", ".cache", "tmp", "temp", ".tmp", "Caches"])
/** Files whose churn is a program's own bookkeeping: SQLite's journals, locks, temporary copies. */
const BOOKKEEPING = /(-wal|-shm|-journal|\.lock|\.pid|\.tmp|\.swp|~)$|\.tmp\b/

/** The static noise folders under `home`, as folders a history read can leave out. */
export function noiseFolders(home: string): RuleFolder[] {
  return HOME_NOISE.map((folder) => ({ folder: `${home}/${folder}`, rule: "noise", why: "caches and the system's churn" }))
}

/**
 * Whether `path` is static noise: a cache or history anywhere outside the
 * tracked checkouts. Only folders below the footprint root holding it
 * count, so `/private/tmp` itself is not a `tmp` folder.
 */
export function staticNoise(path: string, home: string, roots: readonly string[] = [home]): string | undefined {
  const root = roots.find((item) => within(item, path)) ?? ""
  const below = path.slice(root.length)
  const part = below.split("/").find((item) => NOISE_PARTS.has(item))
  if (part) return root + below.slice(0, below.indexOf(`/${part}`) + part.length + 1)
  if (!within(home, path)) return undefined
  const inside = path.slice(home.length + 1)
  if (HOME_NOISE_FILES.has(inside)) return path
  const folder = HOME_NOISE.find((item) => within(item, inside))
  return folder ? `${home}/${folder}` : undefined
}

/**
 * Whether `folder` is too broad to stand for anything: a footprint root
 * (the home folder, the temporary folder) or above one. A command run in
 * the home folder, or a call naming `/tmp`, says nothing about one file.
 */
export function container(folder: string, roots: readonly string[]): boolean {
  return folder === "/" || roots.some((root) => within(folder, root))
}

/** The nearest of `path` and its folders that `set` holds, below every container; undefined when none. */
function holder(set: ReadonlySet<string> | ReadonlyMap<string, unknown>, path: string, roots: readonly string[]): string | undefined {
  if (set.has(path)) return path
  for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
    const folder = path.slice(0, end)
    if (container(folder, roots)) return undefined
    if (set.has(folder)) return folder
  }
  return undefined
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * The folder of `path` named after one of `sessions`, and whose: a UUID
 * anywhere in it (`codex-<id>.json`), or a whole name, extension aside
 * (`ses_8f2c`). Undefined when it names none.
 */
function sessionNamed(path: string, sessions: ReadonlyMap<string, string>): { group: string; why: string } | undefined {
  /** The id ending at `end` names a session: the path up to the name holding it is its group. */
  const named = (id: string, end: number) => {
    const why = sessions.get(id.toLowerCase())
    if (!why) return undefined
    const after = path.indexOf("/", end)
    return { group: after < 0 ? parent(path) : path.slice(0, after), why: `${why}, by its id` }
  }
  for (const match of path.matchAll(SESSION_ID)) {
    const found = named(match[0], match.index + match[0].length)
    if (found) return found
  }
  for (let start = 1; start < path.length; ) {
    const end = path.indexOf("/", start)
    const stop = end < 0 ? path.length : end
    const name = path.slice(start, stop)
    const dot = name.indexOf(".", 1)
    const found = named(dot > 0 ? name.slice(0, dot) : name, stop)
    if (found) return found
    start = stop + 1
  }
  return undefined
}

const RULE_ORDER = new Map<ExclusionRule, number>(EXCLUSION_RULES.map((rule, index) => [rule, index]))

/** Each rule folder by path, so a lookup walks a path's folders once. */
export class FolderRules {
  private readonly byFolder = new Map<string, RuleFolder>()

  constructor(folders: readonly RuleFolder[]) {
    for (const folder of folders) {
      const known = this.byFolder.get(folder.folder)
      if (!known || RULE_ORDER.get(folder.rule)! < RULE_ORDER.get(known.rule)!) this.byFolder.set(folder.folder, folder)
    }
  }

  /** The rule folder holding `path` whose rule comes first: a tracked root inside another session's folder is still tracked. */
  find(path: string): RuleFolder | undefined {
    let best: RuleFolder | undefined
    for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
      const found = this.byFolder.get(end === path.length ? path : path.slice(0, end))
      if (found && (!best || RULE_ORDER.get(found.rule)! < RULE_ORDER.get(best.rule)!)) best = found
    }
    return best
  }
}

/**
 * The folders a history read can leave out before anything crosses to the
 * tracker: a rule folder no evidence of the turn can win back. `tracked`
 * and `store` always qualify; the others only when nothing the turn named,
 * mentioned or ran in lies in or above them, and only where no platform
 * names writers (a writer can win a path back from any of them). The
 * reader counts each path under the innermost folder holding it, so a
 * folder inside one whose rule comes first is not sent: it would only
 * lengthen the list and count its paths under the later rule.
 */
export function readIgnore(folders: readonly RuleFolder[], turn: TurnEvidence, writers: boolean): RuleFolder[] {
  const claims = [...turn.named.keys(), ...turn.mentioned, ...turn.cwds]
  const chosen = new Map<string, RuleFolder>()
  for (const item of folders) {
    if (chosen.has(item.folder)) continue
    const always = item.rule === "tracked" || item.rule === "store"
    if (always || (!writers && !claims.some((path) => within(item.folder, path) || within(path, item.folder)))) chosen.set(item.folder, item)
  }
  return [...chosen.values()].filter((item) => {
    for (let end = item.folder.lastIndexOf("/"); end > 0; end = item.folder.lastIndexOf("/", end - 1)) {
      const outer = chosen.get(item.folder.slice(0, end))
      if (outer && RULE_ORDER.get(outer.rule)! <= RULE_ORDER.get(item.rule)!) return false
    }
    return true
  })
}

/**
 * The rules, in order, for one changed path. A path no rule decides is
 * `window`: weak, kept as a count. Paths that are gone at the turn's end,
 * and the weak list's cap, are decided after, by the caller, because they
 * need the disk.
 */
export function classify(path: string, input: FootprintInput, rules: FolderRules = new FolderRules(input.folders)): Classified {
  const folder = rules.find(path)
  if (folder?.rule === "tracked" || folder?.rule === "store") return { path, kept: false, rule: folder.rule, group: folder.folder, why: folder.why }
  const writers = input.writers?.get(path)
  if (writers?.length && input.ours) {
    if (writers.some((pid) => input.ours!(pid))) return { path, kept: true, basis: "writer", access: "write" }
    return { path, kept: false, rule: "other-writer", group: parent(path), why: `written by process ${writers[0]}` }
  }
  if (input.turn.named.has(path)) return { path, kept: true, basis: "named", access: "write" }
  if (input.turn.mentioned.has(path)) return { path, kept: true, basis: "output", access: "write" }
  if (BOOKKEEPING.test(path.slice(path.lastIndexOf("/") + 1))) return { path, kept: false, rule: "bookkeeping", group: parent(path) }
  if (folder?.rule === "other-session") return { path, kept: false, rule: "other-session", group: folder.folder, why: folder.why }
  const other = holder(input.others, path, input.roots)
  const named = holder(input.turn.named, path, input.roots)
  if (other && !named) return { path, kept: false, rule: "other-thread", group: other, why: "another Thread's calls named it" }
  const session = !named && input.sessions?.size ? sessionNamed(path, input.sessions) : undefined
  if (session) return { path, kept: false, rule: "other-session", group: session.group, why: session.why }
  if (named) return { path, kept: true, basis: "folder", access: "write" }
  if (holder(input.turn.mentioned, path, input.roots)) return { path, kept: true, basis: "output", access: "write" }
  if (holder(input.turn.cwds, path, input.roots)) return { path, kept: true, basis: "cwd", access: "write" }
  const noise = folder?.rule === "noise" ? folder.folder : staticNoise(path, input.home, input.roots)
  if (noise) return { path, kept: false, rule: "noise", group: noise, why: folder?.why }
  const learned = input.baseline?.(path)
  if (learned) return { path, kept: false, rule: "baseline", group: learned.key, why: learned.why }
  return { path, kept: true, basis: "window", access: "write" }
}

export function parent(path: string): string {
  return path.slice(0, Math.max(1, path.lastIndexOf("/")))
}

/** Excluded paths gathered by rule and folder, for the turn's summary: the biggest groups, at most `limit`. */
export interface ExcludedGroup {
  rule: ExclusionRule
  folder: string
  count: number
  why?: string
}

export class Exclusions {
  private readonly groups = new Map<string, ExcludedGroup>()
  readonly byRule = new Map<ExclusionRule, number>()

  add(rule: ExclusionRule, folder: string, count = 1, why?: string): void {
    if (count <= 0) return
    this.byRule.set(rule, (this.byRule.get(rule) ?? 0) + count)
    const key = `${rule}\u0000${folder}`
    const group = this.groups.get(key)
    if (group) {
      group.count += count
      return
    }
    const added: ExcludedGroup = { rule, folder, count }
    if (why) added.why = why
    this.groups.set(key, added)
  }

  top(limit: number): ExcludedGroup[] {
    return [...this.groups.values()].sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder)).slice(0, limit)
  }

  get total(): number {
    let sum = 0
    for (const count of this.byRule.values()) sum += count
    return sum
  }
}

const ExcludedGroupSchema = z.object({ rule: z.enum(EXCLUSION_RULES), folder: z.string(), count: z.number(), why: z.string().optional() })

/** One turn's footprint as read: the window, what the history returned, what was kept and what each rule left out. */
export const FootprintTurnSchema = z.object({
  thread: z.string(),
  session: z.string(),
  turn: z.string().optional(),
  start: z.number(),
  end: z.number(),
  /** Paths the history returned, and those the reader left out under rule folders. */
  read: z.number(),
  ignored: z.number(),
  complete: z.boolean(),
  kept: z.object({ strong: z.number(), weak: z.number() }),
  /** Paths each kept basis covers. */
  bases: z.record(z.string(), z.number()),
  excluded: z.record(z.string(), z.number()),
  /** The biggest groups of excluded paths, by rule and folder. */
  groups: z.array(ExcludedGroupSchema),
  /** Milliseconds: the history read (in the reader, off the host's thread) and the rules, stats and writes on it. */
  ms: z.object({ read: z.number(), classify: z.number() }),
})
export type FootprintTurn = z.infer<typeof FootprintTurnSchema>

/** Strong bases, for the contract's `evidence`. */
export function strength(basis: FootprintBasis): "strong" | "weak" {
  return basis === "window" ? "weak" : "strong"
}
