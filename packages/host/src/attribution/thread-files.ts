import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import type { Git } from "@mako/git"
import type { CarriedEffect, CarriedName } from "@mako/protocol"
import { QUIET_FOLDERS } from "../base/quiet-folders.js"
import type { FileResolution, MovedPaths, Touch, TouchKind } from "../contracts/file-references.js"
import { candidatesOf, RENAME_LOG, RenameHistory, resolveSpelling, spellingLine, SuffixIndex, type Place, type ReferenceContext } from "../files/index.js"
import { decodeText } from "./content.js"
import type { JournalStore, StoredActivity, StoredEffect, StoredRoot } from "./journal-store.js"
import { diffLines, splitLines } from "./line-diff.js"

/** Whose message the spellings are in: its Thread, and the folders it works in now. */
export interface ReferenceSource {
  thread?: string
  /** The conversation's own folder. */
  cwd?: string
  /** The folders the Thread works in now: its checkout, or its worktree after a move. */
  current: readonly string[]
  /** When the answer was finished: what the Thread had touched by then, and renames since. Undefined: now. */
  asOf?: number
}

/** Spellings resolved in one call at most: a long answer's references, with room. */
export const MAX_SPELLINGS = 400
/** Folders a Thread's calls ran in that a relative spelling is tried from, latest first. */
const MAX_FOLDERS = 12
/** Past this many entries since an index was built, building it again is cheaper than catching up. */
const CATCH_UP = 5_000
const PARALLEL = 32
/** Paths a move notice names; the rest are counted. */
const MAX_NOTICE = 20
/** Dependencies and build output a checkout's recipe makes again, which a move notice never lists. */
const QUIET = new Set<string>(QUIET_FOLDERS)
/** A touch this soon after an answer's last message is still its turn's: the record's clock and the journal's differ. */
const AS_OF_SLACK_MS = 5_000
/** How long a repository's renames stand before HEAD is asked again. */
const RENAMES_FRESH_MS = 60_000
/** Reading a repository's renames gives up past this; links go on without them. */
const RENAMES_TIMEOUT_MS = 20_000
/** Threads whose carried history is kept read. */
const CARRIED_THREADS = 32
/** Threads whose work is kept read, until the journal changes. */
const WORK_THREADS = 16
/** Renames a line is followed through, at most. */
const LINE_HOPS = 16

/** A turn, call or background work as resolving reads it: this journal's own, or one carried from another's. */
type Worked = Pick<StoredActivity, "start" | "cwd" | "checkout" | "status"> & { named: readonly string[]; effects?: readonly (StoredEffect | CarriedEffect)[] }

/** The parts of a Thread's history other journals carried here, read for resolving. */
interface Carried {
  version: string
  activity: Worked[]
  writes: { path: string; at: number }[]
  /** The newest of the parts' last entries at each path. */
  names: ReadonlyMap<string, CarriedName>
  roots: readonly { path: string; repository: boolean }[]
}

/** A Thread's work as this journal knows it: its own, and what was carried here. */
interface ThreadWork {
  activity: Worked[]
  /** Writes tied for certain to one of its calls, by absolute path. */
  writes: { path: string; at: number }[]
  names: ReadonlyMap<string, CarriedName>
  /** Folders other journals tracked it in. */
  roots: readonly { path: string; repository: boolean }[]
}

const NO_WORK: ThreadWork = { activity: [], writes: [], names: new Map(), roots: [] }

export interface ThreadFilesDeps {
  git: Git
  home: string
}

interface Indexed {
  index: SuffixIndex
  seq: number
}

interface Renames {
  head: string
  history: RenameHistory
}

/** A repository's renames as last read, and the read after it. */
interface Reading {
  at: number
  done?: Renames
  settled: boolean
  read: Promise<void>
}

const STRENGTH = { wrote: 0, read: 1, named: 2 } as const satisfies Record<TouchKind, number>

