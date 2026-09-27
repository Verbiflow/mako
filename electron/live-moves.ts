import type { ContextTransfer, ConversationControl } from "./contracts/conversation-control.js"
import { pendingQuestion } from "./contracts/live-questions.js"
import { isActiveNativeAgent } from "./contracts/native-agents.js"
import {
  executionRefusal,
  type ClaimReceipt,
  type ExecutionOwner,
  type Handoff,
  type MoveId,
  type Refusal,
  type SessionExecution,
} from "./contracts/thread-execution.js"
import { SessionIdSchema, type Actor, type ThreadId } from "./contracts/thread-identity.js"
import { hostWarn } from "./host-log.js"
import type { Dependencies, Resident } from "./live-runtime.js"
import { errorMessage } from "./live-runtime.js"
import type { LiveSnapshot } from "./shared.js"
import type { JournalFacts, MoveBegan, ThreadStore } from "./thread-store.js"

/** What the move logic may see and do in the conversation host. */
export interface MoveAccess {
  dependencies: Dependencies
  /** A journal this host has in memory; moves never load one. */
  resident(id: string): Resident | undefined
  control(resident: Resident): ConversationControl
  pending(resident: Resident): ContextTransfer | undefined
  canHibernate(resident: Resident): boolean
  hibernate(resident: Resident, reason: string): Promise<void>
  /** Start work that waited while the Session could not run here. */
  resume(resident: Resident): void
}

/** Release refused: something in the Thread is still working, and the move waits for it. */
export class MoveNotQuietError extends Error {
  readonly reasons: string[]
  constructor(reasons: string[]) {
    super(`The Thread can't leave yet: ${reasons.join("; ")}`)
    this.name = "MoveNotQuietError"
    this.reasons = reasons
  }
}

/** What a journal tells the Thread store about itself. */
export function snapshotFacts(snapshot: LiveSnapshot): JournalFacts {
  return {
    conversationId: snapshot.session.id,
    createdAt: snapshot.createdAt,
    harness: snapshot.session.harness,
    threadPath: snapshot.threadPath,
    bindings: snapshot.control?.bindings ?? [{ provider: snapshot.session.harness, nativeId: snapshot.session.nativeId, path: snapshot.threadPath }],
    ancestry: snapshot.control?.ancestry
      ? { kind: snapshot.control.ancestry.kind, parentId: snapshot.control.ancestry.parentId, placement: snapshot.control.ancestry.placement }
      : undefined,
    session: snapshot.control?.session ? SessionIdSchema.parse(snapshot.control.session) : undefined,
  }
}

/**
 * Execution ownership in the conversation host (primitive P2). The host runs
 * a journal's provider only while the Thread store says this environment
 * owns its Session; the check and the dispatch happen in one turn of the
 * event loop, so a release can never fall between them. Moving a Thread is
 * begin, release (once every journal is quiet), then the destination's
 * claim; see `ThreadStore` for the record.
 */
export class LiveMoves {
  private readonly access: MoveAccess
  /** The last answer per journal, kept for when the store cannot be read. */
  private readonly seen = new Map<string, SessionExecution>()
  private readonly unreadable = new Set<string>()

  constructor(access: MoveAccess) {
    this.access = access
  }

  /** Without a Thread store every journal runs here, as before ownership existed. */
  execution(snapshot: LiveSnapshot): SessionExecution | undefined {
    const threads = this.access.dependencies.threads
    if (!threads) return undefined
    const id = snapshot.session.id
    try {
      const found = threads.journalExecution(snapshotFacts(snapshot))
      this.seen.set(id, found)
      this.unreadable.delete(id)
      return found
    } catch (error) {
      if (!this.unreadable.has(id))
        hostWarn("threads", "execution owner unreadable; keeping the last answer", { conversation: id, error: errorMessage({ error }) })
      this.unreadable.add(id)
      return this.seen.get(id)
    }
  }

  /** Whether the host may dispatch or spawn for this journal now. */
  executes(resident: Resident): boolean {
    const execution = this.execution(resident.snapshot)
    return !execution || execution.state === "here"
  }

  /** Queued prompts wait for the move and do not keep a provider warm. */
  holdsQueued(resident: Resident): boolean {
    return this.execution(resident.snapshot)?.state === "leaving"
  }

  /** The generation a dispatched prompt records. */
  generation(resident: Resident): number | undefined {
    return this.execution(resident.snapshot)?.generation
  }

  /** New prompts are accepted while the Thread is leaving and refused once it has gone. */
  assertAdmits(resident: Resident): void {
    const execution = this.execution(resident.snapshot)
    const refusal = execution && executionRefusal(execution)
    if (refusal) throw new Error(refusal)
  }

  /** A provider switch starts a process, so it waits for the move like a new tab. */
  assertStarts(resident: Resident): void {
    this.assertOpens(snapshotFacts(resident.snapshot))
  }

  /** Opening a journal starts a provider; only a Session that runs here and is not moving may. */
  assertOpens(facts: JournalFacts): void {
    const threads = this.access.dependencies.threads
    if (!threads) return
    let execution: SessionExecution
    try {
      execution = threads.journalExecution(facts)
    } catch (error) {
      hostWarn("threads", "execution owner unreadable; opening as before", { conversation: facts.conversationId, error: errorMessage({ error }) })
      return
    }
    if (execution.state === "here") return
    throw new Error(executionRefusal(execution) ?? "This session is moving. Open it again once the move ends or is cancelled.")
  }

