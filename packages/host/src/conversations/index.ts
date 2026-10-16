import type { Git } from "@mako/git"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Admission } from "../base/admission.js"
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
import { resumes, type HarnessProfiles, type Harnesses } from "../harnesses/index.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"
import { EncodedAnswer } from "../contracts/runtime-value.js"
import { SessionHeldError, discardChatFolder, newChatFolder, standsForNoProject, type Threads, type ThreadLifecycle } from "../threads/index.js"
import { NativeRuns } from "./native-runs.js"
import { TransferInputSchema } from "../contracts/conversation-control.js"
import type { HostTelemetry } from "../usage/index.js"
import type { QueuedPromptEdit } from "../contracts/live-queue.js"
import type { RewindInput } from "../contracts/workspace-snapshots.js"
import type { LiveActionInput } from "../contracts/live-actions.js"
import { GoalCommandSchema, type GoalCommand } from "../contracts/live-goals.js"
import { SideQuestionCommandSchema, type SideQuestionCommand } from "../contracts/live-side-questions.js"
import { ReviewTargetSchema, type ReviewTarget } from "../contracts/live-reviews.js"
import type { ForkInput, TransferInput } from "../contracts/conversation-control.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { LivePermissionResponse, PromptAttachment } from "../contracts/providers-acp.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { NativeRequestInput } from "../contracts/native-requests.js"
import { declareTranscriptMethods } from "./transcript-methods.js"

export { CloudConversations, folderRepository } from "./cloud-conversations.js"

/** Live turns and their journals, headless native runs, and who owns each conversation. */
export interface Conversations {
  live: LiveConversations
  /** Headless native runs, one writer per native session. */
  runs: NativeRuns
  native: NativeRequests
  continuation: ContinuationPlanner<unknown>
  /** Replies with their history as pages, for clients that page it. */
  history: LiveHistoryReader
  /** A call about a conversation another host owns is answered there. */
  route(channel: string, args: unknown[]): Promise<ConversationRoutingResult>
  /** Every host's conversations, once the socket can carry their events. */
  share(send: ConstructorParameters<typeof SharedConversations>[1]): void
  /** Stops the conversations; the native requests and the harnesses' own sessions stop after them. */
  stop(): Promise<void>
}

export interface ConversationsDeps {
  environment: HostEnvironment
  git: Git
  threads: Threads
  harnesses: Harnesses
  workspaces: Workspaces
  telemetry: HostTelemetry
  emit(event: HostEvent): void
  /** What each agent can call: Mako's tools and Local Control. */
  tools: NonNullable<LiveDependencies["tools"]>
  /** The MCP servers the harnesses have for `cwd`, which a launch hands its agent. */
  mcpSnapshot: NonNullable<LiveDependencies["mcpSnapshot"]>
  revokeTools: NonNullable<LiveDependencies["revokeTools"]>
  controlInstructions: NonNullable<LiveDependencies["controlInstructions"]>
  /** A waiting move may go ahead; the moves are made after the conversations. */
  settled(conversationId: string): void
  /** Whether the host takes new work. */
  admission: Admission
}

