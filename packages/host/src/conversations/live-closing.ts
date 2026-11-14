import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { disconnectNativeAgents } from "../contracts/native-agents.js"
import { autoContinueCandidate } from "../contracts/turn-continuation.js"
import { stoppedWork } from "./interrupted-turn.js"
import type { LiveActions } from "./live-actions.js"
import type { LiveApprovals } from "./live-approvals.js"
import { recordCutOff } from "./live-auto-continue.js"
import { releaseHold } from "./live-ledger.js"
import type { LiveRecords } from "./live-records.js"
import type { LeftTurn, LiveRestarts } from "./live-restarts.js"
import { revokeTools, type LiveAccess, type Resident } from "./live-runtime.js"
import { interruptRequests, unhandedRequest } from "./live-settlement.js"
import type { LiveTransfers } from "./live-transfers.js"

type ClosingAccess = Pick<LiveAccess,
  "dependencies" | "reclaims" | "require" | "resident" | "control" | "flush" | "noteWork" | "drain" | "clearHibernationTimer" | "declineAutoContinue">

/** The parts closing a conversation settles. */
export interface ClosingParts {
  records: LiveRecords
  actions: LiveActions
  approvals: LiveApprovals
  transfers: LiveTransfers
  restarts: LiveRestarts
}

/** Conversations closing: one at a time on Close, all of them when the host leaves. */
export class LiveClosing {
  private readonly access: ClosingAccess
  private readonly parts: ClosingParts
  private shutdown?: Promise<void>

  constructor(access: ClosingAccess, parts: ClosingParts) {
    this.access = access
    this.parts = parts
  }

  close(id: string, forExit = false): Promise<void> {
    const resident = this.access.require(id)
    // A Close under way answers for one asked meanwhile, and no longer: what opened since is the next Close's to close.
    if (resident.closeOperation) return resident.closeOperation
    const operation = this.closeResident(resident, id, forExit)
    resident.closeOperation = operation
    const done = () => {
      if (resident.closeOperation === operation)
        resident.closeOperation = undefined
    }
    void operation.then(done, done)
    return operation
  }

