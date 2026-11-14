import { grepMatches, listFileStates, type Git, type GrepMatch } from "@mako/git"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { FileIndexCore, type FileFindResults, type FileFolders, type FileFoldersOptions, type FileGrepOptions, type FileGrepResults } from "../contracts/file-index.js"
import type { FileMatches, GitStatus, WorkspaceFile } from "../contracts/git-workspace-search.js"
import type { TreeWatch } from "./tree-watcher.js"

/** Ceilings for the walk of a folder that isn't a repository, so a stray home folder can't hang the view. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_FILES = 20_000
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "vendor",
  "Pods",
  ".turbo",
  "coverage",
])

/** Without a watch, the index is read again when it's older than this. */
const UNWATCHED_FRESH_MS = 5_000
/** Changes heard together are applied together. */
const SETTLE_MS = 40
/** More paths than this at once (a checkout, an install) and reading the folder again is cheaper than reconciling each. */
const RECONCILE_MAX = 500
/** A listed path is checked on disk (a tracked file deleted but not committed) when a change lists at most this many. */
const STAT_MAX = 2_000
/** Git's changed files are read again at most this often for the marks on rows. */
const CHANGED_EVERY_MS = 1_500
/** A file's lines listed at most in a text search. */
const GREP_PER_FILE = 20
/** Files outside any repository read at most by a text search in a folder that isn't one. */
const GREP_LOOSE_FILES = 5_000
/** An untracked file a text search reads is at most this large; larger ones are skipped, never read. */
const GREP_LOOSE_FILE_BYTES = 1024 * 1024
/** Bytes of untracked files one text search reads at most, together. */
const GREP_LOOSE_BYTES = 64 * 1024 * 1024
/** Bytes of Git's output a matching line takes, for its byte limit. */
const GREP_LINE_BYTES = 240

/** Where a folder's Git changes come from: the tab's own repository when the folder is its workspace. */
export type ChangedFiles = () => Promise<Pick<GitStatus, "root" | "files"> | null>

export interface FolderIndexOptions {
  folder: string
  git: Git
  changed?: ChangedFiles
  /** Hears the folder, so the index stays current without reading it again; paths relative to the folder. */
  watch?: (root: string, changed: (paths: string[]) => void, gone: () => void, dropped: () => void) => TreeWatch | undefined
}

/**
 * One folder's files in memory, kept current path by path.
 *
 * Built once from Git's list (tracked and untracked, ignored left out) or, outside a repository, a bounded walk that
 * asks each repository inside the folder for its own. After that a change is applied where it happened: each path
 * the watcher hears is asked of Git again (`ls-files` at that path, so ignore rules and new folders come out as Git
 * says) and the index adds or removes what differs. Only a lost event, a burst too large to reconcile, or an index
 * nobody watches and nobody read for a while reads the folder again.
 */
export class FolderIndex {
  readonly folder: string
  readonly #git: Git
  readonly #changedFiles: ChangedFiles | undefined
  readonly #watchFolder: FolderIndexOptions["watch"]
  #core: FileIndexCore | undefined
  #building: Promise<FileIndexCore> | undefined
  #builtAt = 0
  /** The root paths are relative to: the repository's, or the folder itself. */
  #root = ""
  #repository = false
  /** Outside a repository, the repositories found inside it, relative to the root. */
  #nested: string[] = []
  /** Files no repository tracks: untracked in one, or outside any. A text search reads these itself (`#looseGrep`). */
  #untracked = new Set<string>()
  /** The untracked files' listing after a build, which the `@` list waits for. */
  #untrackedRead: Promise<void> = Promise.resolve()
  /** A change was lost or too large to reconcile: read again on the next look. */
  #stale = true
  #watch: TreeWatch | undefined
  /** Fed by someone else's watch (the tab's), so no watch of its own is needed. */
  #fed = false
  #pending = new Set<string>()
  #settle: ReturnType<typeof setTimeout> | undefined
  #applying: Promise<void> = Promise.resolve()
  #changedAt = 0
  #changedList = new Set<string>()
  /** This index's identity for its whole life, across rebuilds; a new index of the folder, or a new host, has another. */
  readonly #epoch = crypto.randomUUID()
  #marking: Promise<void> | undefined
  #grep: AbortController | undefined
  #closed = false

