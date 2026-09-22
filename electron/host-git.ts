import { relative } from "node:path"
import { discoverRepositories, type RepositoryDiscovery } from "./repository-discovery.js"
import type { Comparison, RepoPath, KiriRepository, KiriClient, ResultValue } from "@kiri/client"
import type { GitCommitEntry, GitCommitFile, GitDiff, GitFile, GitFileStatus, GitStatus, SearchOptions } from "./shared.js"
import { withKiriRepository } from "./kiri-engine.js"
import { readGitPreview, readGitPreviewSet } from "./git-preview.js"

export async function waitForIndexWrites(root: string, signal: AbortSignal): Promise<void> {
  await withKiriRepository(root, async (repo, client) => {
    if (!repo) throw new Error("This folder is not a Git repository")
    signal.throwIfAborted()
    try { await client.request({ method: "fence", repo: repo.id }, signal) }
    catch (error) { signal.throwIfAborted(); throw error }
  })
}
function kind(value: string): GitFileStatus {
  switch (value) {
    case "added": return "added"
    case "deleted": return "deleted"
    case "renamed": return "renamed"
    case "untracked": return "untracked"
    default: return "modified"
  }
}
function expected<T extends ResultValue["kind"]>(result: ResultValue, tag: T): Extract<ResultValue, { kind: T }> {
  const matches = (value: ResultValue): value is Extract<ResultValue, { kind: T }> => value.kind === tag
  if (!matches(result)) throw new Error(`Kiri returned ${result.kind} instead of ${tag}`)
  return result
}