export async function openConversations(deps: ConversationsDeps): Promise<Conversations> {
  const { environment, threads, harnesses, workspaces, emit } = deps
  const { catalog, memory } = threads
  const { host } = harnesses
  const dataRoot = environment.dataRoot
  const history = new LiveHistoryReader(catalog.page, catalog.entry)
  const live = new LiveConversations({
    turns: deps.telemetry.turns,
    memory: memory ?? undefined,
    threads: threads.store ?? undefined,
    mcpSnapshot: deps.mcpSnapshot,
    workspaceSnapshots: new WorkspaceSnapshots(deps.git, join(dataRoot, "workspace-snapshots")),
    checkpoint: (path, provider) => {
      const sourceProvider = provider ?? catalog.ref(path)?.harness
      const driver = sourceProvider ? host.liveDrivers.get(sourceProvider) : undefined
      return driver?.resume.kind === "native" ? driver.resume.checkpoint(path) : Promise.resolve(undefined)
    },
    nativePath: (session) => catalog.nativePath(session),
    accountEnv: (binding) => host.accounts.bindingEnv(binding),
    signInState: (harness, account) => host.accounts.signInState(harness, account),
    emitSession: async (provider, thread) => {
      const emitter = host.sessionEmitters.get(provider)
      return emitter ? emitter.emit(thread) : null
    },
    children: catalog.childSource,
    resumeVerdict: (binding) => harnesses.assessResume(binding),
    projectFolderOfRemoved: (folder) => threads.origins.projectFolderOfRemoved(folder),
    settled: deps.settled,
    admission: deps.admission,
    appPath: environment.appRoot,
    root: join(dataRoot, "conversations"),
    tools: deps.tools,
    threadEnvironment: (conversationId, title, cwd) =>
      workspaces.environments?.forLaunch(conversationId, title, cwd).catch((error) => {
        hostWarn("threads", "a Thread's values could not be assigned; its agent starts without them", { conversation: conversationId, error: error instanceof Error ? error.message : String(error) })
        return undefined
      }) ?? Promise.resolve(undefined),
    controlInstructions: deps.controlInstructions,
    revokeTools: deps.revokeTools,
    driver: (provider) => host.liveDrivers.get(provider),
    accountRemoving: harnesses.accountRemoval.removing,
    history: catalog.page,
    staleHistory: (path, before) => catalog.page(path, before, undefined, { stale: true }),
    holdHistory: catalog.hold,
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
  // Headless runs report to every window, and claim their session in the ledger while they run.
  const runs = new NativeRuns(host, emit, {
    admission: deps.admission,
    assessResume: (ref) => harnesses.assessResume({
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
    assessResume: async (ref) => harnesses.assessResume({
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
  })
  return {
    live,
    runs,
    native,
    continuation,
    history,
    route: (channel, args) => shared ? shared.route(channel, args) : Promise.resolve({ handled: false }),
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
}

/** Starting, continuing, steering and moving conversations, live or headless. */
export function declareConversationMethods(methods: MethodTable, deps: ConversationMethodsDeps): void {
  const { conversations, profiles, threads, workspaces, movers, lifecycle, telemetry, files, emit } = deps
  const { live, runs, native, continuation, history } = conversations
  declareTranscriptMethods(methods, { snapshot: (id) => live.historySnapshot(id), openThread: (path) => threads.catalog.open(path) })
  const { worktrees, environments } = workspaces
  const worktreeMove = () => {
    if (!movers.worktreeMoves) throw new Error("Worktrees need the Thread store, which didn't open.")
    return movers.worktreeMoves
  }
  methods.handle("mako:thread-continuation-resolve", (path: string) => continuation.resolve(path))
  methods.handle("mako:thread-owner-resolve", (path: string) => continuation.owner(path))
  methods.handle("mako:thread-continuation-plan", (path: string) => continuation.plan(path))
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
    const tuning = await profiles.resolveLaunch(harness, startCwd, options.tuning ?? remembered?.settings)
    trace("profile")
    try {
      await live.start(
        harness,
        startCwd,
        { ...options, worktree: undefined, purpose: undefined, tuning },
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
  methods.handle("mako:live-turn-changes", (id: string, requestId: string) => live.turnChanges(id, requestId))
  methods.handle("mako:live-turn-diff", (id: string, requestId: string, path: string) => live.turnDiff(id, requestId, path))
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
    const parsed = TransferInputSchema.parse(input)
    const tuning = await profiles.resolveLaunch(parsed.provider, live.session(id)?.cwd, parsed.tuning)
    await live.historyReady(id)
    const transferred = live.transfer(id, { ...parsed, tuning })
    telemetry.feature("harness.switched", parsed.provider)
    return transferred
  })
  methods.handle("mako:live-edit-queued", (id: string, input: QueuedPromptEdit) => live.editQueued(id, input))
  methods.handle("mako:live-clear-queue", (id: string) => live.clearQueue(id))
  methods.handle("mako:live-sign-in-readiness", (id: string) => live.signInReadiness(id))
  methods.handle("mako:live-sign-in-resume", (id: string, anyway: boolean) => live.resumeSignIn(id, anyway))
  methods.handle("mako:live-earlier", (id: string) => live.earlier(id))
  methods.handle("mako:live-bind", (id: string, path: string) => live.bind(id, path))
  methods.handle("mako:read-live-file", (id: string, path: string) => {
    const session = live.session(id)
    if (!session) throw new Error("That conversation is unavailable")
    const dataDir = environments ? () => environments.fileDataDir({ conversationId: id, cwd: session.cwd }) : undefined
    return files.read(session.cwd, path, dataDir)
  })
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
    const selected = await profiles.resolveLaunch(binding.provider, snapshot.session.cwd, tuning ?? binding.tuning)
    return live.continueBinding(id, bindingId, requestId, text, attachments, selected)
  })
  methods.handle("mako:live-prompt", async (id: string, requestId: string, text: string, attachments?: PromptAttachment[], tuning?: SessionSettings) => {
    const session = live.session(id)
    if (!session) throw new Error("This conversation is no longer available")
    const selected = await profiles.resolveLaunch(session.harness, session.cwd, tuning)
    return live.submit(id, requestId, text, attachments, selected)
  })
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
}
