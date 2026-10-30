import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
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
  traceOf,
  type InterruptionReason,
  type LiveBatch,
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
import { latestPendingQuestion, retireQuestionsForInput } from "../contracts/live-questions.js"
import { isActiveNativeAgent, isBusyNativeAgent } from "../contracts/native-agents.js"
import type { ProviderResidencySnapshot } from "../contracts/provider-residency.js"
import type { ContextBreakdown, LivePermissionResponse, LiveSessionState, PromptAttachment } from "../contracts/providers-acp.js"
import { signInPause } from "../contracts/sign-in-hold.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { ConversationSettings } from "../contracts/turn-continuation.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { RewindInput } from "../contracts/workspace-snapshots.js"
import type { Relocation } from "../workspaces/index.js"
import { changedEntryStart, deliverLiveUpdates } from "@mako/sessions/live-content"
import { bareCommand } from "@mako/sessions/tool-identity"
import { questionWaiting, requestWaiting, type Waiting } from "@mako/protocol/attention"
import type { SessionSettings } from "@mako/sessions/settings"
import { LiveAccounts } from "./live-accounts.js"
import { LiveActions } from "./live-actions.js"
import { LiveApprovals } from "./live-approvals.js"
import { LiveAssets, promptFingerprint } from "./live-assets.js"
import { LiveAutoContinue } from "./live-auto-continue.js"
import { stoppedWork } from "./interrupted-turn.js"
import { LiveCheckpoints } from "./live-checkpoints.js"
import { LiveTurnChanges } from "./live-turn-changes.js"
import { LiveTurnReview } from "./live-turn-review.js"
import type { TurnUndoScope } from "../contracts/turn-review.js"
import { LiveClosing } from "./live-closing.js"
import { LiveDispatch } from "./live-dispatch.js"
import { driverEvents, LiveEvents } from "./live-events.js"
import { LiveForks } from "./live-forks.js"
import { LiveGoals } from "./live-goals.js"
import { LiveSideQuestions } from "./live-side-questions.js"
import { LiveHibernation } from "./live-hibernation.js"
import { JournalWriteError, LiveRequestSchema } from "./live-journal.js"
import { JournalReclaims } from "./journal-reclaim.js"
import { LiveLaunches, nativeStart } from "./live-launches.js"
import { syncMemory } from "./live-ledger.js"
import { LiveMoves } from "./live-moves.js"
import { LiveQuestions } from "./live-questions.js"
import { LiveRecords } from "./live-records.js"
import { isPaged } from "./paged-entries.js"
import { LiveRelocations } from "./live-relocations.js"
import { LiveRestarts } from "./live-restarts.js"
import { ContextBundles } from "./live-context.js"
import { activeBinding, conversationControl, launched, type Dependencies, type LiveAccess, type ProviderStop, type Resident, STOPPED_FOR } from "./live-runtime.js"
import { LiveSources, settled, updateBinding, type SettledBases } from "./live-sources.js"
import { LiveThreads } from "./live-threads.js"
import { LiveTransfers } from "./live-transfers.js"

/** How long after the host starts it moves journals' copies of their history onto records (`LiveSources.settleBases`). */
const SETTLE_AFTER_START_MS = 60_000
/** The most entries a batch carries of a changed base: a window's page (`carriesBase`). */
const BATCH_BASE_ENTRIES = 512
const SETTLE_EVERY_MS = 15 * 60_000
/** How often Mako tries again to write a conversation it couldn't save (`saveAgain`): soon after space comes back. */
const SAVE_AGAIN_MS = 5_000
/** What a conversation in memory is working on, as the lifecycle lists it; undefined while it works on nothing. */
function residentWork(resident: Resident): LifecycleWork | undefined {
  const { snapshot } = resident
  const finishing = resident.transferring || resident.opening || resident.checkpointing || resident.rewinding || resident.closing
  const requests = snapshot.requests.filter((request) => request.status === "dispatching" || request.status === "queued")
  const native = snapshot.nativeAgents?.agents.filter(isBusyNativeAgent) ?? []
  const background = Boolean(snapshot.session.backgroundTasks)
  if (!finishing && (!resident.driver || (snapshot.session.status !== "running" && !background && !requests.length && !native.length && !snapshot.permissions.length))) return undefined
  const status = finishing ? "finishing" : snapshot.permissions.length || native.some((agent) => agent.state.kind === "waiting") ? "waiting" : snapshot.session.status === "running" || background || native.some((agent) => agent.state.kind === "working") ? "running" : "queued"
  return { id: snapshot.session.id, token: `${resident.generation}:${requests.map((request) => request.id).join(":")}:${JSON.stringify(native.map((agent) => [agent.nativeId, agent.nativeRunId ?? agent.observedAt]))}`, title: snapshot.session.title || "Untitled conversation", provider: snapshot.session.harness, cwd: snapshot.session.cwd, status, stoppable: !finishing }
}

