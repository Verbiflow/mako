import { LiveQuestions } from "./live-questions.js"
import { disconnectedContext } from "./execution-context.js"
import { verifyRecoveredSession } from "./provider-recovery.js"
import { retireQuestionsForInput } from "./contracts/live-questions.js"
import { LiveApprovals, knownApprovalOccurrences } from "./live-approvals.js"
import { advancePromptDelivery, type PromptDelivery, type PromptDeliveryEvidence } from "./contracts/prompt-delivery.js"
import { assertLifecycleAdmission, lifecycleBlocked } from "./application-lifecycle.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import type {
  ProviderResidencyEntry,
  ProviderResidencySnapshot,
} from "./contracts/provider-residency.js"
import {
  QueuedPromptEditSchema,
  type QueuedPromptEdit,
} from "./contracts/live-queue.js"
import {
  disconnectNativeAgents,
  isActiveNativeAgent,
  observeNativeAgent,
  NativeAgentObservationSchema,
} from "./contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { captureNativeHistory } from "./native-history.js"
import { prepareLiveContext, contextPrompt } from "./live-context.js"
import { LiveTransfers, reconnectRefusal } from "./live-transfers.js"
import { LiveCheckpoints } from "./live-checkpoints.js"
import { LiveActions } from "./live-actions.js"
import type { LiveActionInput } from "./contracts/live-actions.js"
import type { RewindInput } from "./contracts/workspace-snapshots.js"
import { LiveChildren } from "./live-children.js"
import { LiveMoves, snapshotFacts } from "./live-moves.js"
import { bindingPath, errorMessage } from "./live-runtime.js"
import type {
  LiveAccess,
  Dependencies,
  Resident,
  FailureBoundary,
} from "./live-runtime.js"
import {
  ForkInputSchema,
  resumable,
} from "./contracts/conversation-control.js"
import { resolveAnchor } from "./contracts/message-anchor.js"
import type {
  ForkInput,
  TransferInput,
  ConversationControl,
  ProviderBinding,
} from "./contracts/conversation-control.js"
import { liveEntries } from "./live-context.js"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { statSync } from "node:fs"
import { join } from "node:path"
import type { SessionFacts } from "./session-memory.js"
import type { StartPurpose } from "./contracts/thread-purposes.js"
import { LiveAssets, promptFingerprint } from "./live-assets.js"
import { threadIdentity, type ThreadPage } from "@mako/sessions"
import { z } from "zod"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveDriverEvent,
  LiveRequest,
  LiveSnapshot,
  LiveStartOptions,
  LiveSummary,
  NativeActivity,
  NativeActivityObservation,
} from "./shared.js"
import { reduceLiveUpdates, mergeLiveUpdates, changedLiveBlockStart, isTurnStart } from "./contracts/live-content.js"
import type { InterruptionReason, TurnContinuation } from "./contracts/live-conversations.js"
import { closeCutOffCalls, cutOffNote, pendingInterruption, recordCutOffCalls, TurnSteps } from "./interrupted-turn.js"
import { controlNote } from "./control-launch.js"
import { classifyProviderFailure, classifyStartFailure } from "./contracts/provider-failure.js"
import { carriedUsage, spendBetween } from "./session-usage.js"
import { CONNECTION_LOST_STOP, RETRIES_EXHAUSTED_STOP, type ContextBreakdown } from "./contracts/providers-acp.js"
import {
  AUTO_CONTINUE_DELAY_MS,
  autoContinueCandidate,
  continueTurnPrompt,
} from "./contracts/turn-continuation.js"

import { LiveJournal, LiveRequestSchema, journalIds } from "./live-journal.js"
import { hostLog, hostWarn } from "./host-log.js"
import type { JournalFacts, SourceRef } from "./thread-store.js"
import { SessionIdSchema, ThreadIdSchema, type Actor } from "./contracts/thread-identity.js"

export const PROVIDER_IDLE_MS = 10 * 60_000
export const PROVIDER_WARM_LIMIT = 2

