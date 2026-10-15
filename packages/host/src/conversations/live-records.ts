import { join } from "node:path"
import { disconnectedContext } from "../base/execution-context.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { hostLog } from "../base/host-log.js"
import type { Interruption, LiveSnapshot, LiveSummary } from "../contracts/live-conversations.js"
import type { NativeActivity } from "../contracts/native-activity.js"
import { disconnectNativeAgents, isBusyNativeAgent } from "../contracts/native-agents.js"
import type { ConversationMemory } from "../contracts/provider-residency.js"
import { ContentWeights, residencyPlan, type ResidencyPlan } from "../contracts/residency.js"
import { SessionIdSchema } from "../contracts/thread-identity.js"
import type { JournalFacts } from "../threads/index.js"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import { closeCutOffCalls, recordCutOffCalls } from "./interrupted-turn.js"
import { clearAutoContinue } from "./live-auto-continue.js"
import { LiveJournal, journalIds } from "./live-journal.js"
import { backfillMemory } from "./live-ledger.js"
import { conversationControl, residentOf, type Dependencies, type Resident } from "./live-runtime.js"
import { interruptRequests } from "./live-settlement.js"

/**
 * What the host holds of conversations nothing is using; see `ResidencyBudget`.
 * Journals here run to 95MB, and a host that kept each one it loaded held
 * 640MB minutes after starting.
 */
export const CONVERSATION_MEMORY = { bytes: 128 * 1024 * 1024, recent: 2, sweepMs: 15_000 }

/** What an unloaded conversation keeps that its journal does not. */
interface Unloaded {
  generation: number
  commands: LiveSnapshot["session"]["commands"]
  activityAt?: number
  nativeActivity?: NativeActivity
}

/** What the records ask of the conversations they let go. */
export interface RecordHooks {
  /** Work for the conversation outside its resident: a start, a refresh, a stop, a provider switch. */
  busy(resident: Resident): boolean
  flush(resident: Resident): void
  storageFailed(resident: Resident, boundary: FailureBoundary): void
  /** A journal was read in; what it names but doesn't keep is read now (`LiveSources.readBase`). */
  loaded(resident: Resident): void
  /** A closed journal much of which is free, to compact (`JournalReclaims`). */
  compact(path: string): void
}

/**
 * The conversations a host holds in memory and the ones only on disk. A
 * journal is read in when something needs it, and let go once the memory
 * budget has no room for it and nothing is using it.
 */
export class LiveRecords {
  private readonly dependencies: Dependencies
  private readonly hooks: RecordHooks
  private readonly residents = new Map<string, Resident>()
  /** Conversations on disk only, as the listing has them. */
  private readonly recovered = new Map<string, LiveSummary>()
  /** Conversations `sweep` let go this host life; `load` puts each back as it was. */
  private readonly unloaded = new Map<string, Unloaded>()
  /** Residents `unload` let go, so a continuation still holding one cannot write through it. */
  private readonly released = new WeakSet<Resident>()
  private readonly weights = new ContentWeights()
  /** The conversation each binding's driver events belong to; the journal's index doesn't hold it. */
  readonly owners = new Map<string, string>()
  private sweepTimer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(dependencies: Dependencies, hooks: RecordHooks) {
    this.dependencies = dependencies
    this.hooks = hooks
  }

