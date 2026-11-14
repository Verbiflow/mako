import { noteCarried } from "@mako/sessions/record-carried"
import type { Foreground } from "../base/foreground.js"
import type { NativeRoutingReading } from "../contracts/native-routing.js"
import { routeAccepted } from "../contracts/model-routes.js"
import type { HostWork } from "../base/event-loop.js"
import { makoRecords } from "@mako/sessions/record-streams"
import type { Git } from "@mako/git"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Admission } from "../base/admission.js"
import { readPull } from "../git/index.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { HostEnvironment } from "../base/host-environment.js"
import type { HostMethods } from "../transport/index.js"
import type { MethodTable } from "../base/methods.js"
import { hostWarn } from "../base/host-log.js"
import { LiveConversations } from "./live-conversations.js"
import type { Dependencies as LiveDependencies } from "./live-runtime.js"
import { NativeRequests } from "./native-requests.js"
import { SharedConversations, type ConversationRoutingResult } from "./shared-conversations.js"
import { LiveHistoryReader } from "./live-history-reader.js"
import { LiveHistoryReadSchema, type LiveHistoryRead } from "../contracts/live-history.js"
import { createContinuationPlanner, type ContinuationPlanner } from "./continuation.js"
import { WorkspaceSnapshots, type ConversationFiles, type Workspaces, type WorkspaceMovers } from "../workspaces/index.js"
import { harnessLabel, nativeRoutingReadings, resumes, type FinDefaultsStore, type HarnessProfiles, type Harnesses } from "../harnesses/index.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"
import { decodeRuntimeValue, EncodedAnswer } from "../contracts/runtime-value.js"
import { SessionHeldError, discardChatFolder, newChatFolder, standsForNoProject, type Threads, type ThreadLifecycle } from "../threads/index.js"
import { NativeRuns } from "./native-runs.js"
import { declareAgentMethods } from "./agent-tools.js"
import { placeLink } from "./place-link.js"
import { PlacedCheckouts } from "./placed-checkouts.js"
import type { AgentRefused, AgentsDirectInput, AgentsRespondInput, AgentsRedirectInput } from "../contracts/agents.js"
import { Agents } from "./agents.js"
import { continueOn as continuing, type ContinueOn } from "./continue-on.js"
import { MacCapacity } from "./mac-capacity.js"
import type { HostJobs } from "../base/host-jobs.js"
import { resumingUnder } from "./live-ledger.js"
import { restorePlan, restoringResume } from "./kept-resume.js"
import type { RestorePlan } from "../contracts/restore-plan.js"
import { FIN_CEILING } from "../contracts/fin-tuning.js"
import type { FinCapacity } from "./fin-capacity-host.js"
import { TransferInputSchema } from "../contracts/conversation-control.js"
import type { TurnUndoScope } from "../contracts/turn-review.js"
import type { CloudAccount, HostTelemetry } from "../usage/index.js"
import type { QueuedPromptEdit } from "../contracts/live-queue.js"
import type { RewindInput } from "../contracts/workspace-snapshots.js"
import type { LiveActionInput } from "../contracts/live-actions.js"
import { GoalCommandSchema, type GoalCommand } from "../contracts/live-goals.js"
import { SideQuestionCommandSchema, type SideQuestionCommand } from "../contracts/live-side-questions.js"
import { ReviewTargetSchema, type ReviewTarget } from "../contracts/live-reviews.js"
import type { ForkInput, TransferInput } from "../contracts/conversation-control.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { LivePermissionResponse, PromptAttachment } from "../contracts/providers-acp.js"
import type { CloudPrepareLaunch, CloudPrepareOutcome, CloudProjectsOffer, HandOffCandidate, HandOffResult, HandOffSettings, ThreadContinueOffer, ThreadContinueOutcome, ThreadHandOff, ThreadMoveOutcome, ThreadReturnOptions, ThreadReturnOutcome } from "../contracts/cloud-threads.js"
import type { ContinueReading } from "../contracts/cloud-continues.js"
import { arriveMove, MoveArrivalInputSchema, MoveReadyInputSchema, MoveStageInputSchema, readyForMove, stageMove, type MoveArrivalDeps, type MoveArrivalWire, type MoveReadyInput, type MoveStageInput } from "./move-arrival.js"
import { departMove, followMove, MoveDepartureInputSchema, MoveFollowInputSchema, MoveStayInputSchema, stayMove, type MoveDepartureDeps, type MoveDepartureInput, type MoveFollowInput, type MoveStayInput } from "./move-departure.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { FileReadPurpose } from "../contracts/git-workspace-search.js"
import type { FileFoldersOptions, FileGrepOptions } from "../contracts/file-index.js"
import type { NativeRequestInput } from "../contracts/native-requests.js"
import { declareTranscriptMethods } from "./transcript-methods.js"
import type { ConversationSettings } from "../contracts/turn-continuation.js"
import type { KeepAwakeSettings, KeepAwakeState } from "../contracts/keep-awake.js"
import type { ThreadHarnessCheck } from "../contracts/cloud-harnesses.js"
import { z } from "zod"
import { archivedByKeys, liveArchiveKeys } from "../contracts/thread-lifecycle.js"
import { harnessOrder } from "../contracts/harness-defaults.js"

