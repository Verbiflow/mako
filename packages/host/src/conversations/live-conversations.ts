import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Admission } from "../base/admission.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { disconnectedContext } from "../base/execution-context.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { AccountRemovalSession } from "../contracts/accounts.js"
import type { LifecycleWork } from "../contracts/app-lifecycle.js"
import type { ForkInput, TransferInput } from "../contracts/conversation-control.js"
import type { LiveActionInput } from "../contracts/live-actions.js"
import { GoalCommandSchema, type GoalCommand } from "../contracts/live-goals.js"
import type { SideQuestionCommand } from "../contracts/live-side-questions.js"
import { makoReviewPrompt, reviewDisplayText, ReviewTargetSchema, type ReviewTarget } from "../contracts/live-reviews.js"
import {
  requestsDelta,
  sessionDelta,
  sharedSession,
  type LiveDriverEvent,
  type LiveRequest,
  type LiveSnapshot,
  type LiveStartOptions,
  type LiveSummary,
  type SignInReadiness,
  type SignInResume,
  type TurnContinuation,
} from "../contracts/live-conversations.js"
import { QueuedPromptEditSchema, type QueuedPromptEdit } from "../contracts/live-queue.js"
import { retireQuestionsForInput } from "../contracts/live-questions.js"
import { isActiveNativeAgent, isBusyNativeAgent } from "../contracts/native-agents.js"
import type { ProviderResidencySnapshot } from "../contracts/provider-residency.js"
import type { ContextBreakdown, LivePermissionResponse, LiveSessionState, PromptAttachment } from "../contracts/providers-acp.js"
import { signInPause } from "../contracts/sign-in-hold.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { RewindInput } from "../contracts/workspace-snapshots.js"
import type { Relocation } from "../workspaces/index.js"
import { changedEntryStart, deliverLiveUpdates } from "@mako/sessions/live-content"
import type { SessionSettings } from "@mako/sessions/settings"
import { LiveAccounts } from "./live-accounts.js"
import { LiveActions } from "./live-actions.js"
import { LiveApprovals } from "./live-approvals.js"
import { LiveAssets, promptFingerprint } from "./live-assets.js"
import { LiveAutoContinue } from "./live-auto-continue.js"
import { LiveCheckpoints } from "./live-checkpoints.js"
import { LiveClosing } from "./live-closing.js"
import { LiveDispatch } from "./live-dispatch.js"
import { driverEvents, LiveEvents } from "./live-events.js"
import { LiveForks } from "./live-forks.js"
import { LiveGoals } from "./live-goals.js"
import { LiveSideQuestions } from "./live-side-questions.js"
import { LiveHibernation } from "./live-hibernation.js"
import { LiveRequestSchema } from "./live-journal.js"
import { JournalReclaims } from "./journal-reclaim.js"
import { LiveLaunches, nativeStart } from "./live-launches.js"
import { syncMemory } from "./live-ledger.js"
import { LiveMoves } from "./live-moves.js"
import { LiveQuestions } from "./live-questions.js"
import { LiveRecords } from "./live-records.js"
import { LiveRelocations } from "./live-relocations.js"
import { ContextBundles } from "./live-context.js"
import { activeBinding, conversationControl, launched, type Dependencies, type LiveAccess, type Resident } from "./live-runtime.js"
import { LiveSources, settled, updateBinding, type SettledBases } from "./live-sources.js"
import { LiveThreads } from "./live-threads.js"
import { LiveTransfers } from "./live-transfers.js"

/** How long after the host starts it moves journals' copies of their history onto records (`LiveSources.settleBases`). */
const SETTLE_AFTER_START_MS = 60_000
const SETTLE_EVERY_MS = 15 * 60_000