/**
 * Which file each spelling in a message means, from the journal: the
 * Thread's touches and folders, its places' files by the end of their
 * paths, and renames. One call per message; a place's index is built on
 * first use from the journal's own list of the root's files (no Git, no
 * walk), then kept up from the entries after it. Renames from before the
 * journal tracked a repository come from its Git history, read once in the
 * background and then only the commits since; an answer never waits for it.
 */
export class ThreadFiles {
  private readonly indexes = new Map<string, Indexed>()
  /** Each Thread's work as last read, with the journal's version then. */
  private readonly work = new Map<string, { version: string; work: ThreadWork }>()
  private readonly repositories = new Map<string, Promise<string | undefined>>()
  private readonly renames = new Map<string, Reading>()
  private readonly carried = new Map<string, Carried>()
  private journal = ""
  private readonly deps: ThreadFilesDeps

  constructor(deps: ThreadFilesDeps) {
    this.deps = deps
  }

  async resolve(store: JournalStore, source: ReferenceSource, spellings: readonly string[]): Promise<FileResolution[]> {
    const context = await this.context(store, source)
    const wanted = new Set<string>()
    for (const spelling of spellings) for (const draft of candidatesOf(spelling, context)) wanted.add(draft.path)
    const files = await existing([...wanted])
    const roots = store.roots()
    return spellings.map((spelling) => {
      const found = resolveSpelling(spelling, context, (path) => files.has(path))
      const line = spellingLine(spelling)
      // A line the answer named, where it is now: the file changed since, and the line moved with it.
      if (found.kind !== "file" || line === undefined || source.asOf === undefined) return found
      const now = lineNow(store, roots, found.file.was ?? found.file.path, line, source.asOf)
      return now === undefined ? found : { ...found, file: { ...found.file, line: { was: line, now } } }
    })
  }

  /** Once the renames being read from repositories' Git history are in. */
  async renamesRead(): Promise<void> {
    await Promise.all([...this.renames.values()].map((entry) => entry.read))
  }

  /**
   * The paths the Thread used in the checkout `from` (a folder in it) whose
   * spelling changed beyond moving to `to`'s checkout: renamed since it last
   * used them, by someone other than itself, or not brought along. Undefined
   * when the two folders aren't separate checkouts.
   */
  async movedPaths(store: JournalStore, thread: string, from: string, to: string, limit = MAX_NOTICE): Promise<MovedPaths | undefined> {
    const [old, next] = await Promise.all([this.toplevel(from), this.toplevel(to)])
    if (!old || !next || within(old, next) || within(next, old)) return undefined
    const roots = store.roots()
    const work = this.workOf(store, roots, thread)
    const touched = touchesOf(work.activity, work.writes)
    const used = [...touched]
      .filter(([path]) => within(path, old) && path !== old && !relative(old, path).split(sep).some((part) => QUIET.has(part)))
      .sort((a, b) => b[1].at - a[1].at)
    const rebind = (path: string) => (within(path, old) ? join(next, relative(old, path)) : path)
    const drafts: ({ was: string; now: string } | { stayed: string })[] = []
    // One line a file: its latest spelling, when several of the agent's led to it.
    const named = new Set<string>()
    for (const [path, touch] of used) {
      const now = renamedTo(store, roots, path, work.names)
      const known = now && (touched.get(now)?.at ?? -1) >= touch.at
      if (now && now !== path) {
        if (!known && !named.has(now)) drafts.push({ was: path, now: rebind(now) })
        named.add(now)
      } else drafts.push({ stayed: path })
    }
    const paths = [...new Set(drafts.flatMap((draft) => ("stayed" in draft ? [draft.stayed, rebind(draft.stayed)] : [draft.now])))]
    const files = await existing(paths)
    const notice: MovedPaths = { root: { from: old, to: next }, renamed: [], stayed: [], more: 0 }
    for (const draft of drafts) {
      const kept = "stayed" in draft ? files.has(draft.stayed) && !files.has(rebind(draft.stayed)) : files.has(draft.now)
      if (!kept) continue
      if (notice.renamed.length + notice.stayed.length >= limit) notice.more++
      else if ("stayed" in draft) notice.stayed.push(draft.stayed)
      else notice.renamed.push(draft)
    }
    return notice
  }

