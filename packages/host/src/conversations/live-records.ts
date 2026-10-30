import { join } from "node:path"
import { disconnectedContext } from "../base/execution-context.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { Interruption, LiveRequest, LiveSnapshot, LiveSummary } from "../contracts/live-conversations.js"
import type { NativeActivity } from "../contracts/native-activity.js"
import { disconnectNativeAgents, isBusyNativeAgent } from "../contracts/native-agents.js"
import type { ConversationMemory } from "../contracts/provider-residency.js"
import { ContentWeights, residencyPlan, type ResidencyPlan } from "../contracts/residency.js"
import { SessionIdSchema } from "../contracts/thread-identity.js"
import type { JournalFacts } from "../threads/index.js"
import { isTurnStart, reduceLiveUpdates } from "@mako/sessions/live-content"
import type { Entry } from "@mako/sessions/entries"
import { closeCutOffCalls, recordCutOffCalls } from "./interrupted-turn.js"
import { clearAutoContinue } from "./live-auto-continue.js"
import { LiveJournal, journalIds, storedRequest } from "./live-journal.js"
import { backfillMemory } from "./live-ledger.js"
import { conversationControl, residentOf, type Dependencies, type Resident } from "./live-runtime.js"
import { interruptRequests } from "./live-settlement.js"
import { isPaged, pagedWeight } from "./paged-entries.js"

/**
 * What the host holds of conversations nothing is using; see `ResidencyBudget`.
 * Journals here run to 95MB, and a host that kept each one it loaded held
 * 640MB minutes after starting.
 */
export const CONVERSATION_MEMORY = { bytes: 128 * 1024 * 1024, recent: 2, sweepMs: 15_000 }

/**
 * One reader loading this many conversations from disk between two sweeps is
 * named in the log: a window opens one at a time, so a count like this is a
 * job or a call reading the rail in bulk, which the budget can only chase.
 * The Sessions report once loaded every conversation this host had, every
 * second, and the host ran out of heap 90 seconds after each start.
 */
export const BULK_LOADS = 8

/**
 * What a conversation keeps in memory of its newest finished entries, by
 * characters of content, besides the turn running: what a window opening it
 * reads first. Everything before is paged (`paged-entries.ts`).
 */
export const WARM_CHARS = 256 * 1024
/** How long paging a conversation's entries holds the loop before letting other work run. */
const PAGE_SLICE_MS = 4

