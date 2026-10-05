import { existsSync } from "node:fs"
import { lstat, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { GitError } from "./errors.js"
import { ObjectReader } from "./objects.js"
import { previewBytes, readPreview, type Comparison, type Preview } from "./preview.js"
import { run, text } from "./run.js"
import { mergeStatus, parseStatus, statusMismatches, within, type StatusEntry, type StatusHead, type StatusMismatch } from "./status.js"

/** A Git command that stopped partway and waits to be continued or aborted. */
export type Operation = "merge" | "rebase" | "cherry-pick" | "revert"

export interface RepositoryStatus {
  root: string
  head: StatusHead
  entries: readonly StatusEntry[]
  operation: Operation | null
}

/** How a repository's status is kept and whether it still equals Git's. */
export interface Diagnosis {
  root: string
  /** Watchers reporting this tree; with none, every read is a full one. */
  watchers: number
  /** Folder names the watchers never report. */
  unheard: readonly string[]
  /** Unheard folders re-read on every status; null when there are too many and every read is a full one. */
  rereads: readonly string[] | null
  /** What the held status still had to read when asked: changed paths, or everything. */
  pending: number | "all"
  heardAgoMs: number | null
  /** Why the last full read before this call happened, and how long before. */
  lastFull: { reason: string; agoMs: number } | null
  heldMs: number
  freshMs: number
  held: { entries: number; head: string }
  fresh: { entries: number; head: string }
  mismatches: readonly StatusMismatch[]
  previews: { count: number; bytes: number }
}

export interface RepositoryLocation {
  /** The working tree's top folder. */
  root: string
  /** This working tree's own Git folder; a linked worktree's is inside the main one. */
  gitDir: string
  /** The folder shared by every worktree: objects, refs, config. */
  commonDir: string
}

const STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--no-renames"] as const
/** Past this many changed paths, one full read beats reading each. */
const PARTIAL_LIMIT = 500
/** Unheard folders re-read on every status; past this many, every read is a full one. */
const REREAD_LIMIT = 64
/** The most `ls-files` output read to find tracked files in unheard folders. */
const TRACKED_BYTES = 1024 * 1024
/** Files that change what every path's status means. */
const GLOBAL_FILES = new Set([".gitignore", ".gitattributes", ".gitmodules"])
/** What previews keep, by the bytes they carry. */
const PREVIEW_CACHE_BYTES = 32 * 1024 * 1024
const EMPTY_RAW: ReadonlyMap<string, Buffer> = new Map()
const OPERATIONS: ReadonlyArray<[string, Operation]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
]

/**
 * One working tree. Status is read in full once, then only for the paths a
 * watcher says changed, merged into what is kept; with no watcher, every read
 * is a full one. Writes run one at a time.
 */
export class Repository {
  readonly root: string
  readonly gitDir: string
  readonly commonDir: string
  readonly objects: ObjectReader

  private cache: { version: number; status: RepositoryStatus } | undefined
  private version = 0
  private dirty = new Set<string>()
  private everything = true
  private reading: Promise<void> | undefined
  private watchers = 0
  /** Folder names the watchers never report, such as `node_modules`. */
  private unheard: ReadonlySet<string> = new Set()
  /**
   * Unheard folders where Git tracks or shows files, such as an Electron app's
   * `build/`. No watcher reports changes there, so every status re-reads them;
   * null when there are too many to name and every read is a full one.
   */
  private rereads: readonly string[] | null = []
  /** The unheard folders the index tracks files in, by the index file they were read from. */
  private tracked: { stamp: string; folders: readonly string[] | null } | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private readonly previews = new Map<string, { preview: Preview; bytes: number; path: string; worktree: boolean }>()
  private previewBytes = 0
  private empty: Promise<string> | undefined
  /** The bytes of each status path that isn't valid UTF-8, by the text shown for it. */
  private raw: ReadonlyMap<string, Buffer> = EMPTY_RAW
  /** When a watcher or a write last named changed paths, by `Date.now()`. */
  private heard: number | null = null
  /** Why the next read is a full one, and why and when the last one was. */
  private fullReason = "first read"
  private lastFull: { reason: string; at: number } | null = null

  constructor(location: RepositoryLocation) {
    this.root = location.root
    this.gitDir = location.gitDir
    this.commonDir = location.commonDir
    this.objects = new ObjectReader(location.root)
  }

