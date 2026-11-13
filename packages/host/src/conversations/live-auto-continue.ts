import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { hostLog, hostWarn } from "../base/host-log.js"
import { resumes } from "../harnesses/index.js"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import { BRIEF_AGAIN, DIGEST_AGAIN } from "../contracts/children.js"
import { transientCause, unheardDigest, waitsAgain, carriedDigest } from "../contracts/delivery-retry.js"
import type { Interruption, InterruptionReason, LiveRequest, TurnContinuation } from "../contracts/live-conversations.js"
import type { Actor } from "../contracts/thread-identity.js"
import { AUTO_CONTINUE_DELAY_MS, autoContinueCandidate, continueTurnPrompt } from "../contracts/turn-continuation.js"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import { modelByIdentity, type SessionModel } from "@mako/sessions/settings"
import { closeCutOffCalls, recordCutOffCalls } from "./interrupted-turn.js"
import { promptFingerprint } from "./live-assets.js"
import { LiveRequestSchema } from "./live-journal.js"
import { activeBinding, type LiveAccess, type Resident } from "./live-runtime.js"

type AutoContinueAccess = Pick<LiveAccess, "dependencies" | "admission" | "resident" | "flush" | "pending" | "admit" | "transfer" | "reopens" | "wake">

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
   * `restarted`: `settled` is a turn the last host's exit cut short, which
   * this host continues as the person chose (`LiveRestarts`).
   */
  schedule(resident: Resident, settled: string, restarted = false): void {
    if (resident.autoContinue || (!resident.driver && !this.reconnectBinding(resident)) || this.access.admission.closed) return
    const candidate = autoContinueCandidate(resident.snapshot.requests, restarted)
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
    resident.autoContinue = { requestId: candidate.id, timer, restarted }
  }

  private fire(id: string, requestId: string): void {
    const resident = this.access.resident(id)
    const pending = resident?.autoContinue
    if (!resident || pending?.requestId !== requestId) return
    resident.autoContinue = undefined
    const source = autoContinueCandidate(resident.snapshot.requests, pending.restarted)
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
      // The exit that cut a restarted turn closed its conversation as it went; any other close declines the turn.
      (resident.snapshot.session.status === "closed" && !pending.restarted) ||
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
      text: continueTurnPrompt(reason, "mako", source.interruption.stopped),
      attachments: [],
      tuning: source.tuning,
      notification: source.notification,
      status: "queued",
      continues,
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    try {
      this.access.admission.assert()
      if (reconnect)
        this.access.transfer(id, { id: request.id, provider: reconnect.provider, text: request.text, attachments: [], tuning: source.tuning, notification: request.notification }, actor, continues)
      else this.access.admit(resident, request)
      hostLog("live", pending.restarted ? "continued a turn Mako's exit cut short" : "continued a dropped turn", {
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
   * may be in another host's journal; `stopped` is the background work the cut stopped, else what that request kept
   * of it (`Interruption.stopped`). `stayed`: the move didn't happen and the turn goes on where it was, which its words
   * say (`continueTurnPrompt`). `since`: when the cut was, for the account of what moved since, beneath those words
   * (`finResumedText`). Asked again under the same `requestId`, it changes nothing.
   */
  continueNow(id: string, input: { requestId: string; reason: InterruptionReason; continues: string; stopped?: readonly string[]; stayed?: boolean; actor: Actor; brief?: string; since?: number }): void {
    const resident = this.access.resident(id)
    if (!resident) throw new Error("This conversation is no longer available")
    if (resident.snapshot.requests.some((request) => request.id === input.requestId)) return
    this.decline(resident)
    const tuning = runningTuning(resident, this.access.dependencies.heldModels)
    const continues: TurnContinuation = { requestId: input.continues, reason: input.reason, auto: true, ...input.brief && { brief: input.brief }, ...input.since !== undefined && { since: input.since } }
    // A brief carried again goes as itself, framed; as it's sent, a transcript that shows it has a Continue go instead.
    const brief = input.brief && resident.snapshot.requests.find((request) => request.id === input.brief)
    const request = LiveRequestSchema.parse({
      actor: input.actor,
      id: input.requestId,
      createdAt: Date.now(),
      notification: resident.snapshot.requests.find((request) => request.id === input.continues)?.notification,
      text: brief ? `${brief.digest ? DIGEST_AGAIN : BRIEF_AGAIN}\n\n${brief.text}` : continueTurnPrompt(input.reason, "mako", input.stopped ?? resident.snapshot.requests.find((request) => request.id === input.continues)?.interruption?.stopped, { stayed: input.stayed === true }),
      ...(brief && brief.digest && { displayText: "", digest: carriedDigest(brief.digest) }),
      attachments: [],
      tuning,
      status: "queued",
      continues,
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    this.access.admission.assert()
    // A digest stays a digest: its row waits in the queue, and its session wakes for it, as for one sent to a sleeping Apex.
    const wakes = !resident.driver && request.digest !== undefined && this.access.reopens(resident)
    const reconnect = wakes ? undefined : this.reconnectBinding(resident)
    if (reconnect)
      this.access.transfer(id, { id: request.id, provider: reconnect.provider, text: request.text, attachments: [], tuning, notification: request.notification }, input.actor, continues)
    else this.access.admit(resident, request)
    if (wakes) void this.access.wake(resident)
    hostLog("live", "continued a turn cut short", { conversation: id, harness: resident.snapshot.session.harness, request: request.id, continues: input.continues, reason: input.reason, reconnect: Boolean(reconnect) })
  }

  /**
   * A turn its harness failed partway for a cause that clears by itself (its
   * service at capacity or rate-limited, failing on its side, a dropped or
   * stalled connection): what it did stands in its session, so Mako continues
   * it when its next attempt is due (`nextRetry`), held first in line so what
   * was queued after it follows. The failed turn carries that time, which its
   * row says instead of a failure. A continuation that fails the same way
   * waits longer.
   */
  continueFailed(resident: Resident, settled: string): void {
    const failed = resident.snapshot.requests.find((request) => request.id === settled)
    if (failed?.status !== "failed" || this.access.admission.closed) return
    // A turn a Stop latched isn't picked up again by itself (`LiveRequest.pause`).
    if (failed.pause === "stop") return
    const cause = transientCause(failed.error ?? "", failed.failure ?? "unknown", false, failed.failureEvidence)
    // Only a turn its harness ran is continued: one it never took has nothing to pick up. A digest no model answered is
    // the exception, whatever ended it: it stays until one does.
    const ran = failed.nativeRun !== undefined || failed.nativeDelivery?.evidence.kind === "accepted"
    const unheard = unheardDigest(failed) ? failed.digest : undefined
    if ((!cause || !ran) && !unheard) return
    if (resident.snapshot.requests.some((request) => request.continues?.requestId === failed.id)) return
    const now = Date.now()
    const waits = cause || unheard ? waitsAgain(failed, cause, failed.error ?? "", now) : undefined
    if (!waits) return
    const retry = waits.retry
    const continues: TurnContinuation = { requestId: failed.id, reason: "connection-lost", auto: true }
    // Its reports read as heard, so it goes again as itself, for later news to join, as often as it fails, where "carry
    // on" would tell nothing of them; past the retries it rests (`resting`).
    const request = LiveRequestSchema.parse({
      actor: { kind: "service", name: "auto-continue" },
      id: randomUUID(),
      createdAt: now,
      text: unheard ? failed.text : continueTurnPrompt("connection-lost", "mako"),
      ...(unheard && { displayText: "", digest: { ...carriedDigest(unheard), ...(!retry && { resting: true as const, ...(waits.digest?.nextTry !== undefined && { nextTry: waits.digest.nextTry }) }) } }),
      attachments: [],
      tuning: failed.tuning,
      notification: failed.notification,
      status: "held",
      continues,
      ...(retry && { retry }),
    })
    request.inputDigest = promptFingerprint(request.text, request.attachments, request.tuning)
    const requests = resident.snapshot.requests.map((candidate) => (candidate === failed && retry ? { ...candidate, retry } : candidate))
    const at = requests.findIndex((candidate) => candidate.id === failed.id) + 1
    // The failure is being picked up, not left to the person: the session reads ready, so what was queued after the
    // turn goes in the order it came, behind the continuation or after a message that supersedes it.
    const session = resident.snapshot.session
    resident.snapshot = {
      ...resident.snapshot,
      session: session.status === "failed" ? { ...session, status: "ready", error: undefined } : session,
      requests: [...requests.slice(0, at), request, ...requests.slice(at)],
    }
    this.access.flush(resident)
    hostLog("live", "a turn its harness failed for now continues by itself", { conversation: resident.snapshot.session.id, request: request.id, continues: failed.id, ...(cause && { cause }), ...(retry && { attempt: retry.attempt, at: new Date(retry.at).toISOString() }) })
  }

  /** Drop a pending continuation; new input/host exit preserves a service retry, while an explicit Close cancels it. */
  decline(resident: Resident, keepServiceRetry = false): void {
    // A failed turn's continuation that waits for its time gives way the same way.
    // One carrying a digest doesn't: it's the only way its reports are heard.
    const waiting = resident.snapshot.requests.filter((request) => request.status === "held" && request.continues?.auto && request.retry && !request.digest && !(keepServiceRetry && request.retry.cause === "provider-unavailable"))
    if (waiting.length) {
      const failed = new Set(waiting.map((request) => request.continues!.requestId))
      const ids = new Set(waiting.map((request) => request.id))
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((request) =>
          ids.has(request.id) ? { ...request, status: "canceled" as const }
            : failed.has(request.id) && request.status === "failed" ? { ...request, retry: undefined }
              : request),
      }
    }
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
 * What the conversation's session runs on: the newest tuning a request ran with on its active binding, else that
 * binding's own, and of those only one whose model its harness offers when its catalog has been read. Never another
 * harness's: a Fin that began on Cursor keeps Cursor's model ID on its first request
 * (`claude-opus-5-5[cyber=false,context=1m,…]`), and on 2026-11-11 a continuation after a crash carried it to the Claude
 * session the Fin had moved to, which refused it on every turn after; its binding kept it, so the Fin's next message
 * met it too. Undefined when none fits: the session goes on as its harness has it.
 */
export function runningTuning(resident: Resident, heldModels?: (harness: string) => readonly SessionModel[] | undefined): LiveRequest["tuning"] {
  const binding = activeBinding(resident)
  if (!binding) return undefined
  const models = heldModels?.(binding.provider)
  const offered = (tuning: NonNullable<LiveRequest["tuning"]>) => !tuning.model || !models?.length || modelByIdentity(models, tuning.model) !== undefined
  const ranOn = (request: LiveRequest) => (request.nativeRun?.bindingId ?? request.nativeDelivery?.bindingId) === binding.id
  const ran = [...resident.snapshot.requests].reverse().flatMap((request) => (request.tuning && ranOn(request) ? [request.tuning] : []))
  return [...ran, ...binding.tuning ? [binding.tuning] : []].find(offered)
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
  const closing = closeCutOffCalls(blocks, requestId, stopped || interruption.reason === "steered" ? "canceled" : "failed")
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
