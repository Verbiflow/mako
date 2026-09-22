import { watch, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { WorkspaceGit } from "./host-git.js"
import { searchWorkspace } from "./host-search.js"
import { WorkspaceFiles } from "./host-workspace.js"
import type {
  Capabilities,
  FileContents,
  GitCommitEntry,
  GitDiff,
  GitCommitFile,
  GitStatus,
  HostEvent,
  ModelInfo,
  SearchOptions,
  SearchResults,
  SessionMeta,
  SessionState,
  SessionSummary,
  StagedFile,
  ThinkingLevel,
  WorkspaceFile,
} from "./shared.js"

const EMPTY_CAPABILITIES: Capabilities = { tools: [], commands: [], skills: [] }

function unavailable(operation: string): never {
  throw new Error(
    `${operation} belongs to the removed built-in runtime. Choose a provider session instead.`
  )
}

export class AgentHost {
  readonly id: string
  private emit: (event: HostEvent) => void
  private readonly workspaceGit: WorkspaceGit
  private readonly workspaceFiles: WorkspaceFiles
  private foreground = true
  private workspaceWatcher: FSWatcher | null = null
  private workspaceWatcherGeneration = 0
  private gitPushGeneration = 0
  private gitRefreshTimer: NodeJS.Timeout | null = null
  private sessionId = crypto.randomUUID()
  private sessionName: string | undefined

  constructor(id: string, emit: (event: HostEvent) => void) {
    const cwd = homedir()
    this.id = id
    this.emit = (event) => emit({ ...event, tabId: id })
    this.workspaceGit = new WorkspaceGit(cwd)
    this.workspaceFiles = new WorkspaceFiles(cwd, this.workspaceGit)
  }

  get ready(): boolean {
    return true
  }

  get workspace(): string {
    return this.workspaceFiles.cwd
  }

  get sessionFile(): string | undefined {
    return undefined
  }

  setForeground(value: boolean): void {
    if (this.foreground === value) return
    this.foreground = value
    if (value) {
      this.startWorkspaceWatcher()
      this.pushState()
      void this.pushGit()
    } else {
      this.stopWorkspaceWatcher()
    }
  }

  async start(cwd = this.workspace): Promise<void> {
    this.setWorkspace(cwd)
  }

  private setWorkspace(cwd: string): void {
    this.stopWorkspaceWatcher()
    this.workspaceGit.setCwd(cwd)
    this.workspaceFiles.setCwd(cwd)
    if (this.foreground) this.startWorkspaceWatcher()
  }

  private startWorkspaceWatcher(): void {
    if (this.workspaceWatcher) return
    const generation = ++this.workspaceWatcherGeneration
    try {
      this.workspaceWatcher = watch(
        this.workspace,
        { recursive: true },
        (_event, filename) => {
          if (this.workspaceWatcherGeneration !== generation) return
          const path = filename?.toString() ?? ""
          if (
            /(^|\/)(node_modules|dist|dist-electron|release|build|out|\.next|coverage|\.turbo)(\/|$)/.test(
              path
            )
          )
            return
          if (this.gitRefreshTimer) clearTimeout(this.gitRefreshTimer)
          this.gitRefreshTimer = setTimeout(() => {
            this.gitRefreshTimer = null
            if (this.workspaceWatcherGeneration === generation)
              void this.pushGit()
          }, 180)
        }
      )
    } catch {
      this.workspaceWatcher = null
    }
  }

  private stopWorkspaceWatcher(): void {
    this.workspaceWatcherGeneration += 1
    this.workspaceWatcher?.close()
    this.workspaceWatcher = null
    if (this.gitRefreshTimer) clearTimeout(this.gitRefreshTimer)
    this.gitRefreshTimer = null
  }

  meta(): SessionMeta {
    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      cwd: this.workspace,
      leafId: null,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      autoCompaction: false,
      queued: { steering: [], followUp: [] },
      cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      messageCount: 0,
    }
  }

  state(): SessionState {
    return { meta: this.meta(), messages: [], tree: [] }
  }

  pushState(): void {
    if (this.foreground) this.emit({ type: "session", session: this.state() })
  }

  capabilities(): Capabilities {
    return EMPTY_CAPABILITIES
  }

  async listSessions(
    cwd = this.workspace,
    scope: "workspace" | "all" = "workspace"
  ): Promise<SessionSummary[]> {
    void cwd
    void scope
    return []
  }

  async newSession(): Promise<void> {
    this.sessionId = crypto.randomUUID()
    this.sessionName = undefined
    this.pushState()
  }

  async openSession(path: string): Promise<void> {
    void path
    unavailable("Opening a built-in session")
  }

  async setCwd(cwd: string): Promise<void> {
    this.setWorkspace(cwd)
    this.pushState()
    void this.pushGit()
  }

  setName(name: string): void {
    this.sessionName = name.trim() || undefined
    this.pushState()
  }

  async prompt(
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ): Promise<void> {
    void text
    void mode
    void images
    unavailable("Prompting the built-in runtime")
  }

  async abort(): Promise<void> {}
  clearQueue(): void {}

  async fork(
    entryId: string,
    position: "before" | "at" = "before"
  ): Promise<{ cancelled: true } | { cancelled: false; text?: string }> {
    void entryId
    void position
    unavailable("Forking a built-in session")
  }

  async navigateTree(targetId: string): Promise<void> {
    void targetId
    unavailable("Navigating a built-in session tree")
  }

  async compact(instructions?: string): Promise<void> {
    void instructions
    unavailable("Compacting a built-in session")
  }

  setAutoCompaction(enabled: boolean): void {
    void enabled
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }

  async setModel(provider: string, id: string): Promise<void> {
    void provider
    void id
    unavailable("Selecting a built-in model")
  }

  setThinking(level: ThinkingLevel): void {
    void level
    unavailable("Selecting built-in reasoning")
  }

  setActiveTools(names: string[]): void {
    void names
  }

  async runCommand(name: string, args = ""): Promise<void> {
    void name
    void args
    unavailable("Running a built-in extension command")
  }

  get gitWorkspace(): string { return this.workspaceGit.target }

  async selectGitRepository(cwd: string, root: string): Promise<GitStatus> {
    this.gitPushGeneration += 1
    return this.workspaceGit.selectRepository(cwd, root)
  }

  async gitStatus(): Promise<GitStatus> {
    return this.workspaceGit.status()
  }

  async listFiles(): Promise<WorkspaceFile[]> {
    return this.workspaceFiles.list()
  }

  async stageFile(name: string, base64: string): Promise<StagedFile> {
    return this.workspaceFiles.stage(name, base64)
  }

  async stageFilePath(sourcePath: string): Promise<StagedFile> {
    return this.workspaceFiles.stagePath(sourcePath)
  }

  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResults> {
    return searchWorkspace(
      this.workspace,
      this.workspaceGit,
      async () => [],
      query,
      {
        ...options,
        threads: false,
      }
    )
  }

  async createWorkspaceText(
    cwd: string,
    path: string,
    text: string
  ): Promise<string> {
    return this.workspaceFiles.createText(cwd, path, text)
  }

  async readWorkspaceFile(path: string): Promise<FileContents> {
    return this.workspaceFiles.read(path)
  }

  async resolvePath(path: string): Promise<string> {
    return this.workspaceFiles.resolvePath(path)
  }

  async gitDiff(path: string): Promise<GitDiff> {
    return this.workspaceGit.diff(path)
  }

  async gitDiffAll(): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return this.workspaceGit.diffAll()
  }

  async gitCommitFiles(hash: string): Promise<GitCommitFile[]> {
    return this.workspaceGit.commitFiles(hash)
  }

  async gitCommitDiffAll(
    hash: string
  ): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return this.workspaceGit.commitDiffAll(hash)
  }

  async gitCommitFileDiff(hash: string, path: string): Promise<GitDiff> {
    return this.workspaceGit.commitFileDiff(hash, path)
  }

  async gitStage(paths: string[]): Promise<void> {
    await this.workspaceGit.stage(paths)
    await this.pushGit("index")
  }

  async gitUnstage(paths: string[]): Promise<void> {
    await this.workspaceGit.unstage(paths)
    await this.pushGit("index")
  }

  async gitStageAll(): Promise<void> {
    await this.workspaceGit.stageAll()
    await this.pushGit("index")
  }

  async gitUnstageAll(): Promise<void> {
    await this.workspaceGit.unstageAll()
    await this.pushGit("index")
  }

  async gitCommit(
    message: string,
    options: { amend?: boolean } = {}
  ): Promise<void> {
    await this.workspaceGit.commit(message, options)
    await this.pushGit()
    this.emit({ type: "notice", level: "success", message: "Committed" })
  }

  async gitPush(expectedBranch?: string): Promise<void> {
    const { branch, output } = await this.workspaceGit.push(expectedBranch)
    await this.pushGit("index")
    this.emit({
      type: "notice",
      level: "success",
      message: output.trim().split("\n").at(-1) || `Pushed ${branch}`,
    })
  }

  async gitLog(limit = 60): Promise<GitCommitEntry[]> {
    return this.workspaceGit.log(limit)
  }

  async pushGit(cause: "index" | "workspace" = "workspace"): Promise<void> {
    if (!this.foreground) return
    const generation = ++this.gitPushGeneration
    const workspace = this.workspace
    try {
      const git = await this.gitStatus()
      if (generation === this.gitPushGeneration && this.workspace === workspace && this.foreground) this.emit({ type: "git", git, cause })
    } catch (error) {
      if (generation !== this.gitPushGeneration || this.workspace !== workspace || !this.foreground) return
      this.emit({
        type: "notice",
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async dispose(): Promise<void> {
    this.stopWorkspaceWatcher()
  }
}

export const COMMIT_PROMPT = `You are an expert at writing Git commits. Your job is to write a short clear commit message that summarizes the changes.

If you can accurately express the change in just the subject line, don't include anything in the message body. Only use the body when it is providing useful information.

Only return the commit message in your response.`

export function defaultWorkspace(): string {
  return process.cwd() || homedir()
}
