import { isDeepStrictEqual } from "node:util"
import type { LiveRequest } from "./contracts/live-conversations.js"
import { createHash } from "node:crypto"
import {
  LiveActionInputSchema,
  LiveActionResultSchema,
  type LiveAction,
  type LiveActionInput,
  type LiveActionResult,
} from "./contracts/live-actions.js"
import {
  compactionAvailable,
  COMPACTION_CONFIRMATION_MS,
} from "./contracts/recovery.js"
import { errorMessage, type LiveAccess, type Resident } from "./live-runtime.js"

/** Durable command receipts. A retry returns its receipt and never repeats a provider write. */
export class LiveActions {
  private readonly host: LiveAccess
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(host: LiveAccess) {
    this.host = host
  }

  blocks(resident: Resident): boolean {
    return (
      this.host
        .control(resident)
        .actions?.some(
          (action) =>
            action.state.kind === "dispatching" ||
            (action.input.kind === "compact" &&
              ["accepted", "uncertain"].includes(action.state.kind))
        ) ?? false
    )
  }

  private state(
    resident: Resident,
    id: string,
    state: LiveAction["state"]
  ): LiveAction {
    const control = this.host.control(resident)
    const action = control.actions?.find((item) => item.input.id === id)
    if (!action) throw new Error("This provider action is unavailable")
    const updated = { ...action, state }
    const restoreQueue = state.kind === "not-accepted" && action.input.kind === "steer-queued" && action.queueStatus
      ? { id: action.input.queuedRequestId, status: action.queueStatus } : undefined
    if (state.kind !== "dispatching" && state.kind !== "accepted") {
      const key = `${resident.snapshot.session.id}:${id}`
      clearTimeout(this.deadlines.get(key))
      this.deadlines.delete(key)
    }
    resident.snapshot = {
      ...resident.snapshot,
      // Restore ownership and the refusal in the same journal transaction.
      requests: restoreQueue
        ? resident.snapshot.requests.map((request) => request.id === restoreQueue.id && request.status === "canceled"
          ? { ...request, status: restoreQueue.status } : request)
        : resident.snapshot.requests,
      control: {
        ...control,
        actions: control.actions?.map((item) =>
          item === action ? updated : item
        ),
      },
    }
    this.host.flush(resident)
    return updated
  }