/** The name of a load nothing named: work outside a call, a job or a domain load. */
const UNNAMED_READER = "unnamed work"
/** The largest conversations in memory the readout lists. */
const HELD_SHOWN = 12

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
  /** Entries of the conversation were paged: whatever still holds them warm (a window's view) may hold the paged ones instead. */
  paged?(id: string): void
  /** The conversation was let go: what still holds its entries (a window's view) lets them go too. */
  released?(id: string): void
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
  private readonly weights = new ContentWeights(pagedWeight)
  /** Paging under way, one conversation at a time; see `pageOut`. */
  private paging?: Promise<void>
  /**
   * Journals let go whose paged entries are still somewhere (a read under
   * way): held until those are collected and the journal has tidied its file
   * (`LiveJournal.released`), since nothing else would hear of it.
   */
  private readonly releasing = new Map<string, LiveJournal>()
  /** The conversation each binding's driver events belong to; the journal's index doesn't hold it. */
  readonly owners = new Map<string, string>()
  /** Who read conversations in from disk, by the work that was running (`HostWork.current`), this host life. */
  private readonly loadsBy = new Map<string, number>()
  /** The same since the last sweep: where a reader loading in bulk is caught. */
  private sinceSweep = new Map<string, number>()
  /** Readers already named for bulk loads since the last sweep: each is said once. */
  private bulkSaid = new Set<string>()
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

  /** A request as the conversation keeps it: from memory when it's loaded, else read from its journal without loading it. */
  request(id: string, requestId: string): LiveRequest | undefined {
    const resident = this.residents.get(id)
    if (resident) return resident.snapshot.requests.find((request) => request.id === requestId)
    return this.recovered.has(id) ? storedRequest(this.dependencies.root, id, requestId) : undefined
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
    // A journal let go that hasn't tidied its file yet leaves that to the one opening it now, which writes ahead again.
    const releasing = this.releasing.get(id)
    if (releasing) {
      releasing.keepFile()
      this.releasing.delete(id)
    }
    const journal = new LiveJournal(this.dependencies.root, id)
    const started = performance.now()
    const previous = journal.read()
    if (!previous) {
      journal.close()
      return undefined
    }
    const by = this.noteLoad()
    const unloaded = this.unloaded.get(id)
    if (unloaded) {
      hostLog("residency", "conversation reloaded", { conversation: id, ms: Math.round(performance.now() - started), blocks: previous.blocks.length, by })
      return this.reload(journal, previous, unloaded, by)
    }
    const snapshot = afterRestart(previous, this.dependencies.root)
    journal.commit(snapshot, previous)
    const resident = residentOf(snapshot, journal, { usedAt: this.dependencies.now?.() ?? Date.now(), loadedBy: by })
    this.residents.set(id, resident)
    this.recovered.delete(id)
    this.ownBindings(resident)
    this.scheduleSweep()
    this.hooks.loaded(resident)
    return resident
  }

  /**
   * A conversation is being read in from disk: counts it to the work that's
   * running, and names that work once when it reads in bulk (`BULK_LOADS`).
   */
  private noteLoad(): string {
    const by = this.dependencies.work?.current() ?? UNNAMED_READER
    this.loadsBy.set(by, (this.loadsBy.get(by) ?? 0) + 1)
    const sinceSweep = (this.sinceSweep.get(by) ?? 0) + 1
    this.sinceSweep.set(by, sinceSweep)
    if (sinceSweep >= BULK_LOADS && !this.bulkSaid.has(by)) {
      this.bulkSaid.add(by)
      hostWarn("residency", "one reader is loading conversations in bulk", {
        by, loads: sinceSweep, loaded: this.residents.size, budget: this.memoryBudget().bytes,
        hint: "a list or a job must read the listing (LiveSummary), never a journal; see BULK_LOADS",
      })
    }
    return by
  }

  /** Every reader that loaded a conversation from disk this host life, most first. */
  private loads(): ConversationMemory["loads"] {
    return [...this.loadsBy].map(([by, count]) => ({ by, count })).sort((left, right) => right.count - left.count).slice(0, 10)
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
  private reload(journal: LiveJournal, saved: LiveSnapshot, unloaded: Unloaded, by: string): Resident {
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
      loadedBy: by,
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
    const held: ConversationMemory["held"] = []
    for (const resident of this.residents.values()) {
      const weight = residentWeight(this.weights, resident)
      bytes += weight
      const { session } = resident.snapshot
      held.push({ conversation: session.id, bytes: weight, pinned: this.pinned(resident), ...session.title !== undefined && { title: session.title }, ...resident.loadedBy !== undefined && { by: resident.loadedBy } })
    }
    held.sort((left, right) => right.bytes - left.bytes).splice(HELD_SHOWN)
    return { loaded: this.residents.size, unloaded: this.unloaded.size, bytes, pinnedBytes: plan.pinned, budget: this.memoryBudget().bytes, loads: this.loads(), held }
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

  /**
   * Pages what each conversation is done with (`pageOut`), then lets go of
   * what the memory budget still has no room for; see `ResidencyBudget`.
   * Paging comes first: a conversation's weight is what memory keeps of it
   * once paged, and weighing an entry before measures its whole content.
   */
  private sweep(): void {
    if (this.paging) {
      this.scheduleSweep()
      return
    }
    this.paging = this.pageAll().finally(() => {
      this.paging = undefined
      if (!this.stopped) this.unloadOverBudget()
    })
  }

  private unloadOverBudget(): void {
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
    // Who read in since the last sweep goes with what the sweep let go: a line that frees a gigabyte names who filled it.
    const loads = [...this.sinceSweep].sort((left, right) => right[1] - left[1]).slice(0, 5).map(([by, loaded]) => `${by}=${loaded}`).join(", ")
    this.sinceSweep = new Map()
    this.bulkSaid = new Set()
    if (count)
      hostLog("residency", "conversations unloaded", {
        count, freed, kept: plan.kept, pinned: plan.pinned, budget: this.memoryBudget().bytes, loaded: this.residents.size, unloaded: this.unloaded.size,
        ...loads && { loads },
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
        resident.transferring || resident.checkpointing || resident.counting || resident.rewinding ||
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

  /**
   * `MAKO_PAGING_CHECK=1`: every entry the journal's rows hold is paged as
   * soon as a commit wrote it, the turn running included, so a suite run
   * with it reads every entry back from its row wherever it reads one.
   */
  pageAllNow(resident: Resident): void {
    if (process.env.MAKO_PAGING_CHECK !== "1" || this.released.has(resident) || resident.journalSnapshot !== resident.snapshot) return
    const { blocks, base } = resident.snapshot
    // Every field but an entry's type and id is read back, however short.
    resident.journal.pageBlocks(blocks, 0, blocks.length, Infinity, 0)
    if (base) resident.journal.pageBase(base.entries, 0, base.entries.length, Infinity, 0)
    this.hooks.paged?.(resident.snapshot.session.id)
  }

  /** Pages every conversation in memory, running or not, one after another. */
  private async pageAll(): Promise<void> {
    for (const resident of Array.from(this.residents.values())) {
      if (this.stopped) return
      try {
        await this.pageOut(resident)
      } catch (error) {
        hostWarn("residency", "a conversation's entries couldn't be paged; memory keeps them", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) })
      }
    }
  }

  /**
   * Pages what a conversation is done with out of memory (`paged-entries.ts`),
   * a slice at a time: its blocks and its history's entries, but the turn
   * running and the newest `WARM_CHARS` of each. A block is paged only while
   * the journal's rows hold the blocks as memory does, and a history entry
   * once its row holds it. Running or idle, pinned or not, a conversation
   * then keeps its last turns and an index of the rest.
   */
  private async pageOut(resident: Resident): Promise<void> {
    const id = resident.snapshot.session.id
    let paged = 0
    const current = () => this.residents.get(id) === resident && !this.released.has(resident) && !this.stopped
    for (const table of ["blocks", "base"] as const) {
      let at = 0
      for (;;) {
        if (!current()) return
        const { snapshot } = resident
        // A block is read back from its row: only while the last commit wrote every block as memory has it.
        if (table === "blocks" && (resident.journalSnapshot !== snapshot || resident.updates.length || resident.storageFault)) break
        const entries = table === "blocks" ? snapshot.blocks : snapshot.base?.entries
        if (!entries) break
        const end = table === "blocks" ? Math.min(warmFrom(entries), runningFrom(resident)) : warmFrom(entries)
        while (at < end && isPaged(entries[at]!)) at++
        if (at >= end) break
        const until = performance.now() + PAGE_SLICE_MS
        const reached = table === "blocks" ? resident.journal.pageBlocks(entries, at, end, until) : resident.journal.pageBase(entries, at, end, until)
        paged += reached - at
        at = reached
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    if (paged) this.hooks.paged?.(id)
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
    const { journal } = resident
    journal.close((path) => this.hooks.compact(path))
    if (journal.pagedCount()) {
      this.releasing.set(id, journal)
      void journal.released().finally(() => { if (this.releasing.get(id) === journal) this.releasing.delete(id) })
    }
    this.hooks.released?.(id)
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

/** Where the newest `WARM_CHARS` of `entries` begin, or the first entry paged already after which all are warm. */
function warmFrom(entries: readonly Entry[]): number {
  let chars = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (isPaged(entry)) return index + 1
    chars += contentChars(entry)
    if (chars > WARM_CHARS) return index + 1
  }
  return 0
}

/** About how much an entry's content weighs: its JSON, most of which paging lets go. */
function contentChars(entry: Entry): number {
  return JSON.stringify(entry).length
}

/** Where the turn under way begins, its blocks still changing; the end when none is. */
function runningFrom({ snapshot }: Resident): number {
  const running = snapshot.session.status === "running" || snapshot.session.status === "starting" ||
    snapshot.requests.some((request) => request.status === "dispatching")
  if (!running) return snapshot.blocks.length
  let index = snapshot.blocks.length - 1
  while (index > 0 && !isTurnStart(snapshot.blocks[index])) index--
  return Math.max(0, index)
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
  const wakes = wakeAt(snapshot.requests)
  return {
    hasSessionQuestions: Boolean(snapshot.control?.questions?.length),
    nativePaths: snapshot.control?.bindings.flatMap((binding) =>
      binding.path ? [binding.path] : []
    ),
    nativeIds: snapshot.control?.bindings.flatMap((binding) =>
      binding.nativeId ? [{ provider: binding.provider, nativeId: binding.nativeId }] : []
    ),
    session: snapshot.session,
    revision: snapshot.revision,
    threadPath: snapshot.threadPath,
    createdAt: snapshot.createdAt,
    ...wakes !== undefined && { wakeAt: wakes },
  }
}

/** The soonest a held request sends itself, if one waits for a time. */
export function wakeAt(requests: readonly LiveRequest[]): number | undefined {
  let soonest: number | undefined
  for (const request of requests)
    if (request.status === "held" && request.wake && (soonest === undefined || request.wake.at < soonest)) soonest = request.wake.at
  return soonest
}