  private toplevel(folder: string): Promise<string | undefined> {
    return this.deps.git.run({ cwd: folder, args: ["rev-parse", "--show-toplevel"], read: true })
      .then((result) => result.stdout.toString("utf8").trim() || undefined)
      .catch(() => undefined)
  }

  /** What the Thread knows for resolving the source's spellings: `resolve` asks it, and `npm run attribution -- files` prints it. */
  async context(store: JournalStore, source: ReferenceSource): Promise<ReferenceContext> {
    const until = source.asOf === undefined ? Number.POSITIVE_INFINITY : source.asOf + AS_OF_SLACK_MS
    // Every root the journal has known: a file renamed in a checkout since forgotten still followed.
    const roots = store.roots()
    const work = source.thread ? this.workOf(store, roots, source.thread) : NO_WORK
    const activity = work.activity.filter((item) => item.start <= until).sort((a, b) => b.start - a.start)
    const folders: string[] = []
    for (const item of activity) if (item.cwd && !folders.includes(item.cwd) && folders.length < MAX_FOLDERS) folders.push(item.cwd)
    if (source.cwd && !folders.includes(source.cwd)) folders.push(source.cwd)
    const touched = touchesOf(activity, work.writes, until)
    // Only where the Thread has been: the roots its work ran in or touched, and where it works now.
    const been = new Set(source.current)
    for (const item of work.activity) {
      if (item.checkout) been.add(item.checkout)
      if (item.cwd) been.add(item.cwd)
    }
    const near = (root: StoredRoot) =>
      [...been].some((folder) => within(folder, root.path) || within(root.path, folder)) || [...touched.keys()].some((path) => within(path, root.path))
    const places = await this.places(store, roots.filter(near), source, activity, work.roots)
    const histories = source.asOf === undefined ? new Map<string, RenameHistory>() : this.histories(places, [...folders, ...touched.keys()])
    return {
      folders,
      touched,
      places,
      renamed: (path) => renamedTo(store, roots, path, work.names) ?? (source.asOf === undefined ? undefined : renamedInGit(histories, path, source.asOf)),
      home: this.deps.home,
      ...(source.thread && { chosen: store.choices(source.thread) }),
    }
  }

  /** The Thread's activity and certain writes in this journal, with the parts other journals carried here; read again once anything is written. */
  private workOf(store: JournalStore, roots: readonly StoredRoot[], thread: string): ThreadWork {
    if (store.id !== this.journal) {
      this.indexes.clear()
      this.carried.clear()
      this.work.clear()
      this.journal = store.id
    }
    const version = store.version()
    const known = this.work.get(thread)
    if (known?.version === version) return known.work
    const work = this.readWork(store, roots, thread)
    this.work.delete(thread)
    this.work.set(thread, { version, work })
    if (this.work.size > WORK_THREADS) this.work.delete(this.work.keys().next().value!)
    return work
  }

  private readWork(store: JournalStore, roots: readonly StoredRoot[], thread: string): ThreadWork {
    const carried = this.carriedOf(store, thread)
    const byId = new Map(roots.map((root) => [root.id, root.path]))
    const writes = [...carried.writes]
    // Only writes the journal ties to one of the Thread's calls; one credited only because a turn was running is a guess.
    for (const entry of store.entriesBy("thread", thread)) {
      const root = byId.get(entry.root)
      const certain = entry.author.certainty === "exact" || entry.author.certainty === "named"
      if (root && certain && entry.kind !== "delete") writes.push({ path: join(root, entry.path), at: entry.at })
    }
    return { activity: [...store.activityOfThread(thread), ...carried.activity], writes, names: carried.names, roots: carried.roots }
  }