/** Owns durable conversation intent and observation. Providers still own execution. */
export class LiveConversations {
  private shutdown?: Promise<void>
  private readonly stops = new Map<string, { requestId: string; result: Promise<boolean> }>()
  private readonly checkpoints: LiveCheckpoints
  private readonly questions: LiveQuestions
  private readonly approvals: LiveApprovals
  private readonly actions: LiveActions
  private readonly transfers: LiveTransfers
  private readonly children: LiveChildren
  /** Which Sessions this environment may run, and moving Threads to another. */
  readonly moves: LiveMoves
  private readonly records = new Map<string, Resident>()
  private readonly closedCache = new Map<string, { bytes: number; revision: number }>()
  private readonly bindingOwners = new Map<string, string>()
  private readonly captures = new Map<string, Promise<LiveSnapshot>>()
  // Refresh reads an already durable conversation; unlike an initial capture,
  // it must not hold shutdown open while waiting on an external native store.
  private readonly refreshes = new Map<string, Promise<LiveSnapshot>>()
  private readonly starts = new Map<string, Promise<LiveSessionState>>()
  private readonly recovered = new Map<string, LiveSummary>()
  /** What each journal last told the Thread store, so a flush registers only news. */
  private readonly registeredThreads = new Map<string, string>()
  private placementWarned = false
  private readonly assets: LiveAssets
  private readonly dependencies: Dependencies
  /**
   * One generation per host life. Every batch and snapshot carries it so a
   * renderer can tell a revision numbered by this host from one numbered by
   * the host before it, and re-snapshot instead of merging across the seam.
   */
  readonly epoch = randomUUID()
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.assets = new LiveAssets(join(dependencies.root, "assets"))
    const access: LiveAccess = {
      discoverNativePath: (resident) => this.discoverNativePath(resident),
      observe: (event) => this.observe(event),
      retainAttachments: (attachments) => this.assets.retainPrompt(attachments),
      close: (id) => this.close(id),
      pending: (resident) => this.transfers.pending(resident),
      storageFailed: (resident, boundary) =>
        this.storageFailed(resident, boundary),
      dependencies,
      bindingOwners: this.bindingOwners,
      require: (id) => this.require(id),
      load: (id) => this.load(id),
      control: (resident) => this.control(resident),
      flush: (resident) => this.flush(resident),
      drain: (resident) => this.drain(resident),
      residencyChanged: (resident) => this.scheduleHibernation(resident),
      driverEvents: (resident, bindingId) =>
        this.driverEvents(resident, bindingId),
      agentActor: (conversationId) => this.agentActor(conversationId),
    }
    this.checkpoints = new LiveCheckpoints(access, (id, input) =>
      this.fork(id, input)
    )
    this.approvals = new LiveApprovals(access)
    this.questions = new LiveQuestions(access, {
      continue: (id, bindingId, requestId, text, displayText) => { this.continueBinding(id, bindingId, requestId, text, [], undefined, displayText) },
      steer: (id, input) => this.act(id, input),
    })
    this.actions = new LiveActions(access)
    this.moves = new LiveMoves({
      dependencies,
      resident: (id) => this.records.get(id),
      control: (resident) => this.control(resident),
      pending: (resident) => this.transfers.pending(resident),
      canHibernate: (resident) => this.canHibernate(resident),
      hibernate: (resident, reason) => this.hibernate(resident, reason),
      resume: (resident) => {
        if (!resident.driver && resident.snapshot.session.connection === "hibernated" &&
            resident.snapshot.requests.some((request) => request.status === "queued"))
          void this.wake(resident)
        else this.drain(resident)
      },
    })
    this.transfers = new LiveTransfers(access)
    this.children = new LiveChildren(access)
    const journals: JournalFacts[] = []
    for (const id of journalIds(dependencies.root)) {
      try {
        const journal = new LiveJournal(dependencies.root, id)
        try {
          const found = journal.summary()
          if (found) {
            const { ancestry, threadSession, ...summary } = found
            dependencies.memory?.rememberBindings(id, summary.nativeBindings, summary.createdAt)
            this.backfillMemory(id, summary.session)
            journals.push({
              conversationId: id,
              createdAt: summary.createdAt,
              harness: summary.session.harness,
              threadPath: summary.threadPath,
              bindings: summary.nativeBindings,
              ancestry,
              session: threadSession ? SessionIdSchema.parse(threadSession) : undefined,
            })
            this.recovered.set(id, {
              ...summary,
              session: {
                ...summary.session,
                status:
                  summary.session.status === "closed"
                    ? "closed"
                    : summary.session.status === "ready"
                      ? "ready"
                      : "failed",
                connection: "disconnected",
                error:
                  "The previous provider connection ended. Its saved output is available.",
              },
            })
          }
        } finally {
          journal.close()
        }
      } catch (error) {
        dependencies.emit({
          type: "notice",
          level: "error",
          message: `Saved conversation ${id} could not be opened. Its journal has been preserved for recovery. ${errorMessage({ error })}`,
        })
      }
    }
    this.registerJournals(journals)
  }

  /**
   * Each host offers its journals to the Thread store at start, oldest
   * first. A journal registered before keeps its Session, so a restart
   * changes nothing; one written by a host without the store joins the
   * Session its paths and native IDs name.
   */
  private registerJournals(journals: JournalFacts[]): void {
    const threads = this.dependencies.threads
    if (!threads || !journals.length) return
    try {
      threads.registerJournals(journals, { kind: "service", name: "migration" })
      for (const facts of journals) this.registeredThreads.set(facts.conversationId, registrationKey(facts))
    } catch (error) {
      hostWarn("threads", "journal registration failed", { error: errorMessage({ error }) })
    }
  }

  /** Register a journal when it is created or its bindings name something new. */
  private registerThread(snapshot: LiveSnapshot, actor: Actor | undefined): void {
    const threads = this.dependencies.threads
    if (!threads) return
    const facts = snapshotFacts(snapshot)
    const key = registrationKey(facts)
    if (this.registeredThreads.get(facts.conversationId) === key) return
    try {
      const placed = threads.registerJournal(facts, actor ?? { kind: "service", name: "catalog" })
      const first = !this.registeredThreads.has(facts.conversationId)
      this.registeredThreads.set(facts.conversationId, key)
      if (first && facts.session) this.announceGroup(placed.thread)
    } catch (error) {
      hostWarn("threads", "journal registration failed", { conversation: facts.conversationId, error: errorMessage({ error }) })
    }
  }

  /**
   * Only a new Thread is started for a purpose; a resume or a `+` tab joins
   * one that already is what it is. Written before the provider spawns, so
   * the row shows it from the first frame; a failure leaves it unmarked.
   */
  private markPurpose(conversationId: string, purpose: StartPurpose, options: LiveStartOptions): void {
    const threads = this.dependencies.threads
    if (!threads || options.resume || options.session !== undefined) return
    try {
      const placed = threads.journalPlacement(conversationId)
      if (!placed) throw new Error("the conversation has no Thread yet")
      threads.markPurpose(placed.thread, purpose.kind, purpose.project)
      this.dependencies.emit({ type: "thread-purposes", purposes: threads.purposes() })
      // The name Mako gave the job stays the Thread's; no agent or model renames it.
      const kept = options.title ? threads.keepThreadTitle(placed.thread, options.title) : undefined
      if (kept) this.dependencies.emit({ type: "thread-titles", titles: [kept] })
    } catch (error) {
      hostWarn("threads", "a Thread's purpose could not be recorded", { conversation: conversationId, purpose: purpose.kind, error: errorMessage({ error }) })
    }
  }

  /**
   * A `+` tab's Session, checked before the journal exists: a tab left open
   * after its Session was merged away fails here and leaves no conversation.
   */
  private startingSession(session: string): string {
    const id = SessionIdSchema.parse(session)
    if (this.dependencies.threads && !this.dependencies.threads.sessionPlacement(id))
      throw new Error("This tab's session no longer exists. Open a new tab and send again; your draft is kept.")
    return id
  }

  /** The initiator of an admitted request: the local person unless a caller inside the host says otherwise. */
  private actor(explicit?: Actor): Actor | undefined {
    return explicit ?? this.dependencies.threads?.person()
  }

  private agentActor(conversationId: string): Actor | undefined {
    const session = this.dependencies.threads?.journalPlacement(conversationId)?.session
    return session ? { kind: "agent", session } : undefined
  }

  /**
   * Whether an existing journal is the same Session as the row being opened.
   * Two stores can share a native ID (a Cursor agent and its `chats/` copy);
   * the Thread store tells them apart. Without it, a journal captured from a
   * catalog row still names that row's identity; one started here does not,
   * and its native ID decides.
   */
  private sameSession(conversationId: string, ref: SourceRef): boolean {
    const threads = this.dependencies.threads
    if (!threads) {
      const captured = this.load(conversationId)?.snapshot.base?.ref
      return !captured || captured.harness !== ref.harness || threadIdentity(captured) === threadIdentity(ref)
    }
    try {
      const placed = threads.place(ref, { kind: "service", name: "catalog" })
      return threads.journalPlacement(conversationId)?.session === placed.session
    } catch (error) {
      hostWarn("threads", "capture ownership fell back to the native ID", { conversation: conversationId, error: errorMessage({ error }) })
      return true
    }
  }

  /**
   * A journal written before the ledger existed is this host's only record of
   * what its sessions ran under; another host serving the same store had
   * nothing. Each host offers its journals to the ledger once at start,
   * stamped with the journal's write time so a newer observation stays.
   */
  private backfillMemory(id: string, session: LiveSessionState): void {
    const memory = this.dependencies.memory
    if (!memory || !session.nativeId) return
    if (!session.settings && session.currentMode === null) return
    try {
      const facts: SessionFacts = {}
      if (session.settings) facts.settings = session.settings
      if (session.currentMode !== null) facts.modeId = session.currentMode
      // Recent writes sit in the WAL while the main file's mtime stays put.
      const file = join(this.dependencies.root, `${id}.sqlite`)
      const wal = statSync(`${file}-wal`, { throwIfNoEntry: false })
      const at = Math.max(statSync(file).mtimeMs, wal?.mtimeMs ?? 0)
      memory.backfill(session.harness, session.nativeId, facts, at)
    } catch (error) {
      hostWarn("memory", "journal backfill failed", {
        conversation: id,
        harness: session.harness,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  hasActiveWork(): boolean { return this.lifecycleWork().length > 0 }

  residency(): ProviderResidencySnapshot {
    const entries: ProviderResidencyEntry[] = [...this.records.values()]
      .filter(
        (resident) => resident.snapshot.session.status !== "closed"
      )
      .map(
      (resident) => {
        const { session } = resident.snapshot
        const control = this.control(resident)
        const binding = control.bindings.find(
          (candidate) => candidate.id === control.activeBindingId
        )
        const resumable =
          Boolean(binding?.nativeId && binding.path) &&
          resident.snapshot.requests.some(
            (request) =>
              request.status === "completed" ||
              request.status === "interrupted"
          )
        const state: ProviderResidencyEntry["state"] =
          session.connection === "hibernated"
            ? "hibernated"
            : session.connection === "disconnected"
              ? "disconnected"
              : session.status === "running" ||
                  session.backgroundTasks ||
                  resident.snapshot.nativeAgents?.agents.some(isActiveNativeAgent) ||
                  resident.opening ||
                  resident.transferring ||
                  resident.snapshot.requests.some(
                    (request) =>
                      request.status === "queued" ||
                      request.status === "dispatching"
                  )
                ? "active"
                : resumable
                  ? "warm"
                  : "protected"
        return {
          conversationId: session.id,
          provider: session.harness,
          title: session.title || "Untitled conversation",
          state,
        }
      }
      )
    const count = (state: ProviderResidencyEntry["state"]) =>
      entries.filter((entry) => entry.state === state).length
    return {
      entries,
      active: count("active"),
      warm: count("warm"),
      protected: count("protected"),
      hibernated: count("hibernated"),
      disconnected: count("disconnected"),
      warmLimit:
        this.dependencies.providerWarmLimit ?? PROVIDER_WARM_LIMIT,
      idleMs: this.dependencies.providerIdleMs ?? PROVIDER_IDLE_MS,
    }
  }

  lifecycleWork(): LifecycleWork[] {
    const work: LifecycleWork[] = [...this.records.values()].flatMap((resident) => {
      const { snapshot } = resident
      const finishing = resident.transferring || resident.opening || resident.checkpointing || resident.rewinding || resident.closing
      const requests = snapshot.requests.filter((request) => request.status === "dispatching" || request.status === "queued")
      const native = snapshot.nativeAgents?.agents.filter(isActiveNativeAgent) ?? []
      const background = Boolean(snapshot.session.backgroundTasks)
      if (!finishing && (!resident.driver || (snapshot.session.status !== "running" && !background && !requests.length && !native.length && !snapshot.permissions.length))) return []
      const status = finishing ? "finishing" : snapshot.permissions.length || native.some((agent) => agent.state.kind === "waiting") ? "waiting" : snapshot.session.status === "running" || background || native.some((agent) => agent.state.kind === "working") ? "running" : "queued"
      return [{ id: snapshot.session.id, token: `${resident.generation}:${requests.map((request) => request.id).join(":")}:${JSON.stringify(native.map((agent) => [agent.nativeId, agent.nativeRunId ?? agent.observedAt]))}`, title: snapshot.session.title || "Untitled conversation", provider: snapshot.session.harness, cwd: snapshot.session.cwd, status, stoppable: !finishing }]
    })
    for (const id of this.starts.keys()) if (!work.some((item) => item.id === id)) work.push({ id, token: id, title: "Starting an agent", provider: "", cwd: "", status: "finishing", stoppable: false })
    for (const path of this.captures.keys()) work.push({ id: `capture:${path}`, token: path, title: "Saving a conversation", provider: "", cwd: path, status: "finishing", stoppable: false })
    return work
  }

  async closeForExit(ids = [...this.records.keys()]): Promise<void> {
    const results = await Promise.allSettled(ids.map(async (id) => {
      const resident = this.records.get(id)
      if (
        !resident ||
        (resident.snapshot.session.status === "closed" &&
          !resident.driver &&
          !resident.connections.size &&
          !resident.opening &&
          !resident.hibernating &&
          !resident.waking &&
          !resident.transferOperation)
      )
        return
      resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((request) => request.status === "queued" ? { ...request, status: "held" } : request) }
      this.flush(resident)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.close(id), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("A provider did not finish closing. Mako stayed open; wait for it to settle before trying again.")), 30_000) })])
      } finally { clearTimeout(timer) }
    }))
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  summaries(): LiveSummary[] {
    return [
      ...[...this.recovered.values()].map((summary) => ({ ...summary, epoch: this.epoch, ...this.placement(summary.session.id) })),
      ...[...this.records.values()].map(({ snapshot }) => ({
        hasSessionQuestions: Boolean(snapshot.control?.questions?.length),
        nativePaths: snapshot.control?.bindings.flatMap((binding) =>
          binding.path ? [binding.path] : []
        ),
        session: snapshot.session,
        revision: snapshot.revision,
        epoch: this.epoch,
        threadPath: snapshot.threadPath,
        createdAt: snapshot.createdAt,
        ...this.placement(snapshot.session.id),
      })),
    ]
  }

  /**
   * The Thread and Session a window files this conversation under. Read at
   * the edge and never written into the journal: a merge or a move changes
   * it, and the store is the one place that knows.
   */
  private placement(id: string): Pick<LiveSummary, "threadId" | "sessionId"> {
    try {
      const placed = this.dependencies.threads?.journalPlacement(id)
      return placed ? { threadId: placed.thread, sessionId: placed.session } : {}
    } catch (error) {
      if (!this.placementWarned) hostWarn("threads", "a conversation's Thread could not be read; it is served without one", { conversation: id, error: errorMessage({ error }) })
      this.placementWarned = true
      return {}
    }
  }

  /** A connected driver is authoritative even if a ledger write failed earlier. */
  connectedSession(provider: string, nativeId: string): string | null {
    for (const { snapshot } of this.records.values()) {
      const session = snapshot.session
      if (session.connection === "connected" && session.harness === provider && session.nativeId === nativeId) {
        this.syncMemory(session, session)
        return session.id
      }
    }
    return null
  }

  /** The connected session's context by category; `null` when its harness does not itemize it or nothing is connected. */
  async contextBreakdown(id: string): Promise<ContextBreakdown | null> {
    const resident = this.load(id)
    const bindingId = resident && this.control(resident).activeBindingId
    if (!resident?.driver?.contextBreakdown || !bindingId || resident.snapshot.session.connection !== "connected") return null
    return resident.driver.contextBreakdown(bindingId)
  }

  snapshot(id: string): LiveSnapshot | null {
    const resident = this.load(id)
    if (!resident) return null
    this.flush(resident)
    return this.stamp(resident.snapshot)
  }

  /** Observe native history independently of whether another client owns execution.
   * A single binding records which retained live blocks its native store covers. */
  async refreshedSnapshot(id: string): Promise<LiveSnapshot | null> {
    const resident = this.load(id)
    if (!resident) return null
    try {
      const catchup = this.questions.reconcile(resident)
      if (catchup) await catchup
    } catch (error) {
      hostLog("live", "native question refresh deferred", { conversation: id, error: errorMessage({ error }) })
    }
    this.flush(resident)
    const base = resident.snapshot.base
    const bindings = resident.snapshot.control?.bindings ?? []
    const binding = bindings.length === 1 ? bindings[0] : undefined
    const path = binding?.path ?? base?.ref.path
    const nativeId = binding?.nativeId ?? base?.ref.nativeId
    const provider = binding?.provider ?? base?.ref.harness
    const covered = binding?.coveredBlocks ?? 0
    if (!path || !nativeId || resident.opening || resident.transferring ||
        resident.snapshot.session.status === "running" ||
        resident.snapshot.requests.some((request) => request.status === "dispatching") ||
        (resident.snapshot.blocks.length > 0 &&
          (!binding?.includesBase || covered !== resident.snapshot.blocks.length)))
      return this.snapshot(id)
    const pending = this.refreshes.get(id)
    if (pending) return pending
    const before = resident.snapshot
    const generation = resident.generation
    const work = (async (): Promise<LiveSnapshot> => {
      try {
        const latest = await this.dependencies.history(path)
        if (!latest || latest.ref.nativeId !== nativeId || latest.ref.harness !== provider)
          return this.stamp(resident.snapshot)
        const sameRevision = base && (resident.snapshot.baseCoveredBlocks ?? 0) === covered && latest.checkpoint !== undefined && latest.checkpoint === base.checkpoint &&
          latest.translator === base.translator &&
          latest.ref.bytes === base.ref.bytes && latest.ref.revision === base.ref.revision &&
          latest.ref.updatedAt === base.ref.updatedAt && latest.total === base.total
        if (sameRevision) return this.stamp(resident.snapshot)
        const refreshed = await captureNativeHistory(path, (path, before) =>
          before === undefined ? Promise.resolve(latest) : this.dependencies.history(path, before))
        if (refreshed && this.records.get(id) === resident &&
            resident.snapshot === before && resident.generation === generation &&
            !resident.opening && !resident.transferring && !lifecycleBlocked() &&
            ((before.baseCoveredBlocks ?? 0) !== covered || !isDeepStrictEqual(base, refreshed))) {
          resident.snapshot = { ...before, base: refreshed, baseCoveredBlocks: covered }
          this.flush(resident)
        }
      } catch (error) {
        hostLog("live", "native history refresh deferred", { conversation: id, error: errorMessage({ error }) })
      }
      return this.stamp(resident.snapshot)
    })()
    this.refreshes.set(id, work)
    void work.finally(() => this.refreshes.delete(id)).catch(() => {})
    return work
  }

  hibernateIfIdle(id: string, reason = "explicit"): boolean {
    const resident = this.load(id)
    if (!resident || !this.canHibernate(resident)) return false
    void this.hibernate(resident, reason)
    return true
  }

  setArchived(id: string, archived: boolean): void {
    const resident = this.load(id)
    if (!resident) return
    resident.retireWhenIdle = archived
    if (archived) {
      if (this.canHibernate(resident))
        void this.hibernate(resident, "thread-archived")
    } else if (this.canHibernate(resident)) {
      this.scheduleHibernation(resident)
    }
  }

  /** The snapshot as this host numbers it; the renderer merges batches only onto the same epoch. */
  private stamp(snapshot: LiveSnapshot): LiveSnapshot {
    const placed = this.placement(snapshot.session.id)
    return snapshot.epoch === this.epoch && snapshot.threadId === placed.threadId && snapshot.sessionId === placed.sessionId
      ? snapshot
      : { ...snapshot, epoch: this.epoch, ...placed }
  }

  capture(id: string, path: string): Promise<LiveSnapshot> {
    assertLifecycleAdmission()
    z.string().uuid().parse(id)
    const owned = this.summaries().find(
      (summary) =>
        summary.threadPath === path || summary.nativePaths?.includes(path)
    )
    if (owned) return Promise.resolve(this.require(owned.session.id).snapshot)
    const pending = this.captures.get(path)
    if (pending) return pending
    const work = this.captureNative(id, path)
    this.captures.set(path, work)
    void work.finally(() => this.captures.delete(path)).catch(() => {})
    return work
  }

  private async captureNative(id: string, path: string): Promise<LiveSnapshot> {
    const existing = this.load(id)
    if (existing) {
      if (existing.snapshot.base?.ref.path !== path)
        throw new Error("This conversation ID belongs to another source")
      return existing.snapshot
    }
    const before = await this.dependencies.checkpoint?.(path)
    const base = await captureNativeHistory(path, this.dependencies.history)
    if (!base) throw new Error("The source history could not be captured")
    const owned = this.summaries().find((summary) =>
      summary.session.harness === base.ref.harness &&
      summary.session.nativeId === base.ref.nativeId &&
      this.sameSession(summary.session.id, { harness: base.ref.harness, nativeId: base.ref.nativeId, identity: base.ref.identity, path })
    )
    if (owned) return this.require(owned.session.id).snapshot
    const after = await this.dependencies.checkpoint?.(path, base.ref.harness)
    const checkpoint = before === after ? after : undefined
    const snapshot: LiveSnapshot = {
      session: {
        id,
        harness: base.ref.harness,
        nativeId: base.ref.nativeId,
        settings: base.ref.settings,
        cwd: base.ref.cwd ?? "",
        title: base.ref.title,
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 0,
      createdAt: Date.now(),
      threadPath: path,
      base,
      blocks: [],
      permissions: [],
      requests: [],
      control: {
        children: [],
        merges: [],
        activeBindingId: id,
        bindings: [
          {
            id,
            provider: base.ref.harness,
            nativeId: base.ref.nativeId,
            path,
            checkpoint,
            tuning: base.ref.settings,
            coveredBlocks: 0,
            includesBase: true,
          },
        ],
        transfers: [],
      },
    }
    const journal = new LiveJournal(this.dependencies.root, id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.records.set(id, {
      snapshot,
      journalSnapshot: snapshot,
      journal,
      driver: null,
      connections: new Map(),
      bindingGenerations: new Map(),
      transferring: false,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    })
    this.registerThread(snapshot, this.actor())
    try { await this.questions.reconcile(this.require(id)) } catch (error) {
      hostLog("live", "native question import deferred", { conversation: id, error: errorMessage({ error }) })
    }
    return this.require(id).snapshot
  }

  start(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    actor?: Actor,
    purpose?: StartPurpose
  ): Promise<LiveSessionState> {
    assertLifecycleAdmission()
    z.string().uuid().parse(options.conversationId)
    const pending = this.starts.get(options.conversationId)
    if (pending) return pending
    const existing = this.load(options.conversationId)
    if (existing) {
      if (
        existing.snapshot.session.harness !== provider ||
        existing.snapshot.session.cwd !== cwd
      )
        return Promise.reject(
          new Error(
            "This conversation ID already belongs to a different provider or workspace"
          )
        )
      return Promise.resolve(existing.snapshot.session)
    }
    const start = this.open(provider, cwd, options, actor, purpose)
    this.starts.set(options.conversationId, start)
    void start
      .finally(() => this.starts.delete(options.conversationId))
      .catch(() => {})
    return start
  }

  private async open(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    actor?: Actor,
    purpose?: StartPurpose
  ): Promise<LiveSessionState> {
    const driver = this.dependencies.driver(provider)
    if (!driver?.available(this.dependencies.appPath))
      throw new Error(`${provider} has no available interactive transport`)
    // The tier a reopened session last ran under travels into the launch: a
    // launch-enforced tier (OpenCode's Ask, every Grok tier) is read from the
    // process environment and can never be applied to a running session.
    const remembered = options.resume
      ? this.dependencies.memory?.recall(provider, options.resume)
      : undefined
    const rememberedMode =
      !options.modeId ? remembered?.modeId : undefined
    const modeId = options.modeId ?? rememberedMode
    const tuning = options.tuning ?? remembered?.settings
    const base = options.threadPath
      ? await captureNativeHistory(
          options.threadPath,
          this.dependencies.history
        )
      : null
    if (options.threadPath && !base)
      throw new Error(
        "The saved history could not be loaded; the conversation was not started"
      )
    const id = options.conversationId
    const session = options.session === undefined ? undefined : this.startingSession(options.session)
    const snapshot: LiveSnapshot = {
      control: {
        children: [],
        merges: [],
        session,
        activeBindingId: id,
        bindings: [
          {
            id,
            provider,
            coveredBlocks: 0,
            includesBase: Boolean(options.resume) || !base,
            nativeId: options.resume,
            path: options.threadPath,
            tuning,
            modeId,
          },
        ],
        transfers: [],
      },
      session: {
        id,
        harness: provider,
        cwd,
        title: options.title,
        status: "starting",
        connection: "starting",
        modes: [],
        currentMode: null,
        configOptions: [],
        settings: tuning,
      },
      revision: 0,
      threadPath: options.threadPath,
      createdAt: Date.now(),
      base,
      blocks: [],
      permissions: [],
      requests: options.initialRequest
        ? [
            LiveRequestSchema.parse({
              ...options.initialRequest,
              actor: this.actor(actor),
              targetBindingId: options.resume ? id : undefined,
              displayText: options.displayPrompt,
              tuning,
              inputDigest: promptFingerprint(
                options.initialRequest.text,
                options.initialRequest.attachments,
                tuning
              ),
              attachments: this.assets.retainPrompt(
                options.initialRequest.attachments
              ),
              status: "queued",
            }),
          ]
        : [],
    }
    // Checked with no wait before the journal exists, so a move released
    // during the history read above is seen here.
    this.moves.assertOpens(snapshotFacts(snapshot))
    const resident: Resident = {
      connections: new Map(),
      bindingGenerations: new Map(),
      transferring: false,
      snapshot,
      journalSnapshot: snapshot,
      driver,
      journal: new LiveJournal(this.dependencies.root, id),
      generation: 0,
      opening: true,
      pendingCharacters: 0,
      updates: [],
      timer: null,
      displayPrompt: options.displayPrompt,
    }
    let held = false
    try {
      // The ledger hold is taken after every fallible history read but before
      // anything can spawn. A failed journal commit releases it immediately.
      if (options.resume) {
        this.dependencies.memory?.hold(
          provider,
          options.resume,
          options.conversationId
        )
        held = true
      }
      resident.journal.commit(snapshot)
    } catch (error) {
      resident.journal.close()
      if (held && options.resume)
        this.releaseHold(provider, options.resume, options.conversationId)
      throw error
    }
    this.records.set(id, resident)
    this.bindingOwners.set(id, id)
    this.registerThread(snapshot, this.actor(actor))
    if (purpose) this.markPurpose(id, purpose, options)
    const generation = resident.generation
    const openingOperation = Promise.resolve()
      .then(async () => {
        const conversationTools = await this.dependencies.tools?.(id, id)
        const threadEnvironment = await this.dependencies.threadEnvironment?.(id, options.title, cwd)
        // Preparation may finish after Close or an execution-ownership move.
        // Check and start without yielding so a stale owner never spawns.
        if (resident.generation !== generation || resident.closing || !this.moves.executes(resident))
          throw new Error("Execution ownership changed while preparing the native session.")
        return driver.start(cwd, {
        ...options,
        modeId,
        tuning,
        emit: this.driverEvents(resident, id),
        mcpSnapshot: this.dependencies.mcpSnapshot
          ? () => this.dependencies.mcpSnapshot!(cwd)
          : undefined,
          conversationTools,
          threadEnvironment,
        })
      })
      .then(async (session) => {
        if (resident.generation !== generation) {
          try {
            await driver.close(id)
            await this.revokeTools(id, id)
            resident.opening = false
            resident.driver = null
          } catch (error) {
            resident.driver = driver
            resident.connections.set(id, { driver, session })
            throw error
          }
          return
        }
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...session,
            title: session.title ?? resident.snapshot.session.title,
          },
        }
        resident.connections.set(id, { driver, session })
        this.updateBinding(resident, session)
        // A host- or launch-enforced tier is already current when the session
        // reports; a provider's own mode (Cursor's plan) is applied here. An
        // explicit choice must apply or fail; the ledger's memory applies only
        // when the session still offers it.
        const offered = session.modes.some((mode) => mode.id === modeId)
        if (modeId && modeId !== session.currentMode && (offered || options.modeId)) {
          if (!offered)
            throw new Error("The saved agent mode is no longer available. Choose a mode before sending.")
          await driver.setMode(id, modeId)
          if (resident.generation !== generation) return
          resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, currentMode: modeId } }
        }
        resident.opening = false
        this.flush(resident)
        this.drain(resident)
        this.scheduleHibernation(resident)
      })
      .catch(async (error) => {
        if (resident.generation !== generation) return
        const closed = await Promise.resolve(driver.close(id)).then(
          () => true,
          () => false
        )
        await this.revokeTools(id, id)
        resident.opening = !closed
        resident.driver = closed ? null : driver
        if (closed) resident.connections.clear()
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          session: {
            ...resident.snapshot.session,
            status: "failed",
            connection: closed ? "disconnected" : "connected",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((request) =>
            request.status === "queued"
              ? {
                  ...request,
                  status: "failed",
                  error: errorMessage({ error }),
                  failure: classifyStartFailure(errorMessage({ error }), options.resume !== undefined),
                  nativeDelivery: this.unsentStartupDelivery(resident, request, errorMessage({ error })),
                }
              : request
          ),
        }
        this.flush(resident)
        if (closed && options.resume)
          this.releaseHold(provider, options.resume, id)
      })
    resident.openingOperation = openingOperation
    void openingOperation.finally(() => {
      if (resident.openingOperation === openingOperation)
        resident.openingOperation = undefined
    })
    return snapshot.session
  }

  private releaseHold(provider: string, nativeId: string, conversationId: string): void {
    try {
      this.dependencies.memory?.release(provider, nativeId, conversationId)
    } catch (error) {
      hostWarn("memory", "release failed", { harness: provider, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async revokeTools(
    bindingId: string,
    conversationId: string
  ): Promise<void> {
    try {
      await this.dependencies.revokeTools?.(bindingId, conversationId)
    } catch (error) {
      hostWarn("residency", "control grant revocation failed", {
        conversation: conversationId,
        binding: bindingId,
        error: errorMessage({ error }),
      })
    }
  }

  private unsentStartupDelivery(resident: Resident, request: LiveRequest, reason: string): NonNullable<LiveRequest["nativeDelivery"]> {
    // Only queued requests reach this path: opening/waking blocks drain before
    // prompt dispatch. Preserve any earlier attempt's evidence rather than
    // converting a retained ambiguous receipt into a proven refusal.
    return request.nativeDelivery ?? {
      attemptId: randomUUID(),
      bindingId: this.control(resident).activeBindingId,
      ownerEpoch: this.epoch,
      evidence: { kind: "not-accepted", source: "preflight", reason },
    }
  }

  private driverEvents(
    resident: Resident,
    bindingId: string
  ): (event: LiveDriverEvent) => void {
    const bindingGeneration =
      (resident.bindingGenerations.get(bindingId) ?? 0) + 1
    const residentGeneration = resident.generation
    resident.bindingGenerations.set(bindingId, bindingGeneration)
    return (event) => {
      if (
        resident.generation === residentGeneration &&
        resident.bindingGenerations.get(bindingId) === bindingGeneration
      )
        this.observe(event)
    }
  }

  private activeBinding(resident: Resident): ProviderBinding | undefined {
    const control = this.control(resident)
    return control.bindings.find(
      (binding) => binding.id === control.activeBindingId
    )
  }

  private clearHibernationTimer(resident: Resident, clearSince = true): void {
    if (resident.idleTimer) clearTimeout(resident.idleTimer)
    resident.idleTimer = undefined
    if (clearSince) resident.idleSince = undefined
  }

  private canHibernate(resident: Resident, preparing = false): boolean {
    const native = resident.snapshot.nativeAgents?.agents ?? []
    const children = this.control(resident).children
    const binding = this.activeBinding(resident)
    const driver = this.dependencies.driver(binding?.provider ?? "")
    return Boolean(
      resident.driver &&
        driver?.canResume &&
        resident.snapshot.session.connection === "connected" &&
        resident.snapshot.session.status === "ready" &&
        !resident.snapshot.session.backgroundTasks &&
        binding?.nativeId &&
        binding.path &&
        !resident.opening &&
        !resident.closing &&
        (!resident.hibernating || preparing) &&
        !resident.waking &&
        !resident.transferring &&
        !resident.checkpointing &&
        !resident.rewinding &&
        !resident.autoContinue &&
        !resident.snapshot.permissions.length &&
        resident.snapshot.requests.some(
          (request) =>
            request.status === "completed" ||
            request.status === "interrupted"
        ) &&
        !resident.snapshot.requests.some(
          (request) =>
            request.status === "dispatching" ||
            (request.status === "queued" && !this.moves.holdsQueued(resident))
        ) &&
        !native.some(isActiveNativeAgent) &&
        !children.some(
          (child) =>
            child.status === "starting" ||
            child.status === "working" ||
            child.status === "needs-permission" ||
            child.delivery === "pending" ||
            child.delivery === "queued"
        )
    )
  }

  private scheduleHibernation(
    resident: Resident,
    enforceWarmLimit = true
  ): void {
    if (!this.canHibernate(resident)) {
      this.clearHibernationTimer(resident)
      return
    }
    const now = this.dependencies.now?.() ?? Date.now()
    resident.idleSince ??= now
    if (resident.retireWhenIdle) {
      void this.hibernate(resident, "thread-archived")
      return
    }
    if (resident.idleTimer) clearTimeout(resident.idleTimer)
    const idleMs = this.dependencies.providerIdleMs ?? PROVIDER_IDLE_MS
    resident.idleTimer = setTimeout(() => {
      resident.idleTimer = undefined
      void this.hibernate(resident, "idle-timeout")
    }, Math.max(0, idleMs - (now - resident.idleSince)))
    resident.idleTimer.unref?.()
    if (!enforceWarmLimit) return
    const warmLimit =
      this.dependencies.providerWarmLimit ?? PROVIDER_WARM_LIMIT
    const warm = [...this.records.values()]
      .filter((candidate) => this.canHibernate(candidate))
      .sort(
        (left, right) =>
          (left.idleSince ?? Number.POSITIVE_INFINITY) -
          (right.idleSince ?? Number.POSITIVE_INFINITY)
      )
    for (const candidate of warm.slice(
      0,
      Math.max(0, warm.length - warmLimit)
    ))
      void this.hibernate(candidate, "warm-pool-limit")
  }

  private async refreshIdleCheckpoint(
    resident: Resident,
    binding: ProviderBinding,
    generation: number
  ): Promise<boolean> {
    if (!binding.path || !this.dependencies.checkpoint)
      return Boolean(binding.path)
    const checkpoint = await this.dependencies.checkpoint(
      binding.path,
      binding.provider
    )
    if (
      !checkpoint ||
      resident.generation !== generation ||
      this.activeBinding(resident)?.id !== binding.id
    )
      return false
    const control = this.control(resident)
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        bindings: control.bindings.map((candidate) =>
          candidate.id === binding.id
            ? {
                ...candidate,
                checkpoint,
                coveredBlocks: resident.snapshot.blocks.length,
              }
            : candidate
        ),
      },
    }
    this.flush(resident)
    return true
  }

  private hibernate(resident: Resident, reason: string): Promise<void> {
    if (resident.hibernating) return resident.hibernating
    const operation = this.hibernateNow(resident, reason)
      .catch((error) => {
        hostWarn("residency", "hibernate failed", {
          conversation: resident.snapshot.session.id,
          harness: resident.snapshot.session.harness,
          error: errorMessage({ error }),
        })
      })
      .finally(() => {
        if (resident.hibernating === operation) {
          resident.hibernating = undefined
          if (this.canHibernate(resident))
            this.scheduleHibernation(resident, false)
        }
      })
    resident.hibernating = operation
    return operation
  }

  private async hibernateNow(
    resident: Resident,
    reason: string
  ): Promise<void> {
    if (!this.canHibernate(resident)) return
    const binding = this.activeBinding(resident)
    if (!binding?.nativeId || !binding.path) return
    const generation = resident.generation
    this.clearHibernationTimer(resident)
    const checkpointReady = await this.refreshIdleCheckpoint(
      resident,
      binding,
      generation
    )
    if (
      !checkpointReady ||
      resident.generation !== generation ||
      !this.canHibernate(resident, true)
    )
      return
    const retiringGeneration = ++resident.generation
    const connectionIds = [...resident.connections.keys()]
    try {
      await Promise.all(
        [...resident.connections].map(([bindingId, connection]) =>
          connection.driver.close(bindingId)
        )
      )
    } catch (error) {
      if (resident.generation === retiringGeneration)
        resident.generation = generation
      throw error
    }
    if (resident.generation !== retiringGeneration) return
    await Promise.all(
      connectionIds.map((bindingId) =>
        this.revokeTools(bindingId, resident.snapshot.session.id)
      )
    )
    if (resident.generation !== retiringGeneration) return
    resident.connections.clear()
    resident.driver = null
    resident.snapshot = {
      ...resident.snapshot,
      nativeAgents: disconnectNativeAgents(resident.snapshot.nativeAgents),
      session: {
        ...resident.snapshot.session,
        connection: "hibernated",
        status: "ready",
        error: undefined,
      },
    }
    this.flush(resident)
    hostLog("residency", "provider hibernated", {
      conversation: resident.snapshot.session.id,
      harness: resident.snapshot.session.harness,
      nativeId: binding.nativeId,
      reason,
    })
  }

  private wake(resident: Resident): Promise<void> {
    if (resident.waking) return resident.waking
    const hibernating = resident.hibernating
    const operation = (async () => {
      await hibernating
      await this.wakeNow(resident)
    })().finally(() => {
      if (resident.waking === operation) {
        resident.waking = undefined
        this.drain(resident)
      }
    })
    resident.waking = operation
    return operation
  }

  private async wakeNow(resident: Resident): Promise<void> {
    if (
      !this.moves.executes(resident) ||
      resident.driver ||
      resident.snapshot.session.connection !== "hibernated" ||
      resident.snapshot.session.status === "closed"
    )
      return
    const binding = this.activeBinding(resident)
    const driver = this.dependencies.driver(binding?.provider ?? "")
    if (
      !binding?.nativeId ||
      !binding.path ||
      !driver?.canResume ||
      !driver.available(this.dependencies.appPath)
    ) {
      const message =
        "The hibernated provider has no resumable native session"
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...resident.snapshot.session,
          connection: "disconnected",
          status: "failed",
          error: message,
        },
        requests: resident.snapshot.requests.map((request) =>
          request.status === "queued"
            ? {
                ...request,
                status: "failed",
                error: message,
                failure: classifyStartFailure(message, true),
                nativeDelivery: this.unsentStartupDelivery(resident, request, message),
              }
            : request
        ),
      }
      this.flush(resident)
      return
    }
    const generation = ++resident.generation
    resident.opening = true
    resident.driver = driver
    resident.snapshot = {
      ...resident.snapshot,
      session: {
        ...resident.snapshot.session,
        connection: "starting",
        status: "starting",
        error: undefined,
      },
    }
    this.flush(resident)
    let held = false
    let startedSession: LiveSessionState | undefined
    try {
      const verdict = await this.dependencies.resumeVerdict?.(binding)
      if (!verdict || !resumable(verdict, "moved"))
        throw new Error(reconnectRefusal(verdict))
      if (resident.generation !== generation || resident.closing) return
      if (!this.moves.executes(resident)) throw new Error("Execution ownership changed while preparing native recovery.")
      this.dependencies.memory?.hold(
        binding.provider,
        binding.nativeId,
        resident.snapshot.session.id
      )
      held = true
      const modeId =
        resident.snapshot.session.currentMode ?? binding.modeId
      const tuning =
        resident.snapshot.requests.find(
          (request) => request.status === "queued"
        )?.tuning ??
        resident.snapshot.session.settings ??
        binding.tuning
      const conversationTools = await this.dependencies.tools?.(binding.id, resident.snapshot.session.id)
      const threadEnvironment = await this.dependencies.threadEnvironment?.(
        resident.snapshot.session.id, resident.snapshot.session.title, resident.snapshot.session.cwd
      )
      // Close or an ownership move may have happened during asynchronous preparation.
      // Keep this check and start in the same event-loop turn.
      if (resident.generation !== generation || resident.closing) {
        if (held) this.releaseHold(binding.provider, binding.nativeId, resident.snapshot.session.id)
        held = false
        return
      }
      if (!this.moves.executes(resident)) throw new Error("Execution ownership changed while preparing native recovery.")
      const session = await driver.start(resident.snapshot.session.cwd, {
        conversationId: binding.id,
        resume: binding.nativeId,
        observedAgents: resident.snapshot.nativeAgents?.agents.filter((agent) => agent.bindingId === binding.id && agent.provider === binding.provider),
        observedApprovals: knownApprovalOccurrences(this.control(resident), binding.id),
        threadPath: binding.path,
        title: resident.snapshot.session.title,
        tuning,
        modeId,
        launchModeId: resident.snapshot.session.launchMode,
        emit: this.driverEvents(resident, binding.id),
        mcpSnapshot: this.dependencies.mcpSnapshot
          ? () =>
              this.dependencies.mcpSnapshot!(resident.snapshot.session.cwd)
          : undefined,
        conversationTools,
        threadEnvironment,
      })
      startedSession = session
      if (resident.generation !== generation) {
        await driver.close(binding.id)
        await this.revokeTools(binding.id, resident.snapshot.session.id)
        if (held)
          this.releaseHold(
            binding.provider,
            binding.nativeId,
            resident.snapshot.session.id
          )
        return
      }
      if (
        session.status !== "ready" ||
        session.connection !== "connected"
      )
        throw new Error("The provider did not become ready while waking")
      if (session.nativeId !== binding.nativeId)
        throw new Error(
          "The provider returned a different session while waking. The saved conversation was not replaced."
        )
      await verifyRecoveredSession(binding, session, driver)
      if (
        modeId &&
        modeId !== session.currentMode &&
        !session.modes.some((mode) => mode.id === modeId)
      )
        throw new Error(
          "The saved agent mode is no longer available after waking"
        )
      if (modeId && modeId !== session.currentMode)
        await driver.setMode(binding.id, modeId)
      if (resident.generation !== generation) {
        await driver.close(binding.id)
        await this.revokeTools(binding.id, resident.snapshot.session.id)
        if (held)
          this.releaseHold(
            binding.provider,
            binding.nativeId,
            resident.snapshot.session.id
          )
        return
      }
      const connected = {
        ...session,
        id: resident.snapshot.session.id,
        title: session.title ?? resident.snapshot.session.title,
        currentMode: modeId ?? session.currentMode,
      }
      resident.connections.set(binding.id, {
        driver,
        session: { ...connected, id: binding.id },
      })
      resident.snapshot = { ...resident.snapshot, session: connected }
      this.updateBinding(resident, connected)
      const control = this.control(resident)
      resident.snapshot = {
        ...resident.snapshot,
        control: {
          ...control,
          bindings: control.bindings.map((candidate) =>
            candidate.id === binding.id
              ? {
                  ...candidate,
                  tuning: connected.settings ?? tuning,
                  modeId: connected.currentMode ?? modeId,
                }
              : candidate
          ),
        },
      }
      resident.opening = false
      this.flush(resident)
      hostLog("residency", "provider woke", {
        conversation: resident.snapshot.session.id,
        harness: binding.provider,
        nativeId: binding.nativeId,
      })
      this.drain(resident)
      this.scheduleHibernation(resident)
    } catch (error) {
      const closed = await Promise.resolve(driver.close(binding.id)).then(
        () => true,
        () => false
      )
      await this.revokeTools(binding.id, resident.snapshot.session.id)
      if (closed && held)
        this.releaseHold(
          binding.provider,
          binding.nativeId,
          resident.snapshot.session.id
        )
      if (!closed) {
        resident.driver = driver
        resident.opening = true
        if (startedSession)
          resident.connections.set(binding.id, {
            driver,
            session: startedSession,
          })
      }
      if (resident.generation !== generation) return
      const message = errorMessage({ error })
      if (closed) {
        resident.driver = null
        resident.connections.delete(binding.id)
        resident.opening = false
      }
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...resident.snapshot.session,
          connection: closed ? "disconnected" : "connected",
          nativeId: closed ? binding.nativeId : resident.snapshot.session.nativeId,
          nativePath: closed ? binding.path : resident.snapshot.session.nativePath,
          executionContext: closed ? binding.executionContext : resident.snapshot.session.executionContext,
          status: "failed",
          error: message,
        },
        requests: resident.snapshot.requests.map((request) =>
          request.status === "queued"
            ? {
                ...request,
                status: "failed",
                error: message,
                failure: classifyStartFailure(message, true),
                nativeDelivery: this.unsentStartupDelivery(resident, request, message),
              }
            : request
        ),
      }
      this.flush(resident)
      hostWarn("residency", "provider wake failed", {
        conversation: resident.snapshot.session.id,
        harness: binding.provider,
        nativeId: binding.nativeId,
        error: message,
      })
    }
  }

  observe(event: LiveDriverEvent): void {
    try {
      this.accept(event)
    } catch (error) {
      const id =
        event.type === "live-session"
          ? event.session.id
          : event.type === "live-permission"
            ? event.request.sessionId
            : event.id
      const resident = this.records.get(this.bindingOwners.get(id) ?? id)
      if (resident) this.storageFailed(resident, { error })
    }
  }

  private accept(raw: LiveDriverEvent): void {
    const bindingId =
      raw.type === "live-session"
        ? raw.session.id
        : raw.type === "live-permission"
          ? raw.request.sessionId
          : raw.id
    const owner = this.bindingOwners.get(bindingId) ?? bindingId
    const bound = this.records.get(owner)
    if (!bound) return
    if (this.control(bound).activeBindingId !== bindingId) {
      const connection = bound.connections.get(bindingId)
      if (connection && raw.type === "live-session") {
        connection.session = raw.session
        if (raw.session.connection === "disconnected") {
          bound.connections.delete(bindingId)
          void this.revokeTools(bindingId, owner)
        }
      }
      return
    }
    const event: LiveDriverEvent =
      raw.type === "live-session"
        ? { ...raw, session: { ...raw.session, id: owner } }
        : raw.type === "live-permission"
          ? { ...raw, request: { ...raw.request, sessionId: owner } }
          : { ...raw, id: owner }
    const id =
      event.type === "live-session"
        ? event.session.id
        : event.type === "live-permission"
          ? event.request.sessionId
          : event.id
    const resident = this.records.get(id)
    // A reconnect may recover retained evidence before the new driver is ready.
    // Its generation-fenced callback and exact saved native occurrence own admission.
    if (!resident || (!resident.driver && event.type !== "live-approval-decision" && event.type !== "live-question" && event.type !== "live-question-answered")) return
    // Opening streams the provider's saved history back; it is not new work.
    const replaying = resident.opening && Boolean(resident.snapshot.base || resident.snapshot.blocks.length)
    if (showsActivity(event, resident.snapshot.session.status, replaying))
      resident.activityAt = Date.now()
    if (event.type === "live-session") {
      const previousStatus = resident.snapshot.session.status
      const finishedRequest = resident.snapshot.requests.find(
        (request) => request.status === "dispatching"
      )
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...event.session,
          title: event.session.title ?? resident.snapshot.session.title,
          usage: carriedUsage(resident.snapshot.session, event.session),
        },
        nativeActivity: event.session.status === "running" ? resident.snapshot.nativeActivity : undefined,
      }
      if (event.session.nativeRunId && event.session.status === "running") {
        const runId = event.session.nativeRunId
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching" && !request.nativeRun
              ? { ...request, nativeRun: { bindingId, runId } }
              : request
          ),
        }
      }
      // Startup reports are observations, not permission to replace an admitted
      // source. Wake validates the returned session before committing its binding.
      if (!resident.opening) this.updateBinding(resident, event.session)
      const connection = resident.connections.get(bindingId)
      if (connection) connection.session = { ...event.session, id: bindingId }
      if (event.session.connection === "disconnected") {
        resident.snapshot = {
          ...resident.snapshot,
          nativeAgents: disconnectNativeAgents(
            resident.snapshot.nativeAgents,
            bindingId
          ),
        }
        resident.driver = null
        resident.connections.delete(bindingId)
        void this.revokeTools(bindingId, id)
      }
      if ((previousStatus === "running" && event.session.status !== "running") ||
        event.session.connection === "disconnected" || event.session.status === "closed") {
        this.actions.settle(resident, bindingId)
        this.approvals.settle(resident, bindingId)
      }
      if (previousStatus === "running" && event.session.status !== "running") {
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching"
              ? settleRequest(
                  request,
                  event.session,
                  resident.closing || resident.stopping === request.id
                )
              : request
          ),
        }
        resident.stopping = undefined
        if (finishedRequest) {
          this.recordCutOff(resident, finishedRequest.id)
          this.checkpoints.settle(resident, finishedRequest.id)
          this.scheduleAutoContinue(resident, finishedRequest.id)
        }
      }
    } else if (event.type === "live-action-result") {
      this.actions.result(resident, bindingId, event.actionId, event.result)
    } else if (event.type === "live-agent") {
      const agent = NativeAgentObservationSchema.parse(event.agent)
      resident.snapshot = {
        ...resident.snapshot,
        nativeAgents: observeNativeAgent(resident.snapshot.nativeAgents, {
          ...agent,
          bindingId,
          provider: resident.snapshot.session.harness,
          requestId: resident.snapshot.requests.find(
            (request) => request.status === "dispatching"
          )?.id,
          observedAt: Date.now(),
        }),
      }
    } else if (event.type === "live-activity") {
      const nativeActivity = observeNativeActivity(
        resident.snapshot.nativeActivity,
        resident.snapshot.session.status === "running" && !replaying ? event.activity : null
      )
      if (nativeActivity !== resident.snapshot.nativeActivity)
        resident.snapshot = { ...resident.snapshot, nativeActivity }
    } else if (event.type === "live-question-answered") {
      this.questions.observeAnswer(resident, bindingId, event.answer)
    } else if (event.type === "live-question") {
      this.questions.observe(resident, bindingId, event.question)
    } else if (event.type === "live-approval-decision") {
      this.approvals.decision(resident, bindingId, event.decision)
    } else if (event.type === "live-permission-ended") {
      this.approvals.end(resident, bindingId, event)
    } else if (event.type === "live-permission") {
      this.approvals.observe(resident, event.request)
    } else {
      // A setup notice said while opening is about this launch, not replayed history.
      const updates = (event.type === "live-update" ? [event.update] : event.updates)
        .filter((update) => !replaying || (update.kind === "event" && update.setup === true))
      const dispatching = resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
      const prepared = updates.flatMap((item) => {
        try {
          return this.assets.prepare(item)
        } catch (error) {
          resident.updates.push(item)
          this.storageFailed(resident, { error })
          return []
        }
      })
      // The model answering again is the end of a retry's wait.
      if (resident.snapshot.nativeActivity?.kind === "retrying" && prepared.some((update) => update.kind !== "user"))
        resident.snapshot = { ...resident.snapshot, nativeActivity: undefined }
      for (const update of prepared) {
        if (dispatching && update.kind === "user") continue
        resident.steps?.observe(update)
        const last = resident.updates.at(-1)
        const merged = mergeLiveUpdates(last, update)
        if (last && merged) {
          const characters = resident.pendingCharacters - JSON.stringify(last).length + JSON.stringify(merged).length
          if (characters <= 256_000) {
            resident.updates[resident.updates.length - 1] = merged
            resident.pendingCharacters = characters
            continue
          }
        }
        const characters = JSON.stringify(update).length
        if (
          resident.updates.length >= 128 ||
          resident.pendingCharacters + characters > 256_000
        )
          this.flush(resident)
        resident.updates.push(update)
        resident.pendingCharacters += characters
      }
    }
    // Control and terminal changes flush ahead of the next turn. Text bursts share one frame.
    if (event.type === "live-session" || event.type === "live-question-answered" || event.type === "live-question" || event.type === "live-permission" || event.type === "live-permission-ended" || event.type === "live-approval-decision" || event.type === "live-agent" || event.type === "live-activity")
      this.flush(resident)
    else this.schedule(resident)
    if (event.type === "live-session" || event.type === "live-agent") {
      if (
        resident.snapshot.session.status === "ready" &&
        resident.snapshot.session.connection === "connected"
      )
        this.scheduleHibernation(resident)
      else this.clearHibernationTimer(resident)
    }
    if (!resident.opening && resident.snapshot.session.status === "ready")
      this.drain(resident)
  }

  continueBinding(id: string, bindingId: string, requestId: string, text: string,
    attachments: PromptAttachment[] = [], tuning?: SessionSettings, displayText?: string, actor?: Actor): LiveSnapshot {
    const resident = this.require(id)
    const control = this.control(resident)
    const binding = control.bindings.find((item) => item.id === bindingId)
    if (!binding) throw new Error("The selected native session is no longer part of this conversation")
    const existing = resident.snapshot.requests.find((item) => item.id === requestId)
    const transfer = control.transfers.find((item) => item.input.id === requestId)
    if (transfer || (!existing && (control.activeBindingId !== bindingId || (!resident.driver && !resident.hibernating && resident.snapshot.session.connection !== "hibernated"))))
      return this.transfer(id, { id: requestId, bindingId, provider: binding.provider, text, attachments, tuning, displayText }, actor)
    this.submit(id, requestId, text, attachments, tuning, bindingId, displayText, actor)
    return resident.snapshot
  }

  submit(
    id: string,
    requestId: string,
    text: string,
    attachments: PromptAttachment[] = [],
    tuning?: SessionSettings,
    targetBindingId?: string,
    displayText?: string,
    actor?: Actor
  ): LiveRequest {
    assertLifecycleAdmission()
    const resident = this.require(id)
    if (resident.rewinding)
      throw new Error("Wait for the workspace rewind to finish before sending")
    this.flush(resident)
    const request = LiveRequestSchema.parse({
      actor: this.actor(actor),
      id: requestId,
      text,
      attachments,
      tuning,
      targetBindingId,
      displayText,
      status: "queued",
    })
    const inputDigest = promptFingerprint(
      request.text,
      request.attachments,
      request.tuning
    )
    const existing = resident.snapshot.requests.find(
      (candidate) => candidate.id === request.id
    )
    if (existing) {
      if (existing.targetBindingId !== targetBindingId)
        throw new Error("This request ID was already accepted for a different native session")
      if (
        existing.inputDigest
          ? existing.inputDigest !== inputDigest
          : existing.text !== text ||
            JSON.stringify(existing.attachments) !==
              JSON.stringify(attachments) ||
            JSON.stringify(existing.tuning) !== JSON.stringify(tuning)
      )
        throw new Error(
          "This request ID was already accepted with different content"
        )
      if (existing.status === "queued") this.drain(resident)
      return existing
    }
    this.moves.assertAdmits(resident)
    if (this.transfers.pending(resident))
      throw new Error("A provider switch is pending. Wait for it to settle before sending another message.")
    if (targetBindingId && this.control(resident).activeBindingId !== targetBindingId)
      throw new Error("The selected native session changed before this message was accepted")
    if (!text.trim() && !attachments.length)
      throw new Error("A prompt cannot be empty")
    // The user's own message supersedes any continuation Mako was about to send.
    this.declineAutoContinue(resident)
    this.clearHibernationTimer(resident)
    if (
      resident.hibernating ||
      (!resident.driver &&
        resident.snapshot.session.connection === "hibernated")
    ) {
      request.inputDigest = inputDigest
      const accepted = this.admit(resident, request)
      void this.wake(resident)
      return accepted
    }
    if (!resident.driver) {
      this.transfer(id, {
        id: requestId,
        provider: resident.snapshot.session.harness,
        bindingId: targetBindingId,
        text,
        attachments,
        tuning,
        displayText,
      })
      return request
    }
    request.inputDigest = inputDigest
    return this.admit(resident, request)
  }

  /** Record a new request in the journal and start it when the session is free. */
  private admit(resident: Resident, request: LiveRequest): LiveRequest {
    request.attachments = this.assets.retainPrompt(request.attachments)
    const previousSnapshot = resident.snapshot
    resident.snapshot = {
      ...resident.snapshot,
      control: request.continues?.auto ? this.control(resident) : retireQuestionsForInput(this.control(resident), request.id),
      requests: [...resident.snapshot.requests, request],
    }
    // Rejected acceptance must never become a later executable request.
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      throw error
    }
    this.drain(resident)
    return request
  }

  /**
   * The binding a session whose provider process is gone reopens, when its
   * provider can resume the native session; `undefined` while a driver is
   * attached or when nothing can be reopened.
   */
  private reconnectBinding(resident: Resident): ProviderBinding | undefined {
    if (resident.driver || resident.snapshot.session.connection !== "disconnected") return undefined
    const binding = this.activeBinding(resident)
    const driver = this.dependencies.driver(binding?.provider ?? "")
    return binding?.nativeId && driver?.canResume && driver.available(this.dependencies.appPath) ? binding : undefined
  }

  /**
   * A turn cut short by anything but the user's Stop: closes the calls
   * nothing will report on now, and keeps on the request what the agent has
   * no account of, for the next prompt to tell it.
   */
  private recordCutOff(resident: Resident, requestId: string): void {
    const steps = resident.steps
    resident.steps = undefined
    const request = resident.snapshot.requests.find((candidate) => candidate.id === requestId)
    const interruption = request?.interruption
    if (!interruption || interruption.reason === "stopped") return
    const blocks = reduceLiveUpdates(resident.snapshot.blocks, resident.updates)
    const closing = closeCutOffCalls(blocks, requestId, cutOffNote(interruption, request.error))
    const record = recordCutOffCalls(
      reduceLiveUpdates(blocks, closing),
      requestId,
      steps,
      join(this.dependencies.root, "context", "interrupted", requestId)
    )
    resident.updates.push(...closing)
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === requestId && candidate.interruption
          ? { ...candidate, interruption: { ...candidate.interruption, ...record } }
          : candidate
      ),
    }
  }

  /**
   * A turn that just ended on the provider's dropped connection or exited
   * process is picked up by Mako after `AUTO_CONTINUE_DELAY_MS`, once per
   * turn; a process that is gone is reopened on its native session first,
   * the same reconnect a user's send makes. The interrupted request is
   * stamped with the moment so the renderer says "continuing automatically"
   * instead of offering the button; the timer re-checks eligibility when it
   * fires, because the user may have sent something, closed the
   * conversation, or the host may be leaving. Only `settled`, the request
   * whose turn ended in this very transition, is considered: an older
   * interruption the user left alone, or a provider-started turn or
   * compaction ending later, never revives one.
   */
  private scheduleAutoContinue(resident: Resident, settled: string): void {
    if (resident.autoContinue || (!resident.driver && !this.reconnectBinding(resident)) || lifecycleBlocked()) return
    const candidate = autoContinueCandidate(resident.snapshot.requests)
    if (candidate?.id !== settled || !candidate.interruption) return
    const delay = this.dependencies.autoContinueDelayMs ?? AUTO_CONTINUE_DELAY_MS
    const at = Date.now() + delay
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.id === candidate.id && request.interruption
          ? { ...request, interruption: { ...request.interruption, autoContinue: { at } } }
          : request
      ),
    }
    const timer = setTimeout(() => this.fireAutoContinue(resident.snapshot.session.id, candidate.id), delay)
    timer.unref?.()
    resident.autoContinue = { requestId: candidate.id, timer }
  }

  private fireAutoContinue(id: string, requestId: string): void {
    const resident = this.records.get(id)
    if (!resident || resident.autoContinue?.requestId !== requestId) return
    resident.autoContinue = undefined
    const source = autoContinueCandidate(resident.snapshot.requests)
    resident.snapshot = {
      ...resident.snapshot,
      requests: clearAutoContinue(resident.snapshot.requests, requestId),
    }
    const reconnect = this.reconnectBinding(resident)
    if (
      source?.id !== requestId ||
      !source.interruption?.autoContinue ||
      (!resident.driver && !reconnect) ||
      resident.rewinding ||
      resident.closing ||
      this.transfers.pending(resident) ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.permissions.length > 0
    ) {
      this.flush(resident)
      return
    }
    const reason = source.interruption.reason
    const actor: Actor = { kind: "service", name: "auto-continue" }
    const continues: TurnContinuation = { requestId, reason, auto: true }
    const request = LiveRequestSchema.parse({
      actor,
      id: randomUUID(),
      text: continueTurnPrompt(reason),
      attachments: [],
      tuning: source.tuning,
      status: "queued",
      continues,
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    try {
      assertLifecycleAdmission()
      if (reconnect)
        this.transfer(id, { id: request.id, provider: reconnect.provider, text: request.text, attachments: [], tuning: source.tuning }, actor, continues)
      else this.admit(resident, request)
      hostLog("live", "continued a dropped turn", {
        conversation: id,
        harness: resident.snapshot.session.harness,
        request: request.id,
        continues: requestId,
        reason,
        reconnect: Boolean(reconnect),
      })
    } catch (error) {
      // The manual offer stands; the stamp is already gone from the request.
      hostWarn("live", "auto-continue was not accepted", {
        conversation: id,
        continues: requestId,
        error: error instanceof Error ? error.message : String(error),
      })
      this.flush(resident)
    }
  }

  /** Drop a pending continuation and its stamp; a later prompt, close or host exit made it moot. */
  private declineAutoContinue(resident: Resident): void {
    const pending = resident.autoContinue
    if (!pending) return
    clearTimeout(pending.timer)
    resident.autoContinue = undefined
    resident.snapshot = {
      ...resident.snapshot,
      requests: clearAutoContinue(resident.snapshot.requests, pending.requestId),
    }
  }

  authorizeAgent(id: string, bindingId: string): void {
    const resident = this.require(id)
    if (
      this.control(resident).activeBindingId !== bindingId ||
      !resident.driver ||
      resident.snapshot.session.status !== "running"
    )
      throw new Error(
        "This provider no longer owns an active turn in this conversation"
      )
  }

  cancelChild(id: string, childId: string): LiveSnapshot {
    return this.children.cancelChild(id, childId)
  }

  async mergeFork(id: string, mergeId: string): Promise<LiveSnapshot> {
    z.string().uuid().parse(mergeId)
    const source = this.require(id)
    this.flush(source)
    const ancestry = this.control(source).ancestry
    if (ancestry?.kind !== "fork")
      throw new Error("Only a fork can send findings back to its parent")
    const parent = this.require(ancestry.parentId)
    const existing = this.control(parent).merges.find(
      (merge) => merge.id === mergeId
    )
    if (existing) {
      if (existing.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    if (
      source.snapshot.session.status === "running" ||
      source.snapshot.requests.some(
        (request) =>
          request.status === "queued" || request.status === "dispatching"
      )
    )
      throw new Error(
        "Wait for the fork's current turn to finish before transferring findings"
      )
    if (
      !source.snapshot.requests.some(
        (request) => request.status === "completed"
      )
    )
      throw new Error("The fork has no completed findings yet")
    const captured = source.snapshot
    const manifest = await prepareLiveContext({
      snapshot: captured,
      root: join(this.dependencies.root, "context"),
      fromBlock: 0,
      includesBase: false,
    })
    const control = this.control(parent)
    const concurrent = control.merges.find((merge) => merge.id === mergeId)
    if (concurrent) {
      if (concurrent.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    const previous = parent.snapshot
    parent.snapshot = {
      ...previous,
      control: {
        ...control,
        merges: [
          ...control.merges,
          {
            id: mergeId,
            sourceId: id,
            sourceRevision: captured.revision,
            manifest,
            status: "pending",
          },
        ],
      },
    }
    try {
      this.flush(parent)
    } catch (error) {
      parent.snapshot = previous
      throw error
    }
    return parent.snapshot
  }

  /** `cwd` places the fork's Session in another folder: a worktree the host made for it. */
  fork(id: string, input: ForkInput, cwd?: string): LiveSnapshot {
    const command = ForkInputSchema.parse(input)
    const parent = this.require(id)
    this.flush(parent)
    const source = parent.snapshot
    const point = JSON.stringify(command.point)
    const placement = command.thread === "new" ? undefined : "parent-thread"
    const existing = this.load(command.id)
    if (existing) {
      if (
        existing.snapshot.control?.ancestry?.parentId !== id ||
        existing.snapshot.control.ancestry.point !== point ||
        (existing.snapshot.control.ancestry.provider ??
          existing.snapshot.session.harness) !== command.provider
      )
        throw new Error("This fork ID belongs to another source point")
      if (existing.snapshot.control.ancestry.placement !== placement)
        throw new Error("This fork ID was used for a fork into another Thread")
      return this.stamp(existing.snapshot)
    }
    let nativeFork: NonNullable<ConversationControl["ancestry"]>["nativeFork"]
    let entries = source.base?.entries ?? []
    if (command.point.kind === "run" || command.point.kind === "before-run") {
      const requestId = command.point.requestId
      const request = source.requests.find(
        (candidate) => candidate.id === requestId
      )
      if (
        !request ||
        (command.point.kind === "run" && request.status !== "completed")
      )
        throw new Error("Fork from a completed answer")
      const binding = source.control?.bindings.find(
        (candidate) => candidate.id === request.nativeRun?.bindingId
      )
      const forkPoint = this.dependencies.driver(command.provider)?.forkPoint
      const nativePoint =
        forkPoint === "checkpoint"
          ? request.nativeRun?.forkId
          : forkPoint === "run"
            ? request.nativeRun?.runId
            : undefined
      // A native session is stored against the folder it ran in, so a fork elsewhere starts fresh with the transcript.
      if (
        cwd === undefined &&
        command.point.kind === "run" &&
        binding?.nativeId &&
        request.nativeRun &&
        binding.provider === command.provider &&
        nativePoint
      )
        nativeFork = {
          provider: binding.provider,
          nativeId: binding.nativeId,
          runId: nativePoint,
        }
      const start = source.blocks.findIndex(
        (block) => block.type === "user" && block.requestId === requestId
      )
      if (start < 0)
        throw new Error("The source turn is not present in this capture")
      const next = source.blocks.findIndex(
        (block, index) => index > start && isTurnStart(block)
      )
      const covered = source.baseCoveredBlocks ?? 0
      // The native history read after a checkpoint replaced the blocks it
      // covers. It ends where they end, so it still ends at this answer when
      // no later turn began before that point; an earlier answer is named by
      // its native message instead.
      if (start < covered && (command.point.kind === "before-run" || (next >= 0 && next < covered)))
        throw new Error("The transcript was refreshed. Choose the answer again from its current history.")
      entries = [
        ...entries,
        ...liveEntries(
          source.blocks.slice(
            covered,
            command.point.kind === "before-run"
              ? start
              : next < 0
                ? source.blocks.length
                : next
          )
        ),
      ]
    } else {
      const base = source.base
      if (!base)
        throw new Error(
          "The source history changed. Reload it before choosing a fork point."
        )
      let index = command.point.index - base.start
      if (nativeRevision(base) !== command.point.revision) {
        // The store moved since the transcript was read. The answer is still
        // the same message; find it by its own identity rather than refusing.
        const found = command.point.anchor
          ? resolveAnchor(base.entries, base.start, command.point.anchor, "assistant")
          : undefined
        if (found === undefined)
          throw new Error(
            command.point.anchor
              ? "The source history changed and the chosen answer is no longer in it. Reload the thread and choose again."
              : "The source history changed. Reload it before choosing a fork point."
          )
        index = found - base.start
      }
      if (
        index < 0 ||
        index >= base.entries.length ||
        base.entries[index]?.kind !== "assistant"
      )
        throw new Error(
          "Choose an answer present in the captured native history"
        )
      entries = base.entries.slice(0, index + 1)
    }
    const snapshot: LiveSnapshot = {
      session: {
        ...source.session,
        id: command.id,
        cwd: cwd ?? source.session.cwd,
        harness: command.provider,
        nativeId: undefined,
        nativePath: undefined,
        nativeRunId: undefined,
        nativeForkId: undefined,
        title: command.move ? source.session.title : source.session.title ? `${source.session.title} — fork` : "Fork",
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
        lastStop: undefined,
        error: undefined,
      },
      revision: 0,
      createdAt: Date.now(),
      blocks: [],
      requests: [],
      permissions: [],
      base: {
        ref: source.base?.ref ?? {
          path: id,
          nativeId: id,
          harness: source.session.harness,
          cwd: source.session.cwd,
        },
        entries,
        start: source.base?.start ?? 0,
        total: entries.length,
        hasEarlier: source.base?.hasEarlier ?? false,
      },
      control: {
        children: [],
        merges: [],
        ancestry: {
          kind: "fork",
          nativeFork,
          provider: command.provider,
          parentId: id,
          sourceRevision: source.revision,
          point,
          placement,
        },
        activeBindingId: command.id,
        bindings: [],
        transfers: [],
      },
    }
    const journal = new LiveJournal(this.dependencies.root, command.id)
    try {
      journal.commit(snapshot)
      this.dependencies.memory?.rememberJournal(command.id)
    } catch (error) {
      journal.close()
      throw error
    }
    this.records.set(command.id, {
      snapshot,
      journalSnapshot: snapshot,
      journal,
      driver: null,
      connections: new Map(),
      bindingGenerations: new Map(),
      transferring: false,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    })
    this.registerThread(snapshot, this.actor())
    const stamped = this.stamp(snapshot)
    if (placement && stamped.threadId) this.announceGroup(stamped.threadId)
    return stamped
  }

  /** Tell every window what a Thread's tabs are now, after a Session joined it. */
  announceGroup(thread: string): void {
    const threads = this.dependencies.threads
    if (!threads) return
    try {
      this.dependencies.emit({ type: "thread-group", change: { thread, group: threads.group(ThreadIdSchema.parse(thread)) ?? null } })
    } catch (error) {
      hostWarn("threads", "a Thread's tabs could not be announced", { thread, error: errorMessage({ error }) })
    }
  }

  previewRewind(
    id: string,
    requestId: string,
    position: "before" | "after" = "after"
  ) {
    if (this.actions.blocks(this.require(id)))
      throw new Error("Resolve the pending provider action before rewinding")
    return this.checkpoints.preview(id, requestId, position)
  }

  rewind(id: string, input: RewindInput) {
    assertLifecycleAdmission()
    if (this.actions.blocks(this.require(id)))
      throw new Error("Resolve the pending provider action before rewinding")
    return this.checkpoints.rewind(id, input)
  }

  act(id: string, input: LiveActionInput) {
    assertLifecycleAdmission()
    return this.actions.submit(id, input)
  }

  acknowledgeAction(id: string, actionId: string): Promise<void> {
    return this.actions.acknowledge(id, actionId)
  }

  recoverRewinds() {
    return this.checkpoints.recover()
  }

  transfer(id: string, input: TransferInput, actor?: Actor, continues?: TurnContinuation): LiveSnapshot {
    assertLifecycleAdmission()
    const resident = this.require(id)
    if (resident.rewinding)
      throw new Error(
        "Wait for the workspace rewind to finish before switching providers"
      )
    this.moves.assertStarts(resident)
    return this.transfers.accept(id, input, this.actor(actor), continues)
  }

  private control(resident: Resident): ConversationControl {
    return (
      resident.snapshot.control ?? {
        children: [],
        merges: [],
        activeBindingId: resident.snapshot.session.id,
        bindings: [
          {
            id: resident.snapshot.session.id,
            provider: resident.snapshot.session.harness,
            nativeId: resident.snapshot.session.nativeId,
            path: resident.snapshot.threadPath,
            coveredBlocks: resident.snapshot.blocks.length,
            includesBase: true,
          },
        ],
        transfers: [],
      }
    )
  }

  private updateBinding(resident: Resident, session: LiveSessionState): void {
    const control = this.control(resident)
    const path = bindingPath(this.dependencies, session, session.nativePath ?? resident.snapshot.threadPath)
    const context = session.executionContext && {
      ...session.executionContext,
      store: path ? { kind: "located" as const, path } : session.executionContext.store,
    }
    resident.snapshot = {
      ...resident.snapshot,
      session: { ...resident.snapshot.session, executionContext: context },
      threadPath: path,
      control: {
        ...control,
        bindings: control.bindings.map((binding) =>
          binding.id === control.activeBindingId
            ? {
                ...binding,
                nativeId: session.nativeId ?? binding.nativeId,
                executionContext: context ?? binding.executionContext,
                path: path ?? binding.path,
                tuning: session.settings ?? binding.tuning,
                modeId:
                  session.currentMode ?? binding.modeId,
              }
            : binding
        ),
      },
    }
  }

  /** Native identity belongs to the host, including sessions never opened in a renderer. */
  discoverNativePaths(): void {
    for (const resident of this.records.values()) {
      if (resident.opening || resident.transferring) continue
      this.discoverNativePath(resident)
    }
  }

  private discoverNativePath(resident: Resident): void {
    const binding = this.activeBinding(resident)
    if (!binding?.nativeId || (resident.driver && binding.path)) return
    const session = { ...resident.snapshot.session, harness: binding.provider, nativeId: binding.nativeId, nativePath: binding.path }
    const path = this.dependencies.nativePath?.(session)
    if (!path || path === binding.path) return
    this.updateBinding(resident, { ...session, nativePath: path })
    this.flush(resident)
    this.checkpointIdle(resident)
    this.scheduleHibernation(resident)
  }

  editQueued(id: string, input: QueuedPromptEdit): LiveSnapshot {
    const command = QueuedPromptEditSchema.parse(input)
    const resident = this.require(id)
    const request = resident.snapshot.requests.find(
      (item) => item.id === command.requestId
    )
    if (!request) throw new Error("This queued message is no longer available.")
    if (command.change.kind === "remove" && request.status === "canceled")
      return resident.snapshot
    if (request.status !== "queued" && request.status !== "held")
      throw new Error(
        "This message has already started. Your queued edit was not applied."
      )
    if (request.text !== command.expectedText) {
      if (
        command.change.kind === "edit" &&
        request.text === command.change.text
      )
        return resident.snapshot
      throw new Error(
        "This queued message changed. Review its latest text before editing."
      )
    }
    if (
      command.change.kind === "edit" &&
      !command.change.text.trim() &&
      !request.attachments.length
    )
      throw new Error("A message cannot be empty.")
    let next: LiveRequest
    switch (command.change.kind) {
      case "remove":
        next = { ...request, status: "canceled" }
        break
      case "pause":
        next = { ...request, status: "held" }
        break
      case "resume":
        next = { ...request, status: "queued" }
        break
      case "edit":
        next = {
          ...request,
          status: "queued",
          text: command.change.text,
          displayText: undefined,
          nativeDelivery: undefined,
        }
        break
    }
    const previous = resident.snapshot
    resident.snapshot = {
      ...previous,
      requests: previous.requests.map((item) =>
        item.id === request.id ? next : item
      ),
    }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    if (command.change.kind !== "pause") this.drain(resident)
    return resident.snapshot
  }

  clearQueue(id: string): LiveSnapshot {
    const resident = this.require(id)
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued" || request.status === "held"
          ? {
              ...request,
              status: "canceled",
            }
          : request
      ),
    }
    this.flush(resident)
    return resident.snapshot
  }

  async earlier(id: string): Promise<LiveSnapshot> {
    const resident = this.require(id)
    if (this.transfers.pending(resident))
      throw new Error(
        "Wait for the provider switch before loading earlier history"
      )
    const base = resident.snapshot.base
    if (!base?.hasEarlier) return resident.snapshot
    const earlier = await this.dependencies.history(base.ref.path, base.start)
    if (
      earlier &&
      JSON.stringify([
        earlier.checkpoint,
        earlier.ref.revision,
        earlier.ref.bytes,
        earlier.ref.updatedAt,
      ]) !==
        JSON.stringify([
          base.checkpoint,
          base.ref.revision,
          base.ref.bytes,
          base.ref.updatedAt,
        ])
    )
      throw new Error(
        "The native history changed since this capture. Open the current provider history to read earlier turns."
      )
    if (this.transfers.pending(resident))
      throw new Error("History loading was superseded by a provider switch")
    // Another caller may already have prepended this page.
    if (
      earlier &&
      resident.snapshot.base === base &&
      earlier.total >= base.total &&
      earlier.start < base.start
    ) {
      resident.snapshot = {
        ...resident.snapshot,
        control: {
          ...this.control(resident),
          bindings: this.control(resident).bindings.map((binding) => ({
            ...binding,
            includesBase: false,
          })),
        },
        base: {
          ...base,
          entries: [...earlier.entries, ...base.entries],
          start: earlier.start,
          hasEarlier: earlier.hasEarlier,
        },
      }
      this.flush(resident)
    }
    return resident.snapshot
  }

  private checkpointIdle(resident: Resident): void {
    const bindingId = this.control(resident).activeBindingId
    const path = resident.snapshot.threadPath
    const blocks = resident.snapshot.blocks
    if (
      !path ||
      resident.snapshot.session.status !== "ready" ||
      !this.dependencies.checkpoint
    )
      return
    void this.dependencies
      .checkpoint(path, resident.snapshot.session.harness)
      .then((checkpoint) => {
        if (
          !checkpoint ||
          !this.records.has(resident.snapshot.session.id) ||
          this.control(resident).activeBindingId !== bindingId ||
          resident.snapshot.session.status !== "ready" ||
          resident.snapshot.blocks !== blocks ||
          resident.snapshot.threadPath !== path ||
          resident.snapshot.requests.some(
            (request) => request.status === "dispatching"
          )
        )
          return
        const control = this.control(resident)
        resident.snapshot = {
          ...resident.snapshot,
          control: {
            ...control,
            bindings: control.bindings.map((binding) =>
              binding.id === bindingId
                ? { ...binding, checkpoint, coveredBlocks: blocks.length }
                : binding
            ),
          },
        }
        this.flush(resident)
      })
      .catch(() => {})
  }

  async bind(id: string, path: string): Promise<LiveSnapshot> {
    const resident = this.require(id)
    const page = await this.dependencies.history(path)
    if (
      !page ||
      page.ref.nativeId !== resident.snapshot.session.nativeId ||
      page.ref.harness !== resident.snapshot.session.harness
    )
      throw new Error(
        "That native session does not belong to this conversation"
      )
    resident.snapshot = {
      ...resident.snapshot,
      threadPath: path,
      control: {
        ...this.control(resident),
        bindings: this.control(resident).bindings.map((binding) =>
          binding.id === this.control(resident).activeBindingId
            ? { ...binding, path }
            : binding
        ),
      },
    }
    this.flush(resident)
    this.checkpointIdle(resident)
    return resident.snapshot
  }

  async permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): Promise<void> {
    if (this.control(this.require(id)).questions?.some(question => question.id === requestId)) {
      await this.questions.answer(id, requestId, response)
      return
    }
    await this.approvals.respond(id, requestId, response)
  }

  activeRequest(id: string): string | null {
    const resident = this.records.get(id)
    if (!resident?.driver) return null
    return resident.snapshot.requests.find((request) => request.status === "dispatching" || (resident.opening && request.status === "queued"))?.id ?? null
  }

  stopRequest(id: string, requestId: string): Promise<boolean> {
    const previous = this.stops.get(id)
    if (previous?.requestId === requestId) return previous.result
    if (this.activeRequest(id) !== requestId) return Promise.resolve(false)
    const resident = this.require(id)
    const snapshot = resident.snapshot
    resident.snapshot = { ...snapshot, requests: snapshot.requests.map((request) => request.status === "queued" && request.id !== requestId ? { ...request, status: "held" } : request) }
    try { this.flush(resident) } catch (error) { resident.snapshot = snapshot; return Promise.reject(error) }
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued") this.children.cancelChild(id, child.id)
    const opening = resident.opening
    resident.stopping = requestId
    const result = this.cancelRequest(id, requestId).then(async () => { if (opening) await this.close(id); return true }).catch((error) => { this.stops.delete(id); throw error })
    this.stops.set(id, { requestId, result })
    return result
  }

  async cancelRequest(id: string, requestId: string): Promise<void> {
    const resident = this.require(id)
    if (this.checkpoints.cancelBeforeDispatch(resident, requestId)) return
    const request = resident.snapshot.requests.find(
      (request) => request.id === requestId
    )
    if (request?.status === "dispatching") {
      await resident.driver?.cancel(this.control(resident).activeBindingId)
      return
    }
    const pending = this.transfers.pending(resident)
    if (pending?.input.id === requestId) {
      if (pending.state.kind === "preparing") resident.generation += 1
      this.transfers.save(resident, {
        ...pending,
        state: { kind: "failed", error: "The remote request was canceled" },
      })
    }
    if (request?.status === "queued") {
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((candidate) =>
          candidate.id === requestId
            ? {
                ...candidate,
                status: "interrupted",
                error: "The remote request was canceled",
              }
            : candidate
        ),
      }
      this.flush(resident)
    }
    this.drain(resident)
  }

  async cancel(id: string): Promise<void> {
    const requestId = this.activeRequest(id)
    if (requestId) { await this.stopRequest(id, requestId); return }
    const resident = this.require(id)
    // Stop during the wait before Mako continues a dropped turn is the user's
    // answer: leave the turn where it stopped, and say so.
    if (resident.autoContinue) {
      this.declineAutoContinue(resident)
      this.flush(resident)
      return
    }
    if (this.checkpoints.cancelBeforeDispatch(resident)) return
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued")
        this.children.cancelChild(id, child.id)
    await resident.driver?.cancel(this.control(resident).activeBindingId)
  }
  async setMode(id: string, modeId: string): Promise<void> {
    const resident = this.require(id)
    if (
      !resident.driver &&
      resident.snapshot.session.connection === "hibernated"
    ) {
      if (
        resident.snapshot.session.modes.length > 0 &&
        !resident.snapshot.session.modes.some((mode) => mode.id === modeId)
      )
        throw new Error("That agent mode is unavailable")
      resident.snapshot = {
        ...resident.snapshot,
        session: { ...resident.snapshot.session, currentMode: modeId },
      }
      this.flush(resident)
      const nativeId = resident.snapshot.session.nativeId
      if (nativeId)
        this.dependencies.memory?.remember(
          resident.snapshot.session.harness,
          nativeId,
          { modeId }
        )
      return
    }
    if (!resident.driver) throw new Error("The provider is disconnected")
    await resident.driver.setMode(
      this.control(resident).activeBindingId,
      modeId
    )
  }
  async close(id: string): Promise<void> {
    const resident = this.require(id)
    if (resident.closeOperation) return resident.closeOperation
    const operation = this.closeResident(resident, id)
    resident.closeOperation = operation
    void operation.catch(() => {
      if (resident.closeOperation === operation)
        resident.closeOperation = undefined
    })
    return operation
  }

  private async closeResident(
    resident: Resident,
    id: string
  ): Promise<void> {
    this.clearHibernationTimer(resident)
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued")
        this.children.cancelChild(id, child.id)
    resident.generation += 1
    const pending = this.transfers.pending(resident)
    if (pending)
      this.transfers.save(resident, {
        ...pending,
        state: {
          kind: "failed",
          error: "The conversation was closed before the switch completed",
        },
      })
    const idle = resident.snapshot.session.status === "ready"
    const generation = resident.generation
    resident.closing = true
    this.declineAutoContinue(resident)
    const openingOperation = resident.openingOperation
    if (openingOperation) await openingOperation
    const hibernationOperation = resident.hibernating
    if (hibernationOperation) await hibernationOperation
    const wakeOperation = resident.waking
    if (wakeOperation) await wakeOperation
    const transferOperation = resident.transferOperation
    if (transferOperation) await transferOperation
    const bindingIds = [...resident.connections.keys()]
    const activeBindingId = this.control(resident).activeBindingId
    if (resident.opening && !bindingIds.includes(activeBindingId))
      bindingIds.push(activeBindingId)
    const closings = [...resident.connections].map(
      ([bindingId, connection]) => ({
        bindingId,
        close: Promise.resolve().then(() =>
          connection.driver.close(bindingId)
        ),
      })
    )
    if (
      resident.opening &&
      resident.driver &&
      !resident.connections.has(activeBindingId)
    ) {
      const openingDriver = resident.driver
      closings.push({
        bindingId: activeBindingId,
        close: Promise.resolve().then(() =>
          openingDriver.close(activeBindingId)
        ),
      })
    }
    resident.opening = false
    resident.snapshot = {
      ...resident.snapshot,
      session: {
        ...resident.snapshot.session,
        status: "closed",
        connection:
          closings.length > 0 ? "connected" : "disconnected",
      },
      nativeAgents: disconnectNativeAgents(resident.snapshot.nativeAgents),
      permissions: [],
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued" || request.status === "dispatching"
          ? {
              ...request,
              status: "uncertain",
              error: "The connection closed before completion",
            }
          : request
      ),
    }
    this.approvals.settle(resident, activeBindingId)
    this.flush(resident)
    try {
      await Promise.all(
        bindingIds.map((bindingId) =>
          this.revokeTools(bindingId, id)
        )
      )
      const closeResults = await Promise.allSettled(
        closings.map((closing) => closing.close)
      )
      const failedBindings = new Set(
        closeResults.flatMap((result, index) => {
          const closing = closings[index]
          return result.status === "rejected" && closing
            ? [closing.bindingId]
            : []
        })
      )
      for (const closing of closings)
        if (!failedBindings.has(closing.bindingId))
          resident.connections.delete(closing.bindingId)
      const retainedConnection =
        resident.connections.get(activeBindingId) ??
        resident.connections.values().next().value
      resident.driver = retainedConnection?.driver ?? null
      // A session closed while still opening never reported its native id, so
      // the hold taken before its start is let go through the binding. A
      // binding whose process did not confirm exit keeps its hold.
      for (const binding of this.control(resident).bindings)
        if (binding.nativeId && !failedBindings.has(binding.id))
          this.releaseHold(
            binding.provider,
            binding.nativeId,
            id
          )
      const failures = closeResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      )
      if (failures.length) {
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            connection: resident.connections.size
              ? "connected"
              : "disconnected",
            error: "A provider process did not confirm that it closed",
          },
        }
        this.flush(resident)
        throw new AggregateError(
          failures,
          "One or more provider processes did not close"
        )
      }
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...resident.snapshot.session,
          connection: "disconnected",
        },
      }
      this.flush(resident)
      if (
        idle &&
        this.dependencies.checkpoint &&
        resident.generation === generation
      ) {
        const control = this.control(resident)
        const bindings = await Promise.all(
          control.bindings.map(async (binding) => {
            if (!binding.path || binding.id !== control.activeBindingId)
              return binding
            const checkpoint = await this.dependencies.checkpoint?.(
              binding.path, binding.provider
            )
            return {
              ...binding,
              checkpoint,
              coveredBlocks: resident.snapshot.blocks.length,
            }
          })
        )
        if (
          resident.generation === generation &&
          this.records.get(id) === resident
        ) {
          resident.snapshot = {
            ...resident.snapshot,
            control: { ...this.control(resident), bindings },
          }
          this.flush(resident)
        }
      }
    } finally {
      resident.closing = false
      this.drain(resident)
      this.cacheClosed(resident)
    }
  }

  private cacheClosed(resident: Resident): void {
    if (!this.closedLeaf(resident)) return
    const id = resident.snapshot.session.id
    const cached = this.closedCache.get(id)
    const size = cached?.revision === resident.snapshot.revision ? cached.bytes : JSON.stringify(resident.snapshot).length * 2
    this.closedCache.delete(id)
    this.closedCache.set(id, { bytes: size, revision: resident.snapshot.revision })
    let bytes = [...this.closedCache.values()].reduce((total, entry) => total + entry.bytes, 0)
    for (const [key, entry] of this.closedCache) {
      if (key === id || (this.closedCache.size <= 8 && bytes <= 64 * 1024 * 1024)) break
      this.closedCache.delete(key)
      bytes -= entry.bytes
      const held = this.records.get(key)
      if (!held || !this.closedLeaf(held)) continue
      this.flush(held)
      const snapshot = held.snapshot
      this.recovered.set(key, { session: snapshot.session, revision: snapshot.revision, createdAt: snapshot.createdAt, threadPath: snapshot.threadPath, nativePaths: snapshot.control?.bindings.flatMap((binding) => binding.path ? [binding.path] : []) })
      held.journal.close()
      this.records.delete(key)
      for (const binding of snapshot.control?.bindings ?? []) if (this.bindingOwners.get(binding.id) === key) this.bindingOwners.delete(binding.id)
    }
  }

  private closedLeaf(resident: Resident): boolean {
    return resident.snapshot.session.status === "closed" && !resident.driver && !resident.connections.size && !resident.closing && !resident.opening && !resident.hibernating && !resident.waking && !resident.transferring && !resident.checkpointing && !resident.rewinding && !resident.snapshot.control?.children.length
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown
    const closing: Promise<unknown>[] = []
    this.actions.stop()
    for (const resident of this.records.values()) {
      for (const pending of [resident.hibernating, resident.waking, resident.openingOperation, resident.transferOperation])
        if (pending) closing.push(pending)
      this.clearHibernationTimer(resident)
      resident.generation += 1
      const driver = resident.driver
      resident.driver = null
      for (const [bindingId, connection] of resident.connections) {
        closing.push(Promise.resolve().then(() => connection.driver.close(bindingId)).then(
          () => {
            const binding = this.control(resident).bindings.find(
              (candidate) => candidate.id === bindingId
            )
            if (binding?.nativeId)
              this.releaseHold(
                binding.provider,
                binding.nativeId,
                resident.snapshot.session.id
              )
          },
          () => undefined
        ))
        closing.push(Promise.resolve(this.revokeTools(bindingId, resident.snapshot.session.id)))
      }
      if (
        resident.opening &&
        !resident.connections.has(
          this.control(resident).activeBindingId
        )
      ) {
        const bindingId = this.control(resident).activeBindingId
        const binding = this.control(resident).bindings.find(
          (candidate) => candidate.id === bindingId
        )
        closing.push(Promise.resolve().then(() => driver?.close(bindingId)).then(
          () => {
            if (binding?.nativeId)
              this.releaseHold(
                binding.provider,
                binding.nativeId,
                resident.snapshot.session.id
              )
          },
          () => undefined
        ))
        closing.push(Promise.resolve(this.revokeTools(bindingId, resident.snapshot.session.id)))
      }
      // A continuation this host was about to send goes with it; the next
      // host offers the button instead of promising a send it cannot make.
      this.declineAutoContinue(resident)
      // A turn still running now is cut short by this host, on purpose. The
      // journal says so, with the moment, so the next host does not read it
      // as a crash and the transcript can offer to continue the turn. An idle
      // conversation is left as it is, so stopping writes nothing for it.
      const running = resident.snapshot.requests.find((request) => request.status === "dispatching")
      if (running) {
        resident.snapshot = {
          ...resident.snapshot,
          requests: interruptRequests(
            resident.snapshot.requests,
            "host-quit",
            "Mako closed while this turn was running"
          ),
        }
        this.recordCutOff(resident, running.id)
      }
      // A child's verdict settles into its parent's journal, so every flush
      // runs before any journal closes.
      this.flush(resident)
    }
    for (const resident of this.records.values()) resident.journal.close()
    this.records.clear()
    return this.shutdown = Promise.allSettled(closing).then(() => {})
  }

  /**
   * Keep the per-user ledger in step with what a connected session reports:
   * its native identity is held while it is connected, and its settings and
   * access mode are recorded whenever they change, so another host — or this
   * one after a restart without its journal — reads the same facts.
   */
  private syncMemory(previous: LiveSessionState, next: LiveSessionState): void {
    const memory = this.dependencies.memory
    if (!memory) return
    try {
      const heldId = previous.connection === "connected" ? previous.nativeId : undefined
      const wasHeld = heldId !== undefined
      if (heldId !== undefined && heldId !== next.nativeId)
        memory.release(previous.harness, heldId, next.id)
      if (!next.nativeId) return
      if (next.connection !== "connected") {
        memory.release(next.harness, next.nativeId, next.id)
        return
      }
      if (!memory.owns(next.harness, next.nativeId, next.id))
        memory.hold(next.harness, next.nativeId, next.id)
      const fresh = !wasHeld || previous.nativeId !== next.nativeId
      const settingsChanged =
        JSON.stringify(previous.settings ?? null) !== JSON.stringify(next.settings ?? null)
      const modeChanged = previous.currentMode !== next.currentMode
      // A session without modes reports null; that is nothing to remember,
      // not a request to forget the tier its last session ran under.
      if (fresh || settingsChanged || modeChanged)
        memory.remember(next.harness, next.nativeId, {
          settings: fresh || settingsChanged ? next.settings : undefined,
          modeId: (fresh || modeChanged) && next.currentMode !== null ? next.currentMode : undefined,
        })
    } catch (error) {
      hostWarn("memory", "ledger update failed", {
        conversation: next.id,
        harness: next.harness,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private drain(resident: Resident): void {
    if (lifecycleBlocked()) return
    if (this.actions.blocks(resident)) return
    // Queued work stays queued, not held: cancelling a move starts it again.
    if (!this.moves.executes(resident)) return
    if (
      resident.checkpointing ||
      resident.rewinding ||
      resident.closing ||
      resident.hibernating ||
      resident.waking
    )
      return
    this.children.deliver(resident)
    if (this.transfers.pending(resident)) {
      this.transfers.start(resident)
      return
    }
    if (
      resident.opening ||
      !resident.driver ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    // Failure does not silently drain old queued work. A new explicit submission can retry.
    const queued = resident.snapshot.requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    )
    const request =
      resident.snapshot.session.status === "failed" ? queued.at(-1) : queued[0]
    if (!request || request.status === "held") return
    const previousSnapshot = resident.snapshot
    const previousUpdates = [...resident.updates]
    const previousCharacters = resident.pendingCharacters
    const previousDisplayPrompt = resident.displayPrompt
    const control = this.control(resident)
    const pendingMerges = control.merges.filter(
      (merge) => merge.status === "pending"
    )
    const attemptId = randomUUID()
    const bindingId = control.activeBindingId
    const nativeDelivery: PromptDelivery = { attemptId, bindingId, ownerEpoch: this.epoch, evidence: { kind: "prepared" } }
    const ownerGeneration = this.moves.generation(resident)
    if (ownerGeneration !== undefined) nativeDelivery.ownerGeneration = ownerGeneration
    const usage = resident.snapshot.session.usage
    const current = {
      ...request,
      nativeDelivery,
      usageFrom: usage?.tokens || usage?.cost ? { ...(usage.tokens && { tokens: usage.tokens }), ...(usage.cost && { cost: usage.cost }) } : undefined,
      status: "dispatching" as const,
      context: [
        ...(request.context ?? []),
        ...pendingMerges.map((merge) => merge.manifest),
      ],
    }
    const told = pendingInterruption(resident.snapshot.requests, request.id)
    const toldAt = Date.now()
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...(request.continues?.auto ? control : retireQuestionsForInput(control, request.id)),
        children: control.children.map((child) =>
          child.deliveryId === request.id && child.delivery === "queued"
            ? { ...child, delivery: "delivered" }
            : child
        ),
        merges: control.merges.map((merge) =>
          merge.status === "pending" ? { ...merge, status: "consumed" } : merge
        ),
      },
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === request.id
          ? current
          : candidate.id === told?.requestId && candidate.interruption
            ? { ...candidate, interruption: { ...candidate.interruption, told: toldAt } }
            : candidate
      ),
    }
    resident.steps = new TurnSteps()
    const text = request.displayText ?? resident.displayPrompt ?? request.text
    resident.displayPrompt = undefined
    // A request held back behind a turn the provider was still running
    // already shows its message from that attempt.
    const shown = request.nativeDelivery?.evidence.kind === "not-accepted"
    if (!shown && (text || request.attachments.length))
      resident.updates.push({
        kind: "user",
        provider: resident.snapshot.session.harness,
        requestId: request.id,
        contextFiles: current.context.map((manifest) => manifest.file),
        text,
        attachments: request.attachments.map((attachment) => ({
          type: "attachment",
          name: attachment.name,
          mimeType: attachment.mimeType,
          source: attachment.path
            ? { kind: "file", path: attachment.path }
            : attachment.data
              ? { kind: "inline", data: attachment.data }
              : {
                  kind: "unavailable",
                  reason: "Attachment bytes were not retained",
                },
        })),
      })
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      resident.updates = previousUpdates
      resident.pendingCharacters = previousCharacters
      resident.displayPrompt = previousDisplayPrompt
      this.storageFailed(resident, { error })
      return
    }
    const generation = resident.generation
    const driver = resident.driver
    const report = (evidence: PromptDeliveryEvidence): void => {
      if (resident.generation !== generation || this.control(resident).activeBindingId !== bindingId) return
      const target = resident.snapshot.requests.find((item) => item.id === request.id)
      if (!target?.nativeDelivery || target.nativeDelivery.attemptId !== attemptId) return
      const delivery = target.nativeDelivery
      const next = advancePromptDelivery(delivery.evidence, evidence)
      if (next === delivery.evidence) return
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((item) =>
          item === target ? { ...item, nativeDelivery: { ...delivery, evidence: next } } : item
        ),
      }
      try {
        this.flush(resident)
      } catch (error) {
        this.storageFailed(resident, { error })
      }
    }
    void this.checkpoints
      .prompt(resident, current, () =>
        driver.prompt(
          this.control(resident).activeBindingId,
          [
            controlNote([
              ...(this.dependencies.controlInstructions?.(this.control(resident).activeBindingId, resident.snapshot.session.id) ?? []),
              ...(told ? [told.account] : []),
            ]),
            current.context.reduce((text, manifest) => contextPrompt(manifest, text), request.text),
          ].filter(Boolean).join("\n\n"),
          request.attachments,
          request.tuning,
          { operationId: request.id, attemptId, report }
        )
      )
      .catch((error) => {
        report({ kind: "uncertain", reason: errorMessage({ error }) })
        const target = resident.snapshot.requests.find(
          (candidate) =>
            candidate.id === request.id && candidate.status === "dispatching"
        )
        if (generation !== resident.generation || !target) return
        const session = resident.snapshot.session
        const refused = target.nativeDelivery?.attemptId === attemptId && target.nativeDelivery.evidence.kind === "not-accepted"
        if (session.status === "running" && session.connection === "connected") {
          if (refused) {
            // The driver refused before sending because the provider was
            // still running a turn it had lost track of, and is showing that
            // turn now. Nothing was delivered, so the message waits for it.
            hostWarn("live", "a message waits for a turn the provider was still running", {
              conversation: resident.snapshot.session.id,
              request: request.id,
            })
            resident.snapshot = {
              ...resident.snapshot,
              requests: resident.snapshot.requests.map((candidate) =>
                candidate === target
                  ? { ...candidate, status: "queued", error: undefined, snapshots: undefined }
                  : candidate.id === told?.requestId && candidate.interruption?.told === toldAt
                    ? { ...candidate, interruption: { ...candidate.interruption, told: undefined } }
                    : candidate
              ),
            }
            this.dependencies.workspaceSnapshots?.abandonRun(request.id)
            this.flush(resident)
            return
          }
          // A send that threw without a receipt may still have started the
          // turn, and the driver still runs it: the request settles when
          // that turn ends, like any other, and is never sent again.
          hostWarn("live", "a send failed without a receipt while its turn runs; waiting for the turn", {
            conversation: resident.snapshot.session.id,
            request: request.id,
            error: errorMessage({ error }),
          })
          return
        }
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            status: "failed",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((candidate) =>
            candidate.id === request.id
              ? {
                  ...candidate,
                  status: "failed",
                  error: errorMessage({ error }),
                }
              : candidate
          ),
        }
        this.checkpoints.settle(resident, request.id)
        this.flush(resident)
      })
  }

  private schedule(resident: Resident): void {
    resident.timer ??= setTimeout(() => {
      try {
        this.flush(resident)
      } catch (error) {
        this.storageFailed(resident, { error })
      }
    }, 16)
  }

  private flush(resident: Resident): void {
    const session = resident.snapshot.session
    if (session.executionContext?.identity.kind === "pending" &&
      (session.status === "closed" || session.connection === "hibernated" || session.connection === "disconnected")) {
      resident.snapshot = { ...resident.snapshot, session: { ...session, executionContext: disconnectedContext(session.executionContext) } }
      if (!resident.opening) this.updateBinding(resident, resident.snapshot.session)
    }
    if (resident.timer) clearTimeout(resident.timer)
    resident.timer = null
    const previous = resident.journalSnapshot ?? resident.snapshot
    if (
      !resident.updates.length &&
      resident.journalSnapshot === resident.snapshot
    )
      return
    const updates = resident.updates
    const snapshot = {
      ...resident.snapshot,
      blocks: reduceLiveUpdates(resident.snapshot.blocks, updates),
      revision: resident.snapshot.revision + 1,
      activityAt: resident.activityAt,
    }
    resident.journal.commit(snapshot, previous)
    resident.storageFault = false
    resident.updates = []
    resident.pendingCharacters = 0
    resident.snapshot = snapshot
    resident.journalSnapshot = snapshot
    this.syncMemory(previous.session, snapshot.session)
    if (previous.control !== snapshot.control || previous.threadPath !== snapshot.threadPath)
      this.registerThread(snapshot, undefined)
    this.dependencies.emit({
      type: "live-batch",
      batch: {
        id: snapshot.session.id,
        revision: snapshot.revision,
        epoch: this.epoch,
        updates,
        changedFrom: changedLiveBlockStart(previous.blocks, snapshot.blocks),
        blockCount: snapshot.blocks.length,
        nativeAgents:
          previous.nativeAgents !== snapshot.nativeAgents
            ? snapshot.nativeAgents
            : undefined,
        control:
          previous.control !== snapshot.control ? snapshot.control : undefined,
        base: previous.base !== snapshot.base ? snapshot.base : undefined,
        baseCoveredBlocks: previous.baseCoveredBlocks !== snapshot.baseCoveredBlocks
          ? (snapshot.baseCoveredBlocks ?? 0) : undefined,
        threadPath:
          previous.threadPath !== snapshot.threadPath
            ? (snapshot.threadPath ?? null)
            : undefined,
        session:
          previous.session !== snapshot.session ? snapshot.session : undefined,
        permissions:
          previous.permissions !== snapshot.permissions
            ? snapshot.permissions
            : undefined,
        requests:
          previous.requests !== snapshot.requests
            ? snapshot.requests
            : undefined,
        activityAt:
          previous.activityAt !== snapshot.activityAt
            ? snapshot.activityAt
            : undefined,
        nativeActivity:
          previous.nativeActivity !== snapshot.nativeActivity
            ? (snapshot.nativeActivity ?? null)
            : undefined,
      },
    })
    if (
      previous.session.status === "running" &&
      snapshot.session.status === "ready"
    )
      this.checkpointIdle(resident)
    if (
      previous.requests !== snapshot.requests ||
      previous.permissions !== snapshot.permissions ||
      previous.session.status !== snapshot.session.status
    )
      this.children.settle(resident)
  }

  private storageFailed(resident: Resident, boundary: FailureBoundary): void {
    if (resident.storageFault) return
    resident.storageFault = true
    this.dependencies.emit({
      type: "notice",
      level: "error",
      message: `The conversation could not be saved. The provider is being stopped; buffered output is retained in memory. ${errorMessage(boundary)}`,
    })
    void resident.driver
      ?.cancel(this.control(resident).activeBindingId)
      .catch(() => {})
  }

  private require(id: string): Resident {
    const resident = this.load(id)
    if (!resident) throw new Error("This conversation is unavailable")
    return resident
  }

  private load(id: string): Resident | undefined {
    const existing = this.records.get(id)
    if (existing) { this.cacheClosed(existing); return existing }
    if (!this.recovered.has(id)) return undefined
    const journal = new LiveJournal(this.dependencies.root, id)
    const previous = journal.read()
    if (!previous) {
      journal.close()
      return undefined
    }
    const strandedTransfers = new Set(
      previous.control?.transfers
        .filter(
          (transfer) =>
            transfer.state.kind === "accepted" &&
            previous.requests.some(
              (request) =>
                request.id === transfer.input.id &&
                request.status === "queued"
            )
        )
        .map((transfer) => transfer.input.id) ?? []
    )
    const restartError =
      "The host restarted before the provider switch was activated. Submit a new switch to retry."
    const snapshot: LiveSnapshot = {
      ...previous,
      nativeAgents: disconnectNativeAgents(previous.nativeAgents),
      control: previous.control
        ? {
            ...previous.control,
            approvalResponses: previous.control.approvalResponses?.map(receipt =>
              receipt.state.kind === "dispatching" ? { ...receipt, state: {
                kind: "uncertain" as const,
                reason: "The host restarted before approval submission was confirmed. It will not be sent again automatically.",
              } } : receipt
            ),
            actions: previous.control.actions?.map((action) =>
              action.state.kind === "dispatching" ||
              (action.input.kind === "compact" &&
                action.state.kind === "accepted")
                ? {
                    ...action,
                    state: {
                      kind: "uncertain" as const,
                      reason:
                        "The host restarted before this provider action was confirmed. It will not be retried automatically.",
                    },
                  }
                : action
            ),
            transfers: previous.control.transfers.map((transfer) =>
              transfer.state.kind === "preparing" ||
              transfer.state.kind === "queued" ||
              strandedTransfers.has(transfer.input.id)
                ? {
                    ...transfer,
                    state: {
                      kind: "failed" as const,
                      error: restartError,
                    },
                  }
                : transfer
            ),
          }
        : undefined,
      session: {
        ...previous.session,
        executionContext: disconnectedContext(previous.session.executionContext),
        status:
          previous.session.status === "closed"
            ? "closed"
            : previous.session.status === "ready"
              ? "ready"
              : "failed",
        connection: "disconnected",
        error:
          previous.session.status === "running"
            ? "The host restarted before completion was confirmed. Saved output is available."
            : undefined,
      },
      permissions: [],
      // A request still dispatching in a journal no host is writing was cut
      // short by a host that never reached `stop()`: it died, or was killed.
      // A continuation that host had scheduled died with it.
      requests: clearAutoContinue(
        interruptRequests(
          previous.requests,
          "host-crashed",
          "Mako closed unexpectedly while this turn was running; whether the provider finished it is unknown"
        ).map((request) =>
          strandedTransfers.has(request.id) &&
          request.status === "queued"
            ? {
                ...request,
                status: "failed" as const,
                error: restartError,
                failure: "resume-failed" as const,
              }
            : request
        )
      ),
    }
    const crashed = previous.requests.find((request) => request.status === "dispatching")
    const interruption = snapshot.requests.find((request) => request.id === crashed?.id)?.interruption
    if (crashed && interruption) {
      const closing = closeCutOffCalls(snapshot.blocks, crashed.id, cutOffNote(interruption, undefined))
      snapshot.blocks = reduceLiveUpdates(snapshot.blocks, closing)
      const record = recordCutOffCalls(snapshot.blocks, crashed.id, undefined, join(this.dependencies.root, "context", "interrupted", crashed.id))
      snapshot.requests = snapshot.requests.map((request) =>
        request.id === crashed.id && request.interruption
          ? { ...request, interruption: { ...request.interruption, ...record } }
          : request
      )
    }
    journal.commit(snapshot, previous)
    const resident: Resident = {
      connections: new Map(),
      bindingGenerations: new Map(),
      transferring: false,
      snapshot,
      journal,
      journalSnapshot: snapshot,
      driver: null,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    }
    this.records.set(id, resident)
    this.recovered.delete(id)
    this.children.recover(resident)
    this.cacheClosed(resident)
    return resident
  }
}