export { CloudConversations, folderRepository } from "./cloud-conversations.js"
export { FinCapacity } from "./fin-capacity-host.js"
export { FinCostModel } from "./fin-cost.js"
export { FinCostSampler } from "./fin-cost-sampler.js"
export { MacCapacity, finSlots } from "./mac-capacity.js"
export { callThreadOf } from "./live-runtime.js"
export { makoNote } from "./mako-note.js"
export { OwnerFiles } from "./owner-files.js"
export { ListedRepositories } from "./listed-repositories.js"
export { CloudMoves, namedUuid } from "./cloud-moves.js"
export { CloudContinues } from "./cloud-continues.js"
export { CloudHandOffs, machineLeaving, SHUTDOWN_HOLD_MS, workingThreads } from "./cloud-handoffs.js"
export { conversationShown, finAsking, ownedSessions, sessionOrderIn, REPORT_WORK, SessionPublisher, SessionReporter, type FinAsking, type ReportSources, type SessionLink } from "./session-report.js"
export { MovesUnderWay } from "./moves-under-way.js"
export { CloudTurnOnFollower, declareTurnOnMethods, TURN_ON_POLL_MS, turnOnOf, type TurnOnReading, type TurnOnSources } from "./cloud-turn-on.js"
export { SessionUploads, declareSyncMethods, readBackfill, syncStatusOf, uploadScope, type UploadSources } from "./session-uploads.js"
export { SYNC_WINDOW_MS, syncTier, windowStart } from "./sync-window.js"
export { CloudReadiness, READY_EVERY_MS } from "./cloud-readiness.js"
export { AwayNotes } from "./away-notes.js"
export { SleepHandOff, sleepWatchHelper } from "./sleep-handoff.js"
export { KeepAwake, recountsWork } from "./keep-awake.js"
export { ownerHold } from "./owner-check.js"
export { CloudReturns } from "./cloud-returns.js"
export { CloudFollow } from "./cloud-follow.js"
export { CloudWorktrees } from "./cloud-worktrees.js"
export { CloudArchives } from "./cloud-archives.js"
export { HarnessCheck } from "./harness-check.js"
export { installedReading } from "./kept-resume.js"
export { openMachineTracker, type MachineTracker } from "./machine-tracker.js"
export type { MoveArrivalDeps } from "./move-arrival.js"
export { declareCloudControlPreviewMethods } from "./cloud-control-previews.js"
export { threadHistoryTools, registerThreadHistoryTools, type ThreadHistoryTools } from "./thread-history.js"
export { Agents } from "./agents.js"
export { AgentAnswerSchema, declareAgentMethods, registerAgentTools } from "./agent-tools.js"
export { AgentAskGate, declareAgentAskMethods } from "./agent-ask-gate.js"
export { ThreadActTool, declareThreadActMethods } from "./thread-act-tool.js"
export { SettingsTool, declareSettingsMethods } from "./settings-tool.js"
export { HarnessTool, declareHarnessToolMethods } from "./harness-tool.js"
export { AutomationTool, declareAutomationToolMethods } from "./automation-tool.js"
export { ThreadMoveTool, ThreadMoveAnswerSchema, declareThreadMoveMethods, registerThreadTools, threadToolText, type ThreadToolDoor } from "./thread-move-tool.js"

/** Live turns and their journals, headless native runs, and who owns each conversation. */
export interface Conversations {
  live: LiveConversations
  /** Headless native runs, one writer per native session. */
  runs: NativeRuns
  /** This Thread continues on that harness: the one way there, whoever asks. */
  continueOn: ContinueOn
  /** The Threads each Thread leads, and the runs they follow; none where the Thread store didn't open. */
  agents?: Agents
  native: NativeRequests
  continuation: ContinuationPlanner<unknown>
  /** Replies with their history as pages, for clients that page it. */
  history: LiveHistoryReader
  /** A call about a conversation another host owns is answered there. */
  route(channel: string, args: unknown[]): Promise<ConversationRoutingResult>
  /** A harness's id as people read it, as the registry labels it. */
  harnessLabel(harness: string): string
  /** Where each harness stands on an Apex's native spawns, for Diagnostics. */
  nativeRouting(): Promise<NativeRoutingReading[]>
  /**
   * What a reply to the session at `path` will do, for a session its
   * harness deleted that Mako keeps the records of: restore and resume
   * natively, or wait for the update the restore gate asks for. Reads, never
   * writes; the restore applies the same rule (`restoreGate`).
   */
  restorePlan(path: string): Promise<RestorePlan>
  /** Every host's conversations, once the socket can carry their events. */
  share(send: ConstructorParameters<typeof SharedConversations>[1]): void
  /** Stops the conversations; the native requests and the harnesses' own sessions stop after them. */
  stop(): Promise<void>
}

export interface ConversationsDeps {
  environment: HostEnvironment
  /** The host has begun to stop: what it takes up as it starts ends at its next step, left for the next host. */
  stopping?(): boolean
  git: Git
  threads: Threads
  harnesses: Harnesses
  workspaces: Workspaces
  telemetry: HostTelemetry
  /** This host's start on its data root, which its epoch carries (`takeHostStart`). */
  start?: import("../base/host-start.js").HostStart
  /** A new conversation was written and placed, before its harness starts (`Dependencies.opened`). */
  opened?(conversationId: string): void
  /** Since when a conversation of this Mac's waits to hear its account before it runs a turn (`Dependencies.ownerCheck`). */
  ownerCheck?: LiveDependencies["ownerCheck"]
  emit(event: HostEvent): void
  /** What each agent can call: Mako's tools and Local Control. */
  tools: NonNullable<LiveDependencies["tools"]>
  /** The MCP servers the harnesses have for `cwd`, which a launch hands its agent. */
  mcpSnapshot: NonNullable<LiveDependencies["mcpSnapshot"]>
  revokeTools: NonNullable<LiveDependencies["revokeTools"]>
  rewindWriters?: LiveDependencies["rewindWriters"]
  suspendTools?: LiveDependencies["suspendTools"]
  controlInstructions: NonNullable<LiveDependencies["controlInstructions"]>
  /** A waiting move may go ahead; the moves are made after the conversations. */
  settled(conversationId: string): void
  /** A turn ended in `cwd`, failed or stopped included. */
  turnEnded?(conversationId: string, cwd: string): void
  /** A conversation's work moved (running, waiting, finishing, none), with or without a batch (`LiveConversations.noteWork`). */
  workMoved?(conversationId: string): void
  /** Whether a conversation's agent asked to move into its worktree and the move hasn't happened yet. */
  movePending?(conversationId: string): boolean
  /** Whether the person archived a conversation's Thread, which ends a Fin's work for good. */
  archived?(conversationId: string): boolean
  /** The attribution journal, for counting each turn's changes; undefined until it opens. */
  turnLedger?: LiveDependencies["turnLedger"]
  /** The attribution journal, for reviewing and undoing a turn; undefined until it opens. */
  turnReview?: LiveDependencies["turnReview"]
  /** Whether the host takes new work. */
  admission: Admission
  /** Held while a harness starts, so routine work waits for it. */
  foreground: Foreground
  /** What the host is doing, named (`base/event-loop.ts`): who reads a conversation in is counted to it. */
  work: HostWork
  /** Mako's streams of the live transports (`native-stream.ts`), which an entry's original reads; none on a host that keeps none. */
  streams?: string
  /** A cloud machine's host: nobody is at it to sign a harness in. */
  unattended?: boolean
  jobs: HostJobs
  /** Calls this host's own methods, as a client would: a child starts through `mako:live-start`. */
  invoke: HostMethods["invoke"]
  /** The person's model choices for Fins (Settings › Fins) and what they use on each harness. */
  finDefaults?: Pick<FinDefaultsStore, "reading">
  /** This machine's build slots now, for a heavy suite's note (`build-slots-full`). */
  builds?(): { slots: number; holders: string[] }
  /** This device's Fins at once (`FinCapacity`); without it, `FIN_LIMIT`. */
  finCapacity?: Pick<FinCapacity, "atOnce" | "observe" | "subscribe">
  /** Operations this device runs for another place's Threads (`LentHere`): each takes a Fin's place here. */
  lent?: () => number
  /**
   * The Mako account this host is signed in to, through which it reaches the person's other devices: with it a Fin can
   * be placed on one, and one placed here reports to its Apex's device. Without it Fins start here only.
   */
  account?(): Pick<CloudAccount, "deviceId" | "devices" | "session"> | undefined
}