  /** The carried parts, read again only once another is carried. */
  private carriedOf(store: JournalStore, thread: string): Carried {
    const version = store.carriedVersion(thread)
    const known = this.carried.get(thread)
    if (known?.version === version) return known
    const parts = store.carriedParts(thread).filter((part) => part.journal !== store.id)
    const names = new Map<string, CarriedName>()
    for (const part of parts)
      for (const name of part.names) {
        const seen = names.get(name.path)
        if (!seen || name.at > seen.at) names.set(name.path, name)
      }
    const roots = new Map(parts.flatMap((part) => part.roots).map((root) => [root.path, root]))
    const carried: Carried = {
      version,
      activity: parts.flatMap((part) => part.activity),
      writes: parts.flatMap((part) => part.writes.map((write) => ({ path: write.path, at: write.at }))),
      names,
      roots: [...roots.values()],
    }
    this.carried.delete(thread)
    this.carried.set(thread, carried)
    if (this.carried.size > CARRIED_THREADS) this.carried.delete(this.carried.keys().next().value!)
    return carried
  }

  /** The Git renames of each repository a path in `paths` is in, as far as read; the rest are read for the next answer. */
  private histories(places: readonly Place[], paths: readonly string[]): Map<string, RenameHistory> {
    const histories = new Map<string, RenameHistory>()
    for (const place of places) {
      if (!place.repository || place.gone || !paths.some((path) => within(path, place.root))) continue
      const history = this.renamesOf(place.root)
      if (history) histories.set(place.root, history)
    }
    return histories
  }

  private renamesOf(root: string): RenameHistory | undefined {
    const known = this.renames.get(root)
    if (known && (!known.settled || Date.now() - known.at < RENAMES_FRESH_MS)) return known.done?.history
    const reading: Reading = { at: Date.now(), done: known?.done, settled: false, read: Promise.resolve() }
    reading.read = this.readRenames(root, known?.done).then((done) => {
      reading.done = done
      reading.settled = true
    })
    this.renames.set(root, reading)
    return reading.done?.history
  }

  private async readRenames(root: string, was: Renames | undefined): Promise<Renames | undefined> {
    const run = (args: readonly string[]) => this.deps.git.run({ cwd: root, args, read: true, timeoutMs: RENAMES_TIMEOUT_MS }).then((result) => result.stdout.toString("utf8"))
    try {
      const head = (await run(["rev-parse", "--verify", "--quiet", "HEAD"])).trim()
      if (!head || head === was?.head) return was
      const history = was?.history ?? new RenameHistory()
      history.add(await run([...RENAME_LOG, was ? `${was.head}..${head}` : head]))
      return { head, history }
    } catch {
      return was
    }
  }

  private async places(store: JournalStore, roots: readonly StoredRoot[], source: ReferenceSource, activity: readonly Worked[], carried: ThreadWork["roots"]): Promise<Place[]> {
    const current = (root: string) => source.current.some((folder) => within(folder, root) || within(root, folder))
    const indexes = this.indexesOf(store, roots.filter((root) => root.active))
    const places: Place[] = []
    await Promise.all(roots.map(async (root) => {
      const gone = !root.active && !existsSync(root.path)
      const repository = root.repository && !gone ? await this.repository(root.path) : undefined
      places.push({
        root: root.path,
        name: basename(root.path),
        current: current(root.path),
        ...(repository && { repository }),
        ...(gone && { gone }),
        ...(indexes.has(root.id) && { index: indexes.get(root.id) }),
      })
    }))
    // Folders another journal tracked the Thread in, before it came here: this machine's own index has them if it tracks them too.
    const known = new Set(places.map((place) => place.root))
    await Promise.all(carried.filter((root) => !known.has(root.path)).map(async (root) => {
      known.add(root.path)
      const gone = !existsSync(root.path)
      const repository = root.repository && !gone ? await this.repository(root.path) : undefined
      places.push({ root: root.path, name: basename(root.path), current: current(root.path), ...(repository && { repository }), ...(gone && { gone }) })
    }))
    // The checkouts the Thread was in that the journal no longer tracks: a worktree since removed.
    for (const checkout of new Set(activity.flatMap((item) => (item.checkout ? [item.checkout] : []))))
      if (!known.has(checkout) && !existsSync(checkout)) places.push({ root: checkout, name: basename(checkout), current: false, gone: true })
    return places
  }