function nativeRevision(page: ThreadPage): string {
  return JSON.stringify([page.ref.revision, page.ref.bytes, page.ref.updatedAt])
}

/**
 * The dispatching request's verdict when its session leaves `running`. A
 * Stop is recorded as the user's interruption; a failure carries the kind the
 * provider's text classifies as, so the renderer can say whether sending
 * again is worth anything without reading the text itself.
 */
/** Whether the event shows the provider working, for `LiveSnapshot.activityAt`. */
function showsActivity(event: LiveDriverEvent, status: LiveSessionState["status"], replaying: boolean): boolean {
  switch (event.type) {
    case "live-session":
      return event.session.status === "running" && status !== "running"
    case "live-update":
      return !replaying
    case "live-updates":
      return event.updates.length > 0 && !replaying
    case "live-permission":
    case "live-question":
    case "live-agent":
      return true
    case "live-activity":
      return event.activity !== null && !replaying
    default:
      return false
  }
}

/**
 * The running turn's activity after `observation`: the same object when
 * nothing changed, so a repeated report publishes nothing, and the first
 * `since` while the provider keeps doing the same kind of thing.
 */
function observeNativeActivity(
  current: NativeActivity | undefined,
  observation: NativeActivityObservation | null
): NativeActivity | undefined {
  if (!observation) return undefined
  const next = { ...observation, since: current?.kind === observation.kind ? current.since : Date.now() }
  return current && JSON.stringify(current) === JSON.stringify(next) ? current : next
}