export class WorkspaceGit {
  private cwdValue: string
  private discovery: { cwd: string; expires: number; value: Promise<RepositoryDiscovery> } | undefined
  private selectedRoot: string | undefined
  private repositoryRoots: string[] = []
  private version = 0
  private statusRead: Promise<GitStatus> | null = null
  private readonly paths = new Map<string, RepoPath>()
  constructor(cwd: string) { this.cwdValue = cwd }
  get cwd(): string { return this.cwdValue }
  setCwd(cwd: string): void { if (cwd !== this.cwdValue) { this.cwdValue = cwd; this.version += 1; this.paths.clear(); this.selectedRoot = undefined; this.repositoryRoots = [] } }
  get target(): string { return this.selectedRoot ?? this.cwdValue }
  async selectRepository(cwd: string, root: string): Promise<GitStatus> {
    if (cwd !== this.cwdValue || !this.repositoryRoots.includes(root)) throw new Error("Choose a repository in the current workspace.")
    const previous = this.selectedRoot
    this.selectedRoot = root
    this.version += 1
    this.paths.clear()
    const version = this.version
    try { return await this.status() }
    catch (error) {
      if (version === this.version) {
        this.selectedRoot = previous
        this.version += 1
        this.paths.clear()
      }
      throw error
    }
  }
  private path(bytes: RepoPath): string {
    const display = Buffer.from(bytes).toString("utf8")
    const previous = this.paths.get(display)
    if (previous && !Buffer.from(previous).equals(Buffer.from(bytes))) throw new Error("This host cannot disambiguate two non-UTF-8 paths. Use Kiri's byte-path interface to review them.")
    this.paths.set(display, bytes)
    return display
  }
  private bytes(path: string): RepoPath {
    if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) throw new Error("Choose a file inside this repository.")
    return this.paths.get(path) ?? [...Buffer.from(path)]
  }
  private withRepo<T>(action: (repo: KiriRepository, client: KiriClient) => Promise<T>): Promise<T> {
    const cwd = this.target
    return withKiriRepository(cwd, async (repo, client) => {
      if (!repo) throw new Error("This folder is not a Git repository")
      return action(repo, client)
    })
  }
  async root(): Promise<string | null> { return withKiriRepository(this.cwdValue, async (repo) => repo?.root ?? null) }
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
    const result = await withKiriRepository(cwd, async (repo, client): Promise<GitStatus> => {
      if (!repo) {
        if (!this.discovery || this.discovery.cwd !== cwd || this.discovery.expires < Date.now()) {
          this.discovery = { cwd, expires: Date.now() + 5000, value: discoverRepositories(cwd) }
        }
        const discovery = await this.discovery.value
        const repositories: NonNullable<GitStatus["repositories"]> = []
        // Bound sidecar admission and avoid hydrating patches for child repos.
        for (let offset = 0; offset < discovery.roots.length; offset += 4) {
          repositories.push(...await Promise.all(discovery.roots.slice(offset, offset + 4).map(async (root) => {
            try {
              return await withKiriRepository(root, async (child) => {
                if (!child) return { root, label: relative(cwd, root), unavailable: true }
                const { status } = await child.status()
                return { root: child.root, label: relative(cwd, root), branch: status.branch, changes: status.files.length }
              })
            } catch { return { root, label: relative(cwd, root), unavailable: true } }
          })))
        }
        if (cwd !== this.cwdValue) return { cwd, ahead: 0, behind: 0, files: [] }
        this.repositoryRoots = repositories.map(repository => repository.root)
        if (!this.selectedRoot || !this.repositoryRoots.includes(this.selectedRoot)) this.selectedRoot = repositories.find(repository => !repository.unavailable)?.root
        const selected = this.selectedRoot
        const status = selected
          ? await withKiriRepository(selected, async (child, engine) => child ? this.readRepositoryStatus(cwd, child, engine) : undefined)
          : undefined
        return { cwd, ahead: 0, behind: 0, files: [], ...status, repositories, discoveryLimited: discovery.limited }
      }
      if (cwd === this.cwdValue) this.selectedRoot = repo.root
      return this.readRepositoryStatus(cwd, repo, client)
    })
    return result
  }
  private async readRepositoryStatus(cwd: string, repo: KiriRepository, client: KiriClient): Promise<GitStatus> {
      const [snapshot, operation] = await Promise.all([repo.status(true), client.request({ method: "operation", repo: repo.id })])
      const status = snapshot.status
      const files: GitFile[] = status.files.map((file) => ({ path: this.path(file.path), oldName: file.original_path ? this.path(file.original_path) : undefined, status: file.staged === "renamed" || file.worktree === "renamed" ? "renamed" : kind(file.worktree ?? file.staged ?? "modified"), staged: file.staged != null, insertions: null, deletions: null, binary: false }))
      return { cwd, root: repo.root, branch: status.branch, head: status.head ?? undefined, upstream: status.upstream ?? undefined, ahead: status.ahead, behind: status.behind, files, operation: expected(operation, "operation").operation ?? undefined }
  }
  async listFiles(): Promise<string[] | null> {
    return withKiriRepository(this.cwdValue, async (repo, client) => repo ? expected(await client.request({ method: "files", repo: repo.id }), "files").paths.map((path) => this.path(path)) : null)
  }
  async grep(term: string, options: SearchOptions): Promise<string[]> {
    return withKiriRepository(this.cwdValue, async (repo, client) => repo ? expected(await client.request({ method: "search", repo: repo.id, term, case_sensitive: options.caseSensitive ?? false, whole_word: options.wholeWord ?? false, regex: options.regex ?? false }), "search").lines : [])
  }
  private async comparison(path: string, comparison: Comparison): Promise<GitDiff> {
    const bytes = this.bytes(path)
    return this.withRepo((repo, client) => readGitPreview(repo, client, path, bytes, comparison))
  }
  async diff(path: string): Promise<GitDiff> { return this.comparison(path, { kind: "head_to_worktree" }) }
  async commitFileDiff(oid: string, path: string): Promise<GitDiff> { return this.comparison(path, { kind: "commit", oid }) }
  async diffAll(): Promise<{ diffs: GitDiff[]; truncated: number }> { const target = new WorkspaceGit(this.target); const files = (await target.status()).files; return readGitPreviewSet(files, (path) => target.diff(path)) }
  async commitDiffAll(oid: string): Promise<{ diffs: GitDiff[]; truncated: number }> { const target = new WorkspaceGit(this.target); return readGitPreviewSet(await target.commitFiles(oid), (path) => target.commitFileDiff(oid, path)) }
  async stage(paths: string[]): Promise<void> { const bytes = paths.map((path) => this.bytes(path)); await this.withRepo((repo) => repo.stage(bytes)) }
  async unstage(paths: string[]): Promise<void> { const bytes = paths.map((path) => this.bytes(path)); await this.withRepo((repo) => repo.stage(bytes, false)) }
  async stageAll(): Promise<void> { await this.withRepo(async (repo, client) => { await client.request({ method: "stage_all", repo: repo.id, side: "worktree" }) }) }
  async unstageAll(): Promise<void> { await this.withRepo(async (repo, client) => { await client.request({ method: "stage_all", repo: repo.id, side: "staged" }) }) }
  async commit(message: string, options: { amend?: boolean } = {}): Promise<void> { await this.withRepo(async (repo, client) => { await client.request({ method: "commit_message", repo: repo.id, message, amend: options.amend ?? false }) }) }
  async push(branch?: string): Promise<{ branch: string; output: string }> {
    return this.withRepo(async (repo, client) => {
      const current = branch ?? (await repo.status(true)).status.branch
      await client.request({ method: "push", repo: repo.id, branch: current })
      return { branch: current, output: `Published ${current}` }
    })
  }
  async log(limit = 60): Promise<GitCommitEntry[]> {
    return withKiriRepository(this.target, async (repo, client) => repo ? expected(await client.request({ method: "log", repo: repo.id, limit }), "history").entries.map((entry) => ({ hash: entry.oid, shortHash: entry.short_oid, subject: entry.subject, author: entry.author, date: entry.date, files: null, insertions: null, deletions: null })) : [])
  }
  async commitFiles(oid: string): Promise<GitCommitFile[]> {
    return this.withRepo(async (repo, client) => expected(await client.request({ method: "commit_files", repo: repo.id, oid }), "commit_files").files.map((file) => ({ path: this.path(file.path), status: kind(file.kind), insertions: null, deletions: null, binary: false })))
  }
  async hasStagedChanges(): Promise<boolean> { return (await this.status()).files.some((file) => file.staged) }
}