  result(
    resident: Resident,
    bindingId: string,
    actionId: string,
    raw: LiveActionResult
  ): void {
    const action = this.host
      .control(resident)
      .actions?.find((item) => item.input.id === actionId)
    if (
      !action ||
      action.bindingId !== bindingId ||
      action.input.kind !== "compact" ||
      !["dispatching", "accepted", "uncertain"].includes(action.state.kind)
    )
      return
    const result = LiveActionResultSchema.parse(raw)
    if (result.kind === "failed") {
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((request) =>
          request.status === "queued" ? { ...request, status: "held" } : request
        ),
      }
    }
    this.state(resident, actionId, result)
  }

  stop(): void {
    for (const timer of this.deadlines.values()) clearTimeout(timer)
    this.deadlines.clear()
  }

  settle(resident: Resident, bindingId: string): void {
    const session = resident.snapshot.session
    const interrupted = session.connection === "disconnected" ||
      session.status === "failed" || session.status === "closed" ||
      /cancel|interrupt/i.test(session.lastStop ?? "")
    if (interrupted) {
      for (const action of this.host.control(resident).actions ?? []) {
        if (action.bindingId !== bindingId || action.input.kind === "compact" || action.state.kind !== "dispatching") continue
        // A provider may never answer a steer after its turn is cancelled.
        // Retain its unknown outcome and pause the queue; neither can remain
        // fictitious running work that prevents this host from shutting down.
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((request) =>
            request.status === "queued" ? { ...request, status: "held" } : request
          ),
        }
        this.state(resident, action.input.id, {
          kind: "uncertain",
          reason: "The turn ended before the provider confirmed this steering message. It will not be sent again automatically.",
        })
      }
    }
    // An idle session does not prove that a command has completed (Devin
    // acknowledges /compact before doing the work). Only its result can.
    if (
      resident.snapshot.session.status === "ready" &&
      resident.snapshot.session.connection === "connected"
    )
      return
    for (const action of this.host.control(resident).actions ?? []) {
      if (
        action.bindingId !== bindingId ||
        action.input.kind !== "compact" ||
        !["dispatching", "accepted", "uncertain"].includes(action.state.kind)
      )
        continue
      this.state(resident, action.input.id, {
        kind: "uncertain",
        reason:
          "Compaction ended without a confirmed completion. It will not be retried automatically.",
      })
    }
  }

  async acknowledge(id: string, actionId: string): Promise<void> {
    const resident = this.host.require(id)
    const action = this.host
      .control(resident)
      .actions?.find((item) => item.input.id === actionId)
    if (action?.state.kind === "acknowledged") return
    if (!action || action.state.kind !== "uncertain")
      throw new Error("This action does not need acknowledgement")
    const outcome = action.state
    if (action.input.kind === "compact") {
      const closing = this.host.close(id)
      // Closing advances the generation itself. A further change retires us.
      const generation = resident.generation
      await closing
      if (resident.generation !== generation)
        throw new Error("The action owner changed; reload its saved receipt before continuing")
      const current = this.host.control(resident).actions?.find(item => item.input.id === actionId)
      if (current?.state.kind === "acknowledged") return
      // A native result may arrive while the connection is closing.
      if (current?.state.kind !== "uncertain") return
    }
    const previous = resident.snapshot
    if (action.input.kind === "compact") {
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...resident.snapshot.session,
          status: "ready",
          connection: "disconnected",
        },
      }
    }
    try {
      this.state(resident, actionId, {
        kind: "acknowledged",
        receipt: { at: Date.now(), outcome },
      })
    } catch (error) {
      resident.snapshot = previous
      this.host.storageFailed(resident, { error })
      throw error
    }
    this.host.drain(resident)
  }

  async submit(id: string, raw: LiveActionInput): Promise<LiveAction> {
    const input = LiveActionInputSchema.parse(raw)
    const resident = this.host.require(id)
    const control = this.host.control(resident)
    const digest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex")
    const existing = control.actions?.find(
      (action) => action.input.id === input.id
    )
    if (existing) {
      if (existing.digest !== digest)
        throw new Error("This action ID was already used for different input")
      return existing
    }
    const driver = resident.driver
    if (
      !driver ||
      resident.opening ||
      resident.closing ||
      resident.transferring ||
      resident.rewinding ||
      resident.checkpointing ||
      resident.storageFault
    )
      throw new Error(
        "Wait for this conversation to connect and finish its pending operation"
      )
    if (
      this.blocks(resident) ||
      control.actions?.some(
        (action) =>
          action.state.kind === "dispatching" ||
          action.state.kind === "uncertain"
      )
    )
      throw new Error(
        "Resolve the previous provider action before sending another"
      )
    if ((control.actions?.length ?? 0) >= 2000)
      throw new Error(
        "This conversation has reached its provider-action limit. Continue in a new fork."
      )
    const bindingId = control.activeBindingId
    let perform: () => Promise<LiveAction["state"]>
    let retained = input
    let queued: LiveRequest | undefined
    if (input.kind !== "compact") {
      const steer = driver.steer
      const request = resident.snapshot.requests.find(
        (item) => item.id === input.requestId && item.status === "dispatching"
      )
      if (!steer)
        throw new Error(
          "This provider does not support steering an active turn"
        )
      if (
        resident.snapshot.session.status !== "running" ||
        !request?.nativeRun ||
        request.nativeRun.bindingId !== bindingId
      )
        throw new Error(
          "The selected turn is no longer running or has not started yet"
        )
      if (input.kind === "steer-queued") {
        queued = resident.snapshot.requests.find((item) => item.id === input.queuedRequestId)
        if (!queued || (queued.status !== "queued" && queued.status !== "held"))
          throw new Error("This queued message is no longer available for steering")
        if (queued.targetBindingId && queued.targetBindingId !== bindingId)
          throw new Error("This queued message belongs to a different agent session")
        if (queued.text !== input.text || !isDeepStrictEqual(queued.attachments, input.attachments))
          throw new Error("This queued message changed. Review it before steering")
      }
      const expectedRunId = request.nativeRun.runId
      const attachments = this.host.retainAttachments(input.attachments)
      retained = { ...input, attachments }
      perform = () =>
        steer(bindingId, {
          id: input.id,
          expectedRunId,
          text: input.text,
          attachments,
        })
    } else {
      if (
        input.requestId &&
        !resident.snapshot.requests.some(
          (request) =>
            request.id === input.requestId && request.status === "failed"
        )
      )
        throw new Error(
          "The failed message is no longer available for recovery"
        )
      const compact = driver.compaction
      if (!compact || compact.kind === "unavailable")
        throw new Error(
          compact?.reason ??
            "This provider does not support verified compaction"
        )
      if (
        !compactionAvailable(
          resident.snapshot.session,
          control.actions ?? [],
          resident.snapshot.requests.some(
            (request) =>
              request.status === "queued" || request.status === "dispatching"
          )
        )
      )
        throw new Error(
          "Wait for the conversation and queued messages to finish before compacting"
        )
      perform = async () => {
        await compact.start(bindingId, input.id)
        return { kind: "accepted" }
      }
    }
    const action: LiveAction = {
      input: retained,
      digest,
      bindingId,
      createdAt: Date.now(),
      queueStatus: queued?.status === "queued" || queued?.status === "held" ? queued.status : undefined,
      state: { kind: "dispatching" },
    }
    const previous = resident.snapshot
    resident.snapshot = {
      ...previous,
      // The action takes ownership before the provider write. Keep the source
      // record, but make it ineligible for the normal queue drain.
      requests: queued ? previous.requests.map((item) => item.id === queued.id ? { ...item, status: "canceled" } : item) : previous.requests,
      control: { ...control, actions: [...(control.actions ?? []), action] },
    }
    try {
      this.host.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    const generation = resident.generation
    let result: LiveAction["state"]
    if (input.kind === "compact") {
      const timer = setTimeout(() => {
        this.state(resident, input.id, {
          kind: "uncertain",
          reason:
            "The provider has not confirmed compaction after five minutes. It will not be repeated automatically.",
        })
      }, COMPACTION_CONFIRMATION_MS)
      timer.unref?.()
      this.deadlines.set(`${resident.snapshot.session.id}:${input.id}`, timer)
    }
    try {
      result = await perform()
    } catch (error) {
      result = {
        kind: "uncertain",
        reason: `${errorMessage({ error })} This action will not be retried automatically.`,
      }
    }
    if (resident.generation !== generation)
      throw new Error("The action owner changed; reload its saved receipt before continuing")
    const current = this.host
      .control(resident)
      .actions?.find((item) => item.input.id === input.id)
    if (current?.state.kind !== "dispatching") return current ?? action
    if (result.kind === "accepted" && input.kind !== "compact") {
      resident.updates.push({
        kind: "user",
        requestId: input.id,
        steeringFor: input.requestId,
        text: input.text,
        attachments:
          retained.kind !== "compact"
            ? retained.attachments.map((attachment) => ({
                type: "attachment",
                name: attachment.name,
                mimeType: attachment.mimeType,
                source: attachment.path
                  ? { kind: "file", path: attachment.path }
                  : {
                      kind: "unavailable",
                      reason: "Attachment bytes were not retained",
                    },
              }))
            : [],
      })
    }
    try {
      return this.state(resident, input.id, result)
    } catch (error) {
      this.host.storageFailed(resident, { error })
      throw error
    } finally {
      this.host.drain(resident)
    }
  }
}