export async function openConversations(deps: ConversationsDeps): Promise<Conversations> {
  const { environment, threads, harnesses, workspaces, emit } = deps
  const { catalog, memory } = threads
  const { host } = harnesses
  const dataRoot = environment.dataRoot
  // `live` is made below; the reader asks it only once a read arrives.
  const history = new LiveHistoryReader(catalog.page, catalog.entry, deps.streams === undefined ? undefined : { record: catalog.original, streams: deps.streams },
    (id) => live.held(id))
  // Every resume, from the rail, a reconnect or a wake, first puts a session its harness deleted back from Mako's records.
  const restoring = restoringResume({
    assess: (binding) => harnesses.assessResume(binding),
    ref: (path) => catalog.ref(path),
    heldElsewhere: (provider, nativeId) => memory?.heldBy(provider, nativeId)?.hostLabel ?? null,
    installed: (harness) => harnesses.updates.restoreRuntime(harness),
    restore: (path, installed) => catalog.restoreKept(path, installed),
    writers: (path) => catalog.recordWriters(path),
    label: (harness) => harnessLabel(host, harness),
  })
  const assessResume = resumingUnder(memory ?? undefined, restoring)
  let agents: Agents | undefined
  const live = new LiveConversations({
    agents: () => agents,
    heldModels: (harness) => harnesses.profiles.held(harness)?.models,
    ...(deps.stopping && { stopping: deps.stopping }),
    ...(deps.builds && { builds: deps.builds }),
    unattended: deps.unattended,
    foreground: deps.foreground,
    work: deps.work,
    turns: deps.telemetry.turns,
    opened: deps.opened,
    ownerCheck: deps.ownerCheck,
    memory: memory ?? undefined,
    ...(deps.start && { start: deps.start }),
    threads: threads.store ?? undefined,
    mcpSnapshot: deps.mcpSnapshot,
    workspaceSnapshots: (() => {
      const snapshots = new WorkspaceSnapshots(deps.git, join(dataRoot, "workspace-snapshots"))
      // A turn whose workspace nothing changed in since the last checkpoint goes to its agent on that checkpoint.
      snapshots.followHistory(workspaces.fileHistory)
      return snapshots
    })(),
    rewindWriters: deps.rewindWriters,
    checkpoint: (path, provider) => {
      const sourceProvider = provider ?? catalog.ref(path)?.harness
      const driver = sourceProvider ? host.liveDrivers.get(sourceProvider) : undefined
      return driver?.resume.kind === "native" ? driver.resume.checkpoint(path) : Promise.resolve(undefined)
    },
    nativePath: (session) => catalog.nativePath(session),
    accountEnv: (binding) => host.accounts.bindingEnv(binding),
    signInState: (harness, account) => host.accounts.signInState(harness, account),
    signInProof: (harness, account) => host.accounts.signInProof(harness, account),
    signInSequence: harness => host.accounts.signInSequence(harness),
    signInEvents: listener => host.accounts.onSignedIn(listener),
    signInAllowed: id => {
      const summary = live.listed().find(summary => summary.session.id === id)
      const placed = threads.store?.journalPlacement(id)
      const edge = placed && threads.store?.edges().of(placed.thread)
      return edge?.closedAt === undefined && summary !== undefined && !archivedByKeys(liveArchiveKeys(summary), new Set(threads.archives.snapshot().keys), catalog.ref(summary.session.nativePath ?? ""))
    },
    children: catalog.childSource,
    harnessLabel: (harness) => harnessLabel(host, harness),
    resumeVerdict: assessResume,
    projectFolderOfRemoved: (folder) => threads.origins.projectFolderOfRemoved(folder),
    settled: (id) => {
      deps.settled(id)
      agents?.moved(id)
    },
    turnEnded: (id, cwd) => deps.turnEnded?.(id, cwd),
    workMoved: (id) => deps.workMoved?.(id),
    turnLedger: deps.turnLedger,
    turnReview: deps.turnReview,
    git: deps.git,
    admission: deps.admission,
    appPath: environment.appRoot,
    root: join(dataRoot, "conversations"),
    tools: deps.tools,
    threadEnvironment: (conversationId, title, cwd) =>
      workspaces.environments?.forLaunch(conversationId, title, cwd).then(
        (values) => {
          const session = threads.store?.journalPlacement(conversationId)?.session
          return values && session ? { ...values, session } : values
        },
        (error) => {
          hostWarn("threads", "a Thread's values could not be assigned; its agent starts without them", { conversation: conversationId, error: error instanceof Error ? error.message : String(error) })
          return undefined
        }
      ) ?? Promise.resolve(undefined),
    controlInstructions: deps.controlInstructions,
    revokeTools: deps.revokeTools,
    suspendTools: deps.suspendTools,
    driver: (provider) => host.liveDrivers.get(provider),
    accountRemoving: harnesses.accountRemoval.removing,
    history: catalog.page,
    historyPaged: (id) => history.paged(id),
    historyReleased: (id) => history.released(id),
    staleHistory: (path, before) => catalog.page(path, before, undefined, { stale: true }),
    holdHistory: catalog.hold,
    historyAsOf: (path, asOf, before) => catalog.page(path, before, undefined, { asOf }),
    noteCarried: (harness, nativeId, folder) => noteCarried(makoRecords(environment.userRoot), harness, nativeId, folder),
    emit,
    planBuilt: (planId, build) => {
      try { workspaces.planBuilds.record(planId, build) } catch (error) {
        hostWarn("plans", "a built plan could not be recorded", { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  await live.recoverRewinds().catch((error) =>
    emit({
      type: "notice",
      level: "error",
      message: `Workspace rewind recovery needs attention: ${error instanceof Error ? error.message : String(error)}`,
    })
  )
  // An undo the last host died in the middle of is finished, or put back, from its saved plan.
  await live.resumeUndos().catch((error) => hostWarn("turn-undo", "an undo cut short couldn't be read", { error: error instanceof Error ? error.message : String(error) }))
  // The turns the last host's exit cut short go on, if the person chose so, once their sessions reopen.
  await live.continueRestartedInSlices()
  // Headless runs report to every window, and claim their session in the ledger while they run.
  const runs = new NativeRuns(host, emit, {
    admission: deps.admission,
    assessResume: (ref) => assessResume({
      id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path,
      coveredBlocks: 0, includesBase: false,
    }),
    claimSession: (ref) => {
      if (!memory) throw new Error("Native session ownership is unavailable. Retry after the host reconnects.")
      const owner = randomUUID()
      memory.hold(ref.harness, ref.nativeId, owner)
      return () => memory.release(ref.harness, ref.nativeId, owner)
    },
    // A native reply runs with exactly these settings; the ledger keeps them
    // for a store that records none, the way a live session's report is kept.
    prepared: (ref, settings) => memory?.remember(ref.harness, ref.nativeId, { settings }),
  })
  const continueOn = continuing({
    live,
    resolveLaunch: (provider, cwd, tuning) => harnesses.profiles.resolveLaunch(provider, cwd, tuning),
    carried: (provider, cwd, tuning) => harnesses.profiles.carried(provider, cwd, tuning),
    resumesUnderAccount: (harness) => host.liveDrivers.get(harness)?.accountContinuation?.kind === "resumes",
    switched: (provider) => deps.telemetry.feature("harness.switched", provider),
  })
  // The person's other devices, reached through the account; a Fin placed here works in this device's checkout of its project.
  const away = deps.account && placeLink(deps.account)
  const checkouts = new PlacedCheckouts({
    git: deps.git,
    projects: join(environment.userRoot, "projects"),
    known: () => [...(threads.store?.worktrees().map((worktree) => worktree.repoRoot) ?? []), ...live.summaries().flatMap((summary) => summary.session.cwd ?? [])],
  })
  if (threads.store) {
    agents = new Agents({
      store: () => threads.store ?? undefined,
      catalog,
      jobs: deps.jobs,
      live,
      continueOn,
      startLive: async (harness, cwd, options) => {
        await deps.invoke("mako:live-start", [harness, cwd, options])
      },
      harnesses: () => host.liveDrivers.list().map((driver) => driver.provider),
      runs: (harness) => host.nativeRunners.get(harness) !== undefined,
      harnessLabel: (harness) => harnessLabel(host, harness),
      modes: (harness) => host.liveDrivers.get(harness)?.modes,
      ...(deps.movePending && { movePending: deps.movePending }),
      ...(deps.archived && { archived: deps.archived }),
      finChoices: async (harness, cwd) => {
        const profile = await harnesses.profiles.forSend(harness, cwd)
        const reading = deps.finDefaults?.reading()
        const chosen = reading?.chosen[harness]
        const used = reading?.used[harness]
        return {
          models: profile.available ? profile.models : [],
          ...(profile.available && profile.settings && { recommended: profile.settings }),
          ...(chosen && { chosen }),
          ...(used && { used }),
        }
      },
      catalogOf: (harness) => harnesses.profiles.held(harness)?.models,
      limited: async (harness) => (await harnesses.accounts.limited(harness)) ?? undefined,
      finPolicy: () => deps.finDefaults?.reading().policy,
      accounts: (harness, on, all) => harnesses.accounts.standing(harness, on, all),
      connections: async (harness) => {
        const adapter = host.liveDrivers.get(harness)?.modelRoutes
        const named = adapter?.kind === "accepts" ? adapter.model : undefined
        if (adapter?.kind !== "accepts" || !named) return []
        return (await host.modelConnections.snapshot()).connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          enabled: connection.enabled,
          accepted: routeAccepted(adapter, connection.kind, connection.wire),
          models: connection.models.map((model) => ({ id: model.id, harnessModel: named(connection.id, model.id) })),
        }))
      },
      accountContinuation: (harness) => host.liveDrivers.get(harness)?.accountContinuation,
      moveOnLimit: () => deps.finDefaults?.reading().moveOnLimit ?? false,
      harnessOrder: async () => {
        const saved = await deps.invoke("mako:harness-order-saved", [])
        return harnessOrder(z.array(z.string()).catch([]).parse(decodeRuntimeValue(saved)), host.profiles.list().map((loader) => loader.provider))
      },
      ...(deps.lent && { lent: deps.lent }),
      ...(deps.finCapacity && {
        finLimit: () => deps.finCapacity!.atOnce(),
        observeCapacity: (working: number, mix: Readonly<Record<string, number>>, fins?: readonly { conversation: string; harness: string }[]) => deps.finCapacity!.observe(working, mix, fins),
      }),
      finCeiling: () => deps.finDefaults?.reading().ceiling ?? FIN_CEILING,
      capacity: new MacCapacity(),
      heldPulls: (repoRoot, branch) => workspaces.worktrees?.heldPulls(repoRoot, branch) ?? [],
      readPull: (target) => readPull(target),
      ...(away && { away }),
      remoteOf: (cwd) => deps.git.output(cwd, ["remote", "get-url", "origin"]).then((text) => text.trim() || undefined, () => undefined),
      checkoutOf: (remote) => checkouts.find(remote),
    })
    deps.finCapacity?.subscribe(() => agents?.capacityChanged())
    await agents.resumeInSlices()
  }
  const native = new NativeRequests(join(dataRoot, "native-requests"), {
    read: (path) => catalog.readRef(path),
    running: (path) => runs.state(path)?.status === "running",
    execute: async (ref, text, tuning) => {
      const selected = await harnesses.profiles.resolveNativeLaunch(ref.harness, ref.cwd, tuning)
      await runs.resume(ref, text, { ...selected, captureOutput: true })
      const result = await runs.wait(ref.path)
      if (result.state.status !== "done")
        throw new Error(result.state.error ?? "Native execution did not complete")
    },
    changed: (requests) => emit({ type: "native-requests", requests }),
    failed: (message) => emit({ type: "notice", level: "error", message }),
    admission: deps.admission,
  })
  let shared: SharedConversations | undefined
  const continuation = createContinuationPlanner({
    assessResume: async (ref) => assessResume({
      id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path,
      coveredBlocks: 0, includesBase: false,
    }),
    resolveOwner: async (ref) => shared
      ? shared.resolve(ref.harness, ref.nativeId, Boolean(ref.heldBy || ref.locked || catalog.activity()[ref.path]))
      : { kind: "unavailable", reason: "Session ownership is unavailable. Retry when the host reconnects." },
    ref: async (path) => catalog.list().find((ref) => ref.path === path) ?? (await catalog.readRef(path)) ?? undefined,
    live: (provider) => {
      const driver = host.liveDrivers.get(provider)
      return driver ? { available: driver.available(environment.appRoot), canResume: resumes(driver) } : null
    },
    nativeInstalled: (provider) => host.nativeRunners.get(provider)?.available() ?? false,
    running: (path) => runs.state(path)?.status === "running",
    external: (path) => catalog.activity()[path]?.status ?? null,
    resumeRefusal: () => memory?.resumeRefusal()?.message ?? null,
  })
  return {
    live,
    continueOn,
    runs,
    ...(agents && { agents }),
    native,
    continuation,
    history,
    route: (channel, args) => shared ? shared.route(channel, args) : Promise.resolve({ handled: false }),
    harnessLabel: (harness) => harnessLabel(host, harness),
    nativeRouting: () => nativeRoutingReadings(host),
    async restorePlan(path) {
      const ref = catalog.ref(path)
      if (!ref) return { kind: "none" }
      await harnesses.updates.load()
      return restorePlan(ref, catalog.recordWriters(path), harnesses.updates.restoreRuntime(ref.harness))
    },
    share(send) {
      if (!memory) return
      shared = new SharedConversations(memory, send, {
        snapshot: (id) => live.snapshot(id),
        find: (provider, nativeId) => {
          const id = live.connectedSession(provider, nativeId)
          return id ? live.snapshot(id) : null
        },
      })
    },
    async stop() {
      shared?.dispose()
      agents?.dispose()
      away?.close()
      await live.stop()
      for (const driver of host.liveDrivers.list()) driver.stop?.()
      native.stop()
    },
  }
}

export interface ConversationMethodsDeps {
  conversations: Conversations
  /** Validates each launch's settings against the harness's discovered models. */
  profiles: HarnessProfiles
  threads: Threads
  workspaces: Workspaces
  movers: WorkspaceMovers
  lifecycle: ThreadLifecycle
  telemetry: HostTelemetry
  /** Reads the files a conversation names. */
  files: ConversationFiles
  /** Calls this host's own methods, as a client would. */
  invoke: HostMethods["invoke"]
  /** The folder of the tab in front, where a fresh native run starts. */
  workspace(): Promise<string>
  emit(event: HostEvent): void
  /**
   * The mode the person chose for `harness` (`AccessChoiceStore.mode`), which a new session starts in when its start
   * names none, whoever asked for it: a window, the web app or a phone through this Mac's link.
   */
  accessMode?(harness: string): string | undefined
  /** The person started or sent on `harness` with `settings`: what their Fins there run on until they choose otherwise. */
  used?(harness: string, settings: SessionSettings | undefined): void
  /** On a cloud machine: what a Thread arriving from a device needs (`mako:move-arrive`). */
  arrival?: MoveArrivalDeps
  /** On a cloud machine: what a Thread going back to its device needs (`mako:move-depart`). */
  departure?: MoveDepartureDeps
}

const FINS_UNAVAILABLE: AgentRefused = { refused: "unavailable", why: "Fins need the Thread store, which didn't open on this host." }

/** Starting, continuing, steering and moving conversations, live or headless. */
export function declareConversationMethods(methods: MethodTable, deps: ConversationMethodsDeps): void {
  const { conversations, profiles, threads, workspaces, movers, lifecycle, telemetry, files, emit } = deps
  const { live, runs, native, continuation, history } = conversations
  declareTranscriptMethods(methods, { snapshot: (id) => live.historySnapshot(id), openThread: (path) => threads.catalog.open(path), label: (harness) => conversations.harnessLabel(harness) })
  const { worktrees, environments } = workspaces
  const worktreeMove = () => {
    if (!movers.worktreeMoves) throw new Error("Worktrees need the Thread store, which didn't open.")
    return movers.worktreeMoves
  }
  declareAgentMethods(methods, () => conversations.agents)
  methods.handle("mako:thread-continuation-resolve", (path: string) => continuation.resolve(path))
  methods.handle("mako:conversation-settings", () => live.conversationSettings())
  methods.handle("mako:conversation-settings-set", (settings: ConversationSettings) => live.setConversationSettings(settings))
  methods.handle("mako:thread-owner-resolve", (path: string) => continuation.owner(path))
  methods.handle("mako:thread-continuation-plan", (path: string) => continuation.plan(path))
  methods.handle("mako:thread-restore-plan", (path: string) => conversations.restorePlan(path))
  methods.handle("mako:live-locate", (provider: string, nativeId: string) => live.connectedSession(provider, nativeId))
  methods.handle("mako:live-attach", async (path: string) => {
    const result = await continuation.resolve(path)
    if (result.transport === "unavailable") throw new RuntimeDisconnectedError(false)
    return result.transport === "attached" ? result.snapshot : null
  })
  methods.handle("mako:live-start", async (harness: string, cwd: string, options: LiveStartOptions) => {
    const began = performance.now()
    const trace = (stage: string) => {
      if (process.env.MAKO_STARTUP_TRACE === "1")
        console.info("[mako-startup]", JSON.stringify({ stage, elapsedMs: performance.now() - began }))
    }
    // A resume id is honoured only when the host's own plan reopens that
    // store live; renderer state that says otherwise is stale, not a vote.
    const continueOwned = async (resolved: Awaited<ReturnType<typeof continuation.resolve>>) => {
      if (resolved.transport !== "attached") throw new Error("The conversation owner is not ready")
      if (options.initialRequest) {
        const request = options.initialRequest
        const args = resolved.bindingId
          ? [resolved.conversationId, resolved.bindingId, request.id, request.text, request.attachments, options.tuning]
          : [resolved.conversationId, request.id, request.text, request.attachments, options.tuning]
        await deps.invoke(resolved.bindingId ? "mako:live-continue" : "mako:live-prompt", args)
        return new EncodedAnswer(await deps.invoke("mako:live-snapshot", [resolved.conversationId]))
      }
      if (options.goal !== undefined)
        return new EncodedAnswer(await deps.invoke("mako:live-goal", [resolved.conversationId, { kind: "set", ...options.goal }, options.tuning]))
      if (options.review !== undefined)
        return new EncodedAnswer(await deps.invoke("mako:live-review", [resolved.conversationId, options.review, options.tuning]))
      return resolved.snapshot
    }
    if (options.resume && options.threadPath) {
      const resolved = await continuation.resolve(options.threadPath)
      if (resolved.transport === "attached") return continueOwned(resolved)
      if (resolved.transport === "unavailable") throw new RuntimeDisconnectedError(false)
      if (resolved.transport !== "live" || resolved.provider !== harness || resolved.nativeId !== options.resume)
        throw new Error(resolved.transport === "refused" ? resolved.reason : "This native session cannot be resumed with the selected provider")
    }
    const remembered = options.resume ? threads.memory?.recall(harness, options.resume) : undefined
    // A new Thread in a worktree starts there, and a new Thread outside any
    // project in a chat folder of its own; a resume or a new tab of an
    // existing Thread runs where that Thread already does. Once its
    // worktree is removed, that's the project it was made from.
    const fresh = !options.resume && !options.session
    const landed = live.startFolder(harness, cwd, options)
    const chat = fresh && standsForNoProject(cwd) ? newChatFolder() : undefined
    if (options.worktree && !chat && !worktrees) throw new Error("Worktrees need the Thread store, which didn't open. Choose Project folder to work in the folder itself.")
    const making = options.worktree && fresh && !chat && worktrees
      ? worktrees.prepare(
          options.conversationId,
          cwd,
          options.title ?? options.displayPrompt ?? options.initialRequest?.text,
          options.worktreeStart ?? { kind: "newest" },
          (step) => emit({ type: "worktree-step", conversationId: options.conversationId, step })
        )
      : undefined
    const worktree = making && worktrees ? await worktrees.unlessSkipped(options.conversationId, making) : undefined
    if (worktree) {
      trace("worktree")
      emit({ type: "worktree-ready", conversationId: options.conversationId })
    }
    const startCwd = worktree?.cwd ?? chat ?? landed
    // A conversation already open (a move's, opened as it arrived) answers as it stands: its start reads nothing again.
    const tuning = live.snapshot(options.conversationId) ? options.tuning : await profiles.resolveLaunch(harness, startCwd, options.tuning ?? remembered?.settings)
    trace("profile")
    // A Fin's start is its Apex's choice, and a resume names no new one: neither says what the person uses.
    if (!options.parent && !options.resume) deps.used?.(harness, options.tuning)
    // A resume goes on in the mode its session ran in; a new session starts in the person's, unless its start said one.
    const modeId = options.modeId ?? (options.resume ? undefined : deps.accessMode?.(harness))
    try {
      // A Fin its Apex stopped while its worktree and profile were prepared writes no edge: its worktree goes back below.
      if (options.parent && !options.resume && conversations.agents && !conversations.agents.startWanted(options.parent.op)) throw new Error("Its Apex stopped it before it started.")
      await live.start(
        harness,
        startCwd,
        { ...options, worktree: undefined, purpose: undefined, tuning, ...modeId !== undefined && { modeId } },
        undefined,
        options.purpose ? { kind: options.purpose, project: cwd } : undefined
      )
    } catch (error) {
      // A refused start gives its worktree back; one with anything in it stays, listed in Settings.
      if (worktree) await worktrees?.abandon(options.conversationId).catch(() => undefined)
      if (chat) discardChatFolder(chat)
      if (!(error instanceof SessionHeldError) || !options.threadPath) throw error
      const resolved = await continuation.resolve(options.threadPath)
      if (resolved.transport !== "attached") throw error
      return continueOwned(resolved)
    }
    trace("accepted")
    if (fresh || options.resume)
      telemetry.threadCreated({ harness, origin: fresh ? "new" : "resume", worktree: Boolean(worktree), ...(options.purpose && { purpose: options.purpose }) })
    if (worktree)
      void worktrees?.attach(options.conversationId).catch((error) =>
        hostWarn("threads", "a worktree could not be recorded against its Thread; the next list attaches it", { conversation: options.conversationId, error: error instanceof Error ? error.message : String(error) }))
    return live.snapshot(options.conversationId)
  })
  methods.handle("mako:native-receipt", (id: string) => native.receipt(id) ?? null)
  methods.handle("mako:native-dismiss", (id: string) => native.dismiss(id))
  methods.handle("mako:native-edit-queued", (input: QueuedPromptEdit) => native.editQueued(input))
  methods.handle("mako:native-requests", () => native.list())
  methods.handle("mako:native-submit", async (input: NativeRequestInput) => {
    await continuation.assertNative(input.path)
    return native.submit(input)
  })
  methods.handle("mako:live-merge-fork", (id: string, mergeId: string) => live.mergeFork(id, mergeId))
  methods.handle("mako:live-rewind-preview", (id: string, requestId: string, position?: "before" | "after") =>
    live.previewRewind(id, requestId, position)
  )
  methods.handle("mako:live-turn-changes", (id: string, requestId: string, workspace?: string) => live.turnChanges(id, requestId, workspace))
  methods.handle("mako:live-turn-diff", (id: string, requestId: string, path: string, options?: { only?: boolean }) => live.turnDiff(id, requestId, path, options))
  methods.handle("mako:live-turn-hunks", (id: string, requestId: string, path: string, options?: { context?: number }) => live.turnHunks(id, requestId, path, options))
  methods.handle("mako:live-turn-writers", (id: string, requestId: string, path: string) => live.turnWriters(id, requestId, path))
  methods.handle("mako:live-turn-undo-preview", (id: string, scope: TurnUndoScope) => live.turnUndoPreview(id, scope))
  methods.handle("mako:live-turn-undo", (id: string, scope: TurnUndoScope, token: string) => live.turnUndo(id, scope, token))
  methods.handle("mako:live-rewind", async (id: string, input: RewindInput) => {
    const rewound = await live.rewind(id, input)
    telemetry.feature("turn.rewound", live.session(id)?.harness)
    return rewound
  })
  methods.handle("mako:live-rewind-recover", () => live.recoverRewinds())
  methods.handle("mako:live-action", (id: string, input: LiveActionInput) => live.act(id, input))
  // A separate method advertises atomic queued steering to clients whose UI
  // can update while the shared host remains alive. Keep live-action for
  // existing clients and receipts written before this capability was named.
  methods.handle("mako:live-steer-queued", (id: string, input: Extract<LiveActionInput, { kind: "steer-queued" }>) => live.act(id, input))
  methods.handle("mako:live-action-acknowledge", (id: string, actionId: string) => live.acknowledgeAction(id, actionId))
  methods.handle("mako:live-fork", async (id: string, input: ForkInput) => {
    const fork = !input.worktree ? await live.historyReady(id).then(() => live.fork(id, input))
      : input.move ? (await movers.moves.moveNow(id, (told) => worktreeMove().carry(id, { lead: true, tell: told, input }))).moved
        : (await worktreeMove().move(id, input)).conversation
    telemetry.feature("thread.forked", live.session(id)?.harness)
    return fork
  })
  methods.handle("mako:live-capture", (id: string, path: string) => live.capture(id, path))
  methods.handle("mako:live-transfer", async (id: string, input: TransferInput) => {
    const transferred = await conversations.continueOn(id, { kind: "words", input: TransferInputSchema.parse(input) })
    if (!transferred) throw new Error("This conversation is no longer available")
    return transferred
  })
  methods.handle("mako:live-edit-queued", (id: string, input: QueuedPromptEdit) => live.editQueued(id, input))
  methods.handle("mako:live-clear-queue", (id: string) => live.clearQueue(id))
  methods.handle("mako:live-sign-in-readiness", (id: string) => live.signInReadiness(id))
  methods.handle("mako:live-sign-in-resume", (id: string, anyway: boolean) => live.resumeSignIn(id, anyway))
  methods.handle("mako:live-earlier", (id: string) => live.earlier(id))
  methods.handle("mako:live-bind", (id: string, path: string) => live.bind(id, path))
  methods.handle("mako:read-live-file", (id: string, path: string, purpose?: FileReadPurpose) => {
    const session = live.session(id)
    if (!session) throw new Error("That conversation is unavailable")
    const dataDir = environments ? () => environments.fileDataDir({ conversationId: id, cwd: session.cwd }) : undefined
    return files.read(session.cwd, path, dataDir, purpose)
  })
  /** A conversation's folder, browsed from wherever its window is: another device's Files view. */
  const folderIndex = (id: string) => {
    const session = live.session(id)
    if (!session) throw new Error("That conversation is unavailable")
    return files.index(session.cwd)
  }
  methods.handle("mako:live-files-folders", (id: string, paths: string[], options?: FileFoldersOptions) => folderIndex(id).folders(paths, options))
  methods.handle("mako:live-files-find", (id: string, query: string, limit?: number) => folderIndex(id).find(query, limit))
  methods.handle("mako:live-files-grep", (id: string, query: string, options?: FileGrepOptions) => folderIndex(id).grep(query, options))
  methods.handle("mako:live-snapshot", (id: string) => live.refreshedSnapshot(id))
  methods.handle("mako:live-context-breakdown", (id: string) => live.contextBreakdown(id))
  methods.handle("mako:live-read", (id: string, input: LiveHistoryRead) =>
    history.read(id, LiveHistoryReadSchema.parse(input), () => live.refreshedSnapshot(id))
  )
  methods.handle("mako:live-state", (id: string) => live.session(id) ?? null)
  methods.handle("mako:live-continue", async (id: string, bindingId: string,
    requestId: string, text: string, attachments?: PromptAttachment[], tuning?: SessionSettings) => {
    const snapshot = live.snapshot(id)
    const binding = snapshot?.control?.bindings.find((item) => item.id === bindingId)
    if (!snapshot || !binding) throw new Error("The selected native session is unavailable")
    // Which binding is active is read as it's admitted: a move may land while the selection resolves.
    const continued = await conversations.continueOn(id, { kind: "reply", reply: { bindingId, provider: binding.provider, requestId, text, ...(attachments && { attachments }), tuning: tuning ?? binding.tuning } })
    if (!continued) throw new Error("The selected native session is unavailable")
    return continued
  })
  methods.handle("mako:live-prompt", async (id: string, requestId: string, text: string, attachments?: PromptAttachment[], tuning?: SessionSettings) => {
    const session = live.session(id)
    if (!session) throw new Error("This conversation is no longer available")
    deps.used?.(session.harness, tuning)
    return live.admitInOrder(id, profiles.resolveLaunch(session.harness, session.cwd, tuning),
      (selected) => live.submit(id, requestId, text, attachments, selected))
  })
  // A failed message sent again at a time: a usage limit's reset.
  methods.handle("mako:live-hold-until", (id: string, requestId: string, input: { after: string; at: number }) =>
    live.holdUntil(id, requestId, input))
  // A turn Mako cut short, continued here as Mako: a handoff's turn on the machine it went to, or here when it stayed.
  // `stopped`: the background work the handoff stopped, which the continuation names for the agent.
  methods.handle("mako:live-continue-turn", (id: string, requestId: string, input: { reason: "handed-off"; continues: string; stopped?: string[] }) =>
    live.continueTurn(id, { requestId, reason: input.reason, continues: input.continues, ...input.stopped?.length && { stopped: input.stopped }, actor: { kind: "service", name: "handoff" } }))
  methods.handle("mako:live-permission", (id: string, requestId: string, response: LivePermissionResponse) =>
    live.permission(id, requestId, response)
  )
  methods.handle("mako:live-mode", (id: string, modeId: string) => live.setMode(id, modeId))
  methods.handle("mako:live-cancel", (id: string) => live.cancel(id))
  methods.handle("mako:live-stop-agent", (id: string, nativeId: string) => live.stopNativeAgent(id, nativeId))
  methods.handle("mako:live-goal", async (id: string, command: GoalCommand, tuning?: SessionSettings) => {
    const session = live.session(id)
    if (!session) throw new Error("This conversation is no longer available")
    const selected = tuning && await profiles.resolveLaunch(session.harness, session.cwd, tuning)
    return live.goal(id, GoalCommandSchema.parse(command), selected)
  })
  methods.handle("mako:live-side-question", (id: string, command: SideQuestionCommand) =>
    live.sideQuestion(id, SideQuestionCommandSchema.parse(command)))
  methods.handle("mako:live-review", async (id: string, target: ReviewTarget, tuning?: SessionSettings) => {
    const session = live.session(id)
    if (!session) throw new Error("This conversation is no longer available")
    const selected = tuning && await profiles.resolveLaunch(session.harness, session.cwd, tuning)
    return live.review(id, ReviewTargetSchema.parse(target), selected)
  })
  methods.handle("mako:live-close", (id: string) => live.close(id))
  methods.handle("mako:live-prewarm", (id: string) => live.prewarm(id))
  /**
   * Where no person's Mac starts cloud conversations (a cloud machine, the fixture desk): nothing is made ahead. On a
   * person's Mac the cloud router answers first (`CloudConversations.prepare`); these parameters are its.
   */
  const prepareNowhere: (folder: string, composingMs: number, launch?: CloudPrepareLaunch) => CloudPrepareOutcome = () => "none"
  methods.handle("mako:cloud-prepare", prepareNowhere)
  const offerNowhere: (folders: string[]) => CloudProjectsOffer = () => "none"
  methods.handle("mako:cloud-offer-projects", offerNowhere)
  /** Where no person's Mac moves Threads to the cloud (a cloud machine, the fixture desk); on a Mac, `CloudMoves` answers first. */
  const moveNowhere: (conversationId: string, move: string, handOff?: ThreadHandOff) => ThreadMoveOutcome = () => ({ kind: "kept-here", reason: "This Mako doesn't move Threads to the cloud." })
  methods.handle("mako:thread-move", moveNowhere)
  /** Where no person's Mac moves Threads to the cloud, nothing is weighed; on a Mac, `HarnessCheck` answers first. */
  const weighNothing: (conversationId: string) => ThreadHarnessCheck = () => ({ kind: "unknown", reason: "This Mako doesn't move Threads to the cloud." })
  methods.handle("mako:thread-harness-check", weighNothing)
  /** Where no person's Mac continues another device's Threads in the cloud; on a Mac, `CloudContinues` answers first. */
  const continueNowhere: (conversationId: string, op: string) => ThreadContinueOutcome = () => ({ kind: "failed", reason: "This Mako doesn't continue Threads in the cloud." })
  methods.handle("mako:thread-continue", continueNowhere)
  const offerNoContinue: (conversationId: string) => ThreadContinueOffer = () => ({ offer: { offer: false, why: "no-cloud", detail: "This Mako doesn't continue Threads in the cloud." }, waiting: 0 })
  methods.handle("mako:thread-continue-offer", offerNoContinue)
  const noContinues: () => ContinueReading[] = () => []
  methods.handle("mako:continue-readings", noContinues)
  /** Handing agents at work to the cloud: on a person's Mac `CloudHandOffs` answers first; elsewhere there's nothing to hand. */
  const nothingToHand: () => HandOffCandidate[] = () => []
  methods.handle("mako:handoff-candidates", nothingToHand)
  const handNothing: (handOff: string, why: "quit") => HandOffResult[] = () => []
  methods.handle("mako:handoff", handNothing)
  const noHandOffs: HandOffSettings = { onSleep: false, unavailable: "This Mako doesn't hand agents to the cloud." }
  methods.handle("mako:handoff-settings", () => noHandOffs)
  const setNoHandOffs: (onSleep: boolean) => HandOffSettings = () => noHandOffs
  methods.handle("mako:handoff-settings-set", setNoHandOffs)
  const holdsNothing: () => string[] = () => []
  methods.handle("mako:handoff-away-held", holdsNothing)
  const runNothingHere: (conversationId: string) => number = () => 0
  methods.handle("mako:handoff-run-here", runNothingHere)
  /** Keeping this Mac awake while agents work: on a person's Mac `KeepAwake` answers first; elsewhere there's no Mac to keep. */
  const noKeepAwake: KeepAwakeState = { settings: { on: false, lidClosed: false }, hold: { kind: "rest" }, unavailable: "This Mako doesn't keep a Mac awake." }
  methods.handle("mako:keep-awake", () => noKeepAwake)
  const setNoKeepAwake: (change: Partial<KeepAwakeSettings>) => KeepAwakeState = () => noKeepAwake
  methods.handle("mako:keep-awake-set", setNoKeepAwake)
  /** Where no person's Mac brings Threads back (a cloud machine, the fixture desk); on a Mac, `CloudReturns` answers first. */
  const returnNowhere: (conversationId: string, move: string, options?: ThreadReturnOptions) => ThreadReturnOutcome = () => ({ kind: "stayed", reason: "This Mako doesn't bring Threads back from the cloud." })
  methods.handle("mako:thread-return", returnNowhere)
  /** Before a device releases a Thread: on a cloud machine, once its folder is cloned. */
  methods.handle("mako:move-ready", (input: MoveReadyInput) => {
    const arrival = deps.arrival
    if (!arrival) throw new Error("Only a cloud machine's host takes a Thread's move.")
    return readyForMove(arrival, MoveReadyInputSchema.parse(input))
  })
  /** Before a device releases a Thread: on a cloud machine, what was sent ahead staged here, so the hand-over is short. */
  methods.handle("mako:move-stage", (input: MoveStageInput) => {
    const arrival = deps.arrival
    if (!arrival) throw new Error("Only a cloud machine's host takes a Thread's move.")
    return stageMove(arrival, MoveStageInputSchema.parse(input))
  })
  /** A Thread arriving from a device: on a cloud machine, its checkout applied and its sessions' records written here. */
  methods.handle("mako:move-arrive", (input: MoveArrivalWire) => {
    const arrival = deps.arrival
    if (!arrival) throw new Error("Only a cloud machine's host takes a Thread's move.")
    return arriveMove(arrival, MoveArrivalInputSchema.parse(input))
  })
  /** A Thread going back to its device: on a cloud machine, paused, its checkout and its sessions' records sent up. */
  methods.handle("mako:move-depart", (input: MoveDepartureInput) => {
    const departure = deps.departure
    if (!departure) throw new Error("Only a cloud machine's host sends a Thread back.")
    return departMove(departure, MoveDepartureInputSchema.parse(input))
  })
  /** A Thread's checkout on its cloud machine as it stands, for its device's worktree to follow: read, never released. */
  methods.handle("mako:move-follow", (input: MoveFollowInput) => {
    const departure = deps.departure
    if (!departure) throw new Error("Only a cloud machine's host sends a Thread's checkout to follow.")
    return followMove(departure, MoveFollowInputSchema.parse(input))
  })
  /** A Thread staying on its cloud machine after its departure: the device cancelled the return or gave it back. */
  methods.handle("mako:move-stay", (input: MoveStayInput) => {
    const departure = deps.departure
    if (!departure) throw new Error("Only a cloud machine's host takes a Thread back.")
    return stayMove(departure, MoveStayInputSchema.parse(input))
  })
  /** A new conversation on another harness, from the main composer. */
  methods.handle("mako:harness-start", async (harness: string, prompt: string, options?: SessionSettings) => {
    const cwd = await deps.workspace()
    const tuning = await profiles.resolveNativeLaunch(harness, cwd, options)
    return { run: await runs.startFresh(harness, cwd, prompt, tuning), cwd }
  })
  methods.handle("mako:thread-run", (path: string) => runs.state(path))
  methods.handle("mako:thread-abort-run", async (path: string) => {
    const token = runs.stopToken(path)
    if (token) await lifecycle.stop({ kind: "native", path, token })
  })
  methods.handle("mako:provider-residency", () => live.residency())
  methods.handle("mako:agents-diagnostics", () => conversations.agents?.diagnostics() ?? null)
  /** The person moving a message their Apex passed on to another of its Fins (`Agents.redirect`). */
  methods.handle("mako:agents-redirect", (conversation: string, input: AgentsRedirectInput) =>
    conversations.agents?.redirect(conversation, input) ?? FINS_UNAVAILABLE)
  /** The person writing to one of an Apex's Fins from the Apex's conversation, with no Apex turn (`Agents.direct`). */
  methods.handle("mako:agents-direct", (conversation: string, input: AgentsDirectInput) =>
    conversations.agents?.direct(conversation, input) ?? FINS_UNAVAILABLE)
  /** The person answering what one of an Apex's Fins asks them, from the Apex's Thread on any device (`Agents.respond`). */
  methods.handle("mako:agents-next-place", async (conversation: string) => {
    const next = await conversations.agents?.nextPlace(conversation)
    return next ? { label: next.label, harness: next.harness } : null
  })
  methods.handle("mako:agents-continue-next", async (conversation: string, id: string) => await conversations.agents?.continueNext(conversation, id) ?? false)
  methods.handle("mako:agents-respond", (conversation: string, input: AgentsRespondInput) =>
    conversations.agents?.respond(conversation, input) ?? FINS_UNAVAILABLE)
  methods.handle("mako:native-routing", () => conversations.nativeRouting())
}