  /** Whether anyone is reporting this tree's changes. */
  get watched(): boolean {
    return this.watchers > 0
  }

  /**
   * Says a watcher now reports every change under `root`, including Git's own
   * index and HEAD, except inside folders named in `unheard`; status is then
   * kept between reads. Unheard folders where Git tracks a file, or status
   * shows one, are re-read on every status. Call the returned function when it
   * stops.
   */
  watch(unheard: readonly string[] = []): () => void {
    this.watchers += 1
    if (unheard.some((name) => !this.unheard.has(name))) {
      this.unheard = new Set([...this.unheard, ...unheard])
      this.tracked = undefined
    }
    this.changedAll("a watcher started")
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      this.watchers -= 1
      if (this.watchers > 0) return
      this.unheard = new Set()
      this.tracked = undefined
      this.changedAll("the last watcher stopped")
    }
  }

  /**
   * Paths, relative to `root`, that changed on disk. A folder covers what is
   * in it. Returns whether any can move status: Git's object store, locks and
   * this package's own index copies can't.
   */
  changed(paths: Iterable<string>): boolean {
    this.heard = Date.now()
    let moved = false
    for (const reported of paths) {
      const path = reported.endsWith("/") ? reported.replace(/\/+$/, "") : reported
      if (path === ".git" || path.startsWith(".git/")) {
        if (gitNoise(path.slice(5))) continue
        this.changedAll(`${path} changed`)
        return true
      }
      const name = path.slice(path.lastIndexOf("/") + 1)
      if (!path || GLOBAL_FILES.has(name)) {
        this.changedAll(`${path || "the whole tree"} changed`)
        return true
      }
      moved = true
      this.dirty.add(path)
      this.forgetPreviews(path)
    }
    if (!moved) return false
    if (this.dirty.size > PARTIAL_LIMIT) {
      this.changedAll(`more than ${PARTIAL_LIMIT} paths changed`)
      return true
    }
    this.version += 1
    return true
  }

  /** Anything may have changed: HEAD, the index, or files a watcher missed. `reason` is for `git:doctor`. */
  changedAll(reason: string): void {
    this.fullReason = reason
    this.everything = true
    this.dirty.clear()
    this.version += 1
    for (const [key, entry] of this.previews) if (entry.worktree) this.dropPreview(key)
  }

  /** Status as of this call: changes reported before it are in what it returns. */
  async status(): Promise<RepositoryStatus> {
    if (!this.watched) this.changedAll("nothing watches this tree")
    else if (this.rereads === null) this.changedAll("too many folders no watcher hears hold files Git sees")
    else if (this.rereads.length > 0 && !this.everything) {
      for (const folder of this.rereads) {
        this.dirty.add(folder)
        this.forgetPreviews(folder)
      }
      this.version += 1
    }
    const wanted = this.version
    while (!this.cache || this.cache.version < wanted) {
      this.reading ??= this.read().finally(() => {
        this.reading = undefined
      })
      await this.reading
    }
    return this.cache.status
  }

  private async read(): Promise<void> {
    const version = this.version
    const full = this.everything || !this.cache
    const scopes = [...this.dirty]
    this.everything = false
    this.dirty.clear()
    try {
      let status: RepositoryStatus
      if (full || !this.cache) status = await this.readFull()
      else if (scopes.length === 0) status = this.cache.status
      else {
        const previous = this.cache.status
        status = await this.readPaths(previous, scopes).catch(() => this.readFull())
      }
      this.cache = { version, status }
      this.raw = status.entries.some((entry) => entry.raw) ? new Map(status.entries.flatMap((entry) => entry.raw ? [[entry.path, entry.raw] as const] : [])) : EMPTY_RAW
    } catch (error) {
      this.everything = true
      throw error
    }
  }

  private async readFull(): Promise<RepositoryStatus> {
    this.lastFull = { reason: this.fullReason, at: Date.now() }
    const [result, tracked] = await Promise.all([run({ cwd: this.root, args: STATUS_ARGS, read: true }), this.trackedUnheard()])
    const { head, entries } = parseStatus(result.stdout)
    this.rereads = joinFolders(tracked, this.unheardFolders(entries))
    return { root: this.root, head, entries, operation: this.operation() }
  }

  /** A status limited to `scopes`; a path Git refuses, such as one inside a submodule, fails it. */
  private async readPaths(previous: RepositoryStatus, scopes: string[]): Promise<RepositoryStatus> {
    const result = await run({ cwd: this.root, args: [...STATUS_ARGS, "--", ...scopes.map((scope) => `:(literal)${scope}`)], read: true })
    const { head, entries } = parseStatus(result.stdout)
    this.rereads = joinFolders(this.rereads, this.unheardFolders(entries))
    return { root: this.root, head, entries: mergeStatus(previous.entries, scopes, entries), operation: previous.operation }
  }

  /** The outermost unheard folder above each entry, such as `app/build` for `app/build/icon.png`. */
  private unheardFolders(entries: readonly { path: string; raw?: Buffer }[]): readonly string[] | null {
    if (this.unheard.size === 0) return []
    const folders = new Set<string>()
    for (const entry of entries) {
      const segments = entry.path.split("/")
      const at = segments.findIndex((segment, index) => index < segments.length - 1 && this.unheard.has(segment))
      if (at < 0) continue
      // A folder named by bytes that aren't UTF-8 can't be handed back to Git as text.
      if (entry.raw) return null
      folders.add(segments.slice(0, at + 1).join("/"))
      if (folders.size > REREAD_LIMIT) return null
    }
    return [...folders]
  }

  /** Read again only when the index file changed: what Git tracks changes nowhere else. */
  private async trackedUnheard(): Promise<readonly string[] | null> {
    if (!this.watched || this.unheard.size === 0) return []
    const index = await stat(join(this.gitDir, "index")).catch(() => null)
    const stamp = index ? `${index.ino}:${index.size}:${index.mtimeMs}` : ""
    if (this.tracked?.stamp === stamp) return this.tracked.folders
    const result = await run({ cwd: this.root, args: ["ls-files", "-z", "--cached", "--", ...[...this.unheard].map((name) => `:(glob)**/${name}/**`)], maxBytes: TRACKED_BYTES, read: true })
    const listed = result.stdout.toString("utf8")
    const folders = result.truncated || listed.includes("\ufffd") ? null : this.unheardFolders(listed.split("\0").filter(Boolean).map((path) => ({ path })))
    this.tracked = { stamp, folders }
    return folders
  }

  /**
   * The status this repository answers with beside a fresh full read, and how
   * it is kept, for `git:doctor`. A tree that changes between the two reads
   * shows a mismatch that is not drift; running it again tells them apart.
   */
  async diagnose(): Promise<Diagnosis> {
    const pending = this.everything || !this.cache ? "all" : this.dirty.size
    const lastFull = this.lastFull && { reason: this.lastFull.reason, agoMs: Date.now() - this.lastFull.at }
    let started = performance.now()
    const held = await this.status()
    const heldMs = performance.now() - started
    started = performance.now()
    const result = await run({ cwd: this.root, args: STATUS_ARGS, read: true })
    const freshMs = performance.now() - started
    const fresh = parseStatus(result.stdout)
    const head = (value: StatusHead) => `${value.branch ?? "detached"} ${value.oid?.slice(0, 12) ?? "unborn"} +${value.ahead} -${value.behind}`
    return {
      root: this.root,
      watchers: this.watchers,
      unheard: [...this.unheard],
      rereads: this.rereads,
      lastFull,
      pending,
      heardAgoMs: this.heard === null ? null : Date.now() - this.heard,
      heldMs,
      freshMs,
      held: { entries: held.entries.length, head: head(held.head) },
      fresh: { entries: fresh.entries.length, head: head(fresh.head) },
      mismatches: statusMismatches(held.entries, fresh.entries),
      previews: { count: this.previews.size, bytes: this.previewBytes },
    }
  }

  operation(): Operation | null {
    for (const [name, operation] of OPERATIONS) if (existsSync(join(this.gitDir, name))) return operation
    return null
  }

  /** HEAD as of now, read fresh. */
  async head(signal?: AbortSignal): Promise<{ oid: string | null; branch: string | null }> {
    const [oid, branch] = await Promise.all([
      run({ cwd: this.root, args: ["rev-parse", "--verify", "-q", "HEAD"], codes: [1], read: true, signal }),
      run({ cwd: this.root, args: ["symbolic-ref", "-q", "--short", "HEAD"], codes: [1], read: true, signal }),
    ])
    return { oid: oid.code === 0 ? oid.stdout.toString("utf8").trim() : null, branch: branch.code === 0 ? branch.stdout.toString("utf8").trim() : null }
  }

  /** The empty tree's id, which depends on the repository's hash. */
  emptyTree(): Promise<string> {
    this.empty ??= text({ cwd: this.root, args: ["hash-object", "-t", "tree", "--stdin"], input: "", read: true })
    return this.empty
  }

  /** What the working tree is compared against: HEAD, or the empty tree before the first commit. */
  async base(): Promise<string> {
    return (await this.head()).oid ?? this.emptyTree()
  }

  /** A path inside this repository, as Git names it. */
  path(path: string): string {
    if (!path || isAbsolute(path) || path.includes("\0") || path.split("/").includes("..") || path.split("/").includes(".git"))
      throw new GitError({ kind: "failed", message: "Choose a file inside this repository." })
    return path
  }

  async preview(path: string, comparison: Comparison): Promise<Preview> {
    this.path(path)
    if (this.raw.has(path)) return { kind: "unavailable", reason: "This file's name isn't valid UTF-8, so Mako can't show it. Staging and commits still include it." }
    const worktree = comparison.kind === "worktree"
    // A worktree side is current only while a watcher reports its changes; a commit never changes.
    const cacheable = worktree ? this.watched : /^[0-9a-f]{40,64}$/.test(comparison.oid)
    const key = `${worktree ? "w" : comparison.oid}\0${path}`
    const cached = cacheable ? this.previews.get(key) : undefined
    if (cached) {
      this.previews.delete(key)
      this.previews.set(key, cached)
      return cached.preview
    }
    const version = this.version
    const preview = await readPreview({ root: this.root, objects: this.objects, base: () => this.base() }, path, comparison)
    if (cacheable && (!worktree || version === this.version)) this.keepPreview(key, { preview, bytes: previewBytes(preview), path, worktree })
    return preview
  }

  private keepPreview(key: string, entry: { preview: Preview; bytes: number; path: string; worktree: boolean }): void {
    if (entry.bytes > PREVIEW_CACHE_BYTES / 4) return
    this.dropPreview(key)
    this.previews.set(key, entry)
    this.previewBytes += entry.bytes
    for (const [oldest] of this.previews) {
      if (this.previewBytes <= PREVIEW_CACHE_BYTES) break
      this.dropPreview(oldest)
    }
  }

  private dropPreview(key: string): void {
    const entry = this.previews.get(key)
    if (!entry) return
    this.previews.delete(key)
    this.previewBytes -= entry.bytes
  }

  private forgetPreviews(scope: string): void {
    for (const [key, entry] of this.previews) if (entry.worktree && within(entry.path, scope)) this.dropPreview(key)
  }

  /** Runs `action` after every write before it, alone among this repository's writes. */
  write<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writes.then(() => action(), () => action())
    this.writes = next.catch(() => undefined)
    return next
  }

  /** Resolves once every write already queued has finished. */
  async settled(): Promise<void> {
    await this.writes
  }

  /** Paths as Git knows them: a name that isn't UTF-8 by its bytes. */
  private pathspecs(paths: readonly string[]): Buffer {
    return pathList(paths.map((path) => this.raw.get(this.path(path)) ?? path))
  }

  async stage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    for (const path of paths) this.path(path)
    await this.write(async () => {
      try {
        const selected = await this.stageable(paths)
        if (selected.length > 0) await run({ cwd: this.root, args: ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], input: this.pathspecs(selected) })
      } finally {
        this.changed(paths)
      }
    })
  }

  /**
   * The paths less any whose every change is an already staged deletion: on
   * neither disk nor the index, `git add` refuses them, and staging them
   * again changes nothing. A path Git never knew still fails.
   */
  private async stageable(paths: readonly string[]): Promise<readonly string[]> {
    const missing = (await Promise.all(paths.map((path) => this.raw.has(path) ? null : lstat(join(this.root, path)).then(() => null, () => path)))).filter((path) => path !== null)
    if (missing.length === 0 || missing.length > STAGEABLE_CHECKS) return paths
    const result = await run({ cwd: this.root, args: [...STATUS_ARGS.filter((arg) => arg !== "--untracked-files=all"), "--untracked-files=no", "--", ...missing.map((path) => `:(literal)${path}`)], read: true })
    const { entries } = parseStatus(result.stdout)
    const staged = new Set(missing.filter((path) => {
      const under = entries.filter((entry) => within(entry.path, path))
      return under.length > 0 && under.every((entry) => entry.index === "deleted" && entry.worktree === null)
    }))
    return staged.size === 0 ? paths : paths.filter((path) => !staged.has(path))
  }

  async unstage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const input = this.pathspecs(paths)
    await this.write(async () => {
      try {
        const born = (await this.head()).oid !== null
        await run({ cwd: this.root, args: born ? ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"] : ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], input, codes: [1] })
      } finally {
        this.changed(paths)
      }
    })
  }

  async stageAll(): Promise<void> {
    await this.write(async () => {
      try {
        await run({ cwd: this.root, args: ["add", "-A"] })
      } finally {
        this.changedAll("staged everything")
      }
    })
  }

  async unstageAll(): Promise<void> {
    await this.write(async () => {
      try {
        const born = (await this.head()).oid !== null
        await run({ cwd: this.root, args: born ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "."], codes: [1] })
      } finally {
        this.changedAll("unstaged everything")
      }
    })
  }

  /**
   * Commits what is staged; with nothing staged, everything first. `amend`
   * rewrites the last commit with what is staged now.
   */
  async commit(input: { message: string; amend?: boolean; signal?: AbortSignal }): Promise<void> {
    const message = commitMessage(input.message)
    await this.write(async () => {
      try {
        if (!input.amend && !(await this.status()).entries.some(staged)) await run({ cwd: this.root, args: ["add", "-A"] })
        await run({ cwd: this.root, args: ["commit", ...(input.amend ? ["--amend"] : []), "--cleanup=whitespace", "--file=-"], input: message, timeoutMs: COMMIT_TIMEOUT_MS, signal: input.signal })
      } finally {
        this.changedAll("committed")
      }
    })
  }

  close(): void {
    this.objects.close()
    this.previews.clear()
    this.previewBytes = 0
  }
}