  begin(input: { move: MoveId; thread: ThreadId; target: ExecutionOwner; actor: Actor }): MoveBegan {
    return this.store().beginMove(input)
  }

  cancel(input: { operationId: string; move: MoveId; actor: Actor }): void {
    const threads = this.store()
    const journals = moveJournalIds(threads, input.move)
    threads.cancelMove(input)
    this.resume(journals)
  }

  /**
   * Give up the Thread once nothing in it is working: close every idle
   * provider, check again with no wait before the store commits, and return
   * the handoff for the destination. Refuses, naming what is still busy,
   * rather than wait; the caller asks again when that settles.
   */
  async release(input: { operationId: string; move: MoveId; actor: Actor }): Promise<Handoff> {
    const threads = this.store()
    if (threads.moveStatus(input.move)?.phase !== "leaving") return threads.release(input)
    const residents = this.quiet(threads, input.move)
    await Promise.all(residents.map(async (resident) => {
      await resident.hibernating
      if (resident.driver) await this.access.hibernate(resident, "move")
    }))
    const closing = this.quiet(threads, input.move).filter((resident) => resident.driver)
    if (closing.length) throw new MoveNotQuietError(closing.map((resident) => `${label(resident)} is still connected to its provider`))
    return threads.release(input)
  }

  claim(input: { operationId: string; handoff: Handoff; actor: Actor }): ClaimReceipt {
    const receipt = this.store().claim(input)
    this.resume(input.handoff.sessions.flatMap((session) => session.journals))
    return receipt
  }

  refuse(input: { operationId: string; handoff: Handoff; reason: string; actor: Actor }): Refusal {
    return this.store().refuse(input)
  }

  confirm(input: { operationId: string; receipt: ClaimReceipt; actor: Actor }): void {
    this.store().confirm(input)
  }

  reclaim(input: { operationId: string; refusal: Refusal; actor: Actor }): void {
    const threads = this.store()
    const journals = moveJournalIds(threads, input.refusal.move)
    threads.reclaim(input)
    this.resume(journals)
  }

  /**
   * The residents of a leaving move, once none of them is working and no
   * other host holds one of its native sessions. Queued prompts are allowed:
   * the move holds them.
   */
  private quiet(threads: ThreadStore, move: MoveId): Resident[] {
    const reasons: string[] = []
    const residents: Resident[] = []
    for (const moving of threads.moveJournals(move)) {
      for (const native of moving.natives) {
        const hold = this.access.dependencies.memory?.heldBy(native.harness, native.nativeId)
        if (hold) reasons.push(`a session in it is open in ${hold.hostLabel}`)
      }
      for (const id of moving.journals) {
        const resident = this.access.resident(id)
        if (!resident) continue
        const busy = this.busy(resident)
        if (busy) reasons.push(`${label(resident)} ${busy}`)
        else residents.push(resident)
      }
    }
    if (reasons.length) throw new MoveNotQuietError([...new Set(reasons)])
    return residents
  }

  private busy(resident: Resident): string | undefined {
    const { snapshot } = resident
    const control = this.access.control(resident)
    if (resident.opening || resident.waking) return "is starting"
    if (resident.closing) return "is closing"
    if (resident.transferring || this.access.pending(resident)) return "is switching providers"
    if (resident.checkpointing || resident.rewinding) return "is saving or rewinding its workspace"
    if (snapshot.session.status === "running" || snapshot.requests.some((request) => request.status === "dispatching"))
      return "is running a turn"
    if (snapshot.permissions.length) return "is waiting for an approval"
    if ((control.questions ?? []).some((question) => pendingQuestion(question, control, snapshot.requests)))
      return "is waiting for an answer"
    if (resident.autoContinue) return "is about to continue a dropped turn"
    if (snapshot.session.backgroundTasks) return "has background tasks running"
    if ((snapshot.nativeAgents?.agents ?? []).some(isActiveNativeAgent)) return "has subagents running"
    if (control.children.some((child) =>
      child.status === "starting" || child.status === "working" || child.status === "needs-permission" ||
      child.delivery === "pending" || child.delivery === "queued"))
      return "has delegated work in progress"
    if (resident.driver && !resident.hibernating && !this.access.canHibernate(resident))
      return "can't pause its provider safely yet"
    return undefined
  }

  private resume(journals: readonly string[]): void {
    for (const id of journals) {
      const resident = this.access.resident(id)
      if (resident) this.access.resume(resident)
    }
  }

  private store(): ThreadStore {
    const threads = this.access.dependencies.threads
    if (!threads) throw new Error("Moving a Thread needs the Thread store, which this host could not open")
    return threads
  }
}

function moveJournalIds(threads: ThreadStore, move: MoveId): string[] {
  return threads.moveJournals(move).flatMap((moving) => moving.journals)
}

function label(resident: Resident): string {
  const title = resident.snapshot.session.title?.trim()
  return title ? `"${title}"` : "a tab"
}