  /** Lists every saved journal, as the host before this one left it, for the Thread store to register. */
  open(): JournalFacts[] {
    const { dependencies } = this
    const journals: JournalFacts[] = []
    for (const id of journalIds(dependencies.root)) {
      try {
        const journal = new LiveJournal(dependencies.root, id)
        try {
          const found = journal.summary()
          if (found) {
            const { ancestry, threadSession, ...summary } = found
            dependencies.memory?.rememberBindings(id, summary.nativeBindings, summary.createdAt)
            backfillMemory(dependencies.memory, dependencies.root, id, summary.session)
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
    return journals
  }

  /** A conversation in memory; never reads one in. */
  get(id: string): Resident | undefined {
    return this.residents.get(id)
  }

  has(id: string): boolean {
    return this.residents.has(id)
  }

  values(): IterableIterator<Resident> {
    return this.residents.values()
  }

  ids(): string[] {
    return [...this.residents.keys()]
  }

  /** Keeps a new conversation, its journal already written. */
  add(resident: Resident): void {
    this.residents.set(resident.snapshot.session.id, resident)
  }

  /** The session as the listing has it, without reading an unloaded conversation's transcript back. */
  session(id: string): LiveSummary["session"] | undefined {
    return this.residents.get(id)?.snapshot.session ?? this.recovered.get(id)?.session
  }

  /** The listing's line for every conversation, loaded or not. */
  listing(): LiveSummary[] {
    return [...this.recovered.values(), ...[...this.residents.values()].map(({ snapshot }) => residentSummary(snapshot))]
  }

  /** Whether `unload` let this resident go; a write through it is dropped. */
  isReleased(resident: Resident): boolean {
    return this.released.has(resident)
  }

  require(id: string): Resident {
    const resident = this.load(id)
    if (!resident) throw new Error("This conversation is unavailable")
    return resident
  }

  load(id: string): Resident | undefined {
    const existing = this.residents.get(id)
    if (existing) {
      existing.usedAt = this.dependencies.now?.() ?? Date.now()
      return existing
    }
    if (!this.recovered.has(id)) return undefined
    const journal = new LiveJournal(this.dependencies.root, id)
    const started = performance.now()
    const previous = journal.read()
    if (!previous) {
      journal.close()
      return undefined
    }
    const unloaded = this.unloaded.get(id)
    if (unloaded) {
      hostLog("residency", "conversation reloaded", { conversation: id, ms: Math.round(performance.now() - started), blocks: previous.blocks.length })
      return this.reload(journal, previous, unloaded)
    }
    const snapshot = afterRestart(previous, this.dependencies.root)
    journal.commit(snapshot, previous)
    const resident = residentOf(snapshot, journal, { usedAt: this.dependencies.now?.() ?? Date.now() })
    this.residents.set(id, resident)
    this.recovered.delete(id)
    this.ownBindings(resident)
    this.scheduleSweep()
    this.hooks.loaded(resident)
    return resident
  }

  /** Lets go of a conversation now when nothing is using it, as the memory budget would. */
  release(id: string): boolean {
    const resident = this.residents.get(id)
    return Boolean(resident && this.unload(resident))
  }

  /**
   * A conversation `unload` let go, back exactly as it left. None of a
   * restart's recovery applies: only what nothing was running could go.
   */
  private reload(journal: LiveJournal, saved: LiveSnapshot, unloaded: Unloaded): Resident {
    const id = saved.session.id
    const session = { ...saved.session }
    if (unloaded.commands) session.commands = unloaded.commands
    const snapshot: LiveSnapshot = { ...saved, session }
    if (unloaded.activityAt !== undefined) snapshot.activityAt = unloaded.activityAt
    if (unloaded.nativeActivity) snapshot.nativeActivity = unloaded.nativeActivity
    const resident = residentOf(snapshot, journal, {
      // Past every generation a continuation of the resident it replaces could hold.
      generation: unloaded.generation + 1,
      usedAt: this.dependencies.now?.() ?? Date.now(),
    })
    this.residents.set(id, resident)
    this.recovered.delete(id)
    this.unloaded.delete(id)
    this.ownBindings(resident)
    this.scheduleSweep()
    this.hooks.loaded(resident)
    return resident
  }

  /** Bindings route their driver's events by owner; the owner is not in the journal's index. */
  private ownBindings(resident: Resident): void {
    for (const binding of conversationControl(resident).bindings) this.owners.set(binding.id, resident.snapshot.session.id)
  }

  memory(): ConversationMemory {
    const plan = this.memoryPlan()
    let bytes = 0
    for (const resident of this.residents.values()) bytes += residentWeight(this.weights, resident)
    return { loaded: this.residents.size, unloaded: this.unloaded.size, bytes, pinnedBytes: plan.pinned, budget: this.memoryBudget().bytes }
  }

  private memoryBudget() {
    return this.dependencies.conversationMemory ?? CONVERSATION_MEMORY
  }

  /** Runs `sweep` once things settle, so letting go never lands on a hot path. */
  scheduleSweep(): void {
    if (this.sweepTimer || this.stopped) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined
      this.sweep()
    }, this.memoryBudget().sweepMs)
    this.sweepTimer.unref?.()
  }

  private memoryPlan(): ResidencyPlan {
    return residencyPlan(
      [...this.residents.values()].map((resident) => ({
        id: resident.snapshot.session.id,
        usedAt: resident.usedAt ?? 0,
        weight: residentWeight(this.weights, resident),
        pinned: this.pinned(resident),
      })),
      this.memoryBudget()
    )
  }

  /** Lets go of what the memory budget has no room for; see `ResidencyBudget`. */
  private sweep(): void {
    const plan = this.memoryPlan()
    let freed = 0
    let count = 0
    for (const id of plan.evict) {
      const resident = this.residents.get(id)
      const weight = resident ? residentWeight(this.weights, resident) : 0
      if (resident && this.unload(resident)) {
        freed += weight
        count++
      }
    }
    if (count)
      hostLog("residency", "conversations unloaded", {
        count, freed, kept: plan.kept, pinned: plan.pinned, budget: this.memoryBudget().bytes, loaded: this.residents.size, unloaded: this.unloaded.size,
      })
  }

  /**
   * What memory must keep: anything running, waiting on the person, partway
   * through an operation, or holding a change its journal does not have.
   */
  private pinned(resident: Resident): boolean {
    const { snapshot } = resident
    const control = conversationControl(resident)
    return Boolean(
      resident.driver || resident.connections.size || resident.starting || resident.exited?.size ||
        resident.opening || resident.closing || resident.hibernating || resident.waking ||
        resident.transferring || resident.checkpointing || resident.rewinding ||
        resident.accountSwitching || resident.signInResume || resident.autoContinue || resident.goalContinue || resident.stopping ||
        resident.sideAnswer || snapshot.side ||
        resident.storageFault || resident.timer || resident.updates.length ||
        resident.journalSnapshot !== snapshot ||
        snapshot.session.status === "running" || snapshot.session.status === "starting" ||
        snapshot.permissions.length || control.questions?.length ||
        snapshot.requests.some((request) => request.status === "queued" || request.status === "dispatching") ||
        snapshot.nativeAgents?.agents.some(isBusyNativeAgent) ||
        this.hooks.busy(resident)
    )
  }

  /** Lets go of a conversation nothing is using; `load` brings it back as it was. */
  private unload(resident: Resident): boolean {
    try {
      this.hooks.flush(resident)
    } catch (error) {
      this.hooks.storageFailed(resident, { error })
      return false
    }
    if (this.pinned(resident)) return false
    const { snapshot } = resident
    const id = snapshot.session.id
    this.recovered.set(id, residentSummary(snapshot))
    this.unloaded.set(id, {
      generation: resident.generation,
      commands: snapshot.session.commands,
      activityAt: snapshot.activityAt,
      nativeActivity: snapshot.nativeActivity,
    })
    this.residents.delete(id)
    this.released.add(resident)
    resident.journal.close((path) => this.hooks.compact(path))
    return true
  }

  /** Nothing is swept from here on; the host is stopping. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.sweepTimer)
    this.sweepTimer = undefined
  }

  clear(): void {
    this.residents.clear()
  }
}

/**
 * A journal no host is writing, as this host takes it on: whatever was in
 * flight when the last one ended is settled, and nothing it was doing goes
 * on by itself.
 */
function afterRestart(previous: LiveSnapshot, root: string): LiveSnapshot {
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
    goal: previous.goal?.status === "active"
      ? { ...previous.goal, status: "paused", pending: undefined, note: "Paused when Mako restarted." }
      : previous.goal && { ...previous.goal, pending: undefined },
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
    const closing = closeCutOffCalls(snapshot.blocks, crashed.id)
    snapshot.blocks = reduceLiveUpdates(snapshot.blocks, closing)
    const record = recordCutOffCalls(snapshot.blocks, crashed.id, undefined, join(root, "context", "interrupted", crashed.id))
    const told: Interruption = { ...interruption, ...record }
    if (closing.length) told.closed = closing.map((update) => update.id)
    snapshot.requests = snapshot.requests.map((request) => (request.id === crashed.id && request.interruption ? { ...request, interruption: told } : request))
  }
  return snapshot
}

function residentWeight(weights: ContentWeights, { snapshot }: Resident): number {
  return weights.of({
    blocks: snapshot.blocks,
    base: snapshot.base,
    requests: snapshot.requests,
    control: snapshot.control,
    configOptions: snapshot.session.configOptions,
  })
}

/** The listing's line for a conversation, loaded or not. */
function residentSummary(snapshot: LiveSnapshot): LiveSummary {
  return {
    hasSessionQuestions: Boolean(snapshot.control?.questions?.length),
    nativePaths: snapshot.control?.bindings.flatMap((binding) =>
      binding.path ? [binding.path] : []
    ),
    session: snapshot.session,
    revision: snapshot.revision,
    threadPath: snapshot.threadPath,
    createdAt: snapshot.createdAt,
  }
}
