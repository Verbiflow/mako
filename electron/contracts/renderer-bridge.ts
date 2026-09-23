import type { GitRemoteInput, GitRemoteResult } from "./git-workspace-search.js"
import type {
  ThreadTarget,
  ThreadControls,
  ThreadArchiveSnapshot,
  ArchiveCommand,
  StopTarget,
} from "./thread-lifecycle.js"
import type {
  LifecycleState,
  LifecycleCommand,
  UpdateInstallation,
} from "./app-lifecycle.js"
import type { QueuedPromptEdit } from "./live-queue.js"
import type {
  CommitGenerationInput,
  CommitGenerationResult,
  UtilityConnection,
  UtilityConnectionInput,
  UtilityModelSettings,
  UtilityProvider,
  UtilityCatalogInput,
  UtilityCatalog,
} from "./utility-models.js"
import type { RewindInput, RewindPreview } from "./workspace-snapshots.js"
import type {
  DesktopNotification,
  NotificationDelivery,
  NotificationPermission,
} from "./notifications.js"
import type { LiveAction, LiveActionInput } from "./live-actions.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { NativeRequest, NativeRequestInput } from "../shared.js"
import type {
  DelegateInput,
  ForkInput,
  TransferInput,
  HarnessDescriptor,
} from "../shared.js"
import type { LiveStartOptions, LiveSnapshot, LiveRequest } from "../shared.js"
import type { MessageAnchor } from "./message-anchor.js"
import type { ProviderConnection, ProviderConnectionAction } from "./provider-connection.js"
import type { HarnessUpdateInfo } from "./harness-updates.js"
import type {
  Automation,
  BlockAddress,
  BootPayload,
  Capabilities,
  ExternalEditor,
  ExternalThreadActivity,
  ContinuationPlan,
  ContinuationResolution,
  FileContents,
  GitCommitEntry,
  GitCommitFile,
  GitDiff,
  GitHubStatus,
  IntegrationCatalogSnapshot,
  GitStatus,
  GitPushInput,
  HostEvent,
  HarnessProfile,
  ModelInfo,
  MakoComputerPermissions,
  McpRegistrySnapshot,
  McpSyncPreview,
  McpSyncTarget,
  PullRequest,
  SearchOptions,
  SearchResults,
  SessionState,
  SessionSummary,
  SkillReference,
  SkillRegistrySnapshot,
  SkillSyncPreview,
  SkillSyncTarget,
  LivePermissionResponse,
  PromptAttachment,
  EntryBlock,
  Thread,
  ThreadContextOptions,
  ThreadFileContext,
  ThreadInlineContext,
  ThreadPage,
  ThreadRef,
  ThreadRunState,
  StagedFile,
  TabSnapshot,
  TerminalCreateOptions,
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
  ThinkingLevel,
  UpdateState,
  UsageSummary,
  WorkspaceFile,
} from "../shared.js"

import type { CrashReport } from "../crash.js"
import type { ProviderResidencySnapshot } from "./provider-residency.js"
import type {
  AccountHarness,
  AccountProvider,
  AccountUsage,
  AccountCatalog,
} from "../accounts.js"

export interface BridgeTransport {
  nativeWindowVideo?: boolean
  invoke<Result>(channel: string, ...args: unknown[]): Promise<Result>
  onEvent(listener: (event: HostEvent) => void): () => void
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void
  pathForFile(file: File): string | null
  resolveFileUrl(url: string): string
}

/** The same wire methods are used by Electron preload and the local web desk. */
/**
 * Electron's wrapper around anything a host handler throws:
 * `Error invoking remote method 'mako:read-live-file': Error: ENOENT …`.
 */
const HOST_INVOKE_PREFIX =
  /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

