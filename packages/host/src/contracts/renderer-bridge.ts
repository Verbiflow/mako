import type { GitRemoteInput, GitRemoteResult, ExternalEditor, FileContents, FileReadPurpose, GitCommitEntry, GitCommitFile, GitDiff, GitFile, GitHubStatus, GitStatus, GitPushInput, PullRequest, SearchOptions, SearchResults, StagedFile, WorkspaceFile } from "./git-workspace-search.js"
import type { AuthoringApplied, AuthoringCatalog, AuthoringChange, AuthoringPlan, AuthoringTarget, AuthoringView } from "./native-authoring.js"
import type {
  ThreadTarget,
  ThreadControls,
  ThreadArchiveSnapshot,
  ArchiveCommand,
  StopTarget,
} from "./thread-lifecycle.js"
import type { ThreadGroup } from "./thread-groups.js"
import type { ThreadPurpose } from "./thread-purposes.js"
import type { ThreadTitleEntry } from "./thread-titles.js"
import type { ProjectAppSetup } from "./project-app.js"
import type { ThreadWorktrees, WorktreeBranch, WorktreeInventory, WorktreePull, WorktreeReview, WorktreeStartPoint, WorktreeSummary, WorktreeRemoval, WorktreeUpdate } from "./thread-worktrees.js"
import type { MergeMethod } from "./git-actions.js"
import type { PullRequestSearchRequest, PullRequestSearchResult } from "./pull-request-search.js"
import type { ChatFolders } from "./chat-folders.js"
import type { ChangeUsage, LostVersion, ThreadChangeSummary } from "./thread-changes.js"
import type { FileReferenceSource, FileResolution } from "./file-references.js"
import type { MoveOutcome, WorkspaceMoveAnswer, WorkspaceMoveHold, WorkspaceMoveTarget, WorkspaceMoves } from "./workspace-moves.js"
import type { PlanBuild, PlanBuildClaim, PlanBuildTarget, PlanBuilds } from "./plan-builds.js"
import type { CheckoutHeads } from "./checkout-heads.js"
import type { AppActionOutcome, AppMark, AppOutputChunk, AppOutputCursor, AppOutputKey, AppProbeView, RoomView, ThreadAppView } from "./thread-app.js"
import type { ThreadPlacement } from "./thread-identity.js"
import type {
  LifecycleState,
  LifecycleCommand,
  UpdateInstallation,
} from "./app-lifecycle.js"
import type { QueuedPromptEdit } from "./live-queue.js"
import type { GoalCommand } from "./live-goals.js"
import type { SideQuestionCommand } from "./live-side-questions.js"
import type { ReviewTarget } from "./live-reviews.js"
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
import type { UtilityTask } from "./utility-work.js"
import type { RewindInput, RewindPreview } from "./workspace-snapshots.js"
import type {
  DesktopNotification,
  NotificationDelivery,
  NotificationPermission,
} from "./notifications.js"
import type { LiveAction, LiveActionInput } from "./live-actions.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ChildTranscripts } from "@mako/sessions/children"
import type { EntryOriginal } from "@mako/sessions/record-original"
import type { RecordRef } from "@mako/sessions/entries"
import type { NativeRequest, NativeRequestInput } from "./native-requests.js"
import type { ForkInput, TransferInput } from "./conversation-control.js"
import type { HarnessDescriptor, ContextBreakdown, HarnessProfile, LivePermissionResponse, PromptAttachment } from "./providers-acp.js"
import type { LiveStartOptions, LiveSnapshot, LiveRequest, SignInReadiness, SignInResume } from "./live-conversations.js"
import type { ConversationSettings } from "./turn-continuation.js"
import type { LiveHistoryRead, LiveHistoryChunk } from "./live-history.js"
import type { ProviderConnection, ProviderConnectionAction } from "./provider-connection.js"
import type { CloudAccount, CloudBrowserSession, CloudDevice } from "./cloud-account.js"
import type { CloudSignInsState } from "./cloud-sign-ins.js"
import type { CloudPrepareLaunch, CloudPrepareOutcome, CloudProjectsOffer, HandOffCandidate, HandOffResult, HandOffSettings, ThreadHandOff, ThreadMoveOutcome, ThreadReturnOutcome } from "./cloud-threads.js"
import type { TelemetryChoice, TelemetryState } from "./telemetry.js"
import type { HarnessUpdateInfo } from "./harness-updates.js"
import type { Automation, UpdateState, UsageSummary } from "./automations-usage-updates.js"
import type { Entry, ModelInfo, SessionState, SessionSummary, Thread, ThreadContextOptions, ThreadFileContext, ThreadPage, ThreadRef, ThreadRunState, ThinkingLevel } from "./conversation-session.js"
import type { BootPayload, ExternalThreadActivity, HostEvent, TabSnapshot } from "./host-events-boot.js"
import type { Capabilities, IntegrationCatalogSnapshot, MakoComputerPermissions, McpRegistrySnapshot, McpSyncPreview, McpSyncTarget, SkillReference, SkillRegistrySnapshot, SkillSyncPreview, SkillSyncTarget } from "./mcp-skills-integrations.js"
import type { ContinuationPlan, ContinuationResolution } from "./thread-continuation.js"
import type { RestorePlan } from "./restore-plan.js"
import type { UnreadReport } from "./unread-records.js"
import type { StoreFormats } from "./store-formats.js"
import type { TerminalCreateOptions, TerminalEvent, TerminalSession, TerminalSnapshot } from "./terminal.js"