  private repository(root: string): Promise<string | undefined> {
    let found = this.repositories.get(root)
    if (!found) {
      found = this.deps.git.run({ cwd: root, args: ["rev-parse", "--git-common-dir"], read: true })
        .then((result) => {
          const dir = result.stdout.toString("utf8").trim()
          return dir ? (isAbsolute(dir) ? dir : join(root, dir)) : undefined
        })
        .catch(() => undefined)
      this.repositories.set(root, found)
    }
    return found
  }

  /**
   * Each root's files by the end of their paths, caught up to the journal's
   * last entry: one built from the journal's list of the root's files when
   * it has none or is far behind, the rest caught up together in one pass
   * over the entries since the oldest of them.
   */
  private indexesOf(store: JournalStore, roots: readonly StoredRoot[]): Map<string, SuffixIndex> {
    const last = store.lastSeq()
    const behind = new Map<string, Indexed>()
    for (const root of roots) {
      const indexed = this.indexes.get(root.id)
      if (!indexed || last - indexed.seq > CATCH_UP) this.indexes.set(root.id, { index: SuffixIndex.of(store.stats(root.id).keys()), seq: last })
      else if (indexed.seq < last) behind.set(root.id, indexed)
    }
    let seq = Math.min(...[...behind.values()].map((indexed) => indexed.seq))
    while (behind.size && seq < last) {
      const batch = store.entries(seq, 1_000)
      if (!batch.length) break
      for (const entry of batch) {
        const indexed = behind.get(entry.root)
        if (!indexed || entry.seq <= indexed.seq) continue
        if (entry.kind === "delete") indexed.index.remove(entry.path)
        else {
          if (entry.kind === "rename" && entry.from) indexed.index.remove(entry.from)
          indexed.index.add(entry.path)
        }
      }
      seq = batch.at(-1)!.seq
    }
    for (const indexed of behind.values()) indexed.seq = last
    return new Map(roots.flatMap((root) => {
      const indexed = this.indexes.get(root.id)
      return indexed ? [[root.id, indexed.index]] : []
    }))
  }
}

/**
 * Each file the Thread touched, by absolute path, with its strongest touch
 * and when. A call that failed or was refused wrote nothing it said it
 * would: its effects only name their paths.
 */
function touchesOf(activity: readonly Worked[], writes: ThreadWork["writes"], until = Number.POSITIVE_INFINITY): Map<string, Touch> {
  const touched = new Map<string, Touch>()
  const touch = (path: string | undefined, kind: TouchKind, at: number, cwd?: string) => {
    if (!path) return
    const absolute = isAbsolute(path) ? path : cwd ? join(cwd, path) : undefined
    if (!absolute) return
    const seen = touched.get(absolute)
    if (!seen || STRENGTH[kind] < STRENGTH[seen.kind] || (kind === seen.kind && at > seen.at)) touched.set(absolute, { kind, at })
  }
  for (const item of activity) {
    for (const path of item.named) touch(path, "named", item.start, item.cwd)
    const wrote = item.status === "failed" || item.status === "refused" ? "named" : "wrote"
    for (const effect of item.effects ?? []) {
      if (effect.kind === "rename") touch(effect.to, wrote, item.start, item.cwd)
      else if (effect.kind === "read") touch(effect.path, "read", item.start, item.cwd)
      else if (effect.kind === "command") for (const path of effect.named ?? []) touch(path, "named", item.start, effect.cwd ?? item.cwd)
      else touch(effect.path, wrote, item.start, item.cwd)
    }
  }
  for (const write of writes) if (write.at <= until) touch(write.path, "wrote", write.at)
  return touched
}