/** Inside a Git folder, what never changes status: objects, hooks, locks, and the copies drafting makes of the index. */
function gitNoise(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return path === "" || /^(objects|lfs|hooks|info\/(?!exclude$)|logs\/refs\/)/.test(path) || name.endsWith(".lock") || name.startsWith("mako-index-") || name === "FETCH_HEAD"
}

/** Hooks run inside a commit; a slow one is still the person's to wait on. */
export const COMMIT_TIMEOUT_MS = 10 * 60_000
/** Missing paths checked against the index before staging; past this, Git's own error stands. */
const STAGEABLE_CHECKS = 1_000

export function staged(entry: StatusEntry): boolean {
  return entry.index !== null || entry.conflicted
}

/** NUL-separated paths for `--pathspec-from-file`, read literally. */
export function pathList(paths: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [Buffer.from(":(literal)"), Buffer.isBuffer(path) ? path : Buffer.from(path), Buffer.from([0])]))
}

const MESSAGE_BYTES = 16 * 1024

/** A message Git will record as written: trimmed, not empty, with no control characters but newlines and tabs. */
export function commitMessage(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) throw new GitError({ kind: "failed", message: "Write a commit message first." })
  if (Buffer.byteLength(trimmed) > MESSAGE_BYTES) throw new GitError({ kind: "failed", message: "The commit message is longer than 16 KB. Shorten it and try again." })
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(trimmed)) throw new GitError({ kind: "failed", message: "The commit message contains control characters. Remove them and try again." })
  return `${trimmed}\n`
}

/** Where `cwd` belongs: its working tree and Git folders, or null outside a repository. */
export async function locate(cwd: string, signal?: AbortSignal): Promise<RepositoryLocation | null> {
  const result = await run({ cwd, args: ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], read: true, signal }).catch((error: Error) => {
    if (error instanceof GitError && error.kind === "not_repository") return null
    throw error
  })
  if (!result) return null
  const [root, gitDir, commonDir] = result.stdout.toString("utf8").split("\n")
  if (!root || !gitDir || !commonDir) return null
  return { root, gitDir, commonDir: resolve(cwd, commonDir) }
}

/** Both lists of folders, or null when either is, or together they pass the limit. */
function joinFolders(a: readonly string[] | null, b: readonly string[] | null): readonly string[] | null {
  if (a === null || b === null) return null
  if (b.length === 0) return a
  const joined = [...new Set([...a, ...b])]
  return joined.length > REREAD_LIMIT ? null : joined
}