import type { CrashReport } from "./crash-report.js"
import type { TranscriptDepth, TranscriptDocument, TranscriptSource } from "./transcript-document.js"
import type { ProviderResidencySnapshot } from "./provider-residency.js"
import type { AccountHarness, AccountLogin, AccountLoginResult, AccountProvider, AccountRemovalOutcome, AccountRemovalPlan, AccountUsage, AccountCatalog, ResetCreditOutcome } from "./accounts.js"

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
   * The error object itself is never replaced: `host-call-recovery.ts` and the web
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
    paths: string[],
    options?: ThreadContextOptions
  ): Promise<Array<ThreadFileContext | null>> {
    return invokeTrustedHost("mako:thread-contexts", paths, options)
  }

  const api = {
    nativeWindowVideo: transport.nativeWindowVideo === true,
    boot: () => invokeTrustedHost<BootPayload>("mako:boot"),
    threadArchives: () =>
      invokeTrustedHost<ThreadArchiveSnapshot>("mako:thread-archives"),
    threadGroups: () => invokeTrustedHost<ThreadGroup[]>("mako:thread-groups"),
    threadPurposes: () => invokeTrustedHost<ThreadPurpose[]>("mako:thread-purposes"),
    threadTitles: () => invokeTrustedHost<ThreadTitleEntry[]>("mako:thread-titles"),
    /** `title: null` gives the Thread's name back to automatic titles. */
    renameThread: (operationId: string, thread: string, title: string | null, original?: string) =>
      invokeTrustedHost<ThreadTitleEntry>("mako:thread-rename", operationId, thread, title, original),
    importThreadTitles: (entries: Array<{ thread: string; title: string }>) =>
      invokeTrustedHost<ThreadTitleEntry[]>("mako:thread-titles-import", entries),
    worktrees: () => invokeTrustedHost<ThreadWorktrees>("mako:worktrees"),
    checkoutHeads: (folders: string[]) => invokeTrustedHost<CheckoutHeads>("mako:checkout-heads", folders),
    threadApp: (cwd: string, target?: string) => invokeTrustedHost<ThreadAppView>("mako:thread-app", cwd, target),
    startThreadApp: (cwd: string, target?: string) => invokeTrustedHost<AppActionOutcome>("mako:thread-app-start", cwd, target),
    stopThreadApp: (cwd: string) => invokeTrustedHost<void>("mako:thread-app-stop", cwd),
    restartThreadApp: (cwd: string, target?: string) => invokeTrustedHost<AppActionOutcome>("mako:thread-app-restart", cwd, target),
    checkThreadApp: (cwd: string, tier: "quick" | "full", target?: string, steps?: string[]) =>
      invokeTrustedHost<AppActionOutcome>("mako:thread-app-check", cwd, tier, target, steps),
    makeRoomForThreadApp: (cwd: string, target?: string) => invokeTrustedHost<AppActionOutcome>("mako:thread-app-make-room", cwd, target),
    takeTurnForThreadApp: (cwd: string, target?: string) => invokeTrustedHost<AppActionOutcome>("mako:thread-app-take-turn", cwd, target),
    threadAppOutput: (cwd: string, key: AppOutputKey, cursor?: AppOutputCursor) =>
      invokeTrustedHost<AppOutputChunk>("mako:thread-app-output", cwd, key, cursor),
    threadAppMarks: () => invokeTrustedHost<AppMark[]>("mako:thread-app-marks"),
    probeThreadApp: (cwd: string) => invokeTrustedHost<AppProbeView>("mako:thread-app-probe", cwd),
    threadAppRoom: () => invokeTrustedHost<RoomView>("mako:thread-app-room"),
    stopThreadApps: (apps: string[]) => invokeTrustedHost<void>("mako:thread-app-stop-apps", apps),
    projectAppSetup: (cwd: string) => invokeTrustedHost<ProjectAppSetup>("mako:project-app-setup", cwd),
    chatFolders: (paths: string[]) => invokeTrustedHost<ChatFolders>("mako:chat-folders", paths),
    removeWorktree: (path: string) => invokeTrustedHost<ThreadWorktrees>("mako:worktree-remove", path),
    wantWorktree: (cwd: string) => invokeTrustedHost<void>("mako:worktree-want", cwd),
    worktreeStartPoint: (cwd: string, fetch: boolean) => invokeTrustedHost<WorktreeStartPoint | null>("mako:worktree-start-point", cwd, fetch),
    worktreeBranches: (cwd: string) => invokeTrustedHost<WorktreeBranch[]>("mako:worktree-branches", cwd),
    worktreePulls: (cwd: string) => invokeTrustedHost<WorktreePull[] | null>("mako:worktree-pulls", cwd),
    worktreeSummaries: () => invokeTrustedHost<WorktreeSummary[]>("mako:worktree-summaries"),
    worktreeUpdate: (path: string) => invokeTrustedHost<WorktreeUpdate>("mako:worktree-update", path),
    worktreeRemoval: (path: string) => invokeTrustedHost<WorktreeRemoval>("mako:worktree-removal", path),
    skipWorktree: (conversationId: string) => invokeTrustedHost<void>("mako:worktree-skip", conversationId),
    worktreeAhead: (path: string) => invokeTrustedHost<number | null>("mako:worktree-ahead", path),
    worktreeInventory: () => invokeTrustedHost<WorktreeInventory>("mako:worktree-inventory"),
    worktreeReview: (path: string) => invokeTrustedHost<WorktreeReview>("mako:worktree-review", path),
    worktreeReviewDiffs: (path: string) => invokeTrustedHost<{ diffs: GitDiff[]; truncated: number }>("mako:worktree-review-diffs", path),
    mergeWorktree: (path: string) => invokeTrustedHost<{ branch: string; into: string }>("mako:worktree-merge", path),
    workspaceMoves: () => invokeTrustedHost<WorkspaceMoves>("mako:workspace-moves"),
    workspaceMoveHold: (target: WorkspaceMoveTarget) => invokeTrustedHost<WorkspaceMoveHold>("mako:workspace-move-hold", target),
    answerWorkspaceMove: (id: string, answer: WorkspaceMoveAnswer) => invokeTrustedHost<void>("mako:workspace-move-answer", id, answer),
    forgetWorkspaceMoves: (project: string) => invokeTrustedHost<void>("mako:workspace-move-forget", project),
    bringWithWorkspaceMove: (id: string, bring: boolean) => invokeTrustedHost<void>("mako:workspace-move-bring", id, bring),
    threadChanges: (thread: string) => invokeTrustedHost<ThreadChangeSummary | null>("mako:thread-changes", thread),
    changeUsage: () => invokeTrustedHost<ChangeUsage | null>("mako:change-usage"),
    resolveFileReferences: (source: FileReferenceSource, spellings: string[]) =>
      invokeTrustedHost<FileResolution[] | null>("mako:resolve-file-references", source, spellings),
    chooseFileReference: (source: FileReferenceSource, spelling: string, path: string) =>
      invokeTrustedHost<void>("mako:choose-file-reference", source, spelling, path),
    lostVersions: (target: { thread: string } | { path: string }) => invokeTrustedHost<LostVersion[]>("mako:lost-versions", target),
    restoreVersion: (root: string, entry: number) => invokeTrustedHost<{ path: string }>("mako:restore-version", root, entry),
    workspaceMoveOutcome: (conversationId: string) => invokeTrustedHost<MoveOutcome | null>("mako:workspace-move-outcome", conversationId),
    bringStayedChanges: (conversationId: string) => invokeTrustedHost<{ outcome: MoveOutcome; left: string[] }>("mako:workspace-move-bring-stayed", conversationId),
    putBackMovedFiles: (conversationId: string, paths: string[]) => invokeTrustedHost<{ outcome: MoveOutcome; left: string[] }>("mako:workspace-move-put-back", conversationId, paths),
    planBuilds: () => invokeTrustedHost<PlanBuilds>("mako:plan-builds"),
    recordPlanBuild: (planId: string, build: PlanBuild) => invokeTrustedHost<void>("mako:plan-build-record", planId, build),
    claimPlanBuild: (claimId: string, planId: string, target: PlanBuildTarget, seen: number | null) =>
      invokeTrustedHost<PlanBuildClaim>("mako:plan-build-claim", claimId, planId, target, seen),
    releasePlanBuild: (claimId: string) => invokeTrustedHost<void>("mako:plan-build-release", claimId),
    threadCreateSession: (operationId: string, thread: string) =>
      invokeTrustedHost<ThreadPlacement>("mako:thread-create-session", operationId, thread),
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
    transcriptDocument: (source: TranscriptSource, depth: TranscriptDepth) =>
      invokeTrustedHost<TranscriptDocument>("mako:transcript-document", source, depth),
    readThreadFile: (threadPath: string, filePath: string, purpose?: FileReadPurpose) =>
      invokeTrustedHost<FileContents>("mako:thread-file", threadPath, filePath, purpose),
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
    /** The whole entry a viewer page trimmed (`outputLength`, `rawOmitted`), by its id. */
    threadEntry: (path: string, id: string) =>
      invokeTrustedHost<Entry | null>("mako:thread-entry", path, id),
    /** The bytes a saved entry was read from, by its id: the harness's record, or Mako's copy of it. */
    threadOriginal: (path: string, id: string) =>
      invokeTrustedHost<EntryOriginal | null>("mako:thread-original", path, id),
    threadContexts,
    /** A session's child agents: each one's link, where its transcript is, and how much of it this Mac holds. */
    threadChildren: (path: string) =>
      invokeTrustedHost<ChildTranscripts | null>("mako:thread-children", path),
    /** Live entries of one child's transcript, beside the viewer's follow, as `thread-entries` under its path. */
    followChildThread: (path: string, fromByte: number) =>
      invokeTrustedHost<void>("mako:thread-child-follow", path, fromByte),
    unfollowChildThread: () => invokeTrustedHost<void>("mako:thread-child-unfollow"),
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
    /** Records Mako couldn't read, by harness, version, kind and reason, saved and live (`UnreadReport`). */
    unreadRecords: () => invokeTrustedHost<UnreadReport>("mako:unread-records"),
    /** Each shared store's format for this build: which this one only reads because a newer Mako changed it (`StoreFormats`). */
    storeFormats: () => invokeTrustedHost<StoreFormats>("mako:store-formats"),
    /** The stream lines a live record came in, as Show original reads them. */
    streamOriginal: (frame: RecordRef) => invokeTrustedHost<EntryOriginal>("mako:stream-original", frame),
    /** What a reply to a session Mako keeps the records of will do: restore it natively, or wait for an update (`RestorePlan`). */
    restorePlan: (path: string) =>
      invokeTrustedHost<RestorePlan>("mako:thread-restore-plan", path),
    rememberThreadMode: (path: string, modeId: string) =>
      invokeTrustedHost<ThreadRef | null>("mako:thread-remember-mode", path, modeId),
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
    /** How the person set conversations to behave: whether Mako continues the turns its own restart cut short. */
    conversationSettings: () => invokeTrustedHost<ConversationSettings>("mako:conversation-settings"),
    setConversationSettings: (settings: ConversationSettings) => invokeTrustedHost<ConversationSettings>("mako:conversation-settings-set", settings),
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
      invokeTrustedHost<LiveAction>(input.kind === "steer-queued" ? "mako:live-steer-queued" : "mako:live-action", id, input),
    liveAcknowledgeAction: (id: string, actionId: string) =>
      invokeTrustedHost<void>("mako:live-action-acknowledge", id, actionId),
    liveTurnChanges: (id: string, requestId: string) =>
      invokeTrustedHost<{ root: string; files: GitFile[] }>("mako:live-turn-changes", id, requestId),
    liveTurnDiff: (id: string, requestId: string, path: string) =>
      invokeTrustedHost<GitDiff>("mako:live-turn-diff", id, requestId, path),
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
    liveSignInReadiness: (id: string) =>
      invokeTrustedHost<SignInReadiness | null>("mako:live-sign-in-readiness", id),
    liveSignInResume: (id: string, anyway: boolean) =>
      invokeTrustedHost<SignInResume>("mako:live-sign-in-resume", id, anyway),
    liveEarlier: (id: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-earlier", id),
    liveBind: (id: string, path: string) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-bind", id, path),
    readLiveFile: (id: string, path: string, purpose?: FileReadPurpose) =>
      invokeTrustedHost<FileContents>("mako:read-live-file", id, path, purpose),
    liveAttach: (path: string) =>
      invokeTrustedHost<LiveSnapshot | null>("mako:live-attach", path),
    liveSnapshot: (id: string) =>
      invokeTrustedHost<LiveSnapshot | null>("mako:live-snapshot", id),
    liveContextBreakdown: (id: string) =>
      invokeTrustedHost<ContextBreakdown | null>("mako:live-context-breakdown", id),
    liveRead: (id: string, input: LiveHistoryRead) =>
      invokeTrustedHost<LiveHistoryChunk>("mako:live-read", id, input),
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
    liveStopAgent: (id: string, nativeId: string) => invokeTrustedHost<boolean>("mako:live-stop-agent", id, nativeId),
    liveGoal: (id: string, command: GoalCommand, tuning?: SessionSettings) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-goal", id, command, tuning),
    liveSideQuestion: (id: string, command: SideQuestionCommand) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-side-question", id, command),
    liveReview: (id: string, target: ReviewTarget, tuning?: SessionSettings) =>
      invokeTrustedHost<LiveSnapshot>("mako:live-review", id, target, tuning),
    liveClose: (id: string) => invokeTrustedHost<void>("mako:live-close", id),
    /** The user started writing here: wake it now so its restart overlaps the typing. */
    livePrewarm: (id: string) => invokeTrustedHost<"waking" | "kept-warm" | "unchanged">("mako:live-prewarm", id),
    /** The user started writing a new conversation in `cwd`: prepare what its launch reads. */
    launchPrewarm: (cwd: string) => invokeTrustedHost<void>("mako:launch-prewarm", cwd),
    /**
     * The user is writing a new cloud conversation's first message in `cwd`, for `composingMs` so far: its Thread is
     * made ahead, its machine starting and cloning meanwhile, and once it's ready, `launch`'s harness started there;
     * asked again as they go on.
     */
    cloudPrepare: (cwd: string, composingMs: number, launch?: CloudPrepareLaunch) =>
      invokeTrustedHost<CloudPrepareOutcome>("mako:cloud-prepare", cwd, composingMs, launch),
    /**
     * Moves the Thread of `conversationId` to the cloud under `move`, a fresh id; asked again with the same id it
     * answers how that move went. Its steps arrive as `thread-move-step` events.
     */
    threadMove: (conversationId: string, move: string, handOff?: ThreadHandOff) => invokeTrustedHost<ThreadMoveOutcome>("mako:thread-move", conversationId, move, handOff),
    /** This Mac's Threads whose agents are working, each with why it couldn't go to the cloud now, if it couldn't. */
    handOffCandidates: () => invokeTrustedHost<HandOffCandidate[]>("mako:handoff-candidates"),
    /** Hands every Thread at work to the cloud as one handoff named `handOff`; each move's steps arrive as `thread-move-step`. */
    handOff: (handOff: string, why: "quit") => invokeTrustedHost<HandOffResult[]>("mako:handoff", handOff, why),
    /** Whether agents at work go to the cloud as this Mac sleeps, and whether it can. */
    handOffSettings: () => invokeTrustedHost<HandOffSettings>("mako:handoff-settings"),
    setHandOffOnSleep: (onSleep: boolean) => invokeTrustedHost<HandOffSettings>("mako:handoff-settings-set", onSleep),
    /** Brings the Thread of a conversation back from the cloud under `move`; its steps arrive as `thread-return-step` events. */
    threadReturn: (conversationId: string, move: string) => invokeTrustedHost<ThreadReturnOutcome>("mako:thread-return", conversationId, move),
    /** The account has the cloud: this Mac's recent project folders, newest first, offered once for project bases. */
    cloudOfferProjects: (folders: string[]) => invokeTrustedHost<CloudProjectsOffer>("mako:cloud-offer-projects", folders),

    /* Provider transports with their own sign-in. */
    providerConnections: (refresh?: boolean) =>
      invokeTrustedHost<ProviderConnection[]>("mako:provider-connections", refresh),
    providerConnectionAction: (provider: string, action: ProviderConnectionAction) =>
      invokeTrustedHost<ProviderConnection>("mako:provider-connection-action", provider, action),

    /* This Mac's Mako account; the host pushes `cloud-account` events as it changes. */
    cloudAccount: () => invokeTrustedHost<CloudAccount>("mako:cloud-account"),
    cloudSignIn: () => invokeTrustedHost<CloudAccount>("mako:cloud-sign-in"),
    cloudSignInCancel: () => invokeTrustedHost<CloudAccount>("mako:cloud-sign-in-cancel"),
    cloudDevices: () => invokeTrustedHost<{ devices: CloudDevice[]; current: string }>("mako:cloud-devices"),
    cloudDeviceRemove: (id: string) => invokeTrustedHost<CloudAccount>("mako:cloud-device-remove", id),
    /* The browsers signed in to the account on the cloud's pages, and signing them out. */
    cloudBrowserSessions: () => invokeTrustedHost<CloudBrowserSession[]>("mako:cloud-browser-sessions"),
    cloudBrowserSessionEnd: (id: string) => invokeTrustedHost<void>("mako:cloud-browser-session-end", id),
    cloudBrowserSessionsEnd: () => invokeTrustedHost<number>("mako:cloud-browser-sessions-end"),
    cloudSignOut: () => invokeTrustedHost<CloudAccount>("mako:cloud-sign-out"),
    /* Whether this Mac's harness sign-ins are shared with the account's cloud machines; `cloud-sign-ins` events follow it. */
    cloudSignIns: () => invokeTrustedHost<CloudSignInsState>("mako:cloud-sign-ins"),
    cloudSignInsShare: (sharing: boolean) => invokeTrustedHost<CloudSignInsState>("mako:cloud-sign-ins-share", sharing),
    /** Starts the harness's own sign-in for Mako Cloud to keep; wait, paste and cancel as an account sign-in. */

    /* What this install reports to Mako, and what the person allows. */
    telemetry: () => invokeTrustedHost<TelemetryState>("mako:telemetry"),
    chooseTelemetry: (choice: Partial<TelemetryChoice>) => invokeTrustedHost<TelemetryState>("mako:telemetry-choose", choice),

    /* Harness accounts: several logins per CLI. */
    accounts: () => invokeTrustedHost<AccountCatalog>("mako:accounts"),
    startAccountLogin: (harness: AccountHarness, renew?: string) =>
      invokeTrustedHost<AccountLogin>("mako:account-login-start", harness, renew),
    waitAccountLogin: (id: string) =>
      invokeTrustedHost<AccountLoginResult>("mako:account-login-wait", id),
    submitAccountLoginCode: (id: string, code: string) =>
      invokeTrustedHost<void>("mako:account-login-code", id, code),
    cancelAccountLogin: (id: string) =>
      invokeTrustedHost<void>("mako:account-login-cancel", id),
    captureAccount: (harness: AccountHarness, name: string) =>
      invokeTrustedHost<void>("mako:account-capture", harness, name),
    selectAccount: (harness: AccountHarness, name: string | null) =>
      invokeTrustedHost<void>("mako:account-select", harness, name),
    removeAccount: (harness: AccountHarness, name: string) =>
      invokeTrustedHost<AccountRemovalOutcome>("mako:account-remove", harness, name),
    accountRemovalPlan: (harness: AccountHarness, name: string) =>
      invokeTrustedHost<AccountRemovalPlan>("mako:account-removal-plan", harness, name),
    keepAccount: (harness: AccountHarness, name: string) =>
      invokeTrustedHost<boolean>("mako:account-keep", harness, name),
    accountUsage: (harness: AccountProvider, name: string) =>
      invokeTrustedHost<AccountUsage>("mako:account-usage", harness, name),
    useResetCredit: (harness: AccountProvider, name: string, attempt: string) =>
      invokeTrustedHost<ResetCreditOutcome>("mako:account-reset", harness, name, attempt),

    /* The Agents settings section. */
    harnessProfiles: (force?: boolean) =>
      invokeTrustedHost<HarnessProfile[]>("mako:harness-profiles", force),
    harnessAvailability: () =>
      invokeTrustedHost<Record<string, boolean>>("mako:harness-availability"),
    harnessUpdates: (refresh?: boolean) =>
      invokeTrustedHost<Record<string, HarnessUpdateInfo>>("mako:harness-updates", refresh),
    runHarnessUpdate: (provider: string) =>
      invokeTrustedHost<HarnessUpdateInfo>("mako:harness-update", provider),
    runHarnessInstall: (provider: string) =>
      invokeTrustedHost<HarnessUpdateInfo>("mako:harness-install", provider),
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
      invokeTrustedHost<import("@mako/control-runtime/contracts").AppshotWindow[]>(
        "mako:appshot-windows"
      ),
    captureAppshot: (target: import("@mako/control-runtime/contracts").AppshotTarget) =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").Appshot>(
        "mako:appshot-capture",
        target
      ),
    /** The window the person is in, never one of `exclude`'s (Mako's own). */
    appshotFrontWindow: (request: import("@mako/control-runtime/contracts").AppshotFrontRequest) =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").AppshotWindow>("mako:appshot-front", request),
    /** Hold the Appshot shortcut in this client, or let it go (`null`); answers whether it holds it. */
    setAppshotShortcut: (shortcut: import("./appshot-shortcut.js").AppshotShortcut | null) =>
      invokeTrustedHost<import("./appshot-shortcut.js").AppshotShortcutState>("mako:appshot-shortcut", shortcut),
    /** Show a capture's flash and card outside the desk, for a person whose Mako is behind another app. */
    appshotFeedback: (feedback: import("./appshot-shortcut.js").AppshotFeedback) =>
      invokeTrustedHost<void>("mako:appshot-feedback", feedback),
    controlPreview: (
      conversationId: string,
      watching: boolean,
      watcher = "panel",
      box?: { width: number; height: number }
    ) =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").ControlPreview | null>(
        "mako:control-preview",
        conversationId,
        watching,
        watcher,
        ...(box ? [box] : [])
      ),
    /** A viewer's next packets of a cloud conversation's preview video, as a `ControlVideoBatch`'s bytes; waits up to a second for one. */
    controlVideo: (conversationId: string, viewer: string, box?: { width: number; height: number }) =>
      invokeTrustedHost<Uint8Array<ArrayBuffer>>("mako:control-video", conversationId, viewer, ...(box ? [box] : [])),
    elementPickTargets: () =>
      invokeTrustedHost<import("./element-picks.js").ElementPickTargets>("mako:element-pick-targets"),
    startElementPick: (request: import("./element-picks.js").ElementPickRequest) =>
      invokeTrustedHost<import("./element-picks.js").ElementPickState>("mako:element-pick-start", request),
    waitElementPick: (id: string, waitMs: number) =>
      invokeTrustedHost<import("./element-picks.js").ElementPickState>("mako:element-pick-wait", id, waitMs),
    cancelElementPick: (id: string) =>
      invokeTrustedHost<import("./element-picks.js").ElementPickState | null>("mako:element-pick-cancel", id),
    /** Bring the window this desk is in to the front, when the person comes back to it from another app. */
    surfaceWindow: () => invokeTrustedHost<void>("mako:surface-window"),
    computerPermissions: () =>
      invokeTrustedHost<MakoComputerPermissions>("mako:computer-permissions"),
    prepareBrowserExtension: () =>
      invokeTrustedHost<
        import("./browser-extension.js").BrowserExtensionSetup
      >("mako:browser-extension-setup"),
    browserControlStatus: () =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").BrowserControlStatus[]>(
        "mako:browser-control-status"
      ),
    preferBrowser: (browser: string | null) =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").BrowserControlStatus[]>(
        "mako:browser-control-prefer",
        browser
      ),
    connectBrowser: (browser: string) =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").BrowserControlStatus[]>(
        "mako:browser-control-connect",
        browser
      ),
    disconnectBrowser: (browser: string) =>
      invokeTrustedHost<import("@mako/control-runtime/contracts").BrowserControlStatus[]>(
        "mako:browser-control-disconnect",
        browser
      ),
    requestComputerPermissions: () =>
      invokeTrustedHost<MakoComputerPermissions>(
        "mako:computer-permissions-request"
      ),
    computerDriver: () =>
      invokeTrustedHost<import("./mcp-skills-integrations.js").CuaDriverStatus>(
        "mako:computer-driver"
      ),
    updateComputerDriver: () =>
      invokeTrustedHost<import("./mcp-skills-integrations.js").CuaDriverStatus>(
        "mako:computer-driver-update"
      ),

    /* MCP discovery is read-only; sync is always an explicit settings action. */
    integrations: () =>
      invokeTrustedHost<IntegrationCatalogSnapshot>("mako:integrations"),
    discoverMcp: () =>
      invokeTrustedHost<McpRegistrySnapshot>("mako:mcp-discover"),
    nativeAuthoringCatalog: () => invokeTrustedHost<AuthoringCatalog>("mako:native-authoring-catalog"),
    nativeAuthoringView: (target: AuthoringTarget) => invokeTrustedHost<AuthoringView>("mako:native-authoring-view", target),
    previewNativeAuthoring: (target: AuthoringTarget, change: AuthoringChange) => invokeTrustedHost<AuthoringPlan>("mako:native-authoring-preview", target, change),
    applyNativeAuthoring: (target: AuthoringTarget, change: AuthoringChange, revision: string | null) =>
      invokeTrustedHost<AuthoringApplied>("mako:native-authoring-apply", target, change, revision),
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
    /** `conversation`: the live conversation whose folder this is; one on a cloud machine is read there. */
    setCwd: (cwd: string, conversation?: string) =>
      invokeTrustedHost<TabSnapshot>("mako:set-cwd", cwd, conversation),
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
    /** Puts the files back as HEAD has them; what they held is kept in Git's stash. */
    gitDiscard: (paths: string[]) =>
      invokeTrustedHost<{ stash: string }>("mako:git-discard", paths),
    gitRestoreDiscarded: (stash: string) =>
      invokeTrustedHost<void>("mako:git-restore-discarded", stash),
    gitChangedSince: (ref: string) =>
      invokeTrustedHost<{ base: string; files: GitFile[] } | null>("mako:git-changed-since", ref),
    gitDefaultBranch: () =>
      invokeTrustedHost<string | null>("mako:git-default-branch"),
    gitSinceDiff: (base: string, path: string) =>
      invokeTrustedHost<GitDiff>("mako:git-since-diff", base, path),
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
    /** What does a small task: `auto`, `off` for titles, or a model `utilityModelSettings` lists. */
    chooseUtilityModel: (task: UtilityTask, choice: string) =>
      invokeTrustedHost<void>("mako:utility-choice", task, choice),
    /** The order Mako tries harnesses in for setup and commit messages; empty goes back to Mako's. */
    saveHarnessOrder: (order: string[]) =>
      invokeTrustedHost<void>("mako:harness-order", order),
    /** The harness order the person saved; empty until they reorder. */
    savedHarnessOrder: () =>
      invokeTrustedHost<string[]>("mako:harness-order-saved"),
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

    /* GitHub, via the `gh` CLI. See packages/host/src/git/github.ts for why. */
    githubStatus: () => invokeTrustedHost<GitHubStatus>("mako:github-status"),
    pullRequest: () =>
      invokeTrustedHost<PullRequest | null>("mako:pull-request"),
    pullRequests: (limit?: number) =>
      invokeTrustedHost<PullRequest[]>("mako:pull-requests", limit),
    /** Any pull request of the workspace's GitHub repository by number, title, head branch or author. */
    pullRequestSearch: (request: PullRequestSearchRequest) =>
      invokeTrustedHost<PullRequestSearchResult>("mako:pull-request-search", request),
    pullBranches: () => invokeTrustedHost<string[]>("mako:pull-branches"),
    createPull: (options: {
      title: string
      body: string
      base?: string
      draft?: boolean
    }) => invokeTrustedHost<PullRequest | null>("mako:create-pull", options),
    mergePull: (strategy: MergeMethod) =>
      invokeTrustedHost<PullRequest | null>("mako:merge-pull", strategy),
    /** How many failed GitHub Actions runs were re-run. */
    rerunChecks: () => invokeTrustedHost<number>("mako:rerun-checks"),
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

    /* Crash reports. Local only — see base/crash.ts. */
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