/**
 * Why a turn that ended without finishing can be continued rather than sent
 * again, or `undefined`. The provider's own dropped-connection stop always
 * qualifies. Otherwise the provider must have accepted the prompt, so its
 * saved session holds the turn so far: then a process that died under the
 * turn, or a turn that failed on a dropped connection, is picked up where it
 * stopped. Without that receipt the outcome is unknown and stays the user's
 * call. A session that reports itself closed was ended on purpose, and one
 * whose transport already exhausted its own retries is never re-run here.
 */
function continuableInterruption(request: LiveRequest, session: LiveSessionState): InterruptionReason | undefined {
  if (session.status === "closed" || session.lastStop === RETRIES_EXHAUSTED_STOP) return undefined
  if (session.lastStop === CONNECTION_LOST_STOP) return "connection-lost"
  if (session.status === "ready" || request.nativeDelivery?.evidence.kind !== "accepted") return undefined
  if (session.connection === "disconnected") return "provider-exited"
  return classifyProviderFailure(session.error).kind === "network" ? "connection-lost" : undefined
}

/**
 * The request's outcome for the turn `session` just ended. `ended` says the
 * user stopped this turn or closed the conversation: unless the turn finished
 * first, it settles stopped however the driver reported the end.
 */
function settleRequest(request: LiveRequest, session: LiveSessionState, ended: boolean): LiveRequest {
  const stopped = (ended && session.status !== "ready") || /cancel|interrupt/i.test(session.lastStop ?? "")
  const dropped = stopped ? undefined : continuableInterruption(request, session)
  const status = stopped || dropped ? "interrupted" : session.status === "ready" ? "completed" : "failed"
  const settled: LiveRequest = {
    ...request,
    nativeDelivery: request.nativeDelivery && status !== "completed"
      ? { ...request.nativeDelivery, evidence: advancePromptDelivery(request.nativeDelivery.evidence, { kind: "uncertain", reason: session.error ?? "The turn ended without a delivery receipt" }) }
      : request.nativeDelivery,
    status,
    error: session.error,
    nativeRun:
      request.nativeRun && session.nativeForkId
        ? { ...request.nativeRun, forkId: session.nativeForkId }
        : request.nativeRun,
  }
  if (dropped) {
    // The work so far stands on the provider's side, so the request is
    // continuable rather than one to re-send; the failure kind is still
    // recorded so the panel can say what ended it.
    settled.interruption = { reason: dropped, at: Date.now() }
    settled.failure = dropped === "connection-lost" ? "network" : classifyProviderFailure(session.error).kind
  } else if (status === "interrupted") settled.interruption = { reason: "stopped", at: Date.now() }
  if (status === "failed") settled.failure = classifyProviderFailure(session.error).kind
  const spend = spendBetween(request.usageFrom, session.usage)
  if (spend.tokens || spend.cost !== undefined)
    settled.spend = { provider: session.harness, model: session.settings?.model, at: Date.now(), ...spend }
  return settled
}