export function createMakoBridge(transport: BridgeTransport) {
  /**
   * A host error reaches the UI as the host's own sentence.
   *
   * The viewer, the toasts and the recovery notices print `error.message`,
   * and over Electron IPC that message arrives behind an internal channel
   * name — a reader who clicked a file in an answer was shown
   * `Error invoking remote method 'mako:read-live-file': Error: ENOENT …`
   * where a sentence about their file belonged. The local web transport
   * already throws the host's message alone, so unwrapping here is also what
   * makes the two clients say the same thing.
   *
   * The error object itself is never replaced: `runtime-retry.ts` and the web
   * transport decide what to do by `instanceof`, so only the message is
   * rewritten, and only when the prefix is actually there.
   */
  const invokeTrustedHost = async <Result>(
    channel: string,
    ...args: unknown[]
  ): Promise<Result> => {
    try {
      return await transport.invoke<Result>(channel, ...args)
    } catch (error) {
      if (error instanceof Error && HOST_INVOKE_PREFIX.test(error.message))
        error.message = error.message.replace(HOST_INVOKE_PREFIX, "")
      throw error
    }
  }

  function threadContexts(
    paths: string[]
  ): Promise<Array<ThreadFileContext | null>>
  function threadContexts(
    paths: string[],
    options: ThreadContextOptions & { inline: true }
  ): Promise<Array<ThreadInlineContext | null>>
  function threadContexts(
    paths: string[],
    options?: ThreadContextOptions
  ): Promise<Array<ThreadFileContext | ThreadInlineContext | null>> {
    return invokeTrustedHost("mako:thread-contexts", paths, options)
  }

  const api = {
    nativeWindowVideo: transport.nativeWindowVideo === true,
    boot: () => invokeTrustedHost<BootPayload>("mako:boot"),
    threadArchives: () =>
      invokeTrustedHost<ThreadArchiveSnapshot>("mako:thread-archives"),
    threadControls: (target: ThreadTarget) =>
      invokeTrustedHost<ThreadControls>("mako:thread-controls", target),
    archiveThread: (command: ArchiveCommand) =>
      invokeTrustedHost<ThreadArchiveSnapshot>("mako:thread-archive", command),
    stopThread: (target: StopTarget) =>
      invokeTrustedHost<boolean>("mako:thread-stop", target),

    /* Cross-harness threads: every coding agent's sessions on this machine. */
    threads: (filter?: { cwd?: string; harness?: string }) =>
      invokeTrustedHost<{
        ready: boolean
        threads: ThreadRef[]
        activity: Record<string, ExternalThreadActivity>
      }>("mako:threads", filter),
    openThread: (path: string) =>
      invokeTrustedHost<Thread | null>("mako:thread-open", path),
    readThreadFile: (threadPath: string, filePath: string) =>
      invokeTrustedHost<FileContents>("mako:thread-file", threadPath, filePath),
    pageThread: (path: string, before?: number, limit?: number) =>
      invokeTrustedHost<ThreadPage | null>(
        "mako:thread-page",
        path,
        before,
        limit
      ),
    /** The newest exchanges of a large record, before its full page is read. */
    previewThread: (path: string) =>
      invokeTrustedHost<ThreadPage | null>("mako:thread-preview", path),
    /** The complete block a viewer page trimmed (`outputLength`). */
    threadBlock: (path: string, at: BlockAddress) =>
      invokeTrustedHost<EntryBlock | null>("mako:thread-block", path, at),
    threadContexts,
    followThread: (path: string, fromByte: number) =>
      invokeTrustedHost<void>("mako:thread-follow", path, fromByte),
    unfollowThread: () => invokeTrustedHost<void>("mako:thread-unfollow"),
    harnessDescriptors: () =>
      invokeTrustedHost<HarnessDescriptor[]>("mako:harness-descriptors"),
    resolveContinuation: (path: string) =>
      invokeTrustedHost<ContinuationResolution>("mako:thread-continuation-resolve", path),
    resolveOwner: (path: string) =>
      invokeTrustedHost<Extract<ContinuationResolution, { transport: "attached" }> | null>("mako:thread-owner-resolve", path),
    continuationPlan: (path: string) =>
      invokeTrustedHost<ContinuationPlan>("mako:thread-continuation-plan", path),
    rememberThreadMode: (path: string, modeId: string) =>
      invokeTrustedHost<ThreadRef | null>("mako:thread-remember-mode", path, modeId),
    continueThreadWith: (
      path: string,
      harness: string,
      instruction?: string,
      mode?: "native" | "transcript"
    ) =>
      invokeTrustedHost<
        | { kind: "emitted"; path: string }
        | { kind: "prepared"; prompt: string; cwd: string }
      >("mako:thread-continue-with", path, harness, instruction, mode),
    forkThread: (path: string, upto: number, harness: string, anchor?: MessageAnchor) =>
      invokeTrustedHost<{ prompt: string; cwd: string }>(
        "mako:thread-fork",
        path,
        upto,
        harness,
        anchor
      ),
    threadRun: (path: string) =>
      invokeTrustedHost<ThreadRunState | null>("mako:thread-run", path),
    startHarness: (
      harness: string,
      prompt: string,
      options?: SessionSettings
    ) =>
      invokeTrustedHost<{ run: ThreadRunState | null; cwd: string }>(
        "mako:harness-start",
        harness,
        prompt,
        options
      ),
    harnessTuning: (harness: string, cwd?: string, force?: boolean) =>
      invokeTrustedHost<HarnessProfile>(
        "mako:harness-tuning",
        harness,
        cwd,
        force
      ),
    abortThreadRun: (path: string) =>
      invokeTrustedHost<void>("mako:thread-abort-run", path),

    /* Interactive foreign agents (ACP). */
    liveStart: (harness: string, cwd: string, options: LiveStartOptions) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-start", harness, cwd, options),
    nativeReceipt: (id: string) =>
      invokeTrustedHost<NativeRequest | null>("mako:native-receipt", id),
    nativeDismiss: (id: string) =>
      invokeTrustedHost<void>("mako:native-dismiss", id),
    nativeEditQueued: (input: QueuedPromptEdit) =>
      invokeTrustedHost<NativeRequest[]>("mako:native-edit-queued", input),
    nativeRequests: () =>
      invokeTrustedHost<NativeRequest[]>("mako:native-requests"),
    nativeSubmit: (input: NativeRequestInput) =>
      invokeTrustedHost<NativeRequest>("mako:native-submit", input),
    liveDelegate: (id: string, input: DelegateInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-delegate", id, input),
    liveCancelChild: (id: string, childId: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-child-cancel", id, childId),
    liveMergeFork: (id: string, mergeId: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-merge-fork", id, mergeId),
    liveRewindPreview: (
      id: string,
      requestId: string,
      position?: "before" | "after"
    ) =>
      invokeTrustedHost<RewindPreview>(
        "mako:live-rewind-preview",
        id,
        requestId,
        position
      ),
    liveAction: (id: string, input: LiveActionInput) =>
      invokeTrustedHost<LiveAction>("mako:live-action", id, input),
    liveAcknowledgeAction: (id: string, actionId: string) =>
      invokeTrustedHost<void>("mako:live-action-acknowledge", id, actionId),
    liveRewind: (id: string, input: RewindInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-rewind", id, input),
    liveRecoverRewinds: () =>
      invokeTrustedHost<LiveSnapshot[]>("mako:live-rewind-recover"),
    liveFork: (id: string, input: ForkInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-fork", id, input),
    liveCapture: (id: string, path: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-capture", id, path),
    liveTransfer: (id: string, input: TransferInput) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-transfer", id, input),
    liveEditQueued: (id: string, input: QueuedPromptEdit) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-edit-queued", id, input),
    liveClearQueue: (id: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-clear-queue", id),
    liveEarlier: (id: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-earlier", id),
    liveBind: (id: string, path: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-bind", id, path),
    readLiveFile: (id: string, path: string) =>
      invokeTrustedHost<FileContents>("mako:read-live-file", id, path),
    liveAttach: (path: string) =>
      invokeTrustedHost<LiveSnapshot | null>("mako:live-attach", path),
    liveSnapshot: (id: string) =>
      invokeTrustedHost<LiveSnapshot | null>("mako:live-snapshot", id),
    liveContinue: (id: string, bindingId: string, requestId: string, text: string, attachments?: PromptAttachment[], tuning?: SessionSettings) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-continue", id, bindingId, requestId, text, attachments, tuning),
    livePrompt: (
      id: string,
      requestId: string,
      text: string,
      attachments?: PromptAttachment[],
      tuning?: SessionSettings
    ) =>
      invokeTrustedHost<LiveRequest>(
        "mako:live-prompt",
        id,
        requestId,
        text,
        attachments,
        tuning
      ),
    livePermission: (
      id: string,
      requestId: string,
      response: LivePermissionResponse
    ) =>
      invokeTrustedHost<void>("mako:live-permission", id, requestId, response),
    liveSetMode: (id: string, modeId: string) =>
      invokeTrustedHost<void>("mako:live-mode", id, modeId),
    liveCancel: (id: string) => invokeTrustedHost<void>("mako:live-cancel", id),
    liveClose: (id: string) => invokeTrustedHost<void>("mako:live-close", id),

    /* Provider transports with their own sign-in. */
    providerConnections: (refresh?: boolean) =>
      invokeTrustedHost<ProviderConnection[]>("mako:provider-connections", refresh),
    providerConnectionAction: (provider: string, action: ProviderConnectionAction) =>
      invokeTrustedHost<ProviderConnection>("mako:provider-connection-action", provider, action),

    /* Harness accounts: several logins per CLI. */
    accounts: () => invokeTrustedHost<AccountCatalog>("mako:accounts"),
    captureAccount: (harness: AccountHarness, name: string) =>
      invokeTrustedHost<void>("mako:account-capture", harness, name),
    selectAccount: (harness: AccountHarness, name: string | null) =>
      invokeTrustedHost<void>("mako:account-select", harness, name),
    removeAccount: (harness: AccountHarness, name: string) =>
      invokeTrustedHost<void>("mako:account-remove", harness, name),
    accountUsage: (harness: AccountProvider, name: string) =>
      invokeTrustedHost<AccountUsage>("mako:account-usage", harness, name),

    /* The Agents settings section. */
    harnessProfiles: (force?: boolean) =>
      invokeTrustedHost<HarnessProfile[]>("mako:harness-profiles", force),
    harnessAvailability: () =>
      invokeTrustedHost<Record<string, boolean>>("mako:harness-availability"),
    harnessUpdates: (refresh?: boolean) =>
      invokeTrustedHost<Record<string, HarnessUpdateInfo>>("mako:harness-updates", refresh),
    runHarnessUpdate: (provider: string) =>
      invokeTrustedHost<HarnessUpdateInfo>("mako:harness-update", provider),
    daemonStatus: () =>
      invokeTrustedHost<{
        pid: number
        startedAt: number
        sessions: number
      } | null>("mako:daemon-status"),
    daemonLogin: () => invokeTrustedHost<boolean>("mako:daemon-login"),
    setDaemonLogin: (enabled: boolean) =>
      invokeTrustedHost<void>("mako:daemon-login-set", enabled),

    controlPreviewSource: (conversationId: string) =>
      invokeTrustedHost<string | null>(
        "mako:control-preview-source",
        conversationId
      ),
    appshotWindows: () =>
      invokeTrustedHost<import("../shared.js").AppshotWindow[]>(
        "mako:appshot-windows"
      ),
    captureAppshot: (target: import("../shared.js").AppshotTarget) =>
      invokeTrustedHost<import("../shared.js").Appshot>(
        "mako:appshot-capture",
        target
      ),
    controlPreview: (
      conversationId: string,
      watching: boolean,
      watcher = "panel"
    ) =>
      invokeTrustedHost<import("../shared.js").ControlPreview | null>(
        "mako:control-preview",
        conversationId,
        watching,
        watcher
      ),
    computerPermissions: () =>
      invokeTrustedHost<MakoComputerPermissions>("mako:computer-permissions"),
    prepareBrowserExtension: () =>
      invokeTrustedHost<
        import("../browser-extension-setup.js").BrowserExtensionSetup
      >("mako:browser-extension-setup"),
    browserControlStatus: () =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-status"
      ),
    preferBrowser: (browser: string | null) =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-prefer",
        browser
      ),
    connectBrowser: (browser: string) =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-connect",
        browser
      ),
    disconnectBrowser: (browser: string) =>
      invokeTrustedHost<import("../shared.js").BrowserControlStatus[]>(
        "mako:browser-control-disconnect",
        browser
      ),
    requestComputerPermissions: () =>
      invokeTrustedHost<MakoComputerPermissions>(
        "mako:computer-permissions-request"
      ),
    computerDriver: () =>
      invokeTrustedHost<import("../shared.js").CuaDriverStatus>(
        "mako:computer-driver"
      ),
    updateComputerDriver: () =>
      invokeTrustedHost<import("../shared.js").CuaDriverStatus>(
        "mako:computer-driver-update"
      ),

    /* MCP discovery is read-only; sync is always an explicit settings action. */
    integrations: () =>
      invokeTrustedHost<IntegrationCatalogSnapshot>("mako:integrations"),
    discoverMcp: () =>
      invokeTrustedHost<McpRegistrySnapshot>("mako:mcp-discover"),
    previewMcpSync: (serverId: string, target: McpSyncTarget) =>
      invokeTrustedHost<McpSyncPreview>(
        "mako:mcp-sync-preview",
        serverId,
        target
      ),
    applyMcpSync: (serverId: string, target: McpSyncTarget) =>
      invokeTrustedHost<McpRegistrySnapshot>(
        "mako:mcp-sync-apply",
        serverId,
        target
      ),

    discoverSkills: () =>
      invokeTrustedHost<SkillRegistrySnapshot>("mako:skills-discover"),
    /** The `$skill` names in a message, resolved for the provider that will answer it. */
    resolveSkillReferences: (names: string[], harness: string) =>
      invokeTrustedHost<SkillReference[]>(
        "mako:skills-resolve",
        names,
        harness
      ),
    previewSkillSync: (skillId: string, target: SkillSyncTarget) =>
      invokeTrustedHost<SkillSyncPreview>(
        "mako:skills-sync-preview",
        skillId,
        target
      ),
    previewSkillRemove: (skillId: string, target: SkillSyncTarget) =>
      invokeTrustedHost<SkillSyncPreview>(
        "mako:skills-remove-preview",
        skillId,
        target
      ),
    applySkillSync: (skillId: string, targets: SkillSyncTarget[]) =>
      invokeTrustedHost<SkillRegistrySnapshot>(
        "mako:skills-sync-apply",
        skillId,
        targets
      ),

    /* Tabs. Session-scoped calls below always address the active tab. */
    openTab: (options?: { cwd?: string; sessionPath?: string }) =>
      invokeTrustedHost<TabSnapshot>("mako:open-tab", options),
    closeTab: (id: string) =>
      invokeTrustedHost<{
        tabs: string[]
        activeId: string
        opened?: TabSnapshot
      }>("mako:close-tab", id),
    activateTab: (id: string) =>
      invokeTrustedHost<boolean>("mako:activate-tab", id),

    listSessions: (cwd?: string, scope?: "workspace" | "all") =>
      invokeTrustedHost<SessionSummary[]>("mako:list-sessions", cwd, scope),
    openSession: (path: string) =>
      invokeTrustedHost<SessionState>("mako:open-session", path),
    newSession: () => invokeTrustedHost<SessionState>("mako:new-session"),
    setCwd: (cwd: string) =>
      invokeTrustedHost<TabSnapshot>("mako:set-cwd", cwd),
    setName: (name: string) => invokeTrustedHost<void>("mako:set-name", name),

    prompt: (
      text: string,
      mode?: "steer" | "followUp",
      images?: Array<{ mimeType: string; data: string }>
    ) => invokeTrustedHost<void>("mako:prompt", text, mode, images),
    abort: () => invokeTrustedHost<void>("mako:abort"),
    clearQueue: () => invokeTrustedHost<void>("mako:clear-queue"),
    navigateTree: (targetId: string) =>
      invokeTrustedHost<SessionState>("mako:navigate-tree", targetId),
    fork: (entryId: string, position: "before" | "at" = "before") =>
      invokeTrustedHost<
        | { cancelled: true }
        | { cancelled: false; text?: string; tab: TabSnapshot }
      >("mako:fork", entryId, position),
    compact: (instructions?: string) =>
      invokeTrustedHost<void>("mako:compact", instructions),
    setAutoCompaction: (enabled: boolean) =>
      invokeTrustedHost<void>("mako:set-auto-compaction", enabled),

    listModels: () => invokeTrustedHost<ModelInfo[]>("mako:list-models"),
    setModel: (provider: string, id: string) =>
      invokeTrustedHost<void>("mako:set-model", provider, id),
    setThinking: (level: ThinkingLevel) =>
      invokeTrustedHost<void>("mako:set-thinking", level),

    capabilities: () => invokeTrustedHost<Capabilities>("mako:capabilities"),
    setActiveTools: (names: string[]) =>
      invokeTrustedHost<void>("mako:set-active-tools", names),
    runCommand: (name: string, args?: string) =>
      invokeTrustedHost<void>("mako:run-command", name, args),

    createWorkspaceText: (cwd: string, path: string, text: string) =>
      invokeTrustedHost<string>("mako:create-workspace-text", cwd, path, text),
    listFiles: () => invokeTrustedHost<WorkspaceFile[]>("mako:list-files"),
    readFile: (path: string) =>
      invokeTrustedHost<FileContents>("mako:read-file", path),
    watchFile: (path: string) =>
      invokeTrustedHost<void>("mako:watch-file", path),
    unwatchFile: () => invokeTrustedHost<void>("mako:unwatch-file"),
    search: (query: string, options?: SearchOptions) =>
      invokeTrustedHost<SearchResults>("mako:search", query, options),

    selectGitRepository: (cwd: string, root: string) => invokeTrustedHost<GitStatus>("mako:git-select-repository", cwd, root),
    gitRemote: (input: GitRemoteInput) => invokeTrustedHost<GitRemoteResult>("mako:git-remote", input),
    gitStatus: () => invokeTrustedHost<GitStatus>("mako:git-status"),
    gitDiff: (path: string) =>
      invokeTrustedHost<GitDiff>("mako:git-diff", path),
    gitDiffAll: () =>
      invokeTrustedHost<{ diffs: GitDiff[]; truncated: number }>(
        "mako:git-diff-all"
      ),
    gitStage: (paths: string[]) =>
      invokeTrustedHost<void>("mako:git-stage", paths),
    gitUnstage: (paths: string[]) =>
      invokeTrustedHost<void>("mako:git-unstage", paths),
    gitStageAll: () => invokeTrustedHost<void>("mako:git-stage-all"),
    gitUnstageAll: () => invokeTrustedHost<void>("mako:git-unstage-all"),
    gitCommit: (message: string, options?: { amend?: boolean }) =>
      invokeTrustedHost<void>("mako:git-commit", message, options),
    gitPush: (input: GitPushInput) =>
      invokeTrustedHost<void>("mako:git-push", input),
    gitLog: (limit?: number) =>
      invokeTrustedHost<GitCommitEntry[]>("mako:git-log", limit),
    gitCommitFiles: (hash: string) =>
      invokeTrustedHost<GitCommitFile[]>("mako:git-commit-files", hash),
    gitCommitFileDiff: (hash: string, path: string) =>
      invokeTrustedHost<GitDiff>("mako:git-commit-file-diff", hash, path),
    gitCommitDiffAll: (hash: string) =>
      invokeTrustedHost<{ diffs: GitDiff[]; truncated: number }>(
        "mako:git-commit-diff-all",
        hash
      ),
    generateCommitMessage: (input: CommitGenerationInput) =>
      invokeTrustedHost<CommitGenerationResult>(
        "mako:git-generate-message",
        input
      ),
    cancelCommitGeneration: (requestId: string) =>
      invokeTrustedHost<void>("mako:git-cancel-generation", requestId),
    utilityModelSettings: () =>
      invokeTrustedHost<UtilityModelSettings>("mako:utility-model-settings"),
    utilityModelCatalog: (input: UtilityCatalogInput) =>
      invokeTrustedHost<UtilityCatalog>("mako:utility-model-catalog", input),
    connectUtilityModel: (input: UtilityConnectionInput) =>
      invokeTrustedHost<UtilityConnection>("mako:utility-model-connect", input),
    disconnectUtilityModel: (provider: UtilityProvider) =>
      invokeTrustedHost<void>("mako:utility-model-disconnect", provider),
    stageFile: (name: string, base64: string) =>
      invokeTrustedHost<StagedFile>("mako:stage-file", name, base64),
    stageFilePath: (sourcePath: string) =>
      invokeTrustedHost<StagedFile>("mako:stage-file-path", sourcePath),
    /** The OS path behind a dropped/picked File — the fast lane for staging. */
    pathForFile: transport.pathForFile,
    resolveFileUrl: transport.resolveFileUrl,
    listPlugins: () =>
      invokeTrustedHost<Array<{ id: string; source: string; error?: string }>>(
        "mako:list-plugins"
      ),
    pluginsDir: () => invokeTrustedHost<string>("mako:plugins-dir"),
    writePlugin: (id: string, source: string) =>
      invokeTrustedHost<void>("mako:write-plugin", id, source),
    deletePlugin: (id: string) =>
      invokeTrustedHost<void>("mako:delete-plugin", id),
    revealPlugins: () => invokeTrustedHost<void>("mako:reveal-plugins"),

    defaultCommitPrompt: () =>
      invokeTrustedHost<string>("mako:default-commit-prompt"),

    /* GitHub, via the `gh` CLI. See electron/github.ts for why. */
    githubStatus: () => invokeTrustedHost<GitHubStatus>("mako:github-status"),
    pullRequest: () =>
      invokeTrustedHost<PullRequest | null>("mako:pull-request"),
    pullRequests: (limit?: number) =>
      invokeTrustedHost<PullRequest[]>("mako:pull-requests", limit),
    pullBranches: () => invokeTrustedHost<string[]>("mako:pull-branches"),
    createPull: (options: {
      title: string
      body: string
      base?: string
      draft?: boolean
    }) => invokeTrustedHost<PullRequest | null>("mako:create-pull", options),
    mergePull: (strategy: "merge" | "squash" | "rebase") =>
      invokeTrustedHost<PullRequest | null>("mako:merge-pull", strategy),
    rerunChecks: () => invokeTrustedHost<void>("mako:rerun-checks"),
    repoAvatar: (repo: string) =>
      invokeTrustedHost<string | undefined>("mako:repo-avatar", repo),
    userAvatar: () => invokeTrustedHost<string | undefined>("mako:user-avatar"),

    usage: () => invokeTrustedHost<UsageSummary>("mako:usage"),
    automations: () => invokeTrustedHost<Automation[]>("mako:automations"),
    saveAutomations: (next: Automation[]) =>
      invokeTrustedHost<Automation[]>("mako:save-automations", next),
    setAutomationEnabled: (id: string, enabled: boolean) =>
      invokeTrustedHost<Automation[]>("mako:automation-enabled", id, enabled),
    runAutomation: (id: string) =>
      invokeTrustedHost<void>("mako:run-automation", id),
    reloadAutomations: () =>
      invokeTrustedHost<Automation[]>("mako:reload-automations"),

    terminalList: () =>
      invokeTrustedHost<TerminalSession[]>("mako:terminal-list"),
    terminalCreate: (options: TerminalCreateOptions) =>
      invokeTrustedHost<TerminalSession>("mako:terminal-create", options),
    terminalAttach: (sessionId: string) =>
      invokeTrustedHost<TerminalSnapshot>("mako:terminal-attach", sessionId),
    terminalDetach: (sessionId: string) =>
      invokeTrustedHost<void>("mako:terminal-detach", sessionId),
    terminalWrite: (sessionId: string, data: string) =>
      invokeTrustedHost<void>("mako:terminal-write", sessionId, data),
    terminalAcknowledge: (sessionId: string, sequence: number) =>
      invokeTrustedHost<void>("mako:terminal-acknowledge", sessionId, sequence),
    terminalResize: (sessionId: string, cols: number, rows: number) =>
      invokeTrustedHost<void>("mako:terminal-resize", sessionId, cols, rows),
    terminalKill: (sessionId: string) =>
      invokeTrustedHost<void>("mako:terminal-kill", sessionId),
    onTerminalEvent: transport.onTerminalEvent,

    lifecycleState: () =>
      invokeTrustedHost<LifecycleState>("mako:lifecycle-state"),
    lifecycleCommand: (command: LifecycleCommand) =>
      invokeTrustedHost<LifecycleState>("mako:lifecycle-command", command),
    quitClient: () => invokeTrustedHost<void>("mako:quit-client"),
    acknowledgeShutdown: (requestId: string) =>
      invokeTrustedHost<void>("mako:shutdown-ack", requestId),
    installationState: () =>
      invokeTrustedHost<UpdateInstallation>("mako:installation-state"),
    selectUpdateSource: (path: string) =>
      invokeTrustedHost<UpdateInstallation>("mako:select-update-source", path),
    buildUpdate: () => invokeTrustedHost<void>("mako:build-update"),
    updateState: () => invokeTrustedHost<UpdateState>("mako:update-state"),
    checkUpdates: () => invokeTrustedHost<UpdateState>("mako:check-updates"),
    installUpdate: () => invokeTrustedHost<void>("mako:install-update"),
    /** Quit and come back on the current build; conversations reopen from their journals. */
    relaunch: () => invokeTrustedHost<void>("mako:relaunch"),
    openPreviewWindow: () =>
      invokeTrustedHost<void>("mako:open-preview-window"),

    /* Crash reports. Local only — see electron/crash.ts. */
    crashes: () => invokeTrustedHost<CrashReport[]>("mako:crashes"),
    crashesDir: () => invokeTrustedHost<string>("mako:crashes-dir"),
    /** The host's own log of provider starts, failures and exits; empty when no host log is open. */
    hostLogPath: () => invokeTrustedHost<string>("mako:host-log-path"),
    providerResidency: () =>
      invokeTrustedHost<ProviderResidencySnapshot>(
        "mako:provider-residency"
      ),
    clearCrashes: () => invokeTrustedHost<void>("mako:clear-crashes"),
    reportCrash: (
      kind: "renderer-error" | "renderer-rejection",
      payload: { message: string; stack?: string; source?: string }
    ) => invokeTrustedHost<void>("mako:report-crash", kind, payload),

    pickFolder: () => invokeTrustedHost<string | null>("mako:pick-folder"),
    externalEditors: () =>
      invokeTrustedHost<ExternalEditor[]>("mako:external-editors"),
    openInEditor: (path: string, editor?: string) =>
      invokeTrustedHost<void>("mako:open-in-editor", path, editor),
    revealPath: (path: string) => invokeTrustedHost<void>("mako:reveal", path),
    openUrl: (url: string) => invokeTrustedHost<void>("mako:open-url", url),
    copy: (text: string) => invokeTrustedHost<void>("mako:copy", text),

    /*
     * Desktop notifications and the app-icon badge. These are answered by the
     * client process that owns the window (or the web bridge in a browser),
     * never by the shared host: a banner belongs to the desk you are looking
     * away from, and a badge to the icon in its dock.
     */
    notify: (notification: DesktopNotification) =>
      invokeTrustedHost<NotificationDelivery>("mako:notify", notification),
    dismissNotification: (subject: string) =>
      invokeTrustedHost<void>("mako:notify-dismiss", subject),
    setBadgeCount: (count: number) =>
      invokeTrustedHost<void>("mako:set-badge-count", count),
    notificationPermission: () =>
      invokeTrustedHost<NotificationPermission>("mako:notification-permission"),
    requestNotificationPermission: () =>
      invokeTrustedHost<NotificationPermission>(
        "mako:request-notification-permission"
      ),

    /** Subscribe to host events. Returns a disposer. */
    onEvent: transport.onEvent,
  }
  return api
}

export type MakoBridge = ReturnType<typeof createMakoBridge>
