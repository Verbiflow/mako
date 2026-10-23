import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { hostLog, hostWarn } from "../base/host-log.js"
import { resumes } from "../harnesses/index.js"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import type { Interruption, InterruptionReason, LiveRequest, TurnContinuation } from "../contracts/live-conversations.js"
import type { Actor } from "../contracts/thread-identity.js"
import { AUTO_CONTINUE_DELAY_MS, autoContinueCandidate, continueTurnPrompt } from "../contracts/turn-continuation.js"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import { closeCutOffCalls, recordCutOffCalls } from "./interrupted-turn.js"
import { promptFingerprint } from "./live-assets.js"
import { LiveRequestSchema } from "./live-journal.js"
import { activeBinding, type LiveAccess, type Resident } from "./live-runtime.js"

type AutoContinueAccess = Pick<LiveAccess, "dependencies" | "admission" | "resident" | "flush" | "pending" | "admit" | "transfer">

/**
 * A turn that just ended on the provider's dropped connection or exited
 * process is picked up by Mako after `AUTO_CONTINUE_DELAY_MS`, once per
 * turn; a process that is gone is reopened on its native session first,
 * the same reconnect a user's send makes.
 */
export class LiveAutoContinue {
  private readonly access: AutoContinueAccess

  constructor(access: AutoContinueAccess) {
    this.access = access
  }