/** The requests with the scheduled-continuation stamp removed from `requestId`, or from every request. */
function clearAutoContinue(requests: LiveRequest[], requestId?: string): LiveRequest[] {
  return requests.map((request) => {
    if (!request.interruption?.autoContinue || (requestId !== undefined && request.id !== requestId)) return request
    const interruption = { ...request.interruption }
    delete interruption.autoContinue
    return { ...request, interruption }
  })
}

/** Mark every in-flight request cut short by the host itself, with the reason and the moment. */
function interruptRequests(
  requests: LiveRequest[],
  reason: Extract<InterruptionReason, "host-quit" | "host-crashed">,
  error: string
): LiveRequest[] {
  const at = Date.now()
  return requests.map((request) =>
    request.status === "dispatching"
      ? {
          ...request,
          nativeDelivery: request.nativeDelivery
            ? { ...request.nativeDelivery, evidence: advancePromptDelivery(request.nativeDelivery.evidence, { kind: "uncertain", reason: error }) }
            : undefined,
          status: reason === "host-quit" ? "interrupted" : "uncertain",
          error,
          interruption: { reason, at },
        }
      : request
  )
}

function registrationKey(facts: JournalFacts): string {
  return JSON.stringify([
    facts.threadPath ?? null,
    facts.ancestry?.parentId ?? null,
    facts.bindings.map((binding) => [binding.provider, binding.nativeId ?? null, binding.path ?? null]),
  ])
}
