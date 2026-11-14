import { randomBytes, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { join } from "node:path"
import { Admission } from "../base/admission.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { disconnectedContext } from "../base/execution-context.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { AccountRemovalSession } from "../contracts/accounts.js"
import type { LifecycleWork } from "../contracts/app-lifecycle.js"
import type { ContextTransfer, ForkInput, ProviderBinding, TransferInput } from "../contracts/conversation-control.js"
import type { ThreadMove } from "./continue-on.js"
import { ASLEEP_AFTER_MS } from "../contracts/session-choice.js"
import type { LiveActionInput } from "../contracts/live-actions.js"
import { GoalCommandSchema, type GoalCommand } from "../contracts/live-goals.js"
import type { SideQuestionCommand } from "../contracts/live-side-questions.js"
import { makoReviewPrompt, reviewDisplayText, ReviewTargetSchema, type ReviewTarget } from "../contracts/live-reviews.js"
import {
  LIVE_FRAME_MS,
  requestsDelta,
  compactLiveBatch,
  rosteredLiveBatch,
  sessionDelta,
  sharedFields,
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
import { digestAsks } from "../contracts/agents.js"
import { childGroup, childStateOf, DIGEST_WAITS, rollup, WAKE_COALESCE_MS } from "../contracts/children.js"
import { latestPendingQuestion, retireQuestionsForInput, type PendingAsk } from "../contracts/live-questions.js"
import { isActiveNativeAgent, isBusyProviderWork, withChildren } from "../contracts/native-agents.js"
import type { ProviderResidencySnapshot } from "../contracts/provider-residency.js"
import type { ContextBreakdown, LivePermissionResponse, LiveSessionState, PromptAttachment } from "../contracts/providers-acp.js"
import { signInPause } from "../contracts/sign-in-hold.js"
import { ActorSchema, type Actor } from "../contracts/thread-identity.js"
import { admittedInPlace, type ConversationSettings } from "../contracts/turn-continuation.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { RewindInput } from "../contracts/workspace-snapshots.js"
import type { Relocation } from "../workspaces/index.js"
import { changedEntryStart, deliverLiveUpdates, queueLiveUpdate, reduceLiveUpdates } from "@mako/sessions/live-content"
import type { DirectRoute } from "@mako/sessions/events"
import { bareCommand } from "@mako/sessions/tool-identity"
import { needsYouWaiting, questionWaiting, requestWaiting, type Waiting } from "@mako/protocol/attention"
import { agentAskLine } from "../contracts/agent-asks.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { steerHeard } from "../harnesses/index.js"
import { LiveAccounts } from "./live-accounts.js"
import { LiveActions, type SteerInput, type SteerSender } from "./live-actions.js"
import { LiveApprovals } from "./live-approvals.js"
import { LiveAsks } from "./live-asks.js"
import { LiveAssets, promptFingerprint } from "./live-assets.js"
import { LiveAutoContinue } from "./live-auto-continue.js"
import { stoppedWork } from "./interrupted-turn.js"
import { LiveCheckpoints } from "./live-checkpoints.js"
import { LiveTurnChanges } from "./live-turn-changes.js"
import { LiveTurnReview } from "./live-turn-review.js"
import type { TurnUndoScope } from "../contracts/turn-review.js"
import { LiveClosing } from "./live-closing.js"
import { LiveDispatch, nextQueued } from "./live-dispatch.js"
import { latchedByStop } from "../contracts/delivery-retry.js"
import { arriving, goesNext, goingFirst, holdDue, holdOf, released, sooner, transferDue } from "../contracts/request-hold.js"
import { driverEvents, LiveEvents } from "./live-events.js"
import { LiveForks } from "./live-forks.js"
import { LiveGoals, turnReply, type TurnReply } from "./live-goals.js"
import { LiveSideQuestions } from "./live-side-questions.js"
import { LiveHibernation } from "./live-hibernation.js"
import { JournalWriteError, LiveRequestSchema } from "./live-journal.js"
import { JournalReclaims } from "./journal-reclaim.js"
import { LiveLaunches, nativeStart } from "./live-launches.js"
import { syncMemory } from "./live-ledger.js"
import { LiveMoves } from "./live-moves.js"
import { LiveQuestions } from "./live-questions.js"
import { LiveRecords, wakeAt } from "./live-records.js"
import { isPaged } from "./paged-entries.js"
import { LiveRelocations } from "./live-relocations.js"
import { LiveRestarts } from "./live-restarts.js"
import { ContextBundles, prepareLiveContext } from "./live-context.js"
import { activeBinding, conversationControl, launched, type Dependencies, type LiveAccess, type ProviderStop, type Resident, STOPPED_FOR } from "./live-runtime.js"
import { LiveSources, settled, updateBinding, type SettledBases } from "./live-sources.js"
import { LiveThreads } from "./live-threads.js"
import { holdSwitches, LiveTransfers, withdrawGone } from "./live-transfers.js"

/** How long after the host starts it moves journals' copies of their history onto records (`LiveSources.settleBases`). */
const SETTLE_AFTER_START_MS = 60_000
/** The most entries a batch carries of a changed base: a window's page (`carriesBase`). */
const BATCH_BASE_ENTRIES = 512
const SETTLE_EVERY_MS = 15 * 60_000
/** How often Mako tries again to write a conversation it couldn't save (`saveAgain`): soon after space comes back. */
const SAVE_AGAIN_MS = 5_000
/** The longest a timer waits; a held message due later is armed for again when this fires. */
const MAX_TIMER_MS = 2_147_483_647
/** What a conversation in memory is working on, as the lifecycle lists it; undefined while it works on nothing. */
/**
 * A conversation's work's status alone, as `residentWork` says it, read with an early exit and nothing built: it's asked
 * after every flush of every working conversation (`noteWork`).
 */
function residentWorkStatus(resident: Resident): LifecycleWork["status"] | undefined {
  if (resident.transferring || resident.opening || resident.checkpointing || resident.rewinding || resident.closing) return "finishing"
  if (!resident.driver) return undefined
  const { snapshot } = resident
  if (snapshot.permissions.length) return "waiting"
  let busy = false
  let working = false
  for (const agent of snapshot.nativeAgents?.agents ?? []) {
    if (!isBusyProviderWork(agent)) continue
    if (agent.state.kind === "waiting") return "waiting"
    busy = true
    if (agent.state.kind === "working") working = true
  }
  if (snapshot.session.status === "running" || snapshot.session.backgroundTasks || working) return "running"
  if (busy || snapshot.requests.some((request) => request.status === "dispatching" || request.status === "queued")) return "queued"
  return undefined
}

function residentWork(resident: Resident): LifecycleWork | undefined {
  const status = residentWorkStatus(resident)
  if (!status) return undefined
  const { snapshot } = resident
  const finishing = status === "finishing"
  const requests = snapshot.requests.filter((request) => request.status === "dispatching" || request.status === "queued")
  const native = snapshot.nativeAgents?.agents.filter(isBusyProviderWork) ?? []
  return { id: snapshot.session.id, token: `${resident.generation}:${requests.map((request) => request.id).join(":")}:${JSON.stringify(native.map((agent) => [agent.nativeId, agent.nativeRunId ?? agent.observedAt]))}`, title: snapshot.session.title || "Untitled conversation", provider: snapshot.session.harness, cwd: snapshot.session.cwd, status, stoppable: !finishing }
}

const startingWork = (id: string): LifecycleWork => ({ id, token: id, title: "Starting an agent", provider: "", cwd: "", status: "finishing", stoppable: false })

/** Owns durable conversation intent and observation. Providers still own execution. */
/** A continuation of a turn a usage limit cut: it can wait days, so it holds no place, and takes one again to go on. */
function limitCut(request: LiveRequest): boolean {
  return request.continues !== undefined && request.retry?.cause === "rate-limited"
}

export class LiveConversations {
  private readonly stops = new Map<string, { requestId: string; result: Promise<boolean> }>()
  /** The steers whose words `steerByRestart` is sending as a message of their own, under their receipt's ID. */
  private readonly restarting = new Set<string>()
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
  /** What its agents ask the person through Mako's tools (`ThreadMoveTool`). */
  readonly asks: LiveAsks
  private readonly actions: LiveActions
  private readonly transfers: LiveTransfers
  private readonly bundles: ContextBundles
  /** Each conversation's Stops so far (`stopMark`). */
  private readonly stopped = new Map<string, number>()
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
   * With its start on its data root (`Dependencies.start`): `g<generation>.<data root>.<48 random bits>`, which a
   * window orders by generation where both are of one data root (`olderThan`), so a reply of the host before, answered
   * late, never takes back what this one said, whatever any clock says. Without one, and in a build before this, 72
   * random bits, which no window orders: a reply it can't place is read again rather than taken.
   */
  readonly epoch: string
  /** The one timer for held messages' times (`armWakes`): when it fires, and the timer. */
  private wakeTimer: { at: number; timer: ReturnType<typeof setTimeout> } | undefined
  private wakesStopped = false
  private readonly reclaims = new JournalReclaims()

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.epoch = dependencies.start
      ? `g${dependencies.start.generation}.${dependencies.start.root}.${randomBytes(6).toString("base64url")}`
      : randomBytes(9).toString("base64url")
    this.admission = dependencies.admission ?? new Admission()
    this.assets = new LiveAssets(join(dependencies.root, "assets"))
    this.restarts = new LiveRestarts(dependencies.root, dependencies.emit)
    this.threads = new LiveThreads(dependencies)
    this.records = new LiveRecords(dependencies, {
      busy: (resident) => {
        const id = resident.snapshot.session.id
        return Boolean(this.transfers.pending(resident)) || this.launches.starting(id) || this.sources.refreshing(id) || this.stops.has(id) || this.finsAtWork(id)
      },
      flush: (resident) => this.flush(resident),
      storageFailed: (resident, boundary) => this.storageFailed(resident, boundary),
      loaded: (resident) => {
        void this.sources.readBase(resident)
        this.counts.loaded(resident)
        // A journal keeps no children: their engine says how they are now, and a window that holds the last revision
        // hears what moved while none was in memory.
        if (this.takeChildren(resident)) this.schedule(resident)
        // A switch that waited behind another when the last host ended goes on, as it was asked to.
        if (this.transfers.pending(resident)?.behind) queueMicrotask(() => this.dispatch.drain(resident))
      },
      compact: (path) => { void this.reclaims.reclaim(path) },
      paged: (id) => this.dependencies.historyPaged?.(id),
      released: (id) => {
        // Let go of: its work is read again, from memory, when it's next loaded.
        this.workSaid.delete(id)
        this.dependencies.historyReleased?.(id)
      },
    })
    this.moves = new LiveMoves({
      dependencies,
      resident: (id) => this.records.get(id),
      residents: () => this.records.values(),
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
    this.bundles = new ContextBundles(dependencies.children, dependencies.harnessLabel)
    const observe = (event: LiveDriverEvent) => this.events.observe(event)
    const access: LiveAccess = {
      dependencies,
      reclaims: this.reclaims,
      epoch: this.epoch,
      bundles: this.bundles,
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
      noteWork: (resident) => this.noteWork(resident),
      keep: (resident) => this.keep(resident),
      schedule: (resident) => this.schedule(resident),
      storageFailed: (resident, boundary) => this.storageFailed(resident, boundary),
      stamp: (snapshot) => this.stamp(snapshot),
      snapshot: (id) => this.snapshot(id),
      summaries: () => this.summaries(),
      actor: (explicit) => this.threads.actor(explicit),
      register: (snapshot, actor) => this.threads.register(snapshot, actor),
      markPurpose: (conversationId, purpose, options) => this.threads.markPurpose(conversationId, purpose, options),
      markParent: (conversationId, parent) => this.threads.markParent(conversationId, parent),
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
      scheduleAutoContinue: (resident, settled) => {
        this.autoContinue.schedule(resident, settled)
        this.autoContinue.continueFailed(resident, settled)
      },
      declineAutoContinue: (resident, keepProviderWait) => this.autoContinue.decline(resident, keepProviderWait),
      goalSettled: (resident, settled) => this.goals.settled(resident, settled),
      turnSettled: (resident, settled) => this.dependencies.agents?.()?.settled(resident.snapshot.session.id, settled),
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
    this.asks = new LiveAsks(access)
    this.questions = new LiveQuestions(access, {
      // An answer goes to the session that asked, on the binding it read as active with nothing awaited since: never a switch.
      continue: (id, bindingId, requestId, text, displayText) => {
        if (conversationControl(this.records.require(id)).activeBindingId !== bindingId) throw new Error("This question is no longer available on the current session")
        this.continueBinding(id, bindingId, requestId, text, [], undefined, displayText)
      },
      steer: (id, input) => this.act(id, input, "native"),
    })
    this.actions = new LiveActions(access, (id, running, input) => this.steerByRestart(id, running, input))
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
    const work: LifecycleWork[] = [...this.records.values()].flatMap((resident) => {
      const item = residentWork(resident)
      const apex = item && this.apexOf(item.id)
      return item ? (apex ? { ...item, lead: apex } : item) : []
    })
    for (const id of this.launches.startingIds()) if (!work.some((item) => item.id === id)) work.push(startingWork(id))
    for (const path of this.sources.capturing()) work.push({ id: `capture:${path}`, token: path, title: "Saving a conversation", provider: "", cwd: path, status: "finishing", stoppable: false })
    return work
  }

  /** The Apex's conversation of a Fin's, as the lifecycle names it; undefined for a conversation that isn't a Fin's. */
  private apexOf(id: string): LifecycleWork["lead"] {
    const threads = this.dependencies.threads
    const placed = threads?.journalPlacement(id)
    const edge = placed && threads?.edges().of(placed.thread)
    if (!edge) return undefined
    const apex = threads?.conversationsOf(edge.parentSession).at(-1)
    return apex ? { id: apex, title: this.records.get(apex)?.snapshot.session.title || "Untitled conversation" } : undefined
  }

  /** One conversation's work, as `lifecycleWork` lists it; undefined while it has none. Reads only memory. */
  workOf(id: string): LifecycleWork | undefined {
    const resident = this.records.get(id)
    return (resident && residentWork(resident)) ?? (this.launches.starting(id) ? startingWork(id) : undefined)
  }

  closeForExit(ids?: string[]): Promise<void> {
    return this.closing.closeForExit(ids)
  }

  /** The listing's line for every conversation, without its Fins: what a job that looks often reads. */
  listed(): LiveSummary[] {
    return this.records.listing()
  }

  /** Every conversation's summary as a list shows it, or those of `only` alone. */
  summaries(only?: ReadonlySet<string>): LiveSummary[] {
    const agents = this.dependencies.agents?.()
    const listing = only ? this.records.listing().filter((summary) => only.has(summary.session.id)) : this.records.listing()
    const away = this.threads.runningElsewhere(listing.map((summary) => summary.session.id))
    return listing.map((summary) => {
      const children = agents ? rollup(agents.roster(summary.session.id)) : undefined
      const elsewhere = away.get(summary.session.id)
      return { ...summary, epoch: this.epoch, ...this.threads.placement(summary.session.id), ...(children?.total && { children }), ...(elsewhere && { elsewhere }) }
    })
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

  /** The harness Sessions the conversation is bound to, from what's already listed: this never reads it in. */
  nativeIds(id: string): readonly { provider: string; nativeId: string }[] {
    return this.records.nativeIds(id)
  }

  /** What memory holds of the conversation now; `undefined` for one only on disk, which this never reads in. */
  held(id: string): LiveSnapshot | undefined {
    return this.records.get(id)?.snapshot
  }

  /**
   * Whether this host runs a turn of `id` or is sending it one: its harness runs a turn, a message is being sent, the
   * message next in line goes once its harness is up (`nextQueued`), or Mako continues a turn cut short. A message
   * nothing here will send (behind a paused one, behind a failed turn, waiting for this Mac's account, or with no
   * harness and none opening) is not work, however long it waits.
   */
  atWork(id: string): boolean {
    const resident = this.records.get(id)
    if (!resident) return false
    const { session, requests } = resident.snapshot
    if (session.status === "running" || session.status === "starting" || requests.some((request) => request.status === "dispatching") || resident.autoContinue) return true
    // A message waiting to go again goes by itself: work, as a continuation Mako scheduled is. A turn a usage limit cut is
    // the exception: it can wait days, so the Fin reads as its failure says, and holds no place meanwhile.
    if (requests.some((request) => holdOf(request)?.kind === "retry" && !limitCut(request)) || this.transfers.pending(resident)?.retry) return true
    const next = session.status === "failed" ? undefined : nextQueued(resident.snapshot)
    if (!next || next.ownerCheck) return false
    return Boolean(resident.driver || resident.starting || resident.opening || resident.waking || resident.hibernating || resident.transferring)
  }

  /**
   * Sends on the messages `ids` that a stop or an exit paused, `first` ahead of them when it waits too: a Fin's
   * Apex resuming it, which nobody would press Resume for. A message waiting on a sign-in or a usage limit stays, and
   * so does one the person paused to edit (`editing`).
   */
  resumeHeld(id: string, ids: readonly string[], first?: string): void {
    const resident = this.records.require(id)
    const resuming = new Set(ids)
    const requests = resident.snapshot.requests.map((request) =>
      resuming.has(request.id) && holdOf(request)?.kind === "paused" ? released(request) : request)
    const previous = resident.snapshot
    resident.snapshot = { ...previous, requests: first === undefined ? requests : [...goingFirst(requests, first)] }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    this.release(resident)
  }

  /**
   * An unsent message of `id` says `text` now, carrying `digest`, its place and its hold kept: an Apex's digest a
   * notice joined before it went (`AgentWakes`). With no notices left it's taken back. False when it went meanwhile.
   */
  rewriteWaiting(id: string, requestId: string, text: string, digest: NonNullable<LiveRequest["digest"]>): boolean {
    const resident = this.records.get(id)
    const request = resident?.snapshot.requests.find((candidate) => candidate.id === requestId)
    if (!resident || !request || (request.status !== "queued" && request.status !== "held")) return false
    // A question joining a digest the budget holds takes it along, within the burst's window (`digestAsks`).
    const wake = request.wake?.after === DIGEST_WAITS && digestAsks(digest.notices) ? { ...request.wake, at: Math.min(request.wake.at, Date.now() + WAKE_COALESCE_MS) } : request.wake
    const next: LiveRequest = digest.notices.length
      ? { ...request, wake, text, digest: { ...digest, ...(request.digest?.resting && { resting: true as const, ...(request.digest.nextTry !== undefined && { nextTry: request.digest.nextTry }) }) }, inputDigest: promptFingerprint(text, request.attachments, request.tuning) }
      : { ...request, status: "canceled" }
    const previous = resident.snapshot
    resident.snapshot = { ...previous, requests: previous.requests.map((candidate) => (candidate === request ? next : candidate)) }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    return true
  }

  /**
   * A Stop of `id`, the person's or an Apex's of its Fin: every message waiting there pauses, and one that was to go by
   * itself (again, or at a time) stops being so, so nothing sends until a deliberate resume (`resumeHeld`, Resume),
   * across a restart too. A message waiting for a sign-in keeps its own hold and takes the mark, so a move that lifts
   * that hold leaves it paused (`arriving`). A switch not yet committed is held, or with no message retired (`holdSwitches`). Read in if it isn't loaded. How many it
   * paused (`docs/delivery-queue.md`).
   */
  stopHolds(id: string): number {
    this.stopped.set(id, this.stopMark(id) + 1)
    const resident = this.records.load(id)
    // Waiting, or being sent now: a send whose refusal comes back after the Stop is caught by its mark too (`flush`).
    // One being edited takes the mark under its edit, so saving the edit doesn't send it.
    const stops = (request: LiveRequest) => request.pause !== "stop" &&
      (request.status === "queued" || request.status === "dispatching" || request.status === "held")
    if (!resident) return 0
    // A switch not yet committed is queued work, held like any message; a committed one's message is in the queue
    // already. Holding moves no generation, so the source binding's events still count (`holdSwitches`).
    const { snapshot, held, retired } = holdSwitches(resident.snapshot)
    const count = resident.snapshot.requests.filter(stops).length + held + retired.length
    if (!count) return 0
    const previous = resident.snapshot
    resident.snapshot = { ...snapshot, requests: snapshot.requests.map((request) => stops(request)
      ? { ...request, pause: "stop" as const, ...request.status !== "dispatching" && { status: "held" as const, retry: undefined, wake: undefined } }
      : request) }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    for (const transfer of retired) this.transfers.tell(transfer)
    return count
  }

  /**
   * How many Stops `id` has had on this host. What takes this before it waits and reads it after knows whether a Stop
   * came meanwhile, whatever the conversation looks like by then: idle is what a Stop leaves.
   */
  stopMark(id: string): number {
    return this.stopped.get(id) ?? 0
  }

  /** Whether a message to its running turn lands at the agent's next step (`steer` with `step`), not at the turn's end. */
  steersAtStep(id: string): boolean {
    const steering = this.records.get(id)?.driver?.steering
    return steering?.kind === "supported" && steering.lands === "step"
  }

  /**
   * How this conversation's harness takes a message into its running turn: when its agent hears one (`steerHeard`),
   * and whether it answers every steer it holds once that turn ends. Undefined where it takes none.
   */
  steering(id: string): { hears: string; answersOnEnd: boolean } | undefined {
    const steering = this.records.get(id)?.driver?.steering
    return steering?.kind === "supported" ? { hears: steerHeard(steering), answersOnEnd: steering.answersOnEnd === true } : undefined
  }

  /** What the agent said at the end of a request's turn, and how the request ended; undefined for one not in memory. */
  turnReply(id: string, requestId: string): (TurnReply & { request?: LiveRequest }) | undefined {
    const resident = this.records.get(id)
    if (!resident) return undefined
    return { ...turnReply(resident, requestId), request: resident.snapshot.requests.find((request) => request.id === requestId) }
  }

  /** The conversation a driver's binding speaks for: a hand-off's new session is another binding of the same one. */
  ownerOf(bindingId: string): string {
    return this.records.owners.get(bindingId) ?? bindingId
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
    return asked ? questionWaiting(asked.question) : this.askWaiting(id)
  }

  /** What its agent asked the person through Mako's tools, as its row says it. */
  askWaiting(id: string): Waiting | undefined {
    const ask = this.asks.open(id)[0]
    return ask && needsYouWaiting(agentAskLine(ask.want))
  }

  /** What `waitingOn` names, whole, so an answer can reach it through `permission`. */
  pendingAsk(id: string): PendingAsk | undefined {
    const resident = this.records.has(id) ? this.records.load(id) : undefined
    if (!resident) return undefined
    const permission = resident.snapshot.permissions[0]
    if (permission)
      return {
        request: permission.id,
        kind: permission.questions?.length ? "question" : "approval",
        options: permission.options,
        questions: permission.questions ?? [],
        ...(permission.feedbackOption && { feedbackOption: permission.feedbackOption }),
        ...(permission.gone && { gone: true as const }),
      }
    const question = latestPendingQuestion(conversationControl(resident), resident.snapshot.requests)
    const open = question?.native.questions.filter((item) => !question.answered?.includes(item.id)) ?? []
    return question && open.length ? { request: question.id, kind: "question", options: [], questions: open } : this.asks.pending(id)
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
    return snapshot.epoch === this.epoch && snapshot.threadId === placed.threadId && snapshot.sessionId === placed.sessionId &&
      snapshot.parent?.thread === placed.parent?.thread && snapshot.parent?.session === placed.parent?.session
      ? snapshot
      : { ...snapshot, epoch: this.epoch, ...placed }
  }

  capture(id: string, path: string): Promise<LiveSnapshot> {
    return this.sources.capture(id, path)
  }

  async start(provider: string, cwd: string, options: LiveStartOptions, by?: Actor, purpose?: StartPurpose): Promise<LiveSessionState> {
    if (options.goal !== undefined) GoalCommandSchema.parse({ kind: "set", ...options.goal })
    if (options.review !== undefined) ReviewTargetSchema.parse(options.review)
    // A Fin's brief is its Apex's words, not the person's.
    const actor = by ?? (options.parent && !options.resume ? ActorSchema.parse(options.parent.startedBy) : undefined)
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
    marks: Pick<LiveRequest, "goal" | "review" | "verbatim" | "wake" | "digest" | "pause" | "grants" | "notification"> = {}
  ): LiveRequest {
    this.admission.assert()
    const resident = this.records.require(id)
    if (resident.rewinding)
      throw new Error("Wait for the workspace rewind to finish before sending")
    // A request whose process has gone can't be answered; a new message is what the person did instead.
    if (resident.snapshot.permissions.some((permission) => permission.gone))
      resident.snapshot = { ...resident.snapshot, permissions: resident.snapshot.permissions.filter((permission) => !permission.gone) }
    this.flush(resident)
    // A retune (`moveOn`) rides the next message that names no model of its own, once.
    const retuned = tuning ? undefined : resident.retuned
    tuning ??= retuned
    const request = LiveRequestSchema.parse({
      actor: this.threads.actor(actor),
      id: requestId,
      createdAt: Date.now(),
      admissionOrder: resident.snapshot.requests.reduce((last, request) => Math.max(last, request.admissionOrder ?? 0), resident.snapshot.requests.length) + 1,
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
    if (!this.restarting.has(requestId) && conversationControl(resident).actions?.some((action) => action.input.id === requestId && action.state.kind !== "not-accepted"))
      throw new Error("This message already went into the running turn.")
    this.moves.assertAdmits(resident)
    if (this.transfers.pending(resident))
      throw new Error("A provider switch is pending. Wait for it to settle before sending another message.")
    if (targetBindingId && conversationControl(resident).activeBindingId !== targetBindingId)
      throw new Error("The selected native session changed before this message was accepted")
    if (!text.trim() && !attachments.length)
      throw new Error("A prompt cannot be empty")
    if (retuned && resident.retuned === retuned) resident.retuned = undefined
    if (resident.snapshot.session.status === "closed") this.reopenClosed(resident)
    const rested = (request.createdAt ?? Date.now()) - (resident.snapshot.requests.at(-1)?.createdAt ?? Number.POSITIVE_INFINITY)
    if (rested > ASLEEP_AFTER_MS) hostLog("residency", "a message reaches a session asleep a day or more", { conversation: id, request: requestId, restedMs: rested })
    // A new message supersedes a pending continuation, except for a service outage's timed retry: queuing more work
    // cannot make its service available or bypass its backoff. An explicit Stop, Resume or move still controls it.
    this.autoContinue.decline(resident, true)
    if (resident.snapshot.requests.some((request) => goesNext(request, true)))
      resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((request) => (goesNext(request, true) ? released(request) : request)) }
    if (marks.goal?.step !== "continue") this.goals.decline(resident)
    this.hibernation.clearHibernationTimer(resident)
    const pause = signInPause(resident.snapshot.requests)
    if (pause) {
      // Work paused on a sign-out goes together, on Resume; nothing launches before.
      request.inputDigest = inputDigest
      return this.admit(resident, { ...request, status: "held", signIn: pause.hold })
    }
    // A message for later, or one its sender's stop paused (a stopped Fin's news), waits here, held, whatever the
    // process is doing; `wakeDue` releases the one, the Fin's resume the other.
    if (request.wake || request.pause) {
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
        ...marks.grants && { grants: marks.grants },
        ...marks.notification && { notification: marks.notification },
      }, actor)
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
    const binding = activeBinding(resident)
    if (!binding?.nativeId) throw new Error("This conversation was closed before it started a session. Start a new conversation to carry on.")
    // A session whose records were never located opens through a transfer instead, which finds them or hands a new
    // session of its harness the conversation (`LiveTransfers.perform`): a wake could only fail.
    const connection = launched(binding) ? "hibernated" : "disconnected"
    resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, status: "ready", connection, error: undefined } }
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
  /**
   * One timer for every held message's time, armed for the soonest: each commit that gives a message a time arms it
   * earlier (`flush`), and each time it fires it sends what's due and arms for the next (`wakeDue`). Undefined `at`
   * reads the soonest from every conversation's listing, as the host's start does.
   */
  armWakes(at = this.soonestWake()): void {
    if (at === undefined || this.wakesStopped || (this.wakeTimer && this.wakeTimer.at <= at)) return
    if (this.wakeTimer) clearTimeout(this.wakeTimer.timer)
    const timer = setTimeout(() => {
      this.wakeTimer = undefined
      try {
        this.wakeDue()
      } catch (error) {
        hostWarn("live", "held messages' times couldn't be read; tried again", { error: errorMessage({ error }) })
        this.armWakes(Date.now() + (this.dependencies.saveAgainMs ?? SAVE_AGAIN_MS))
      }
    }, Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS))
    timer.unref?.()
    this.wakeTimer = { at, timer }
  }

  /** The soonest time a held message anywhere goes, after `after`: one that was due and couldn't go waits for a later arming. */
  private soonestWake(after = Number.NEGATIVE_INFINITY): number | undefined {
    let soonest: number | undefined
    for (const summary of this.records.listing())
      if (summary.wakeAt !== undefined && summary.wakeAt > after && (soonest === undefined || summary.wakeAt < soonest)) soonest = summary.wakeAt
    return soonest
  }

  wakeDue(now = Date.now()): string[] {
    const due = this.records.listing().filter((summary) => summary.wakeAt !== undefined && summary.wakeAt <= now).map((summary) => summary.session.id)
    let failed = false
    try {
      // One conversation's failure (its journal unwritable) is its own: the rest go, and it's tried again.
      for (const id of due) if (!this.wakeOne(id, now)) failed = true
    } finally {
      const next = this.soonestWake(now)
      const again = failed ? Date.now() + (this.dependencies.saveAgainMs ?? SAVE_AGAIN_MS) : undefined
      this.armWakes(next === undefined ? again : again === undefined ? next : Math.min(next, again))
    }
    return due
  }

  /** Sends what of `id` was due at `now`; false when its journal couldn't take the release, which then waits to be tried again. */
  private wakeOne(id: string, now: number): boolean {
    let resident: Resident | undefined
    try {
      resident = this.records.load(id)
    } catch (error) {
      hostWarn("live", "a held message's time came, and its conversation couldn't be read", { conversation: id, error: errorMessage({ error }) })
      return false
    }
    // A session Mako's exit closed reopens for what was due, as for a new message (`release`); one the person closed
    // holds nothing with a time (`close`).
    if (!resident || resident.closing) return true
    // A retry goes again keeping its count, so a failure after it waits longer (`nextRetry`).
    // A turn a usage limit cut gave up its place, so it takes one again to go on (`Agents.mayWake`): with no room it waits.
    const ready = resident.snapshot.requests.filter((request) => {
      const hold = holdOf(request)
      const at = hold && holdDue(hold)
      return at !== undefined && at <= now && (!limitCut(request) || this.dependencies.agents?.()?.mayWake?.(id) !== false)
    })
    const previous = resident.snapshot
    try {
      // A reconnect waiting to go again goes at its time too: its gate opens now (`LiveTransfers.start`).
      const transfer = this.transfers.pending(resident)
      const transferDue = Boolean(transfer?.retry && transfer.retry.at <= now)
      if (transfer?.retry && transferDue) this.transfers.save(resident, { ...transfer, retry: { ...transfer.retry, at: Math.min(transfer.retry.at, Date.now()) } })
      if (!ready.length) {
        if (transferDue) this.release(resident)
        return true
      }
      const ids = new Set(ready.map((request) => request.id))
      const session = resident.snapshot.session
      resident.snapshot = {
        ...resident.snapshot,
        session: session.status === "failed" ? { ...session, status: "ready", error: undefined } : session,
        requests: resident.snapshot.requests.map((request) => ids.has(request.id) ? released(request) : request),
      }
      this.flush(resident)
    } catch (error) {
      // Nothing goes that isn't written: the release is undone, storage recovery runs, and the timer tries it again.
      resident.snapshot = previous
      this.storageFailed(resident, { error })
      return false
    }
    hostLog("live", "a held message's time came", { conversation: id, requests: ready.length })
    try {
      this.release(resident)
    } catch (error) {
      hostWarn("live", "a held message's time came, and its session couldn't reopen", { conversation: id, error: errorMessage({ error }) })
    }
    return true
  }

  /** Record a new request in the journal and start it when the session is free. */
  private admit(resident: Resident, request: LiveRequest): LiveRequest {
    request.attachments = this.assets.retainPrompt(request.attachments)
    const previousSnapshot = resident.snapshot
    resident.snapshot = {
      ...resident.snapshot,
      control: request.continues?.auto ? conversationControl(resident) : retireQuestionsForInput(conversationControl(resident), request.id),
      requests: admittedInPlace(resident.snapshot.requests, request),
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

  /** A provider action. A steer the person sends lands at once (`SteerSender`); an agent's goes as its harness takes it. */
  act(id: string, input: LiveActionInput, sender: SteerSender = "person") {
    this.admission.assert()
    return this.actions.submit(id, input, sender)
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

  /**
   * The admission of `continueOn`'s move: the Thread goes to `to` with its queue as it stands, and every waiting message
   * stays a row and goes there once it lands (`arriving`). On another harness, or another account where the session
   * can't go, that's a quiet switch: nothing is sent, and the transcript goes with whichever row goes first. `stays`: the
   * session goes on where it is, so it lands now, its binding pinned to the account; the next send takes it there.
   * Undefined when it's no longer decided: `wanted` is read here, and again with nothing awaited before a switch commits.
   */
  moveOn(id: string, move: ThreadMove, stays: boolean, actor?: Actor, stillDecided?: () => boolean): LiveSnapshot | undefined {
    this.admission.assert()
    const resident = this.records.require(id)
    if (resident.rewinding)
      throw new Error("Wait for the workspace rewind to finish before moving this Thread")
    this.moves.assertStarts(resident)
    const wanted = () => !(move.unlessStopped && resident.snapshot.requests.some((request) => request.status === "held" && request.pause === "stop")) && (stillDecided?.() ?? true)
    if (!wanted()) return undefined
    const { to } = move
    if (!stays) return this.transfers.accept(id, { id: move.id, provider: to.harness, text: "", attachments: [], ...(to.tuning && { tuning: to.tuning }), ...(to.modeId && { modeId: to.modeId }), ...(to.account && { account: to.account }) }, this.threads.actor(actor), undefined, { wanted, ...(move.first !== undefined && { first: move.first }) })
    const previous = resident.snapshot
    const control = conversationControl(resident)
    // A move that names a model on the harness it's on retunes the session: its binding and settings take it, so a
    // reopening launches on it, and the next message that names none carries it into the process running now.
    const retune = to.tuning
    const pinned = (binding: ProviderBinding): ProviderBinding => binding.id !== control.activeBindingId ? binding
      : { ...binding, ...(to.account && { account: to.account }), ...(retune && { tuning: retune }) }
    resident.snapshot = {
      ...previous,
      requests: arriving(previous.requests, { harness: to.harness, account: to.account, tuning: to.tuning }, false, move.first),
      ...(retune && { session: { ...previous.session, settings: retune } }),
      control: { ...control, bindings: to.account || retune ? control.bindings.map(pinned) : control.bindings },
    }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    if (retune) {
      resident.retuned = retune
      hostLog("transfer", "a Thread is retuned on its harness", { conversation: id, harness: to.harness, model: retune.model ?? "" })
    }
    this.release(resident)
    return resident.snapshot
  }

  /**
   * A pin from before the binding kept one (a Fin started on another account, kept on its edge alone) comes onto its
   * binding, so what a launch reads is the same. A binding with a pin of its own, or on another harness, keeps to it.
   */
  adoptPin(id: string, harness: string, account: string): void {
    const resident = this.records.load(id)
    const binding = resident && activeBinding(resident)
    if (!resident || binding?.provider !== harness || binding.account !== undefined) return
    const control = conversationControl(resident)
    const previous = resident.snapshot
    resident.snapshot = { ...previous, control: { ...control, bindings: control.bindings.map((each) => (each.id === binding.id ? { ...each, account } : each)) } }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
  }

  /** The account `id` is pinned to on `harness`, whatever is selected: a move's, on its binding, for a Fin and an Apex alike. */
  pinnedAccount(id: string, harness: string): string | undefined {
    const resident = this.records.get(id)
    const binding = resident && activeBinding(resident)
    return binding?.provider === harness ? binding.account : undefined
  }

  /** The conversation's whole transcript as a file, the bundle a switch hands over (`prepareLiveContext`). */
  async transcriptBundle(id: string): Promise<{ file: string } | null> {
    const snapshot = await this.historySnapshot(id)
    if (!snapshot) return null
    return prepareLiveContext({ snapshot, root: join(this.dependencies.root, "context"), fromBlock: 0, includesBase: true, bundles: this.bundles })
  }

  /** Once the switch `transferId` has gone or can't go (`LiveTransfers.settled`). */
  switchSettled(transferId: string): Promise<ContextTransfer> {
    return this.transfers.settled(transferId)
  }

  /** Each conversation's native file as the catalog lists it now, or (`only`) those bound to one session's alone. */
  discoverNativePaths(only?: { harness: string; nativeId: string }): void {
    this.sources.discoverNativePaths(only)
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
        next = { ...request, status: "canceled", signIn: undefined, editing: undefined }
        break
      case "pause":
        next = { ...request, status: "held", wake: undefined, retry: undefined, editing: true }
        break
      // A message waiting on a sign-out keeps waiting; only the session's Resume releases it.
      case "resume":
        next = { ...released(request), retry: undefined }
        break
      // The person's words stand, and a Stop's hold with them: saving an edit isn't a resume.
      case "edit":
        next = {
          ...request,
          status: request.signIn || request.pause === "stop" ? "held" : "queued",
          wake: undefined,
          retry: undefined,
          editing: undefined,
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
   * to wake it: draining alone found no harness and sent nothing. An update's exit closes them, and a closed one
   * opens again for the message as for a new one (`reopenClosed`): waking alone leaves a closed conversation shut.
   */
  private release(resident: Resident): void {
    if (resident.snapshot.session.status === "closed" && !resident.closing && !resident.driver && launched(activeBinding(resident)))
      this.reopenClosed(resident)
    if (resident.hibernating || (!resident.driver && this.hibernation.reopens(resident))) void this.hibernation.wake(resident)
    // A conversation whose first start failed before any session existed starts again for what waited for it.
    else if (!resident.driver && !launched(activeBinding(resident)) && this.launches.relaunch(resident)) return
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

  /**
   * `continueRestarted`, each conversation read in first a slice at a time
   * (`readIn`): what a host starting calls. A host that stops meanwhile
   * continues nothing and leaves the turns where they were, for the next.
   */
  async continueRestartedInSlices(): Promise<void> {
    if (await this.readIn(this.restarts.left().map((turn) => turn.conversationId))) this.continueRestarted()
  }

  /**
   * Reads conversations in from their journals a slice at a time, one after
   * another (`LiveRecords.loadSliced`), for work that then reads them at
   * once: read whole as a host started, a day of Fins' journals held its loop
   * for 4.8 s. Other work runs between two journals too: a read that ends
   * within its slice resolves without letting it, and ten small journals
   * read back to back held the loop as long as reading them at once. One
   * that can't be read is left to the read that follows, which fails as it
   * would have. False when the host began to stop before all were read: it
   * ends at its next step, and what was to follow doesn't.
   */
  async readIn(ids: Iterable<string>): Promise<boolean> {
    for (const id of ids) {
      if (this.records.stopping()) return false
      await this.records.loadSliced(id).catch(() => undefined)
      await new Promise((resolve) => setImmediate(resolve))
    }
    return !this.records.stopping()
  }

  /** Whether `id` is switching provider or reopening its session (`transfer`): a message waits for it to settle. */
  switching(id: string): boolean {
    const resident = this.records.load(id)
    return resident ? Boolean(this.transfers.pending(resident)) : false
  }

  /** Whether the host before this one left a message of `id` waiting, paused or running: an exit pauses them, a crash cuts the turn. */
  leftUnsettled(id: string): boolean {
    return this.records.leftUnsettled(id)
  }

  /** Continues a turn cut short, as Mako, now; see `LiveAutoContinue.continueNow`. `brief`: the Fin's brief it carries again. */
  continueTurn(id: string, input: { requestId: string; reason: InterruptionReason; continues: string; stopped?: readonly string[]; stayed?: boolean; actor: Actor; brief?: string; since?: number }): LiveSnapshot {
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
    // An agent's ask through Mako's tools is answered on the path a harness's approval is (`agents_answer`, the person).
    if (this.asks.open(id).some(ask => ask.id === requestId)) return this.asks.answer(id, requestId, response)
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
    // The person's Stop pauses what waited, and what they send next goes ahead of it; any other stop keeps its order.
    const pause = why === "person" ? { pause: "stop" as const } : {}
    resident.snapshot = { ...snapshot, requests: snapshot.requests.map((request) => request.status === "queued" && request.id !== requestId ? { ...request, status: "held", ...pause } : request) }
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

  /**
   * Stops the running turn and sends this message as the next one, ahead of what was queued, which follows it in
   * order; with no turn running it goes as the next message, like any. Answers whether it stopped a turn.
   */
  interrupt(id: string, requestId: string, text: string, attachments: PromptAttachment[], actor?: Actor, grants?: string[], notification?: true): boolean {
    const running = this.activeRequest(id)
    this.submit(id, requestId, text, attachments, undefined, undefined, undefined, actor, { ...grants && { grants }, ...notification && { notification } })
    if (!running) return false
    this.stopFor(id, running, requestId, "person")
    return true
  }

  /**
   * A person's steer sent by stopping the running turn (`SteerLanding`): its words go as the next message, ahead of
   * what was queued, and the stop reads as `steered`, so that message tells the agent what the stopped turn left
   * (`pendingInterruption`). A queued message steered goes as itself, from wherever the steer's receipt had put it.
   */
  private steerByRestart(id: string, running: string, input: SteerInput): void {
    const own = input.kind === "steer-queued" ? input.queuedRequestId : input.id
    if (input.kind === "steer") {
      // Its receipt may already be the steer's, as one unconfirmed in time is: these words are that steer's own.
      this.restarting.add(input.id)
      try {
        this.submit(id, input.id, input.text, input.attachments, undefined, undefined, input.displayText)
      } finally {
        this.restarting.delete(input.id)
      }
    }
    this.stopFor(id, running, own, "steer")
  }

  /**
   * The message a stop was for goes once the stop settled. A harness that ends its process on Stop (Claude Code) left
   * nothing to send it to: its session opens again under its native ID, as a message to a sleeping one does.
   */
  private sendAfterStop(id: string): void {
    const resident = this.records.get(id)
    if (!resident?.snapshot.requests.some((request) => request.status === "queued")) return
    if (!resident.driver && !resident.opening && this.hibernation.reopens(resident)) void this.hibernation.wake(resident)
    else this.dispatch.drain(resident)
  }

  /** Stops `running` and sends `requestId` next, ahead of what was queued, which follows it in order. */
  private stopFor(id: string, running: string, requestId: string, why: ProviderStop): void {
    const resident = this.records.require(id)
    const waiting = new Set(resident.snapshot.requests.filter((request) => request.status === "queued" && request.id !== requestId).map((request) => request.id))
    void this.stopRequest(id, running, why).then(
      () => this.sendAfterStop(id),
      (error) => hostWarn("live", "an interrupt couldn't stop the turn; its message waits for the turn's end", { conversation: id, why, error: errorMessage({ error }) }))
    // The stop held what was queued, as the person's Stop does; an interrupt sends it on, its own message first. That
    // order is kept in memory alone (the journal keeps requests as they came): it must hold only until this message
    // starts, and a host that restarts holds its queue anyway.
    const requests = resident.snapshot.requests.map((request) =>
      request.id === requestId || (waiting.has(request.id) && request.status === "held") ? { ...request, status: "queued" as const, pause: undefined } : request)
    const own = requests.find((request) => request.id === requestId)
    const rest = requests.filter((request) => request.id !== requestId)
    const ahead = rest.findIndex((request) => request.status === "queued" || request.status === "held")
    resident.snapshot = { ...resident.snapshot, requests: own && ahead !== -1 ? [...rest.slice(0, ahead), own, ...rest.slice(ahead)] : requests }
    this.flush(resident)
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
    const pending = this.transfers.unsettled(resident, requestId)
    if (pending) {
      if (pending.state.kind === "preparing") resident.generation += 1
      this.transfers.save(resident, {
        ...pending,
        state: { kind: "failed", error: "The remote request was canceled" },
      })
    }
    if (request?.status === "queued" || (pending && request?.status === "held")) {
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
    const child = resident.snapshot.nativeAgents?.agents.find((candidate) => candidate.nativeId === nativeId && candidate.child)?.child
    if (child) return (await this.dependencies.agents?.()?.stopChild(id, child.thread)) ?? false
    const binding = conversationControl(resident).activeBindingId
    const agent = resident.snapshot.nativeAgents?.agents.find((candidate) =>
      candidate.nativeId === nativeId && candidate.bindingId === binding && candidate.stoppable && isActiveNativeAgent(candidate))
    const stop = resident.driver?.stopNativeAgent
    if (!agent || !stop) return false
    hostLog("live", "stop one task", { conversation: id, provider: agent.provider, work: agent.work ?? "agent" })
    await stop(binding, nativeId)
    return true
  }

  /**
   * The conversation's children moved: a loaded conversation's roster takes
   * them from their engine, which keeps each entry's identity while it's
   * unchanged. A start or an end goes out at once, progress with the frame.
   * Only its Thread's newest Session's conversations are told (`finReaders`):
   * one memory let go of is read back in, so its windows hear the move as it
   * happens; it then stays while its Fins are at work (`finsAtWork`).
   */
  childrenChanged(id: string, progressOnly = false): void {
    const resident = this.records.get(id)
    if (!resident) return this.readForChildren(id)
    if (this.records.isReleased(resident) || !this.takeChildren(resident)) return
    if (progressOnly) this.schedule(resident)
    else this.keep(resident)
  }

  private readForChildren(id: string): void {
    void this.records.loadSliced(id).then((resident) => {
      if (resident && !this.records.isReleased(resident) && (this.takeChildren(resident) || resident.timer)) this.keep(resident)
    }).catch((error) => hostWarn("live", "a conversation whose Fins moved couldn't be read in", { conversation: id, error: errorMessage({ error }) }))
  }

  /**
   * Whether any of the conversation's Fins is at work, queued or waiting on the person, and it hears them: its roster
   * still moves. An older Session of the Thread hears none of it, so its Fins don't hold it in memory.
   */
  private finsAtWork(id: string): boolean {
    const agents = this.dependencies.agents?.()
    if (agents?.showsFins && !agents.showsFins(id)) return false
    return (agents?.roster(id) ?? []).some((agent) => {
      const group = childGroup(childStateOf(agent))
      return group === "working" || group === "queued" || group === "needs"
    })
  }

  /**
   * Keeps in the conversation the person's message it sent straight to one of
   * its Fins (`Agents.direct`): an event its harness never sees, so no turn
   * starts. Kept once under the message's request; false when the
   * conversation isn't on this host.
   */
  recordDirect(id: string, direct: DirectRoute, text: string): boolean {
    const resident = this.records.load(id)
    if (!resident) return false
    this.keep(resident)
    if (resident.snapshot.blocks.some((block) => block.type === "event" && block.direct?.request === direct.request)) return true
    queueLiveUpdate(resident, { kind: "event", label: `You wrote to ${direct.to} directly`, body: text, direct })
    this.keep(resident)
    return true
  }

  /**
   * The words a waiting request goes with, as a move says what happened above them (`Agents.moveOn`), only while it still
   * says `was`: a request no longer waiting, or that someone edited since, stays as it is, and the answer is false.
   */
  rewordWaiting(id: string, requestId: string, was: string, text: string, displayText?: string): boolean {
    const resident = this.records.get(id)
    const waiting = resident?.snapshot.requests.find((request) => request.id === requestId)
    if (!resident || !waiting || (waiting.status !== "queued" && waiting.status !== "held") || waiting.text !== was) return false
    const previous = resident.snapshot
    const said: LiveRequest = { ...waiting, text, displayText, inputDigest: promptFingerprint(text, waiting.attachments, waiting.tuning) }
    resident.snapshot = { ...previous, requests: previous.requests.map((request) => (request === waiting ? said : request)) }
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    return true
  }

  /**
   * A line Mako writes into a conversation that no harness's record holds, as `recordDirect` does: a Fin's move to
   * another account or harness when its own ran out. Said once: the same words again change nothing.
   */
  recordNote(id: string, label: string, detail: string): boolean {
    const resident = this.records.load(id)
    if (!resident) return false
    this.keep(resident)
    if (reduceLiveUpdates(resident.snapshot.blocks, resident.updates).some((block) => block.type === "event" && block.label === label && block.detail === detail)) return true
    queueLiveUpdate(resident, { kind: "event", label, detail })
    this.keep(resident)
    return true
  }

  /** Whether the roster took a change of its children. */
  private takeChildren(resident: Resident): boolean {
    const agents = this.dependencies.agents?.()?.roster(resident.snapshot.session.id)
    if (!agents) return false
    const nativeAgents = withChildren(resident.snapshot.nativeAgents, agents)
    if (nativeAgents === resident.snapshot.nativeAgents) return false
    resident.snapshot = { ...resident.snapshot, nativeAgents }
    return true
  }

  /** Stop: the person's (`mako:live-cancel`) unless `why` names Mako's own reason. */
  async cancel(id: string, why: ProviderStop = "person"): Promise<void> {
    // The person's Stop: nothing of this conversation goes by itself after it (`stopHolds`).
    if (why === "person") this.stopHolds(id)
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

  /**
   * The person closes a conversation: what waited to go again or at a time stops waiting and stays paused, with
   * Resume, since closing it says they're done for now. Mako's own exit closes through `closeForExit`, which keeps
   * those, so the next host sends them when their time comes.
   */
  close(id: string): Promise<void> {
    // Read in if it isn't: right after a restart its journal may not be loaded yet, and its times must still stop.
    const resident = this.records.load(id)
    if (resident?.snapshot.requests.some((request) => request.status === "held" && (request.retry || request.wake))) {
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((request) => request.status === "held" && (request.retry || request.wake) ? { ...request, retry: undefined, wake: undefined } : request),
      }
      this.flush(resident)
    }
    return this.closing.close(id)
  }

  stop(): Promise<void> {
    clearTimeout(this.settleTimer)
    this.wakesStopped = true
    clearTimeout(this.wakeTimer?.timer)
    this.wakeTimer = undefined
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
  /** What each conversation's work was last said to be (`noteWork`), so only a move is said. */
  private readonly workSaid = new Map<string, string>()

  private noteWork(resident: Resident): void {
    const id = resident.snapshot.session.id
    const status = residentWorkStatus(resident) ?? "none"
    if (this.workSaid.get(id) === status) return
    this.workSaid.set(id, status)
    this.dependencies.workMoved?.(id)
  }

  private flush(resident: Resident): void {
    try {
      this.write(resident)
    } finally {
      this.noteWork(resident)
    }
  }

  private write(resident: Resident): void {
    resident.snapshot = withdrawGone(resident.snapshot)
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
    // A Stop's latch holds whatever its requests became since, in the one place every change is written.
    const latched = latchedByStop(resident.snapshot.requests)
    if (latched !== resident.snapshot.requests) resident.snapshot = { ...resident.snapshot, requests: latched }
    const previous = resident.journalSnapshot ?? resident.snapshot
    if (
      !resident.updates.length &&
      resident.journalSnapshot === resident.snapshot
    )
      return
    const delivered = resident.snapshot.blocks
    const delivery = deliverLiveUpdates(delivered, resident.updates)
    const updates = delivery.updates
    const snapshot = {
      ...sharedFields(previous, resident.snapshot),
      session: sharedSession(previous.session, resident.snapshot.session),
      blocks: delivery.blocks,
      revision: resident.snapshot.revision + 1,
      activityAt: resident.activityAt,
    }
    resident.journal.commit(snapshot, previous, previous.blocks === resident.snapshot.blocks ? delivery.grown : undefined)
    if (snapshot.requests !== previous.requests || snapshot.control !== previous.control) this.armWakes(sooner(wakeAt(snapshot.requests), transferDue(snapshot.control)))
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
    // Readers hold `previous`; its updates were reduced against the blocks it held only when nothing replaced them since.
    const compact = compactLiveBatch(batch, { blocks: previous.blocks === delivered ? delivered : [], requests: previous.requests, ...(previous.control && { control: previous.control }) })
    const rostered = rosteredLiveBatch(compact, previous.nativeAgents)
    this.dependencies.emit({ type: "live-batch", batch, compact, ...(rostered && { rostered }) })
    this.relocations.changed(resident)
    // A turn that ended, as it ended, failed included: what its record holds is all it will.
    if (previous.session.status === "running" && settled(snapshot.session.status)) {
      void this.sources.checkpointIdle(resident)
      this.dependencies.turnEnded?.(snapshot.session.id, snapshot.session.cwd)
    }
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
 * A streaming conversation's batches go at most once a window's paint frame (`LIVE_FRAME_MS`), the first of a burst at
 * once: each batch on 2026-10-28's 16 ms, and on 33 ms after it, was mostly sent to be painted over, on every hop to
 * every device, and written to the journal.
 */
const BATCH_MS = LIVE_FRAME_MS

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