  constructor(options: FolderIndexOptions) {
    this.folder = resolve(options.folder)
    this.#git = options.git
    this.#changedFiles = options.changed
    this.#watchFolder = options.watch
  }

  /** Whether changes reach it as they happen, from a watch of its own or the one feeding it. */
  get current(): boolean {
    return this.#fed || this.#watch !== undefined
  }

  /** Someone else hears the folder and passes on what changed (`noteChanges`), or stopped doing so. */
  feed(fed: boolean): void {
    this.#fed = fed
    if (!fed) this.#stale = true
  }

  /** Paths that changed, relative to the folder; `undefined`: anything may have. */
  noteChanges(paths: readonly string[] | undefined): void {
    if (this.#closed || (!this.#core && !this.#building)) return
    if (paths === undefined) {
      this.#stale = true
      this.#pending.clear()
      return
    }
    for (const path of paths) {
      const rooted = this.#rooted(path)
      if (rooted === undefined || rooted.split("/").includes(".git")) continue
      this.#pending.add(rooted)
    }
    if (this.#pending.size > RECONCILE_MAX) {
      this.#stale = true
      this.#pending.clear()
      return
    }
    if (this.#pending.size && !this.#settle) this.#settle = setTimeout(() => this.#flush(), SETTLE_MS)
  }

  async folders(paths: readonly string[], options: FileFoldersOptions = {}): Promise<FileFolders> {
    const core = await this.#ready()
    void this.#markChanged(core)
    return core.folders(paths, options)
  }

  async find(query: string, limit?: number): Promise<FileFindResults> {
    const core = await this.#ready()
    return core.find(query, limit)
  }

  /** Every file, for the composer's `@` list. */
  async list(): Promise<WorkspaceFile[]> {
    const core = await this.#ready()
    await this.#untrackedRead
    await this.#markChanged(core, true)
    const changed = this.#changedList
    return core.paths().sort((left, right) => left.localeCompare(right)).map((path) => (changed.has(path) ? { path, changed: true } : { path }))
  }

  /**
   * Lines inside files that hold the query. Git searches what each repository tracks (the folder's, or each one inside
   * a folder that isn't one) and stops once it has `limit` lines; the files no repository tracks, which the index
   * already knows, are read here within a bound, so Git never walks the folders looking for them. A newer search in
   * the same folder stops this one.
   */
  async grep(query: string, options: FileGrepOptions = {}): Promise<FileGrepResults> {
    const started = performance.now()
    const term = query.trim()
    const empty: FileGrepResults = { query: term, files: [], total: 0, more: false, ms: 0 }
    if (term.length < 2) return empty
    if (options.regex) {
      try {
        new RegExp(term)
      } catch (error) {
        return { ...empty, error: error instanceof Error ? error.message : "Invalid pattern" }
      }
    }
    this.#grep?.abort()
    const controller = new AbortController()
    this.#grep = controller
    const limit = Math.max(1, Math.min(options.limit ?? 400, 5_000))
    // Not waiting for a fresh index's untracked listing: those it knows by now are read, and the rest join it.
    await this.#ready()
    const search = { caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regex: options.regex, perFile: GREP_PER_FILE, maxBytes: limit * GREP_LINE_BYTES, signal: controller.signal }
    const roots = this.#repository ? [""] : this.#nested
    const found = await Promise.all([
      ...roots.map((root) => grepMatches(this.#git, join(this.#root, root), term, search).then(({ matches, more }) => ({ matches: root ? matches.map((match) => ({ ...match, path: `${root}/${match.path}` })) : matches, more }))),
      this.#looseGrep(term, options, limit, controller.signal),
    ]).catch((error: Error) => {
      if (controller.signal.aborted) return undefined
      throw error
    })
    if (this.#grep === controller) this.#grep = undefined
    if (!found) return { ...empty, more: true, ms: performance.now() - started }
    const byPath = new Map<string, FileMatches>()
    let total = 0
    let more = false
    for (const { matches, more: cut } of found) {
      more ||= cut
      for (const match of matches) {
        if (total >= limit) {
          more = true
          break
        }
        let file = byPath.get(match.path)
        if (!file) {
          file = { path: match.path, lines: [], more: 0 }
          byPath.set(match.path, file)
        }
        file.lines.push({ line: match.line, text: match.text.slice(0, 400) })
        total += 1
      }
    }
    const files = [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return { query: term, files, total, more, ms: performance.now() - started }
  }

  close(): void {
    this.#closed = true
    this.#watch?.close()
    this.#watch = undefined
    this.#grep?.abort()
    if (this.#settle) clearTimeout(this.#settle)
    this.#settle = undefined
  }


  /**
   * Git's changed files, onto the index's rows. A folder's listing doesn't wait for them (a large repository's status
   * can take seconds): the marks it has are drawn, and the next listing carries the new ones. `now`: wait for them.
   */
  async #markChanged(core: FileIndexCore, now = false): Promise<void> {
    if (!this.#changedFiles) return
    if (!this.#marking && Date.now() - this.#changedAt >= CHANGED_EVERY_MS) {
      this.#changedAt = Date.now()
      this.#marking = this.#changedFiles().catch(() => null).then((status) => {
        this.#marking = undefined
        if (status) this.#applyChanged(core, status)
      })
    }
    if (now) await this.#marking
  }

  #applyChanged(core: FileIndexCore, status: NonNullable<Awaited<ReturnType<ChangedFiles>>>): void {
    const base = status.root ?? this.folder
    const changed = new Set<string>()
    for (const file of status.files) {
      const path = base === this.#root ? file.path : relative(this.#root, join(base, file.path)).split(sep).join("/")
      if (path.startsWith("..")) continue
      // Git lists a tracked file someone deleted until the deletion is committed; the tree doesn't.
      if (file.status === "deleted") core.remove(path)
      else changed.add(path)
    }
    this.#changedList = changed
    core.setChanged(changed)
  }

  async #ready(): Promise<FileIndexCore> {
    if (this.#building) return this.#building
    const old = !this.current && Date.now() - this.#builtAt > UNWATCHED_FRESH_MS
    if (this.#core && !this.#stale && !old) {
      if (this.#pending.size) this.#flush()
      await this.#applying
      return this.#core
    }
    const building = this.#build()
    this.#building = building
    try {
      return await building
    } finally {
      if (this.#building === building) this.#building = undefined
    }
  }

  async #build(): Promise<FileIndexCore> {
    this.#stale = false
    this.#pending.clear()
    const startedAt = Date.now()
    const repository = await this.#git.openRepository(this.folder).catch(() => null)
    let paths: string[]
    const untracked = new Set<string>()
    if (repository) {
      this.#repository = true
      this.#root = resolve(repository.root)
      this.#nested = []
      // What Git tracks comes from its index alone, so a large repository is browsable at once; the untracked files,
      // which take a walk of every folder, join it when that's done.
      paths = (await listFileStates(this.#git, this.#root, undefined, { untracked: false })).tracked
      const root = this.#root
      this.#untrackedRead = listFileStates(this.#git, root).then((states) => {
        const core = this.#core
        if (!core || this.#root !== root || this.#closed) return
        for (const path of states.untracked) {
          core.add(path)
          this.#untracked.add(path)
        }
      }, () => {
        this.#stale = true
      })
    } else {
      this.#untrackedRead = Promise.resolve()
      this.#repository = false
      this.#root = this.folder
      const nested: string[] = []
      paths = await walkWorkspace(this.#root, this.#root, 0, async (dir) => {
        const prefix = relative(this.#root, dir).split(sep).join("/")
        nested.push(prefix)
        const states = await listFileStates(this.#git, dir).catch(() => null)
        if (!states) return null
        for (const path of states.untracked) untracked.add(`${prefix}/${path}`)
        return [...states.tracked, ...states.untracked]
      })
      for (const path of paths) if (!nested.some((root) => path.startsWith(`${root}/`))) untracked.add(path)
      this.#nested = nested
    }
    this.#untracked = untracked
    // Versions climb across rebuilds: a window holding the last index's version is never told it's current.
    const core = new FileIndexCore(paths, this.#core?.version ?? 0, this.#epoch)
    this.#core = core
    this.#builtAt = startedAt
    this.#changedAt = 0
    if (!this.#fed && !this.#watch && this.#watchFolder && !this.#closed) {
      this.#watch = this.#watchFolder(this.folder, (changed) => this.noteChanges(changed), () => this.#lost(), () => this.noteChanges(undefined))
    }
    return core
  }

  /** The folder went away, or its watch did: what's held is read again next time. */
  #lost(): void {
    this.#watch?.close()
    this.#watch = undefined
    this.#stale = true
  }

  /** A path relative to the folder, as one relative to the index's root; `undefined` outside it. */
  #rooted(path: string): string | undefined {
    const slashed = path.split(sep).join("/").replace(/^\.\//, "")
    if (!this.#root || this.#root === this.folder) return slashed
    const rooted = relative(this.#root, join(this.folder, path)).split(sep).join("/")
    return rooted.startsWith("..") || isAbsolute(rooted) ? undefined : rooted
  }

  #flush(): void {
    if (this.#settle) clearTimeout(this.#settle)
    this.#settle = undefined
    if (!this.#pending.size) return
    const paths = [...this.#pending]
    this.#pending.clear()
    this.#applying = this.#applying.then(() => this.#reconcile(paths)).catch(() => {
      this.#stale = true
    })
  }

  /** What Git (or, outside a repository, the disk) says is at each path now, against what the index holds there. */
  async #reconcile(paths: string[]): Promise<void> {
    const core = this.#core
    if (!core || this.#stale) return
    const groups = new Map<string, string[]>()
    const loose: string[] = []
    for (const path of paths) {
      const repository = this.#repository ? "" : this.#nested.find((root) => path === root || path.startsWith(`${root}/`))
      if (repository === undefined) loose.push(path)
      else {
        const group = groups.get(repository) ?? []
        group.push(repository ? path.slice(repository.length + 1) : path)
        groups.set(repository, group)
      }
    }
    for (const [repository, inside] of groups) {
      const states = await listFileStates(this.#git, join(this.#root, repository), inside)
      const listed = [...states.tracked, ...states.untracked]
      const present = listed.length <= STAT_MAX ? await existing(join(this.#root, repository), listed) : listed
      const prefix = repository ? `${repository}/` : ""
      this.#settleAt(core, inside.map((path) => prefix + path), new Set(present.map((path) => prefix + path)))
      for (const path of states.untracked) this.#untracked.add(prefix + path)
      for (const path of states.tracked) this.#untracked.delete(prefix + path)
    }
    for (const path of loose) {
      const info = await lstat(join(this.#root, path)).catch(() => null)
      const found = new Set<string>()
      if (info?.isFile() && walkable(path)) found.add(path)
      else if (info?.isDirectory() && walkable(path)) {
        const depth = path.split("/").length
        for (const inside of await walkWorkspace(this.#root, join(this.#root, path), depth)) found.add(inside)
      }
      this.#settleAt(core, [path], found)
      for (const file of found) this.#untracked.add(file)
    }
  }

  /** Makes the index hold exactly `present` at and under `paths`. */
  #settleAt(core: FileIndexCore, paths: readonly string[], present: ReadonlySet<string>): void {
    for (const path of paths) {
      const held = core.has(path) ? [path] : core.filesUnder(path)
      for (const file of held)
        if (!present.has(file)) {
          core.remove(file)
          this.#untracked.delete(file)
        }
    }
    for (const file of present) core.add(file)
  }

  async #looseGrep(term: string, options: FileGrepOptions, limit: number, signal: AbortSignal): Promise<{ matches: GrepMatch[]; more: boolean }> {
    const core = this.#core
    if (!core) return { matches: [], more: false }
    const test = matcher(term, options)
    const loose = [...this.#untracked].filter((path) => core.has(path)).sort().slice(0, GREP_LOOSE_FILES)
    const root = await realpath(this.#root).catch(() => this.#root)
    const matches: GrepMatch[] = []
    let budget = GREP_LOOSE_BYTES
    for (const path of loose) {
      if (signal.aborted || matches.length >= limit) return { matches, more: matches.length >= limit }
      if (budget <= 0) return { matches, more: true }
      const text = await looseText(root, path, Math.min(GREP_LOOSE_FILE_BYTES, budget))
      if (text === undefined) continue
      budget -= text.length
      let inFile = 0
      let from = 0
      for (let line = 1; from <= text.length && inFile < GREP_PER_FILE; line += 1) {
        const end = text.indexOf("\n", from)
        const content = text.slice(from, end < 0 ? text.length : end)
        if (test(content)) {
          matches.push({ path, line, text: content })
          inFile += 1
        }
        if (end < 0) break
        from = end + 1
      }
    }
    return { matches, more: false }
  }
}

/**
 * An untracked file's text for a search, or undefined to skip it: only a regular file inside `root`, never through a
 * symlink (its last part is opened with `O_NOFOLLOW`, and what was opened must be the file its real path names, so a
 * folder swapped for a link mid-read is refused), never past `max` bytes (its size is read before anything is), and
 * never one whose first 8 KB hold a NUL, as Git tells binary from text.
 */
async function looseText(root: string, path: string, max: number): Promise<string | undefined> {
  const absolute = join(root, path)
  let handle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) return undefined
    const real = await realpath(absolute).catch(() => undefined)
    if (!real || !real.startsWith(`${root}${sep}`)) return undefined
    const named = await stat(real).catch(() => undefined)
    if (!named || named.ino !== info.ino || named.dev !== info.dev) return undefined
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0)
    const read = bytes.subarray(0, bytesRead)
    if (read.subarray(0, 8000).includes(0)) return undefined
    return read.toString("utf8")
  } finally {
    await handle.close()
  }
}

function matcher(term: string, options: FileGrepOptions): (text: string) => boolean {
  if (options.regex || options.wholeWord) {
    const source = options.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? "" : "i")
    return (text) => pattern.test(text)
  }
  if (options.caseSensitive) return (text) => text.includes(term)
  const lower = term.toLowerCase()
  return (text) => text.toLowerCase().includes(lower)
}

/** Whether a walk outside a repository lists what's at `path`: never a hidden or build folder's files. */
function walkable(path: string): boolean {
  return path.split("/").every((segment) => !segment.startsWith(".") && !WALK_SKIP.has(segment))
}

/** The paths of `paths` that are on disk: Git lists a tracked file someone deleted until the deletion is committed. */
async function existing(root: string, paths: readonly string[]): Promise<string[]> {
  const found = await Promise.all(paths.map((path) => lstat(join(root, path)).then(() => path, () => undefined)))
  return found.filter((path) => path !== undefined)
}

/**
 * A folder's files when it isn't a repository: a bounded walk that skips hidden and build folders, and asks each
 * repository inside it for its own files (`listRepository`), which honours that repository's ignore rules.
 */
export async function walkWorkspace(
  root: string,
  dir: string,
  depth: number,
  listRepository?: (dir: string) => Promise<string[] | null>
): Promise<string[]> {
  if (depth > WALK_MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  if (depth > 0 && listRepository && entries.some((entry) => entry.name === ".git")) {
    const paths = await listRepository(dir)
    if (paths) return paths.slice(0, WALK_MAX_FILES).map((path) => relative(root, join(dir, path)))
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkWorkspace(root, full, depth + 1, listRepository)))
    } else if (entry.isFile()) {
      out.push(relative(root, full))
    }
    if (out.length > WALK_MAX_FILES) break
  }
  return out.slice(0, WALK_MAX_FILES)
}