const startingWork = (id: string): LifecycleWork => ({ id, token: id, title: "Starting an agent", provider: "", cwd: "", status: "finishing", stoppable: false })

/** Owns durable conversation intent and observation. Providers still own execution. */
export class LiveConversations {
  private readonly stops = new Map<string, { requestId: string; result: Promise<boolean> }>()
  /** Each conversation's last write as `lastMoved` read it, at the revision it read it. */
  private readonly moved = new Map<string, { revision: number; at: number | undefined }>()
  /** By conversation: when the last message that arrived for it is admitted or refused (`admitInOrder`). */
  private readonly arrivals = new Map<string, Promise<void>>()
  private settleTimer?: ReturnType<typeof setTimeout>
  private readonly dependencies: Dependencies
  private readonly admission: Admission
  private readonly assets: LiveAssets
  private readonly threads: LiveThreads
  private readonly records: LiveRecords
  private readonly checkpoints: LiveCheckpoints
  private readonly counts: LiveTurnChanges
  private readonly turnReview: LiveTurnReview
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
  private readonly restarts: LiveRestarts
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
    this.restarts = new LiveRestarts(dependencies.root, dependencies.emit)
    this.threads = new LiveThreads(dependencies)
    this.records = new LiveRecords(dependencies, {
      busy: (resident) => {
        const id = resident.snapshot.session.id
        return Boolean(this.transfers.pending(resident)) || this.launches.starting(id) || this.sources.refreshing(id) || this.stops.has(id)
      },
      flush: (resident) => this.flush(resident),
      storageFailed: (resident, boundary) => this.storageFailed(resident, boundary),
      loaded: (resident) => {
        void this.sources.readBase(resident)
        this.counts.loaded(resident)
      },
      compact: (path) => { void this.reclaims.reclaim(path) },
      paged: (id) => this.dependencies.historyPaged?.(id),
      released: (id) => this.dependencies.historyReleased?.(id),
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
      loadSliced: (id) => this.records.loadSliced(id),
      request: (id, requestId) => this.records.request(id, requestId),
      add: (resident) => this.records.add(resident),
      control: conversationControl,
      flush: (resident) => this.flush(resident),
      keep: (resident) => this.keep(resident),
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
    this.counts = new LiveTurnChanges({ ledger: () => dependencies.turnLedger?.(), flush: (resident) => access.keep(resident) })
    this.checkpoints = new LiveCheckpoints(access, (id, input) => this.fork(id, input), this.counts)
    this.turnReview = new LiveTurnReview({
      git: dependencies.git,
      ledger: () => dependencies.turnReview?.(),
      request: (id, requestId) => this.records.request(id, requestId),
      cwd: (id) => this.records.session(id)?.cwd,
      checkpoints: (id, requestId) => {
        try {
          return this.checkpoints.turn(id, requestId)
        } catch {
          // Checkpoints pruned since: the journal draws the turn.
          return undefined
        }
      },
      busy: (folder) => [...this.records.values()].some(({ snapshot, checkpointing }) =>
        (checkpointing || snapshot.session.status === "running" || snapshot.requests.some((request) => request.status === "dispatching")) &&
        (snapshot.session.cwd === folder || snapshot.session.cwd.startsWith(`${folder}/`) || folder.startsWith(`${snapshot.session.cwd}/`))),
      plans: join(dependencies.root, "undos"),
      undone: (id, pick, undone) => {
        const resident = this.records.require(id)
        const marked = pick(resident.snapshot.requests)
        if (!marked.size) return
        resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((request) => (marked.has(request.id) ? { ...request, undone } : request)) }
        access.flush(resident)
      },
    })
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
      stop: (id) => this.cancelTurn(id, "goal-budget"),
    })
    this.sideQuestions = new LiveSideQuestions(access)
    const { actions, approvals, questions, checkpoints, assets, transfers, records } = this
    this.events = new LiveEvents(access, { actions, approvals, questions, checkpoints, assets })
    this.dispatch = new LiveDispatch(access, { actions, checkpoints, transfers })
    this.closing = new LiveClosing(access, { records, actions, approvals, transfers, restarts: this.restarts })
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
    const work: LifecycleWork[] = [...this.records.values()].flatMap((resident) => residentWork(resident) ?? [])
    for (const id of this.launches.startingIds()) if (!work.some((item) => item.id === id)) work.push(startingWork(id))
    for (const path of this.sources.capturing()) work.push({ id: `capture:${path}`, token: path, title: "Saving a conversation", provider: "", cwd: path, status: "finishing", stoppable: false })
    return work
  }

  /** One conversation's work, as `lifecycleWork` lists it; undefined while it has none. Reads only memory. */
  workOf(id: string): LifecycleWork | undefined {
    const resident = this.records.get(id)
    return (resident && residentWork(resident)) ?? (this.launches.starting(id) ? startingWork(id) : undefined)
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

  /** What memory holds of the conversation now; `undefined` for one only on disk, which this never reads in. */
  held(id: string): LiveSnapshot | undefined {
    return this.records.get(id)?.snapshot
  }

  /** Whether the conversation is in memory; one only on disk runs nothing, and `snapshot` would read it in. */
  loaded(id: string): boolean {
    return this.records.has(id)
  }

  /**
   * What a conversation waits on, as every surface says it (`requestWaiting`): its first request of the person (a
   * question, even one asked as an approval, or an approval), else its latest open question. Memory keeps whatever
   * waits, so one only on disk waits on nothing, and isn't read back in to find out.
   */
  waitingOn(id: string): Waiting | undefined {
    const resident = this.records.has(id) ? this.records.load(id) : undefined
    if (!resident) return undefined
    const permission = resident.snapshot.permissions[0]
    // A command as its person would type it: Codex asks about `/bin/zsh -lc '…'`, which says nothing more.
    if (permission) return requestWaiting(permission, bareCommand)
    const question = latestPendingQuestion(conversationControl(resident), resident.snapshot.requests)
    const asked = question?.native.questions.find((item) => !question.answered?.includes(item.id))
    return asked ? questionWaiting(asked.question) : undefined
  }

  /**
   * When a conversation last moved: the last write to its journal, read from the disk's times without opening it, and
   * read again only once its revision moved, so a list of hundreds costs a stat for each that changed.
   */
  lastMoved(id: string, revision: number): number | undefined {
    const known = this.moved.get(id)
    if (known?.revision === revision) return known.at
    const times = [`${id}.sqlite`, `${id}.sqlite-wal`].flatMap((name) => {
      try {
        return [statSync(join(this.dependencies.root, name)).mtimeMs]
      } catch {
        return []
      }
    })
    const at = times.length ? Math.max(...times) : undefined
    this.moved.set(id, { revision, at })
    return at
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

  /**
   * A message is admitted in the order messages for its conversation arrived, whatever each waits on first. A send
   * resolves its model's settings before `submit` (a folder's real path, the account's environment, at worst a
   * discovery), and that takes longer for one send than the next: a phone's message overtook the laptop's sent a moment
   * before it, and a person's second message could overtake their first. Each send's wait starts as it arrives, so
   * they overlap; only admission waits for the ones ahead. One refused lets the next go.
   */
  admitInOrder<Ready, Admitted>(id: string, ready: Promise<Ready>, admit: (ready: Ready) => Admitted): Promise<Admitted> {
    // Its refusal is this send's own answer, read once the sends ahead are in; until then nothing else watches it.
    ready.catch(() => undefined)
    const ahead = this.arrivals.get(id)
    const admitted = (ahead ? ahead.then(() => ready) : ready).then(admit)
    const settled = admitted.then(() => undefined, () => undefined)
    this.arrivals.set(id, settled)
    void settled.then(() => {
      if (this.arrivals.get(id) === settled) this.arrivals.delete(id)
    })
    return admitted
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
    marks: Pick<LiveRequest, "goal" | "review" | "verbatim" | "wake"> = {}
  ): LiveRequest {
    this.admission.assert()
    const resident = this.records.require(id)
    if (resident.rewinding)
      throw new Error("Wait for the workspace rewind to finish before sending")
    // A request whose process has gone can't be answered; a new message is what the person did instead.
    if (resident.snapshot.permissions.some((permission) => permission.gone))
      resident.snapshot = { ...resident.snapshot, permissions: resident.snapshot.permissions.filter((permission) => !permission.gone) }
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
      if (existing.status === "queued") this.release(resident)
      return existing
    }
    // A message is taken once under its ID, as a steer into a turn or as a message of its own (`steerTo` in the window).
    if (conversationControl(resident).actions?.some((action) => action.input.id === requestId && action.state.kind !== "not-accepted"))
      throw new Error("This message already went into the running turn.")
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
    // A message for later waits here, held, whatever the process is doing; `wakeDue` releases it.
    if (request.wake) {
      request.inputDigest = inputDigest
      return this.admit(resident, { ...request, status: "held" })
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

  /**
   * Sends a failed request's message again at `at`, as a new request held
   * until then: the person's "Resume at 3:40 PM" after a usage limit. The
   * failed record stays; the new one repeats its words, attachments and
   * tuning, and a repeated id answers with the first acceptance.
   */
  holdUntil(id: string, requestId: string, input: { after: string; at: number }, actor?: Actor): LiveRequest {
    const failed = this.records.require(id).snapshot.requests.find((request) => request.id === input.after)
    if (!failed || failed.status !== "failed") throw new Error("That message is no longer waiting to be sent again.")
    if (!Number.isFinite(input.at) || input.at <= 0) throw new Error("A send time is required.")
    return this.submit(id, requestId, failed.text, failed.attachments, failed.tuning, undefined, failed.displayText, actor, { wake: { at: input.at, after: failed.id } })
  }

  /**
   * The attribution journal opened: each turn in memory that ended while it
   * wasn't open, or whose count it held, is counted now, as when its
   * conversation loads.
   */
  journalOpened(): void {
    for (const resident of this.records.values()) this.counts.loaded(resident)
  }

  /**
   * Releases every held request whose time has come, in conversations loaded
   * or not; run by the host's `held-wakes` job. A released request goes as a
   * Resume would: queued, and the session reopened when its process went.
   */
  wakeDue(now = Date.now()): string[] {
    const due = this.records.listing().filter((summary) => summary.wakeAt !== undefined && summary.wakeAt <= now).map((summary) => summary.session.id)
    for (const id of due) {
      const resident = this.records.load(id)
      if (!resident || resident.closing || resident.snapshot.session.status === "closed") continue
      const released = resident.snapshot.requests.filter((request) => request.status === "held" && request.wake && request.wake.at <= now)
      if (!released.length) continue
      const ids = new Set(released.map((request) => request.id))
      const session = resident.snapshot.session
      resident.snapshot = {
        ...resident.snapshot,
        session: session.status === "failed" ? { ...session, status: "ready", error: undefined } : session,
        requests: resident.snapshot.requests.map((request) => ids.has(request.id) ? { ...request, status: request.signIn ? "held" : "queued", wake: undefined } : request),
      }
      this.flush(resident)
      hostLog("live", "a held message's time came", { conversation: id, requests: released.length })
      if (!resident.driver && !resident.opening && this.hibernation.reopens(resident)) void this.hibernation.wake(resident)
      else this.dispatch.drain(resident)
    }
    return due
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
    const resident = this.records.has(id) ? this.records.load(id) : await this.records.loadSliced(id)
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

  /** A turn's files, from its request's record (or, for a turn from before it, its checkpoints): any turn, loaded or not. */
  turnChanges(id: string, requestId: string, workspace?: string) {
    return this.turnReview.files(id, requestId, workspace)
  }

  turnDiff(id: string, requestId: string, path: string, options?: { only?: boolean }) {
    return this.turnReview.diff(id, requestId, path, options)
  }

  /** A turn's diff of one file as stretches, bounded, with its writers when another writer shares a change. */
  turnHunks(id: string, requestId: string, path: string, options?: { context?: number }) {
    return this.turnReview.hunks(id, requestId, path, options)
  }

  /** Who wrote each changed line of a turn's diff of one file. */
  turnWriters(id: string, requestId: string, path: string) {
    return this.turnReview.writers(id, requestId, path)
  }

  turnUndoPreview(id: string, scope: TurnUndoScope) {
    return this.turnReview.undoPreview(id, scope)
  }

  turnUndo(id: string, scope: TurnUndoScope, token: string) {
    this.admission.assert()
    return this.turnReview.undo(id, scope, token)
  }

  /** At start: undos a host died in the middle of are finished or put back. */
  resumeUndos() {
    return this.turnReview.resume()
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
        next = { ...request, status: "held", wake: undefined }
        break
      // A message waiting on a sign-out keeps waiting; only the session's Resume releases it.
      case "resume":
        next = { ...request, status: request.signIn ? "held" : "queued", wake: undefined }
        break
      case "edit":
        next = {
          ...request,
          status: request.signIn ? "held" : "queued",
          wake: undefined,
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
    if (command.change.kind !== "pause") this.release(resident)
    return resident.snapshot
  }

  /**
   * A message waiting here may go: sent now if the harness is connected, or once a sleeping conversation wakes. A
   * restart leaves its conversations asleep with their queues paused, and Resume, or the message asked for again, has
   * to wake it: draining alone found no harness and sent nothing.
   */
  private release(resident: Resident): void {
    if (resident.hibernating || (!resident.driver && this.hibernation.reopens(resident))) void this.hibernation.wake(resident)
    else this.dispatch.drain(resident)
  }

  /**
   * Hands a conversation's work to another machine, here: its running turn stopped as `handed-off` (its waiting
   * messages held, to go with it) and any background work it left stopped. Answers the turn to continue where it
   * lands: the one it stopped, or, when only background work ran, the turn that left it running; with what of that
   * work it stopped, as the harness listed it, so the continuation can name it. Undefined when nothing was at work.
   * The Thread's move then waits for it to settle and continues it there (`continueTurn`).
   */
  async handOff(id: string): Promise<{ requestId: string; stopped: string[] } | undefined> {
    const resident = this.records.get(id)
    const active = this.activeRequest(id)
    const stopped = resident ? stoppedWork(resident.snapshot, active !== undefined) : []
    if (active) {
      await this.stopRequest(id, active, "handed-off", stopped)
      return { requestId: active, stopped }
    }
    if (!resident || !stopped.length) return undefined
    // The turn that left it running: the newest that ran, which the continuation follows on from.
    const left = [...resident.snapshot.requests].reverse().find((request) => request.status !== "canceled" && request.status !== "queued" && request.status !== "held")
    await this.cancel(id, "handed-off")
    return left ? { requestId: left.id, stopped } : undefined
  }

  conversationSettings(): ConversationSettings {
    return this.restarts.settings()
  }

  setConversationSettings(settings: ConversationSettings): ConversationSettings {
    return this.restarts.set(settings)
  }

  /**
   * Continues the turns the host before this one cut short as it quit,
   * restarted or updated, when the person chose so (`LiveRestarts`): each
   * is scheduled as a dropped connection's is (`LiveAutoContinue.schedule`),
   * reopening its session, so its footer says Mako is continuing it.
   */
  continueRestarted(): void {
    for (const { conversationId, requestId } of this.restarts.take()) {
      try {
        const resident = this.records.load(conversationId)
        if (!resident) continue
        this.autoContinue.schedule(resident, requestId, true)
        if (resident.autoContinue) this.flush(resident)
      } catch (error) {
        hostWarn("live", "a turn Mako's exit cut short wasn't continued; it waits for Continue turn", { conversation: conversationId, error: errorMessage({ error }) })
      }
    }
  }

  /** Continues a turn cut short, as Mako, now; see `LiveAutoContinue.continueNow`. */
  continueTurn(id: string, input: { requestId: string; reason: InterruptionReason; continues: string; stopped?: readonly string[]; actor: Actor }): LiveSnapshot {
    this.autoContinue.continueNow(id, input)
    return this.records.require(id).snapshot
  }

  /** The messages waiting here, queued or held, in order: what goes with a Thread that moves. */
  waitingPrompts(id: string): Array<Pick<LiveRequest, "id" | "text" | "attachments" | "tuning" | "displayText">> {
    const resident = this.records.load(id)
    return (resident?.snapshot.requests ?? [])
      .filter((request) => (request.status === "queued" || request.status === "held") && !request.continues)
      .map(({ id: requestId, text, attachments, tuning, displayText }) => ({ id: requestId, text, attachments, ...tuning && { tuning }, ...displayText !== undefined && { displayText } }))
  }

  /** Waiting messages sent on with their Thread, by id: they run there, never here. Asked again, it changes nothing. */
  carried(id: string, requestIds: readonly string[], to: "cloud"): void {
    const resident = this.records.load(id)
    if (!resident) return
    const ids = new Set(requestIds)
    if (!resident.snapshot.requests.some((request) => ids.has(request.id) && (request.status === "queued" || request.status === "held"))) return
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        ids.has(request.id) && (request.status === "queued" || request.status === "held")
          ? { ...request, status: "canceled", signIn: undefined, carried: { at: Date.now(), to } }
          : request
      ),
    }
    this.flush(resident)
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

  /**
   * Stops the running request. `why`: who asked, as the host log says it (`stopProvider`) and the turn reads
   * (`STOPPED_FOR`): only the person's Stop settles as `stopped`. `handed-off`: Mako stops it to hand the Thread to
   * another machine, which continues it (`continueTurn`); its queued messages are held, to go with it, and the
   * interruption keeps the background work that stops with it (`stopped`).
   */
  stopRequest(id: string, requestId: string, why: ProviderStop = "person", stopped: string[] = []): Promise<boolean> {
    const previous = this.stops.get(id)
    if (previous?.requestId === requestId) return previous.result
    if (this.activeRequest(id) !== requestId) return Promise.resolve(false)
    const resident = this.records.require(id)
    const snapshot = resident.snapshot
    resident.snapshot = { ...snapshot, requests: snapshot.requests.map((request) => request.status === "queued" && request.id !== requestId ? { ...request, status: "held" } : request) }
    try { this.flush(resident) } catch (error) { resident.snapshot = snapshot; return Promise.reject(error) }
    const opening = resident.opening
    // A turn Mako already stopped because it couldn't save it stays Mako's, whoever presses Stop after.
    if (resident.stopping !== requestId || resident.stoppingFor !== "not-saved") {
      resident.stopping = requestId
      resident.stoppingFor = STOPPED_FOR[why]
      resident.stoppingWork = stopped.length ? stopped : undefined
    }
    const result = this.cancelRequest(id, requestId, why).then(async () => { if (opening) await this.close(id); return true }).catch((error) => { this.stops.delete(id); throw error })
    this.stops.set(id, { requestId, result })
    return result
  }

  async cancelRequest(id: string, requestId: string, why: ProviderStop = "person"): Promise<void> {
    const resident = this.records.require(id)
    if (this.checkpoints.cancelBeforeDispatch(resident, requestId)) return
    const request = resident.snapshot.requests.find(
      (request) => request.id === requestId
    )
    if (request?.status === "dispatching") {
      await this.cancelDriver(resident, why)
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
  private async cancelDriver(resident: Resident, why: ProviderStop): Promise<void> {
    const binding = conversationControl(resident).activeBindingId
    const driver = resident.driver
    if (!driver) return
    const running = new Set((resident.snapshot.nativeAgents?.agents ?? [])
      .filter((agent) => agent.bindingId === binding && agent.background && isActiveNativeAgent(agent))
      .map((agent) => agent.nativeId))
    await this.stopProvider(resident, why)
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

  /** Stop: the person's (`mako:live-cancel`) unless `why` names Mako's own reason. */
  async cancel(id: string, why: ProviderStop = "person"): Promise<void> {
    const loaded = this.records.get(id)
    const pauseGoal = loaded ? await this.goals.stopping(loaded) : undefined
    await this.cancelTurn(id, why)
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

  private async cancelTurn(id: string, why: ProviderStop): Promise<void> {
    const requestId = this.activeRequest(id)
    if (requestId) { await this.stopRequest(id, requestId, why); return }
    const resident = this.records.require(id)
    // Stop on a request whose process has gone puts it away: there is no turn left to stop.
    if (resident.snapshot.permissions.some((permission) => permission.gone)) {
      resident.snapshot = { ...resident.snapshot, permissions: resident.snapshot.permissions.filter((permission) => !permission.gone) }
      this.flush(resident)
      return
    }
    // Stop during the wait before Mako continues a dropped turn is the user's
    // answer: leave the turn where it stopped, and say so.
    if (resident.autoContinue) {
      this.autoContinue.decline(resident)
      this.flush(resident)
      return
    }
    if (this.checkpoints.cancelBeforeDispatch(resident)) return
    await this.cancelDriver(resident, why)
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

  /**
   * A change goes out in the next batch: at once (the next turn of the event loop) when the conversation hasn't
   * flushed for a frame, else when the frame since its last flush has passed. So the first token of a burst isn't held,
   * and a stream goes at most every `BATCH_MS`, in batches every window, watching device and the journal share.
   */
  private schedule(resident: Resident): void {
    if (resident.timer) return
    const wait = resident.flushedAt === undefined ? 0 : Math.max(0, resident.flushedAt + BATCH_MS - performance.now())
    resident.timer = setTimeout(() => {
      try {
        this.flush(resident)
      } catch (error) {
        this.storageFailed(resident, { error })
      }
    }, wait)
  }

  /** See `LiveAccess.keep`. */
  private keep(resident: Resident): void {
    try {
      this.flush(resident)
    } catch (error) {
      if (!(error instanceof JournalWriteError)) throw error
      this.storageFailed(resident, { error })
    }
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
    resident.flushedAt = performance.now()
    resident.storageFault = false
    resident.updates = []
    resident.pendingCharacters = 0
    resident.snapshot = snapshot
    resident.journalSnapshot = snapshot
    resident.usedAt = this.dependencies.now?.() ?? Date.now()
    this.records.scheduleSweep()
    this.records.pageAllNow(resident)
    syncMemory(this.dependencies.memory, previous.session, snapshot.session)
    if (previous.requests !== snapshot.requests) this.dependencies.turns?.(previous, snapshot)
    if (previous.control !== snapshot.control || previous.threadPath !== snapshot.threadPath)
      this.threads.register(snapshot, undefined)
    const batch: LiveBatch = {
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
        harnessTurns: previous.harnessTurns !== snapshot.harnessTurns ? snapshot.harnessTurns : undefined,
        spentThrough: previous.spentThrough !== snapshot.spentThrough ? (snapshot.spentThrough ?? null) : undefined,
        control:
          previous.control !== snapshot.control ? snapshot.control : undefined,
        ...previous.base !== snapshot.base && (carriesBase(snapshot.base) ? { base: snapshot.base } : { historyChanged: true }),
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
        activityAt: activityMoved(previous.activityAt, snapshot.activityAt) ? snapshot.activityAt : undefined,
        nativeActivity:
          previous.nativeActivity !== snapshot.nativeActivity
            ? (snapshot.nativeActivity ?? null)
            : undefined,
    }
    // A sampled batch says when it left and carries a trace every hop logs (`traceOf`).
    const trace = traceOf(batch, () => randomUUID().slice(0, 13))
    if (trace) {
      batch.emittedAt = Date.now()
      batch.trace = trace
    }
    this.dependencies.emit({ type: "live-batch", batch })
    this.relocations.changed(resident)
    // A turn that ended, as it ended, failed included: what its record holds is all it will.
    if (previous.session.status === "running" && settled(snapshot.session.status))
      void this.sources.checkpointIdle(resident)
  }

  /**
   * Every Stop Mako sends a provider goes through here, said in the host log with why, so a turn a harness reports
   * interrupted is never left unexplained: the person's Stop, a handoff, a goal at its budget, or a conversation
   * Mako can't save.
   */
  private stopProvider(resident: Resident, why: ProviderStop, error?: string): Promise<void> {
    const driver = resident.driver
    if (!driver) return Promise.resolve()
    const id = resident.snapshot.session.id
    const request = this.activeRequest(id)
    const fields = {
      conversation: id,
      provider: activeBinding(resident)?.provider ?? resident.snapshot.session.harness,
      why,
      ...(request && { request }),
      ...(error !== undefined && { error }),
    }
    if (why === "not-saved") hostWarn("live", "Mako stops the provider's turn", fields)
    else hostLog("live", "Mako stops the provider's turn", fields)
    return driver.cancel(conversationControl(resident).activeBindingId)
  }

  /**
   * The conversation's journal couldn't be written, so its turn is stopped rather than left to go on with nothing
   * saved. The turn it stops settles as Mako's (`not-saved`) with what failed as its error, whoever's Stop follows;
   * what isn't saved stays in memory, and the next commit that works writes it.
   */
  private storageFailed(resident: Resident, boundary: FailureBoundary): void {
    if (resident.storageFault) return
    resident.storageFault = true
    const error = errorMessage(boundary)
    this.dependencies.emit({
      type: "notice",
      level: "error",
      message: `Mako couldn't save this conversation, so it stopped the agent's turn. What isn't saved yet is kept until Mako can write it. ${error}`,
    })
    const requestId = resident.snapshot.requests.find((request) => request.status === "dispatching")?.id
    if (resident.driver && requestId && resident.stopping !== requestId) {
      resident.stopping = requestId
      resident.stoppingFor = STOPPED_FOR["not-saved"]
      resident.stoppingError = error
      resident.stoppingWork = undefined
    }
    void this.stopProvider(resident, "not-saved", error).catch(() => {})
    this.saveAgain(resident)
  }

  /**
   * Tries an unsaved conversation's journal again until a commit works, which writes what memory kept and tells every
   * window, the stopped turn included. Nothing else would: the stopped provider says nothing more, and space coming
   * back on a disk is no event Mako hears. It ends once a commit works, or the conversation leaves this host.
   */
  private saveAgain(resident: Resident): void {
    resident.savingAgain = setTimeout(() => {
      resident.savingAgain = undefined
      if (!resident.storageFault || this.records.get(resident.snapshot.session.id) !== resident) return
      try {
        this.flush(resident)
      } catch {
        this.saveAgain(resident)
      }
    }, this.dependencies.saveAgainMs ?? SAVE_AGAIN_MS)
    resident.savingAgain.unref?.()
  }
}

/**
 * A streaming conversation's batches go at most this often, the first of a burst at once. No screen paints more than
 * about twenty a second (`StreamFrames`), so each batch on 2026-10-28's 16 ms was mostly sent to be thrown away, on every
 * hop to every device, and written to the journal.
 */
const BATCH_MS = 33

/**
 * Whether a batch says when the conversation last showed work: when it moved into another second. It moves with every
 * token, and what reads it waits a minute for quiet (`QUIET_AFTER_MS`), so a second late costs nothing; said each
 * time, it was in nearly every batch to every device.
 */
function activityMoved(before: number | undefined, after: number | undefined): boolean {
  return after !== undefined && (before === undefined || Math.floor(after / 1_000) !== Math.floor(before / 1_000))
}

/**
 * Whether a batch carries a changed base whole. A long one goes as the
 * notice that the history changed, which every reader answers by reading it
 * again through the history protocol: serialised whole into the event, a
 * history of 150MB, most of it paged (`paged-entries.ts`), was read back
 * and written as one string on the loop, and every window but an old one
 * took that notice instead anyway (`historyChangedNotice`, past 512KB).
 */
function carriesBase(base: LiveSnapshot["base"]): boolean {
  return !base || (base.entries.length <= BATCH_BASE_ENTRIES && !base.entries.some(isPaged))
}