/**
 * Where a file is now, following each rename after the last: at each path,
 * whichever saw it last, this journal or a part carried from another,
 * says whether it was renamed away, so a file renamed on the laptop and
 * again on a cloud machine is followed through both.
 */
function renamedTo(store: JournalStore, roots: readonly StoredRoot[], path: string, carried: ReadonlyMap<string, CarriedName>): string | undefined {
  let current = path
  let since = Number.NEGATIVE_INFINITY
  let after = { root: "", seq: 0 }
  for (let hops = 0; hops < 16; hops++) {
    let root: StoredRoot | undefined
    for (const candidate of roots) if (within(current, candidate.path) && current !== candidate.path && (!root || candidate.path.length > root.path.length)) root = candidate
    const inside = root && current.slice(root.path.length + 1)
    const local = root && inside ? store.last(root.id, inside, after.root === root.id ? after.seq : 0) : undefined
    const elsewhere = carried.get(current)
    const away = elsewhere && elsewhere.at >= since && (!local || elsewhere.at > local.at) ? elsewhere : undefined
    if (away) {
      if (!away.to) break
      current = away.to
      since = away.at
      continue
    }
    if (!root || !local || local.kind !== "rename" || local.from !== inside) break
    current = join(root.path, local.path)
    since = local.at
    after = { root: root.id, seq: local.seq }
  }
  return current !== path ? current : undefined
}

/**
 * Where line `line` (from 1) of the file at `path` as of `asOf` is now:
 * through each change to it since, by the journal's own line diff of the
 * change's two sides, and through its renames. Null once the line was
 * removed or the file deleted; undefined when the file isn't tracked or a
 * version between isn't kept.
 */
export function lineNow(store: JournalStore, roots: readonly StoredRoot[], path: string, line: number, asOf: number): number | null | undefined {
  let root: StoredRoot | undefined
  for (const candidate of roots) if (within(path, candidate.path) && path !== candidate.path && (!root || candidate.path.length > root.path.length)) root = candidate
  if (!root) return undefined
  let current = path.slice(root.path.length + 1)
  let at = line - 1
  let after = 0
  const text = (ref: string | null) => {
    if (ref === null) return []
    const bytes = store.blob(ref)
    return bytes && splitLines(decodeText(bytes))
  }
  for (let hops = 0; hops < LINE_HOPS; hops++) {
    let renamed = false
    for (const entry of store.versions(root.id, current, after, asOf)) {
      after = entry.seq
      if (entry.after === null) return null
      if (!entry.text) return undefined
      const before = text(entry.before)
      const next = text(entry.after)
      if (!before || !next) return undefined
      let shift = 0
      for (const hunk of diffLines(before, next)) {
        if (at < hunk.a) break
        if (at < hunk.a + hunk.removed) return null
        shift += hunk.added - hunk.removed
      }
      at += shift
      if (entry.kind === "rename" && entry.from === current) {
        current = entry.path
        renamed = true
        break
      }
    }
    if (!renamed) return at + 1
  }
  return at + 1
}

/** Where Git's history says a file in one of these repositories went after `since`. */
function renamedInGit(histories: ReadonlyMap<string, RenameHistory>, path: string, since: number): string | undefined {
  let root: string | undefined
  for (const candidate of histories.keys()) if (within(path, candidate) && (!root || candidate.length > root.length)) root = candidate
  if (!root || path === root) return undefined
  const to = histories.get(root)!.follow(relative(root, path), since)
  return to ? join(root, to) : undefined
}

const within = (path: string, root: string) => path === root || path.startsWith(root + sep)

/** Which of `paths` are files now, `PARALLEL` `stat`s at a time. */
async function existing(paths: readonly string[]): Promise<Set<string>> {
  const files = new Set<string>()
  for (let i = 0; i < paths.length; i += PARALLEL)
    await Promise.all(paths.slice(i, i + PARALLEL).map(async (path) => {
      if ((await stat(path).catch(() => undefined))?.isFile()) files.add(path)
    }))
  return files
}