  /**
   * The interrupted request is stamped with the moment so the renderer says
   * "continuing automatically" instead of offering the button; the timer
   * re-checks eligibility when it fires, because the user may have sent
   * something, closed the conversation, or the host may be leaving. Only
   * `settled`, the request whose turn ended in this very transition, is
   * considered: an older interruption the user left alone, or a
   * provider-started turn or compaction ending later, never revives one.
   */
  schedule(resident: Resident, settled: string): void {
    if (resident.autoContinue || (!resident.driver && !this.reconnectBinding(resident)) || this.access.admission.closed) return
    const candidate = autoContinueCandidate(resident.snapshot.requests)
    if (candidate?.id !== settled || !candidate.interruption) return
    const delay = this.access.dependencies.autoContinueDelayMs ?? AUTO_CONTINUE_DELAY_MS
    const at = Date.now() + delay
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.id === candidate.id && request.interruption
          ? { ...request, interruption: { ...request.interruption, autoContinue: { at } } }
          : request
      ),
    }
    const timer = setTimeout(() => this.fire(resident.snapshot.session.id, candidate.id), delay)
    timer.unref?.()
    resident.autoContinue = { requestId: candidate.id, timer }
  }

  private fire(id: string, requestId: string): void {
    const resident = this.access.resident(id)
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
      this.access.pending(resident) ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.permissions.length > 0
    ) {
      this.access.flush(resident)
      return
    }
    const reason = source.interruption.reason
    const actor: Actor = { kind: "service", name: "auto-continue" }
    const continues: TurnContinuation = { requestId, reason, auto: true }
    const request = LiveRequestSchema.parse({
      actor,
      id: randomUUID(),
      createdAt: Date.now(),
      text: continueTurnPrompt(reason, "mako"),
      attachments: [],
      tuning: source.tuning,
      status: "queued",
      continues,
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    try {
      this.access.admission.assert()
      if (reconnect)
        this.access.transfer(id, { id: request.id, provider: reconnect.provider, text: request.text, attachments: [], tuning: source.tuning }, actor, continues)
      else this.access.admit(resident, request)
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
      this.access.flush(resident)
    }
  }

  /**
   * Continues a turn cut short now, as Mako, with Mako's words for `reason`: a turn Mako stopped to hand its Thread
   * to another machine continues where the Thread runs next. `continues` names the request that was cut short, which
   * may be in another host's journal. Asked again under the same `requestId`, it changes nothing.
   */
  continueNow(id: string, input: { requestId: string; reason: InterruptionReason; continues: string; stopped?: readonly string[]; actor: Actor }): void {
    const resident = this.access.resident(id)
    if (!resident) throw new Error("This conversation is no longer available")
    if (resident.snapshot.requests.some((request) => request.id === input.requestId)) return
    this.decline(resident)
    const tuning = [...resident.snapshot.requests].reverse().find((request) => request.tuning)?.tuning
    const continues: TurnContinuation = { requestId: input.continues, reason: input.reason, auto: true }
    const request = LiveRequestSchema.parse({
      actor: input.actor,
      id: input.requestId,
      createdAt: Date.now(),
      text: continueTurnPrompt(input.reason, "mako", input.stopped),
      attachments: [],
      tuning,
      status: "queued",
      continues,
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    this.access.admission.assert()
    const reconnect = this.reconnectBinding(resident)
    if (reconnect)
      this.access.transfer(id, { id: request.id, provider: reconnect.provider, text: request.text, attachments: [], tuning }, input.actor, continues)
    else this.access.admit(resident, request)
    hostLog("live", "continued a turn cut short", { conversation: id, harness: resident.snapshot.session.harness, request: request.id, continues: input.continues, reason: input.reason, reconnect: Boolean(reconnect) })
  }

  /** Drop a pending continuation and its stamp; a later prompt, close or host exit made it moot. */
  decline(resident: Resident): void {
    const pending = resident.autoContinue
    if (!pending) return
    clearTimeout(pending.timer)
    resident.autoContinue = undefined
    resident.snapshot = {
      ...resident.snapshot,
      requests: clearAutoContinue(resident.snapshot.requests, pending.requestId),
    }
  }

  /**
   * The binding a session whose provider process is gone reopens, when its
   * provider can resume the native session; `undefined` while a driver is
   * attached or when nothing can be reopened.
   */
  private reconnectBinding(resident: Resident): ProviderBinding | undefined {
    if (resident.driver || resident.snapshot.session.connection !== "disconnected") return undefined
    const binding = activeBinding(resident)
    const driver = this.access.dependencies.driver(binding?.provider ?? "")
    return binding?.nativeId && driver && resumes(driver) && driver.available(this.access.dependencies.appPath) ? binding : undefined
  }
}

/**
 * A turn cut short: closes the calls nothing will report on now. Unless the
 * user stopped it, keeps on the request what the agent has no account of,
 * for the next prompt to tell it.
 */
export function recordCutOff(resident: Resident, requestId: string, root: string): void {
  const steps = resident.steps
  resident.steps = undefined
  const request = resident.snapshot.requests.find((candidate) => candidate.id === requestId)
  const interruption = request?.interruption
  if (!interruption) return
  const blocks = reduceLiveUpdates(resident.snapshot.blocks, resident.updates)
  // A harness that ends its process on Stop never reports the calls it was running.
  const stopped = interruption.reason === "stopped"
  const closing = closeCutOffCalls(blocks, requestId, stopped ? "canceled" : "failed")
  resident.updates.push(...closing)
  // The person who stopped the turn knows what it left; the agent is told only of a turn cut short.
  const record = stopped ? {} : recordCutOffCalls(reduceLiveUpdates(blocks, closing), requestId, steps, join(root, "context", "interrupted", requestId))
  const told: Interruption = { ...interruption, ...record }
  if (closing.length) told.closed = closing.map((update) => update.id)
  if (stopped && !closing.length) return
  resident.snapshot = {
    ...resident.snapshot,
    requests: resident.snapshot.requests.map((candidate) => (candidate.id === requestId && candidate.interruption ? { ...candidate, interruption: told } : candidate)),
  }
}

/** The requests with the scheduled-continuation stamp removed from `requestId`, or from every request. */
export function clearAutoContinue(requests: LiveRequest[], requestId?: string): LiveRequest[] {
  return requests.map((request) => {
    if (!request.interruption?.autoContinue || (requestId !== undefined && request.id !== requestId)) return request
    const interruption = { ...request.interruption }
    delete interruption.autoContinue
    return { ...request, interruption }
  })
}