/** Owns durable conversation intent and observation. Providers still own execution. */
export class LiveConversations {
  private readonly stops = new Map<string, { requestId: string; result: Promise<boolean> }>()
  private settleTimer?: ReturnType<typeof setTimeout>
  private readonly dependencies: Dependencies
  private readonly admission: Admission
  private readonly assets: LiveAssets
  private readonly threads: LiveThreads
  private readonly records: LiveRecords
  private readonly checkpoints: LiveCheckpoints
  private readonly questions: LiveQuestions
  private readonly approvals: LiveApprovals
  private readonly actions: LiveActions
  private readonly transfers: LiveTransfers
  private readonly sources: LiveSources
  private readonly launches: LiveLaunches
  private readonly hibernation: LiveHibernation
  private readonly accounts: LiveAccounts
  private readonly relocations: LiveRelocations
  private readonly forks: LiveForks
  private readonly autoContinue: LiveAutoContinue
  private readonly goals: LiveGoals
  private readonly sideQuestions: LiveSideQuestions
  private readonly events: LiveEvents
  private readonly dispatch: LiveDispatch
  private readonly closing: LiveClosing
  /** Which Sessions this environment may run, and moving Threads to another. */
  readonly moves: LiveMoves
  /**
   * One generation per host life. Every batch and snapshot carries it so a
   * renderer can tell a revision numbered by this host from one numbered by
   * the host before it, and re-snapshot instead of merging across the seam.
   */
  readonly epoch = randomUUID()
  private readonly reclaims = new JournalReclaims()

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.admission = dependencies.admission ?? new Admission()
    this.assets = new LiveAssets(join(dependencies.root, "assets"))
    this.threads = new LiveThreads(dependencies)
    this.records = new LiveRecords(dependencies, {
      busy: (resident) => {
        const id = resident.snapshot.session.id
        return Boolean(this.transfers.pending(resident)) || this.launches.starting(id) || this.sources.refreshing(id) || this.stops.has(id)
      },
      flush: (resident) => this.flush(resident),
      storageFailed: (resident, boundary) => this.storageFailed(resident, boundary),
      loaded: (resident) => { void this.sources.readBase(resident) },
      compact: (path) => { void this.reclaims.reclaim(path) },
    })
    this.moves = new LiveMoves({
      dependencies,
      resident: (id) => this.records.get(id),
      control: conversationControl,
      pending: (resident) => this.transfers.pending(resident),
      canHibernate: (resident) => this.hibernation.canHibernate(resident),
      hibernate: (resident, reason) => this.hibernation.hibernate(resident, reason),
      resume: (resident) => {
        if (!resident.driver && resident.snapshot.session.connection === "hibernated" &&
            resident.snapshot.requests.some((request) => request.status === "queued"))
          void this.hibernation.wake(resident)
        else this.dispatch.drain(resident)
      },
    })
    const observe = (event: LiveDriverEvent) => this.events.observe(event)
    const access: LiveAccess = {
      dependencies,
      reclaims: this.reclaims,
      epoch: this.epoch,
      bundles: new ContextBundles(dependencies.children, dependencies.harnessLabel),
      admission: this.admission,
      moves: this.moves,
      bindingOwners: this.records.owners,
      resident: (id) => this.records.get(id),
      residents: () => this.records.values(),
      require: (id) => this.records.require(id),
      load: (id) => this.records.load(id),
      add: (resident) => this.records.add(resident),
      control: conversationControl,
      flush: (resident) => this.flush(resident),
      schedule: (resident) => this.schedule(resident),
      storageFailed: (resident, boundary) => this.storageFailed(resident, boundary),
      stamp: (snapshot) => this.stamp(snapshot),
      snapshot: (id) => this.snapshot(id),
      summaries: () => this.summaries(),
      actor: (explicit) => this.threads.actor(explicit),
      register: (snapshot, actor) => this.threads.register(snapshot, actor),
      markPurpose: (conversationId, purpose, options) => this.threads.markPurpose(conversationId, purpose, options),
      startingSession: (session) => this.threads.startingSession(session),
      sameSession: (conversationId, ref) => this.threads.sameSession(conversationId, ref, () => {
        const snapshot = this.records.load(conversationId)?.snapshot
        return snapshot?.base?.ref ?? snapshot?.baseSource
      }),
      announceGroup: (thread) => this.threads.announceGroup(thread),
      observe,
      takeUpdates: (resident, updates) => this.events.take(resident, updates),
      driverEvents: (resident, bindingId) => driverEvents(resident, bindingId, observe),
      nativeStart,
      retainAttachments: (attachments) => this.assets.retainPrompt(attachments),
      reconcileQuestions: (resident) => this.questions.reconcile(resident),
      pending: (resident) => this.transfers.pending(resident),
      admit: (resident, request) => this.admit(resident, request),
      transfer: (id, input, actor, continues) => this.transfer(id, input, actor, continues),
      drain: (resident) => this.dispatch.drain(resident),
      close: (id) => this.closing.close(id),
      launch: (...launch) => this.launches.launch(...launch),
      discoverNativePath: (resident) => this.sources.discoverNativePath(resident),
      readBase: (resident) => this.sources.readBase(resident),
      release: (id) => this.records.release(id),
      hasActiveWork: () => this.hasActiveWork(),
      locateNativePath: (resident) => this.sources.locateNativePath(resident),
      nativeRewound: (resident, run) => this.sources.nativeRewound(resident, run),
      canHibernate: (resident, preparing, recoverAccount) => this.hibernation.canHibernate(resident, preparing, recoverAccount),
      hibernate: (resident, reason) => this.hibernation.hibernate(resident, reason),
      scheduleHibernation: (resident, enforceWarmLimit) => this.hibernation.scheduleHibernation(resident, enforceWarmLimit),
      clearHibernationTimer: (resident, clearSince) => this.hibernation.clearHibernationTimer(resident, clearSince),
      reopen: (resident) => this.hibernation.reopen(resident),
      reopens: (resident) => this.hibernation.reopens(resident),
      wake: (resident) => this.hibernation.wake(resident),
      residencyChanged: (resident) => {
        this.hibernation.scheduleHibernation(resident)
        this.relocations.changed(resident)
      },
      homeFromRemovedWorktree: (resident) => this.relocations.homeFromRemovedWorktree(resident),
      returnFromRemovedWorktree: (resident) => this.relocations.returnFromRemovedWorktree(resident),
      failedStart: (resident, boundary, resuming) => this.accounts.failedStart(resident, boundary, resuming),
      signInHold: (resident) => this.accounts.signInHold(resident),
      retireFromAccount: (resident) => this.accounts.retireFromAccount(resident),
      switchAccount: (resident, request) => this.accounts.switchAccount(resident, request),
      accountSwitchWait: (resident) => this.accounts.accountSwitchWait(resident),
      scheduleAutoContinue: (resident, settled) => this.autoContinue.schedule(resident, settled),
      declineAutoContinue: (resident) => this.autoContinue.decline(resident),
      goalSettled: (resident, settled) => this.goals.settled(resident, settled),
      goalObserved: (resident, goal) => this.goals.observe(resident, goal),
      goalSpent: (resident) => this.goals.spent(resident),
    }
    this.checkpoints = new LiveCheckpoints(access, (id, input) => this.fork(id, input))
    this.approvals = new LiveApprovals(access)
    this.questions = new LiveQuestions(access, {
      continue: (id, bindingId, requestId, text, displayText) => { this.continueBinding(id, bindingId, requestId, text, [], undefined, displayText) },
      steer: (id, input) => this.act(id, input),
    })
    this.actions = new LiveActions(access)
    this.transfers = new LiveTransfers(access)
    this.sources = new LiveSources(access)
    this.launches = new LiveLaunches(access)
    this.hibernation = new LiveHibernation(access)
    this.accounts = new LiveAccounts(access)
    this.relocations = new LiveRelocations(access)
    this.forks = new LiveForks(access)
    this.autoContinue = new LiveAutoContinue(access)
    this.goals = new LiveGoals(access, {
      submit: (id, message) => this.submit(id, randomUUID(), message.text, [], message.tuning, undefined, message.displayText, message.actor, { goal: message.goal, verbatim: message.verbatim }),
      stop: (id) => this.cancelTurn(id),
    })
    this.sideQuestions = new LiveSideQuestions(access)
    const { actions, approvals, questions, checkpoints, assets, transfers, records } = this
    this.events = new LiveEvents(access, { actions, approvals, questions, checkpoints, assets })
    this.dispatch = new LiveDispatch(access, { actions, checkpoints, transfers })
    this.closing = new LiveClosing(access, { records, actions, approvals, transfers })
    this.threads.registerJournals(records.open())
    if (dependencies.holdHistory) this.scheduleSettle(SETTLE_AFTER_START_MS)
  }

  /** The sweep a minute after the host starts, then every `SETTLE_EVERY_MS`: a turn writes its conversation's copy back until its session holds the turn. */
  private scheduleSettle(delay: number): void {
    this.settleTimer = setTimeout(() => {
      void this.sources.settleBases()
        .catch((error) => hostWarn("live", "journals' copies of their history stay for now", { error: errorMessage({ error }) }))
        .finally(() => { if (!this.admission.closed) this.scheduleSettle(SETTLE_EVERY_MS) })
    }, delay)
    this.settleTimer.unref?.()
  }

  /** Once every compaction of a journal this host closed has ended. */
  journalsCompacted(): Promise<void> {
    return this.reclaims.settled()
  }

  /** The host's sweep, now; `pauseMs` between journals. */
  settleHistoryCopies(pauseMs?: number): Promise<SettledBases> {
    return this.sources.settleBases(pauseMs)
  }

  hasActiveWork(): boolean { return this.lifecycleWork().length > 0 }

  residency(): ProviderResidencySnapshot {
    return this.hibernation.snapshot(this.records.memory())
  }

  lifecycleWork(): LifecycleWork[] {
    const work: LifecycleWork[] = [...this.records.values()].flatMap((resident) => {
      const { snapshot } = resident
      const finishing = resident.transferring || resident.opening || resident.checkpointing || resident.rewinding || resident.closing
      const requests = snapshot.requests.filter((request) => request.status === "dispatching" || request.status === "queued")
      const native = snapshot.nativeAgents?.agents.filter(isBusyNativeAgent) ?? []
      const background = Boolean(snapshot.session.backgroundTasks)
      if (!finishing && (!resident.driver || (snapshot.session.status !== "running" && !background && !requests.length && !native.length && !snapshot.permissions.length))) return []
      const status = finishing ? "finishing" : snapshot.permissions.length || native.some((agent) => agent.state.kind === "waiting") ? "waiting" : snapshot.session.status === "running" || background || native.some((agent) => agent.state.kind === "working") ? "running" : "queued"
      return [{ id: snapshot.session.id, token: `${resident.generation}:${requests.map((request) => request.id).join(":")}:${JSON.stringify(native.map((agent) => [agent.nativeId, agent.nativeRunId ?? agent.observedAt]))}`, title: snapshot.session.title || "Untitled conversation", provider: snapshot.session.harness, cwd: snapshot.session.cwd, status, stoppable: !finishing }]
    })
    for (const id of this.launches.startingIds()) if (!work.some((item) => item.id === id)) work.push({ id, token: id, title: "Starting an agent", provider: "", cwd: "", status: "finishing", stoppable: false })
    for (const path of this.sources.capturing()) work.push({ id: `capture:${path}`, token: path, title: "Saving a conversation", provider: "", cwd: path, status: "finishing", stoppable: false })
    return work
  }

  closeForExit(ids?: string[]): Promise<void> {
    return this.closing.closeForExit(ids)
  }

  summaries(): LiveSummary[] {
    return this.records.listing().map((summary) => ({ ...summary, epoch: this.epoch, ...this.threads.placement(summary.session.id) }))
  }

  /** A connected driver is authoritative even if a ledger write failed earlier. */
  connectedSession(provider: string, nativeId: string): string | null {
    for (const { snapshot } of this.records.values()) {
      const session = snapshot.session
      if (session.connection === "connected" && session.harness === provider && session.nativeId === nativeId) {
        syncMemory(this.dependencies.memory, session, session)
        return session.id
      }
    }
    return null
  }

  /** The connected session's context by category; `null` when its harness does not itemize it or nothing is connected. */
  async contextBreakdown(id: string): Promise<ContextBreakdown | null> {
    const resident = this.records.load(id)
    const bindingId = resident && conversationControl(resident).activeBindingId
    const breakdown = resident?.driver?.contextBreakdown
    if (breakdown?.kind !== "itemized" || !bindingId || resident?.snapshot.session.connection !== "connected") return null
    return breakdown.read(bindingId)
  }

  /** The session as the listing has it, without reading an unloaded conversation's transcript back. */
  session(id: string): LiveSessionState | undefined {
    return this.records.session(id)
  }

  /** Whether the conversation is in memory; one only on disk runs nothing, and `snapshot` would read it in. */
  loaded(id: string): boolean {
    return this.records.has(id)
  }

  snapshot(id: string): LiveSnapshot | null {
    const resident = this.records.load(id)
    if (!resident) return null
    this.flush(resident)
    return this.stamp(resident.snapshot)
  }

  refreshedSnapshot(id: string): Promise<LiveSnapshot | null> {
    return this.sources.refreshedSnapshot(id)
  }

  relocate(id: string, cwd: string): Promise<string | undefined> {
    return this.relocations.relocate(id, cwd)
  }

  resumeMoved(id: string, from: string): Promise<string | undefined> {
    return this.relocations.resumeMoved(id, from)
  }

  relocation(id: string): Relocation {
    return this.relocations.relocation(id)
  }

  relocationWithin(id: string, ms: number): Promise<Relocation> {
    return this.relocations.relocationWithin(id, ms)
  }

  hibernateIfIdle(id: string, reason?: string): boolean {
    return this.hibernation.hibernateIfIdle(id, reason)
  }

  prewarm(id: string): "waking" | "kept-warm" | "unchanged" {
    return this.hibernation.prewarm(id)
  }

  setArchived(id: string, archived: boolean): void {
    this.hibernation.setArchived(id, archived)
  }

  /** The snapshot as this host numbers it; the renderer merges batches only onto the same epoch. */
  private stamp(snapshot: LiveSnapshot): LiveSnapshot {
    const placed = this.threads.placement(snapshot.session.id)
    return snapshot.epoch === this.epoch && snapshot.threadId === placed.threadId && snapshot.sessionId === placed.sessionId
      ? snapshot
      : { ...snapshot, epoch: this.epoch, ...placed }
  }

  capture(id: string, path: string): Promise<LiveSnapshot> {
    return this.sources.capture(id, path)
  }

  async start(provider: string, cwd: string, options: LiveStartOptions, actor?: Actor, purpose?: StartPurpose): Promise<LiveSessionState> {
    if (options.goal !== undefined) GoalCommandSchema.parse({ kind: "set", ...options.goal })
    if (options.review !== undefined) ReviewTargetSchema.parse(options.review)
    const state = await this.launches.start(provider, cwd, options, actor, purpose)
    if (options.initialRequest) this.firstMessage(options, actor)
    if (options.goal !== undefined) this.goals.begin(options.conversationId, options.goal, { actor: this.threads.actor(actor), tuning: options.tuning })
    if (options.review !== undefined) this.review(options.conversationId, options.review, options.tuning, actor)
    return state
  }

  /**
   * Once the conversation's start has settled: resolves when its harness is ready, rejects with why it couldn't
   * start. A conversation that started earlier answers how it stands.
   */
  async opened(id: string): Promise<LiveSessionState> {
    const resident = this.records.require(id)
    await resident.openingOperation?.catch(() => undefined)
    const session = resident.snapshot.session
    if (session.status === "failed") throw new Error(session.error ?? "Its harness didn't start.")
    return session
  }

  /**
   * A conversation started without a message, as a cloud Thread's harness is started while its person writes, takes
   * its first one from the start that brings it: under that start's request ID, so a repeated start sends it once,
   * with the start's title when it has none. The start ahead had the start's harness, folder and mode; a caller whose
   * choice changed starts another conversation. A conversation that already holds requests keeps its own.
   */
  private firstMessage(options: LiveStartOptions, actor?: Actor): void {
    const request = options.initialRequest
    const resident = this.records.require(options.conversationId)
    if (!request || resident.snapshot.requests.length) return
    if (options.title && !resident.snapshot.session.title) {
      resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, title: options.title } }
      this.threads.register(resident.snapshot, actor)
    }
    this.submit(options.conversationId, request.id, request.text, request.attachments, options.tuning, undefined, options.displayPrompt, actor)
  }

  /** Where a start in `cwd` runs (`LiveLaunches.folder`). */
  startFolder(provider: string, cwd: string, options: Pick<LiveStartOptions, "conversationId" | "resume" | "session">): string {
    return this.launches.folder(provider, cwd, options)
  }

  signInReadiness(id: string): Promise<SignInReadiness | null> {
    return this.accounts.signInReadiness(id)
  }

  resumeSignIn(id: string, anyway?: boolean, actor?: Actor): Promise<SignInResume> {
    return this.accounts.resumeSignIn(id, anyway, actor)
  }

  accountSessions(bindingIds: readonly string[]): AccountRemovalSession[] {
    return this.accounts.accountSessions(bindingIds)
  }

  retireAccountSessions(bindingIds: readonly string[]): void {
    this.accounts.retireAccountSessions(bindingIds)
  }

  observe(event: LiveDriverEvent): void {
    this.events.observe(event)
  }

  continueBinding(id: string, bindingId: string, requestId: string, text: string,
    attachments: PromptAttachment[] = [], tuning?: SessionSettings, displayText?: string, actor?: Actor): LiveSnapshot {
    const resident = this.records.require(id)
    const control = conversationControl(resident)
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
    actor?: Actor,
    marks: Pick<LiveRequest, "goal" | "review" | "verbatim"> = {}
  ): LiveRequest {
    this.admission.assert()
    const resident = this.records.require(id)
    if (resident.rewinding)
      throw new Error("Wait for the workspace rewind to finish before sending")
    this.flush(resident)
    const request = LiveRequestSchema.parse({
      actor: this.threads.actor(actor),
      id: requestId,
      createdAt: Date.now(),
      text,
      attachments,
      tuning,
      targetBindingId,
      displayText,
      status: "queued",
      ...marks,
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
      if (existing.status === "queued") this.dispatch.drain(resident)
      return existing
    }
    this.moves.assertAdmits(resident)
    if (this.transfers.pending(resident))
      throw new Error("A provider switch is pending. Wait for it to settle before sending another message.")
    if (targetBindingId && conversationControl(resident).activeBindingId !== targetBindingId)
      throw new Error("The selected native session changed before this message was accepted")
    if (!text.trim() && !attachments.length)
      throw new Error("A prompt cannot be empty")
    if (resident.snapshot.session.status === "closed") this.reopenClosed(resident)
    // The user's own message supersedes any continuation Mako was about to send.
    this.autoContinue.decline(resident)
    if (marks.goal?.step !== "continue") this.goals.decline(resident)
    this.hibernation.clearHibernationTimer(resident)
    const pause = signInPause(resident.snapshot.requests)
    if (pause) {
      // Work paused on a sign-out goes together, on Resume; nothing launches before.
      request.inputDigest = inputDigest
      return this.admit(resident, { ...request, status: "held", signIn: pause.hold })
    }
    if (resident.hibernating || (!resident.driver && this.hibernation.reopens(resident))) {
      request.inputDigest = inputDigest
      const accepted = this.admit(resident, request)
      void this.hibernation.wake(resident)
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

  /**
   * A message to a closed conversation carries it on: it opens again under
   * its native session, as a sleeping one wakes, and in its project folder
   * when its worktree was removed. One with nothing to resume refuses the
   * message, since nothing would ever send it.
   */
  private reopenClosed(resident: Resident): void {
    if (resident.closing || resident.driver) throw new Error("This conversation is still closing. Send again in a moment.")
    if (!launched(activeBinding(resident))) throw new Error("This conversation was closed before it started a session. Start a new conversation to carry on.")
    resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, status: "ready", connection: "hibernated", error: undefined } }
    hostLog("residency", "a closed conversation reopens for a new message", { conversation: resident.snapshot.session.id })
  }

  /** Record a new request in the journal and start it when the session is free. */
  private admit(resident: Resident, request: LiveRequest): LiveRequest {
    request.attachments = this.assets.retainPrompt(request.attachments)
    const previousSnapshot = resident.snapshot
    resident.snapshot = {
      ...resident.snapshot,
      control: request.continues?.auto ? conversationControl(resident) : retireQuestionsForInput(conversationControl(resident), request.id),
      requests: [...resident.snapshot.requests, request],
    }
    // Rejected acceptance must never become a later executable request.
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      throw error
    }
    this.dispatch.drain(resident)
    return request
  }

  authorizeAgent(id: string, bindingId: string): void {
    const resident = this.records.require(id)
    if (
      conversationControl(resident).activeBindingId !== bindingId ||
      !resident.driver ||
      resident.snapshot.session.status !== "running"
    )
      throw new Error(
        "This provider no longer owns an active turn in this conversation"
      )
  }

  async mergeFork(id: string, mergeId: string): Promise<LiveSnapshot> {
    await this.historyReady(id)
    return this.forks.merge(id, mergeId)
  }

  /** `cwd` places the fork's Session in another folder: a worktree the host made for it. Callers wait for `historyReady` first. */
  fork(id: string, input: ForkInput, cwd?: string): LiveSnapshot {
    return this.forks.fork(id, input, cwd)
  }

  /**
   * Once the history the journal names by source is read (`LiveSources.readBase`);
   * what reads the history whole or tells its harness something waits for it.
   */
  async historyReady(id: string): Promise<void> {
    const resident = this.records.load(id)
    if (resident) await this.sources.readBase(resident)
  }

  /** `snapshot` once its history is read. */
  async historySnapshot(id: string): Promise<LiveSnapshot | null> {
    await this.historyReady(id)
    return this.snapshot(id)
  }

  /** Tell every window what a Thread's tabs are now, after a Session joined it. */
  announceGroup(thread: string): void {
    this.threads.announceGroup(thread)
  }

  async previewRewind(
    id: string,
    requestId: string,
    position: "before" | "after" = "after"
  ) {
    if (this.actions.blocks(this.records.require(id)))
      throw new Error("Resolve the pending provider action before rewinding")
    await this.historyReady(id)
    return this.checkpoints.preview(id, requestId, position)
  }

  turnChanges(id: string, requestId: string) {
    return this.checkpoints.turnChanges(id, requestId)
  }

  turnDiff(id: string, requestId: string, path: string) {
    return this.checkpoints.turnDiff(id, requestId, path)
  }

  async rewind(id: string, input: RewindInput) {
    this.admission.assert()
    if (this.actions.blocks(this.records.require(id)))
      throw new Error("Resolve the pending provider action before rewinding")
    await this.historyReady(id)
    return this.checkpoints.rewind(id, input)
  }

  act(id: string, input: LiveActionInput) {
    this.admission.assert()
    return this.actions.submit(id, input)
  }

  acknowledgeAction(id: string, actionId: string): Promise<void> {
    return this.actions.acknowledge(id, actionId)
  }

  recoverRewinds() {
    return this.checkpoints.recover()
  }

  transfer(id: string, input: TransferInput, actor?: Actor, continues?: TurnContinuation): LiveSnapshot {
    this.admission.assert()
    const resident = this.records.require(id)
    if (resident.rewinding)
      throw new Error(
        "Wait for the workspace rewind to finish before switching providers"
      )
    this.moves.assertStarts(resident)
    return this.transfers.accept(id, input, this.threads.actor(actor), continues)
  }

  discoverNativePaths(): void {
    this.sources.discoverNativePaths()
  }

  editQueued(id: string, input: QueuedPromptEdit): LiveSnapshot {
    const command = QueuedPromptEditSchema.parse(input)
    const resident = this.records.require(id)
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
        next = { ...request, status: "canceled", signIn: undefined }
        break
      case "pause":
        next = { ...request, status: "held" }
        break
      // A message waiting on a sign-out keeps waiting; only the session's Resume releases it.
      case "resume":
        next = { ...request, status: request.signIn ? "held" : "queued" }
        break
      case "edit":
        next = {
          ...request,
          status: request.signIn ? "held" : "queued",
          text: command.change.text,
          displayText: undefined,
          nativeDelivery: undefined,
          nativePrompt: undefined,
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
    if (command.change.kind !== "pause") this.dispatch.drain(resident)
    return resident.snapshot
  }

  clearQueue(id: string): LiveSnapshot {
    const resident = this.records.require(id)
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued" || request.status === "held"
          ? {
              ...request,
              status: "canceled",
              signIn: undefined,
            }
          : request
      ),
    }
    this.flush(resident)
    return resident.snapshot
  }

  earlier(id: string): Promise<LiveSnapshot> {
    return this.sources.earlier(id)
  }

  bind(id: string, path: string): Promise<LiveSnapshot> {
    return this.sources.bind(id, path)
  }

  async permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): Promise<void> {
    if (conversationControl(this.records.require(id)).questions?.some(question => question.id === requestId)) {
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
    const resident = this.records.require(id)
    const snapshot = resident.snapshot
    resident.snapshot = { ...snapshot, requests: snapshot.requests.map((request) => request.status === "queued" && request.id !== requestId ? { ...request, status: "held" } : request) }
    try { this.flush(resident) } catch (error) { resident.snapshot = snapshot; return Promise.reject(error) }
    const opening = resident.opening
    resident.stopping = requestId
    const result = this.cancelRequest(id, requestId).then(async () => { if (opening) await this.close(id); return true }).catch((error) => { this.stops.delete(id); throw error })
    this.stops.set(id, { requestId, result })
    return result
  }

  async cancelRequest(id: string, requestId: string): Promise<void> {
    const resident = this.records.require(id)
    if (this.checkpoints.cancelBeforeDispatch(resident, requestId)) return
    const request = resident.snapshot.requests.find(
      (request) => request.id === requestId
    )
    if (request?.status === "dispatching") {
      await this.cancelDriver(resident)
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
    this.dispatch.drain(resident)
  }

  /**
   * The driver's Stop, which ends the session's background work wherever
   * its `backgroundStop` says so. What ran in the background when Stop was
   * asked is then stopped, not lost: a process Stop closes can't report its
   * tasks' ends, and its disconnect alone would read as "status unavailable".
   */
  private async cancelDriver(resident: Resident): Promise<void> {
    const binding = conversationControl(resident).activeBindingId
    const driver = resident.driver
    if (!driver) return
    const running = new Set((resident.snapshot.nativeAgents?.agents ?? [])
      .filter((agent) => agent.bindingId === binding && agent.background && isActiveNativeAgent(agent))
      .map((agent) => agent.nativeId))
    await driver.cancel(binding)
    if (driver.backgroundStop.kind !== "ends-on-stop" || !running.size || this.records.isReleased(resident)) return
    const roster = resident.snapshot.nativeAgents
    if (!roster) return
    const at = Date.now()
    let changed = false
    const agents = roster.agents.map((agent) => {
      if (agent.bindingId !== binding || !running.has(agent.nativeId) || (isActiveNativeAgent(agent) ? false : agent.state.kind !== "unknown")) return agent
      changed = true
      return { ...agent, stoppable: false, observedAt: at, settledAt: at, state: { kind: "canceled" as const } }
    })
    if (!changed) return
    resident.snapshot = { ...resident.snapshot, nativeAgents: { ...roster, agents } }
    this.flush(resident)
  }

  /**
   * Stops one roster entry its provider can stop alone (a background
   * command, monitor or agent), leaving the session and the rest of its
   * work running. False when there is nothing to stop: the entry ended,
   * belongs to an earlier process, or its provider can't stop one alone.
   */
  async stopNativeAgent(id: string, nativeId: string): Promise<boolean> {
    const resident = this.records.require(id)
    const binding = conversationControl(resident).activeBindingId
    const agent = resident.snapshot.nativeAgents?.agents.find((candidate) =>
      candidate.nativeId === nativeId && candidate.bindingId === binding && candidate.stoppable && isActiveNativeAgent(candidate))
    const stop = resident.driver?.stopNativeAgent
    if (!agent || !stop) return false
    hostLog("live", "stop one task", { conversation: id, provider: agent.provider, work: agent.work ?? "agent" })
    await stop(binding, nativeId)
    return true
  }

  async cancel(id: string): Promise<void> {
    const loaded = this.records.get(id)
    const pauseGoal = loaded ? await this.goals.stopping(loaded) : undefined
    await this.cancelTurn(id)
    await pauseGoal?.()
  }

  /** Goal commands: Mako's loop on a harness without a goal of its own, the harness's own otherwise. */
  goal(id: string, command: GoalCommand, tuning?: SessionSettings, actor?: Actor): Promise<LiveSnapshot> {
    return this.goals.command(id, command, { actor: this.threads.actor(actor), tuning })
  }

  /**
   * A code review of the target, as a turn of the conversation: the
   * harness's own review, or Mako's review prompt on a harness without one.
   * It queues behind a running turn like any message.
   */
  review(id: string, target: ReviewTarget, tuning?: SessionSettings, actor?: Actor): LiveSnapshot {
    const resident = this.records.require(id)
    const provider = activeBinding(resident)?.provider ?? resident.snapshot.session.harness
    const review = this.dependencies.driver(provider)?.review
    if (!review) throw new Error("This conversation's agent isn't available")
    const shown = reviewDisplayText(target)
    const text = review.kind === "mako" ? makoReviewPrompt(target, review.reviewer)
      : review.start.via === "message" ? review.start.text(target)
        : shown
    this.submit(id, randomUUID(), text, [], tuning, undefined, shown, actor,
      { review: target, ...(review.kind === "native" && { verbatim: true }) })
    return this.snapshot(id) ?? resident.snapshot
  }

  /** A question beside the turn, answered without interrupting it or joining the conversation. */
  async sideQuestion(id: string, command: SideQuestionCommand): Promise<LiveSnapshot> {
    await this.historyReady(id)
    return this.sideQuestions.command(id, command)
  }

  private async cancelTurn(id: string): Promise<void> {
    const requestId = this.activeRequest(id)
    if (requestId) { await this.stopRequest(id, requestId); return }
    const resident = this.records.require(id)
    // Stop during the wait before Mako continues a dropped turn is the user's
    // answer: leave the turn where it stopped, and say so.
    if (resident.autoContinue) {
      this.autoContinue.decline(resident)
      this.flush(resident)
      return
    }
    if (this.checkpoints.cancelBeforeDispatch(resident)) return
    await this.cancelDriver(resident)
  }

  async setMode(id: string, modeId: string): Promise<void> {
    const resident = this.records.require(id)
    // The next message reopens an unconnected session in the mode recorded here.
    const { connection, status } = resident.snapshot.session
    if (!resident.driver && (connection === "hibernated" || connection === "disconnected") && status !== "closed") {
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
      conversationControl(resident).activeBindingId,
      modeId
    )
  }

  close(id: string): Promise<void> {
    return this.closing.close(id)
  }

  stop(): Promise<void> {
    clearTimeout(this.settleTimer)
    return this.closing.stop()
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

  /** Commits what changed to the journal and tells every window, in one batch. */
  private flush(resident: Resident): void {
    if (this.records.isReleased(resident)) {
      hostWarn("residency", "a write reached an unloaded conversation and was dropped", { conversation: resident.snapshot.session.id })
      return
    }
    const session = resident.snapshot.session
    if (session.executionContext?.identity.kind === "pending" &&
      (session.status === "closed" || session.connection === "hibernated" || session.connection === "disconnected")) {
      resident.snapshot = { ...resident.snapshot, session: { ...session, executionContext: disconnectedContext(session.executionContext) } }
      if (!resident.opening) updateBinding(this.dependencies, resident, resident.snapshot.session)
    }
    if (resident.timer) clearTimeout(resident.timer)
    resident.timer = null
    const previous = resident.journalSnapshot ?? resident.snapshot
    if (
      !resident.updates.length &&
      resident.journalSnapshot === resident.snapshot
    )
      return
    const delivery = deliverLiveUpdates(resident.snapshot.blocks, resident.updates)
    const updates = delivery.updates
    const snapshot = {
      ...resident.snapshot,
      session: sharedSession(previous.session, resident.snapshot.session),
      blocks: delivery.blocks,
      revision: resident.snapshot.revision + 1,
      activityAt: resident.activityAt,
    }
    resident.journal.commit(snapshot, previous, previous.blocks === resident.snapshot.blocks ? delivery.grown : undefined)
    resident.storageFault = false
    resident.updates = []
    resident.pendingCharacters = 0
    resident.snapshot = snapshot
    resident.journalSnapshot = snapshot
    resident.usedAt = this.dependencies.now?.() ?? Date.now()
    this.records.scheduleSweep()
    syncMemory(this.dependencies.memory, previous.session, snapshot.session)
    if (previous.requests !== snapshot.requests) this.dependencies.turns?.(previous, snapshot)
    if (previous.control !== snapshot.control || previous.threadPath !== snapshot.threadPath)
      this.threads.register(snapshot, undefined)
    this.dependencies.emit({
      type: "live-batch",
      batch: {
        id: snapshot.session.id,
        revision: snapshot.revision,
        epoch: this.epoch,
        updates,
        changedFrom: changedEntryStart(previous.blocks, snapshot.blocks),
        blockCount: snapshot.blocks.length,
        nativeAgents:
          previous.nativeAgents !== snapshot.nativeAgents
            ? snapshot.nativeAgents
            : undefined,
        goal: previous.goal !== snapshot.goal ? (snapshot.goal ?? null) : undefined,
        side: previous.side !== snapshot.side ? (snapshot.side ?? null) : undefined,
        historyFailure: previous.historyFailure !== snapshot.historyFailure ? (snapshot.historyFailure ?? null) : undefined,
        control:
          previous.control !== snapshot.control ? snapshot.control : undefined,
        base: previous.base !== snapshot.base ? snapshot.base : undefined,
        baseCoveredBlocks: previous.baseCoveredBlocks !== snapshot.baseCoveredBlocks
          ? (snapshot.baseCoveredBlocks ?? 0) : undefined,
        threadPath:
          previous.threadPath !== snapshot.threadPath
            ? (snapshot.threadPath ?? null)
            : undefined,
        ...sessionDelta(previous.session, snapshot.session),
        permissions:
          previous.permissions !== snapshot.permissions
            ? snapshot.permissions
            : undefined,
        ...requestsDelta(previous.requests, snapshot.requests),
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
    this.relocations.changed(resident)
    // A turn that ended, as it ended, failed included: what its record holds is all it will.
    if (previous.session.status === "running" && settled(snapshot.session.status))
      void this.sources.checkpointIdle(resident)
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
      ?.cancel(conversationControl(resident).activeBindingId)
      .catch(() => {})
  }
}