  async closeForExit(ids = this.parts.records.ids()): Promise<void> {
    const left: LeftTurn[] = []
    const results = await Promise.allSettled(ids.map(async (id) => {
      const resident = this.access.resident(id)
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
      // A Fin's turn its Apex waits on, and an Apex's turn its open Fins' work rests on, go on in the next host, as a
      // quit leaves them; the person's own stop where they are.
      const cut = this.inTree(resident) ? this.cutForNextHost(resident) : undefined
      if (cut) left.push(cut)
      this.access.flush(resident)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.close(id, true), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("A provider did not finish closing. Mako stayed open; wait for it to settle before trying again.")), 30_000) })])
      } finally { clearTimeout(timer) }
    }))
    this.parts.restarts.leave(left)
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }

  /**
   * A turn still running now is cut short by this host, on purpose. The
   * journal says so, with the moment, so the next host does not read it as a
   * crash and the transcript can offer to continue the turn; what's returned
   * is the turn to leave for that host. An idle conversation is left as it
   * is, so stopping writes nothing for it. The background work it had sent off
   * ends with the harness's process, and the request names it, as the
   * continuation will tell the agent.
   */
  private cutForNextHost(resident: Resident): LeftTurn | undefined {
    // One never handed its harness is no turn to continue: it waits, as those queued do, to be sent again.
    resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(unhandedRequest) }
    const running = resident.snapshot.requests.find((request) => request.status === "dispatching")
    if (!running) return undefined
    const stopped = stoppedWork(resident.snapshot, true)
    resident.snapshot = {
      ...resident.snapshot,
      requests: interruptRequests(
        resident.snapshot.requests,
        "host-quit",
        "Mako closed while this turn was running"
      ).map((request) => request.id === running.id && request.interruption && stopped.length ? { ...request, interruption: { ...request.interruption, stopped } } : request),
    }
    recordCutOff(resident, running.id, this.access.dependencies.root)
    if (autoContinueCandidate(resident.snapshot.requests, true)?.id !== running.id) return undefined
    return { conversationId: resident.snapshot.session.id, requestId: running.id, ...(this.inTree(resident) && { always: true as const }) }
  }

  /** Whether a conversation's Thread is a Fin, or an Apex with Fins still open (`ThreadStore.edges`). */
  private inTree(resident: Resident): boolean {
    const threads = this.access.dependencies.threads
    const placed = threads?.journalPlacement(resident.snapshot.session.id)
    if (!placed || !threads) return false
    const edges = threads.edges()
    return edges.of(placed.thread) !== undefined || edges.children(placed.thread).some((edge) => edge.closedAt === undefined)
  }

  private async closeResident(
    resident: Resident,
    id: string,
    forExit: boolean
  ): Promise<void> {
    const { dependencies } = this.access
    const { transfers } = this.parts
    this.access.clearHibernationTimer(resident)
    resident.generation += 1
    const pending = transfers.pending(resident)
    // A switch that only waits (behind another, or for its time) did nothing yet: Mako's exit leaves it for the next
    // host, as it leaves queued messages; one under way, or any the person's close finds, fails.
    if (pending && !(forExit && pending.state.kind === "queued"))
      transfers.save(resident, {
        ...pending,
        state: {
          kind: "failed",
          error: "The conversation was closed before the switch completed",
        },
      })
    const idle = resident.snapshot.session.status === "ready"
    const generation = resident.generation
    resident.closing = true
    this.access.declineAutoContinue(resident, forExit)
    const starting = resident.starting
    if (starting) {
      hostLog("live", "Close cancels a native setup in progress", { conversation: id, harness: starting.driver.provider })
      await Promise.resolve()
        .then(() => starting.driver.close(starting.bindingId))
        .catch((error) => hostWarn("live", "a native setup did not cancel on Close", { conversation: id, harness: starting.driver.provider, error: errorMessage({ error }) }))
    }
    const openingOperation = resident.openingOperation
    if (openingOperation) await openingOperation
    const hibernationOperation = resident.hibernating
    if (hibernationOperation) await hibernationOperation
    const wakeOperation = resident.waking
    if (wakeOperation) await wakeOperation
    const transferOperation = resident.transferOperation
    if (transferOperation) await transferOperation
    const bindingIds = [...resident.connections.keys()]
    const activeBindingId = this.access.control(resident).activeBindingId
    // A hibernated binding has no connection but can still hold its Local Control session.
    if (!bindingIds.includes(activeBindingId))
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
    this.access.noteWork(resident)
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
    this.parts.approvals.settle(resident, activeBindingId)
    this.access.flush(resident)
    try {
      await Promise.all(
        bindingIds.map((bindingId) =>
          revokeTools(dependencies, bindingId, id)
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
      for (const binding of this.access.control(resident).bindings)
        if (binding.nativeId && !failedBindings.has(binding.id))
          releaseHold(
            dependencies.memory,
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
        this.access.flush(resident)
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
      this.access.flush(resident)
      if (
        idle &&
        dependencies.checkpoint &&
        resident.generation === generation
      ) {
        const control = this.access.control(resident)
        const bindings = await Promise.all(
          control.bindings.map(async (binding) => {
            if (!binding.path || binding.id !== control.activeBindingId)
              return binding
            const checkpoint = await dependencies.checkpoint?.(
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
          this.access.resident(id) === resident
        ) {
          resident.snapshot = {
            ...resident.snapshot,
            control: { ...this.access.control(resident), bindings },
          }
          this.access.flush(resident)
        }
      }
    } finally {
      resident.closing = false
      // Mako's exit starts nothing: what still waits is the next host's.
      if (!forExit) this.access.drain(resident)
      this.parts.records.scheduleSweep()
    }
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown
    const { dependencies } = this.access
    const { records } = this.parts
    const closing: Promise<unknown>[] = []
    const left: LeftTurn[] = []
    records.stop()
    this.parts.actions.stop()
    for (const resident of records.values()) {
      for (const pending of [resident.hibernating, resident.waking, resident.openingOperation, resident.transferOperation])
        if (pending) closing.push(pending)
      this.access.clearHibernationTimer(resident)
      resident.generation += 1
      const driver = resident.driver
      resident.driver = null
      this.access.noteWork(resident)
      for (const [bindingId, connection] of resident.connections) {
        closing.push(Promise.resolve().then(() => connection.driver.close(bindingId)).then(
          () => {
            const binding = this.access.control(resident).bindings.find(
              (candidate) => candidate.id === bindingId
            )
            if (binding?.nativeId)
              releaseHold(
                dependencies.memory,
                binding.provider,
                binding.nativeId,
                resident.snapshot.session.id
              )
          },
          () => undefined
        ))
        closing.push(revokeTools(dependencies, bindingId, resident.snapshot.session.id))
      }
      if (
        resident.opening &&
        !resident.connections.has(
          this.access.control(resident).activeBindingId
        )
      ) {
        const bindingId = this.access.control(resident).activeBindingId
        const binding = this.access.control(resident).bindings.find(
          (candidate) => candidate.id === bindingId
        )
        closing.push(Promise.resolve().then(() => driver?.close(bindingId)).then(
          () => {
            if (binding?.nativeId)
              releaseHold(
                dependencies.memory,
                binding.provider,
                binding.nativeId,
                resident.snapshot.session.id
              )
          },
          () => undefined
        ))
        closing.push(revokeTools(dependencies, bindingId, resident.snapshot.session.id))
      }
      // In-memory continuation promises go with this host. A provider wait is already journaled with its due time,
      // so the next host owns it; stopping this host must not silently cancel the pending work.
      this.access.declineAutoContinue(resident, true)
      const cut = this.cutForNextHost(resident)
      if (cut) left.push(cut)
      // One conversation Mako can't save doesn't keep the others from saving how this host left them.
      try {
        this.access.flush(resident)
      } catch (error) {
        hostWarn("live", "a conversation couldn't be saved as Mako stopped", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) })
      }
      // Open questions keep a conversation loaded until the host stops, so its dropped copy's space is reclaimed here.
      resident.journal.close((path) => { void this.access.reclaims.reclaim(path) }, true)
    }
    records.clear()
    this.parts.restarts.leave(left)
    return this.shutdown = Promise.allSettled(closing).then(() => {})
  }
}
