import { realpathSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { changedSince, commitFiles, defaultBranch, GitError, grep, knownRepository, listFiles, log, openRepository, push, remote, within, type BinarySide, type Comparison, type LineCount, type Preview, type TreeComparison, type Repository, type RepositoryStatus, type StatusEntry } from "@mako/git"
import { discoverRepositories, type RepositoryDiscovery } from "./repository-discovery.js"
import { QUIET_FOLDERS } from "./tree-watcher.js"
import type { GitBinarySide, GitRemoteInput, GitRemoteResult, GitCommitEntry, GitCommitFile, GitDiff, GitFile, GitFileStatus, GitStatus, SearchOptions } from "./shared.js"

/** Resolves once every Git write Mako queued for `root` has finished. */
export async function waitForIndexWrites(root: string, signal: AbortSignal): Promise<void> {
  const repository = await openRepository(root, signal)
  if (!repository) throw new Error("This folder is not a Git repository")
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    repository.settled().then(resolve, resolve).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** The file against HEAD: one staged as new stays added however it was edited since. */
function fileStatus(entry: StatusEntry): GitFileStatus {
  if (entry.conflicted) return "conflicted"
  if (entry.untracked) return "untracked"
  if (entry.index === "deleted" || entry.worktree === "deleted") return "deleted"
  return entry.index === "added" ? "added" : "modified"
}

function gitFiles(status: RepositoryStatus, counts: ReadonlyMap<string, LineCount> | null | undefined): GitFile[] {
  return status.entries.map((entry) => ({ path: entry.path, status: fileStatus(entry), staged: entry.index !== null || entry.conflicted, ...lines(counts?.get(entry.path)), binary: counts?.get(entry.path) === null }))
}

/** A count as the window shows it; unknown and binary both show none. */
function lines(count: LineCount | undefined): { insertions: number | null; deletions: number | null } {
  return count ? count : { insertions: null, deletions: null }
}

/** How long a status waits for its line counts; slower ones follow in another push. */
const COUNT_WAIT_MS = 120

/** What changed between two trees, as the Changes panel lists files. */
export async function treeFiles(comparison: TreeComparison): Promise<GitFile[]> {
  return (await comparison.files()).map((file) => ({ path: file.path, status: CHANGE_STATUS.get(file.change) ?? "modified", staged: false, ...lines(file.lines), binary: file.lines === null }))
}

export async function treeDiff(comparison: TreeComparison, path: string): Promise<GitDiff> {
  return gitDiff(path, await comparison.preview(path))
}

function gitDiff(path: string, preview: Preview): GitDiff {
  switch (preview.kind) {
    case "files": return { path, binary: false, oldFile: preview.before == null ? null : { name: path, contents: preview.before }, newFile: preview.after == null ? null : { name: path, contents: preview.after } }
    case "binary": return { path, binary: true, oldFile: null, newFile: null, before: binarySide(preview.mime, preview.before), after: binarySide(preview.mime, preview.after) }
    case "patch": return { path, binary: false, oldFile: null, newFile: null, preview: { kind: "patch", contents: preview.patch, limited: preview.limited } }
    case "unavailable": return { path, binary: false, oldFile: null, newFile: null, preview: { kind: "unavailable", reason: preview.reason } }
  }
}

function binarySide(mime: string | null, side: BinarySide | null): GitBinarySide | null {
  if (!side) return null
  return mime && side.image ? { bytes: side.bytes, image: `data:${mime};base64,${side.image.toString("base64")}` } : { bytes: side.bytes }
}

/** What a diff carries across to the window. */
function diffBytes(diff: GitDiff): number {
  return Buffer.byteLength(diff.oldFile?.contents ?? "") + Buffer.byteLength(diff.newFile?.contents ?? "") + Buffer.byteLength(diff.preview?.kind === "patch" ? diff.preview.contents : "") + (diff.before?.image?.length ?? 0) + (diff.after?.image?.length ?? 0)
}

const PREVIEW_SET = { files: 25, bytes: 512 * 1024, ms: 5_000, concurrency: 4 }

/** A path to preview, and where it was before a rename. */
export interface PreviewPath {
  path: string
  from?: string
}

/**
 * The diffs of `files` in the repository at `root`, against `comparison`,
 * as many as fit the window's budget. A Thread's worktree review reads
 * through this, the same reader the Changes panel uses.
 */
export async function previewDiffs(root: string, files: readonly PreviewPath[], comparison: Exclude<Comparison, { kind: "trees" }>): Promise<{ diffs: GitDiff[]; truncated: number }> {
  const repository = await openRepository(root)
  if (!repository) throw new Error("This folder is not a Git repository")
  return previewSet(repository, files, comparison)
}

/** As many previews of `files`, in order, as fit 25 files, 512 KB and five seconds. */
async function previewSet(repository: Repository, files: readonly PreviewPath[], comparison: Exclude<Comparison, { kind: "trees" }>): Promise<{ diffs: GitDiff[]; truncated: number }> {
  const deadline = Date.now() + PREVIEW_SET.ms
  const diffs: GitDiff[] = []
  let bytes = 0
  const read = async ({ path, from }: PreviewPath) => {
    const diff = gitDiff(path, await repository.preview(path, comparison, from))
    if (from && diff.oldFile) diff.oldFile = { ...diff.oldFile, name: from }
    return diff
  }
  for (let offset = 0; offset < files.length; offset += PREVIEW_SET.concurrency) {
    if (diffs.length >= PREVIEW_SET.files || bytes >= PREVIEW_SET.bytes || Date.now() >= deadline) break
    const batch = files.slice(offset, Math.min(offset + PREVIEW_SET.concurrency, offset + PREVIEW_SET.files - diffs.length))
    for (const diff of await Promise.all(batch.map(read))) {
      if (bytes >= PREVIEW_SET.bytes) break
      bytes += diffBytes(diff)
      diffs.push(diff)
    }
  }
  return { diffs, truncated: files.length - diffs.length }
}

const CHANGE_STATUS = new Map<string, GitFileStatus>([["added", "added"], ["deleted", "deleted"]])

type RepositorySummary = NonNullable<GitStatus["repositories"]>[number]

/**
 * The Git side of one workspace: its repository, or when the workspace holds
 * several, the one selected. While a watcher reports the workspace's changes
 * (`trackChanges`), the repository keeps its status between reads and reads
 * again only what changed.
 */
export class WorkspaceGit {
  private cwdValue: string
  private realCwd: string
  private discovery: { cwd: string; expires: number; value: Promise<RepositoryDiscovery> } | undefined
  private selectedRoot: string | undefined
  private repositoryRoots: string[] = []
  private version = 0
  private statusRead: Promise<GitStatus> | null = null
  private tracking = false
  /** Cached child summaries are sound only while a live watcher reports every change. */
  private summaries: Map<string, RepositorySummary> | null = null
  /** The repository being kept current, and where it sits in the workspace (`""` at its top). */
  private watched: { repository: Repository; prefix: string; release: () => void } | undefined

  /** Runs when line counts a status went without arrive later. */
  private readonly counted: (() => void) | undefined

  constructor(cwd: string, counted?: () => void) {
    this.counted = counted
    this.cwdValue = cwd
    this.realCwd = real(cwd)
  }

  get cwd(): string { return this.cwdValue }
  get target(): string { return this.selectedRoot ?? this.cwdValue }

  setCwd(cwd: string): void {
    if (cwd === this.cwdValue) return
    this.cwdValue = cwd
    this.realCwd = real(cwd)
    this.version += 1
    this.selectedRoot = undefined
    this.repositoryRoots = []
    this.summaries = null
    this.unwatch()
  }

  trackChanges(enabled: boolean): void {
    this.tracking = enabled
    this.summaries = null
    if (!enabled) this.unwatch()
  }

  /**
   * A watched change, relative to the workspace, or `undefined` for "anything
   * may have changed". Returns whether Git status can have moved.
   */
  noteChange(path: string | undefined, why = "the workspace watcher asked for a rescan"): boolean {
    if (path === undefined) {
      this.summaries?.clear()
      this.discovery = undefined
      this.watched?.repository.changedAll(why)
      return true
    }
    const slashed = sep === "/" ? path : path.split(sep).join("/")
    const watched = this.watched
    if (watched && (watched.prefix === "" || within(slashed, watched.prefix))) {
      const inside = watched.prefix === "" ? slashed : slashed.slice(watched.prefix.length + 1)
      const moved = watched.repository.changed([inside])
      if (moved) this.summaries?.delete(watched.repository.root)
      return moved
    }
    const summaries = this.summaries
    if (!summaries) return !watched
    const absolute = join(this.realCwd, path)
    const root = this.repositoryRoots.find((candidate) => absolute === candidate || absolute.startsWith(candidate + sep))
    if (root) {
      summaries.delete(root)
      return true
    }
    if (!slashed.split("/").includes(".git")) return false
    this.discovery = undefined
    return true
  }

  private unwatch(): void {
    this.watched?.release()
    this.watched = undefined
  }

  /** Keeps `repository` current from the workspace's watcher, when that watcher covers all of it. */
  private watch(repository: Repository): void {
    if (this.watched?.repository === repository) return
    this.unwatch()
    if (!this.tracking) return
    const prefix = relative(this.realCwd, repository.root).split(sep).join("/")
    if (prefix.startsWith("..") || prefix.startsWith("/")) return
    // The watcher hears nothing inside a dependency or build folder.
    const quiet = new Set<string>(QUIET_FOLDERS)
    if (prefix.split("/").some((segment) => quiet.has(segment))) return
    this.watched = { repository, prefix, release: repository.watch([...QUIET_FOLDERS]) }
  }

  async selectRepository(cwd: string, root: string): Promise<GitStatus> {
    if (cwd !== this.cwdValue) throw new Error("The workspace changed. Refresh Changes and select the repository again.")
    // The renderer can still display a repository list after this owner was
    // recreated. Discovery is evidence; an unpopulated cache is not a refusal.
    if (!this.repositoryRoots.includes(root)) {
      const version = this.version
      await this.status()
      if (cwd !== this.cwdValue || version !== this.version) throw new Error("The workspace changed. Refresh Changes and select the repository again.")
    }
    if (!this.repositoryRoots.includes(root)) throw new Error("This repository is no longer available in the current workspace. Refresh Changes to update the list.")
    const previous = this.selectedRoot
    this.selectedRoot = root
    this.version += 1
    const version = this.version
    try { return await this.status() }
    catch (error) {
      if (version === this.version) {
        this.selectedRoot = previous
        this.version += 1
      }
      throw error
    }
  }

  private async repository(): Promise<Repository> {
    const repository = await openRepository(this.target)
    if (!repository) throw new Error("This folder is not a Git repository")
    return repository
  }

  async root(): Promise<string | null> {
    return (await openRepository(this.cwdValue))?.root ?? null
  }

  status(): Promise<GitStatus> {
    if (this.statusRead) return this.statusRead
    const read = async (): Promise<GitStatus> => {
      while (true) {
        const version = this.version
        const status = await this.readStatus()
        if (version === this.version) return status
      }
    }
    const pending = read().finally(() => { if (this.statusRead === pending) this.statusRead = null })
    this.statusRead = pending
    return pending
  }

  private async readStatus(): Promise<GitStatus> {
    const cwd = this.cwdValue
    const repository = await openRepository(cwd)
    if (repository) {
      if (cwd !== this.cwdValue) return { cwd, ahead: 0, behind: 0, files: [] }
      this.selectedRoot = repository.root
      this.summaries = null
      this.watch(repository)
      return this.describe(cwd, repository, await repository.status())
    }
    if (!this.discovery || this.discovery.cwd !== cwd || this.discovery.expires < Date.now()) {
      // Resolved, as Git resolves every root it reports: `/tmp` and a symlinked projects folder name the same repositories.
      this.discovery = { cwd, expires: Date.now() + 5000, value: discoverRepositories(this.realCwd) }
    }
    const discovery = await this.discovery.value
    const summaries = this.tracking ? (this.summaries ??= new Map()) : null
    const repositories: RepositorySummary[] = []
    for (let offset = 0; offset < discovery.roots.length; offset += 4) {
      repositories.push(...await Promise.all(discovery.roots.slice(offset, offset + 4).map(async (root): Promise<RepositorySummary> => {
        const known = summaries?.get(root)
        if (known) return known
        let summary: RepositorySummary
        try {
          const child = await openRepository(root)
          if (!child) summary = { root, label: relative(this.realCwd, root), unavailable: true }
          else {
            const status = await child.status()
            summary = { root, label: relative(this.realCwd, root), branch: status.head.branch ?? undefined, changes: status.entries.length }
          }
        } catch { summary = { root, label: relative(this.realCwd, root), unavailable: true } }
        summaries?.set(root, summary)
        return summary
      })))
    }
    if (cwd !== this.cwdValue) return { cwd, ahead: 0, behind: 0, files: [] }
    this.repositoryRoots = repositories.map((repository) => repository.root)
    for (const root of summaries?.keys() ?? []) if (!this.repositoryRoots.includes(root)) summaries?.delete(root)
    if (!this.selectedRoot || !this.repositoryRoots.includes(this.selectedRoot)) this.selectedRoot = repositories.find((repository) => !repository.unavailable)?.root
    const selected = this.selectedRoot ? await openRepository(this.selectedRoot) : null
    if (selected) this.watch(selected)
    else this.unwatch()
    const status = selected ? await this.describe(cwd, selected, await selected.status()) : undefined
    const index = repositories.findIndex((repository) => repository.root === this.selectedRoot)
    if (status && index >= 0) {
      repositories[index] = { ...repositories[index]!, branch: status.branch, changes: status.files.length }
      summaries?.set(repositories[index]!.root, repositories[index]!)
    }
    return { cwd, ahead: 0, behind: 0, files: [], ...status, repositories, discoveryLimited: discovery.limited }
  }

  private async describe(cwd: string, repository: Repository, status: RepositoryStatus): Promise<GitStatus> {
    const counting = repository.lineCounts(status)
    const counts = await Promise.race([counting, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), COUNT_WAIT_MS))]).catch(() => null)
    if (counts === undefined) void counting.then(() => this.counted?.(), () => undefined)
    return {
      cwd,
      root: status.root,
      branch: status.head.branch ?? undefined,
      head: status.head.oid ?? undefined,
      upstream: status.head.upstream ?? undefined,
      ahead: status.head.ahead,
      behind: status.head.behind,
      files: gitFiles(status, counts),
      operation: status.operation ?? undefined,
    }
  }

  async listFiles(): Promise<string[] | null> {
    const repository = await openRepository(this.cwdValue)
    return repository ? listFiles(repository.root) : null
  }

  async grep(term: string, options: SearchOptions): Promise<string[]> {
    const repository = await openRepository(this.cwdValue)
    return repository ? grep(repository.root, term, options) : []
  }

  async diff(path: string): Promise<GitDiff> {
    return gitDiff(path, await (await this.repository()).preview(path, { kind: "worktree" }))
  }

  async commitFileDiff(oid: string, path: string): Promise<GitDiff> {
    return gitDiff(path, await (await this.repository()).preview(path, { kind: "commit", oid }))
  }

  async diffAll(): Promise<{ diffs: GitDiff[]; truncated: number }> {
    const repository = await this.repository()
    return previewSet(repository, (await repository.status()).entries.map((entry) => ({ path: entry.path })), { kind: "worktree" })
  }

  /**
   * Every file that differs from where HEAD left `ref` (or `origin/<ref>`
   * when there's no such local branch), committed or not, and that point's
   * commit. Null when HEAD shares no history with it.
   */
  async changedSince(ref: string): Promise<{ base: string; files: GitFile[] } | null> {
    const repository = await this.repository()
    const since = await changedSince(repository.root, ref) ?? (ref.startsWith("origin/") ? null : await changedSince(repository.root, `origin/${ref}`))
    if (!since) return null
    return { base: since.base, files: since.files.map((file) => ({ path: file.path, status: CHANGE_STATUS.get(file.change) ?? "modified", staged: false, ...lines(file.lines), binary: file.lines === null })) }
  }

  async defaultBranch(): Promise<string | null> {
    const repository = await openRepository(this.target)
    return repository ? defaultBranch(repository.root) : null
  }

  async sinceDiff(base: string, path: string): Promise<GitDiff> {
    return gitDiff(path, await (await this.repository()).preview(path, { kind: "since", oid: base }))
  }

  async commitDiffAll(oid: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    const repository = await this.repository()
    return previewSet(repository, (await commitFiles(repository.root, oid)).map((file) => ({ path: file.path })), { kind: "commit", oid })
  }

  // Writes start through an open repository without awaiting, so each joins the queue in the order it arrived.
  async stage(paths: string[]): Promise<void> { await (knownRepository(this.target) ?? await this.repository()).stage(paths) }
  async unstage(paths: string[]): Promise<void> { await (knownRepository(this.target) ?? await this.repository()).unstage(paths) }
  async stageAll(): Promise<void> { await (knownRepository(this.target) ?? await this.repository()).stageAll() }
  async unstageAll(): Promise<void> { await (knownRepository(this.target) ?? await this.repository()).unstageAll() }
  async discard(paths: string[]): Promise<{ stash: string }> {
    const message = paths.length === 1 ? `Mako discarded ${paths[0]}` : `Mako discarded ${paths.length} files`
    return (knownRepository(this.target) ?? await this.repository()).discard(paths, message)
  }
  async restoreDiscarded(stash: string): Promise<void> { await (knownRepository(this.target) ?? await this.repository()).restoreDiscarded(stash) }
  async commit(message: string, options: { amend?: boolean } = {}): Promise<void> { await (knownRepository(this.target) ?? await this.repository()).commit({ message, amend: options.amend }) }

  async remote(input: GitRemoteInput): Promise<GitRemoteResult> {
    const repository = await openRepository(input.cwd)
    if (!repository) throw new Error("This repository is unavailable.")
    let failure: unknown
    try {
      await remote(repository, input.action, { branch: input.branch, head: input.head ?? null })
    } catch (error) { failure = error }
    const status = await repository.status()
    const described = await this.describe(input.cwd, repository, status)
    const detail = failure instanceof Error ? failure.message : failure ? String(failure) : undefined
    const kind = failure instanceof GitError ? failure.kind : undefined
    if (status.entries.some((entry) => entry.conflicted)) return { status: described, problem: { kind: "conflicts", message: status.operation ? "Resolve and stage the conflicted files, then continue." : input.action === "merge_autostash" && !failure ? "Incoming commits are merged, but restoring your edits caused conflicts. Git kept a stash backup. Resolve and stage the files before committing." : "Resolve and stage the remaining conflicts before committing.", detail } }
    if (!failure) return { status: described }
    if (kind === "untracked_files") return { status: described, problem: { kind: "untracked", message: "A local file conflicts with incoming changes.", detail } }
    if (kind === "local_changes" && (input.action === "pull" || input.action === "merge")) return { status: described, problem: { kind: "dirty", message: "Local edits overlap incoming changes.", detail } }
    if (input.action === "pull" && status.head.ahead > 0 && status.head.behind > 0 && /Both branches have new commits|Not possible to fast-forward/.test(detail ?? "")) return { status: described, problem: { kind: "incoming", message: "Both branches have new commits. Pull & merge to combine them, then push.", detail } }
    return { status: described, problem: { kind: "failed", message: `Could not ${input.action === "merge" || input.action === "merge_autostash" ? "merge incoming changes" : input.action}. Review the Git details before trying again.`, detail } }
  }

  async push(branch?: string): Promise<{ branch: string; output: string }> {
    const repository = await this.repository()
    const current = branch ?? (await repository.head()).branch
    if (!current) throw new Error("Create or switch to a branch before pushing.")
    await push(repository, current)
    return { branch: current, output: `Published ${current}` }
  }

  async log(limit = 60): Promise<GitCommitEntry[]> {
    const repository = await openRepository(this.target)
    if (!repository) return []
    return (await log(repository.root, limit)).map((entry) => ({ hash: entry.oid, shortHash: entry.shortOid, subject: entry.subject, author: entry.author, date: entry.date, files: null, insertions: null, deletions: null }))
  }

  async commitFiles(oid: string): Promise<GitCommitFile[]> {
    const repository = await this.repository()
    return (await commitFiles(repository.root, oid)).map((file) => ({ path: file.path, status: CHANGE_STATUS.get(file.change) ?? "modified", ...lines(file.lines), binary: file.lines === null }))
  }

  async hasStagedChanges(): Promise<boolean> { return (await this.status()).files.some((file) => file.staged) }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
