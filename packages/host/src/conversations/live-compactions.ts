import { isDeepStrictEqual } from "node:util"
import { hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import { compactionPending, compactionRecovering, retiredMove, type CompactionRecovery } from "../contracts/conversation-control.js"
import type { LiveRequest } from "../contracts/live-conversations.js"
import { COMPACTION_CONFIRMATION_MS } from "../contracts/recovery.js"
import type { LiveAction } from "../contracts/live-actions.js"
import { ProviderFailureError } from "../contracts/provider-failure.js"
import { continueTurnPrompt } from "../contracts/turn-continuation.js"
import { DIGEST_RESTART_HINT } from "../contracts/children.js"
import { goingFirst } from "../contracts/request-hold.js"
import { LiveRequestSchema } from "./live-journal.js"
import { promptFingerprint } from "./live-assets.js"
import { namedUuid } from "./cloud-moves.js"
import { activeBinding, type LiveAccess, type Resident } from "./live-runtime.js"

interface CompactionParts {
  compact(id: string, action: string, recovery: string): Promise<LiveAction>
  replace(resident: Resident, recovery: CompactionRecovery): void
  restartAllowed(id: string): boolean
  refresh(resident: Resident, recovery: CompactionRecovery): Promise<boolean>
}

/** A compaction receipt owns its recovery, whether or not a window is open. */
export class LiveCompactions {
  private readonly requested = new Set<string>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly host: LiveAccess
  private readonly parts: CompactionParts
  constructor(host: LiveAccess, parts: CompactionParts) { this.host = host; this.parts = parts }

  /** Called inside the action receipt's commit: no crash can leave held work without its successor. */
  record(resident: Resident, action: LiveAction): void {
    if (action.input.kind !== "compact" || action.owner?.epoch === this.host.epoch && action.owner.stop !== this.host.stopMark(resident.snapshot.session.id)) return
    const control = this.host.control(resident)
    const current = control.compactionRecovery
    const actionEpisode = current?.origin === "native" ? undefined : current
    if (action.bindingId !== control.activeBindingId) return
    if (action.state.kind === "failed" && (action.state.cancelled || action.state.failureEvidence &&
      (!["unknown", "context-exhausted", "transcript-rejected"].includes(action.state.failureEvidence.kind) || action.state.failureEvidence.source === "host"))) {
      // A credential, permission, service or storage problem is not a broken summary. Keep its existing fixing action/wait.
      if (actionEpisode?.retryActionId === action.input.id) this.withdraw(resident, "superseded")
      else if (actionEpisode?.actionId === action.input.id) resident.snapshot = { ...resident.snapshot, control: { ...control, compactionRecovery: undefined } }
      if (!action.state.cancelled && action.state.failureEvidence) resident.snapshot = { ...resident.snapshot,
        requests: this.host.failedStart(resident, { error: new ProviderFailureError(action.state.reason, action.state.failureEvidence) }, true) }
      return
    }
    let next: CompactionRecovery | undefined
    const same = actionEpisode?.actionId === action.input.id || actionEpisode?.retryActionId === action.input.id
    if (same && current && current.origin !== "native") {
      if (!compactionRecovering(current)) return
      if (action.state.kind === "completed") next = { ...current, state: { kind: "completed", bindingId: action.bindingId, waiting: resident.snapshot.requests.filter(request => request.status === "queued").map(request => request.id) } }
      else if (action.state.kind === "failed") next = { ...current, state: current.retryActionId === action.input.id
        ? { kind: "replace", transferId: namedUuid(`compact-replace:${current.id}`) } : { kind: "retry" } }
      else if (["dispatching", "accepted", "uncertain"].includes(action.state.kind) && current.state.kind !== "replace" &&
        (current.state.kind !== "reconcile" || current.state.actionId !== action.input.id)) next = { ...current,
        state: { kind: "reconcile", actionId: action.input.id, deadline: action.createdAt + COMPACTION_CONFIRMATION_MS, at: action.createdAt + COMPACTION_CONFIRMATION_MS } }
    } else if (!compactionRecovering(current) && ["dispatching", "accepted", "uncertain", "failed"].includes(action.state.kind)) {
      const id = namedUuid(`compact-recovery:${action.bindingId}:${action.input.id}`)
      next = { id, actionId: action.input.id, bindingId: action.bindingId, retryActionId: namedUuid(`compact-retry:${id}`),
        target: compactionTarget(resident), requestId: action.input.requestId, createdAt: action.createdAt, epoch: this.host.epoch,
        state: action.state.kind === "failed" ? { kind: "retry" } : { kind: "reconcile", actionId: action.input.id,
          deadline: action.createdAt + COMPACTION_CONFIRMATION_MS, at: action.createdAt + COMPACTION_CONFIRMATION_MS } }
    }

    if (next) {
      resident.snapshot = { ...resident.snapshot, control: { ...control, compactionRecovery: next } }
      this.continuation(resident, next)
    }
  }

  /** Only a terminal, handed-over native turn on an automatic-only harness may enter this path. */
  automatic(resident: Resident, request: LiveRequest): void {
    const control = this.host.control(resident), current = control.compactionRecovery
    if (resident.closing || resident.opening || resident.stopping || request.pause === "stop" || request.status !== "failed" ||
      request.failureEvidence?.kind !== "context-exhausted" ||
      request.nativeRun?.bindingId !== control.activeBindingId || request.continues?.reason === "compaction-failed" ||
      current?.state.kind === "completed" && current.state.waiting?.includes(request.id) || compactionPending(current) ||
      resident.driver?.compaction.kind !== "automatic") return
    const id = namedUuid(`compact-native:${control.activeBindingId}:${request.id}`)
    if (current?.id === id) return
    const recovery: CompactionRecovery = { id, origin: "native", bindingId: control.activeBindingId, requestId: request.id,
      target: compactionTarget(resident), createdAt: Date.now(), epoch: this.host.epoch,
      state: { kind: "replace", transferId: namedUuid(`compact-replace:${id}`) } }
    resident.snapshot = { ...resident.snapshot, control: { ...control, compactionRecovery: recovery } }
    this.continuation(resident, recovery)
    queueMicrotask(() => this.resume(resident))
  }

  /** Queue a discovery turn in the same commit as its episode, ahead of later work. Never copy an uncertain original. */
  private continuation(resident: Resident, recovery: CompactionRecovery): void {
    const original = resident.snapshot.requests.find(request => request.id === recovery.requestId)
    if (!original || !["failed", "interrupted", "uncertain"].includes(original.status) || original.pause === "stop" ||
      resident.snapshot.requests.some(request => request.continues?.requestId === original.id)) return
    const delivery = original.nativeDelivery
    if (delivery?.evidence.kind === "not-accepted" || delivery?.gated && delivery.evidence.kind === "prepared") {
      // Only authoritative non-delivery permits the exact request to go again. Its admission, grants and attachments stay intact.
      const unheard = { ...original, status: "queued" as const, error: undefined, failure: undefined, failureEvidence: undefined,
        retry: undefined, nativeDelivery: undefined, nativePrompt: undefined, nativeRun: undefined, interruption: undefined }
      resident.snapshot = { ...resident.snapshot, requests: [...goingFirst(resident.snapshot.requests.map(request => request === original ? unheard : request), original.id)] }
      return
    }
    const text = `${continueTurnPrompt("compaction-failed", "mako")}${original.digest ? `\n\n${DIGEST_RESTART_HINT}` : ""}`
    const request = LiveRequestSchema.parse({ id: namedUuid(`compact-continue:${recovery.id}`), createdAt: recovery.createdAt,
      actor: { kind: "service", name: "auto-continue" }, text, attachments: [], tuning: original.tuning, notification: original.notification,
      status: "queued", continues: { requestId: original.id, reason: "compaction-failed", auto: true },
      inputDigest: promptFingerprint(text, [], original.tuning) })
    resident.snapshot = { ...resident.snapshot, requests: [...goingFirst([...resident.snapshot.requests, request], request.id)] }
  }

  /** A new message explicitly reopens a closed conversation; it must not reopen its known failed native context. */
  reopen(resident: Resident): boolean {
    const control = this.host.control(resident), recovery = control.compactionRecovery
    if (recovery?.state.kind !== "withdrawn" || recovery.state.reason !== "close" || control.activeBindingId !== recovery.bindingId) return false
    const unknown = recovery.origin !== "native" && [...(control.actions ?? [])].reverse().find(action =>
      (action.input.id === recovery.actionId || action.input.id === recovery.retryActionId) && ["dispatching", "accepted", "uncertain"].includes(action.state.kind))
    const deadline = unknown ? unknown.createdAt + COMPACTION_CONFIRMATION_MS : undefined
    const state: CompactionRecovery["state"] = unknown && deadline !== undefined
      ? { kind: "reconcile", actionId: unknown.input.id, deadline, at: Math.max(deadline, Date.now()) }
      : { kind: "replace", transferId: this.replacementId(resident, recovery) }
    // A person's new input is authority to reopen; an uncertain compact is still never authority to replay it.
    const next: CompactionRecovery = recovery.origin !== "native" ? { ...recovery, epoch: this.host.epoch, state }
      : { ...recovery, epoch: this.host.epoch, state: { kind: "replace", transferId: this.replacementId(resident, recovery) } }
    resident.snapshot = { ...resident.snapshot, control: { ...control, compactionRecovery: next } }
    queueMicrotask(() => this.resume(resident))
    return true
  }

  private replacementId(resident: Resident, recovery: CompactionRecovery): string {
    const previous = [...this.host.control(resident).transfers].reverse().find(transfer => transfer.compaction?.recoveryId === recovery.id)
    return previous ? namedUuid(`compact-reopen:${previous.input.id}`) : namedUuid(`compact-replace:${recovery.id}`)
  }

  withdraw(resident: Resident, reason: Extract<CompactionRecovery["state"], { kind: "withdrawn" }>["reason"]): boolean {
    const control = this.host.control(resident), recovery = control.compactionRecovery
    if (!recovery || !compactionPending(recovery)) return false
    resident.snapshot = { ...resident.snapshot, control: { ...control, compactionRecovery: { ...recovery, state: { kind: "withdrawn", reason } },
      transfers: control.transfers.map(transfer => transfer.compaction?.recoveryId === recovery.id && (transfer.state.kind === "queued" || transfer.state.kind === "preparing") ? retiredMove(transfer, "Compaction recovery was withdrawn") : transfer) } }
    return true
  }

  resume(resident: Resident): void {
    const id = resident.snapshot.session.id
    const recovery = this.host.control(resident).compactionRecovery
    if (this.running.has(id)) { this.requested.add(id); return }
    if (!recovery || !compactionPending(recovery) || this.host.admission.closed || resident.storageFault || resident.closing || resident.opening) return
    if (recovery.epoch !== this.host.epoch && !this.parts.restartAllowed(id)) {
      if (this.withdraw(resident, "restart-off")) this.host.flush(resident)
      return
    }
    const before = recovery.state
    const work = this.run(resident, recovery).catch(error => {
      hostWarn("live", "compaction recovery waits", { conversation: id, error: errorMessage({ error }) })
      const control = this.host.control(resident), current = control.compactionRecovery
      if (current?.id === recovery.id && current.origin !== "native" && current.state.kind === "reconcile" && control.activeBindingId === recovery.bindingId &&
        !resident.storageFault && this.host.resident(id) === resident) {
        resident.snapshot = { ...resident.snapshot, control: { ...control, compactionRecovery: { ...current,
          state: { ...current.state, at: Date.now() + 30_000 } } } }
        try { this.host.flush(resident) } catch (error) { this.host.storageFailed(resident, { error }) }
      }
    }).finally(() => {
      if (this.running.get(id) === work) this.running.delete(id)
      const next = this.host.control(resident).compactionRecovery
      const requested = this.requested.delete(id)
      if (next?.id === recovery.id && (requested || !isDeepStrictEqual(next.state, before))) this.resume(resident)
    })
    this.running.set(id, work)
  }

  /** The saved backlog is cleared by its own receipts, never by notification delivery. */
  settled(resident: Resident): void {
    const control = this.host.control(resident), recovery = control.compactionRecovery
    if (recovery?.state.kind !== "completed" || !recovery.state.waiting?.length) return
    const waiting = recovery.state.waiting.filter(id => resident.snapshot.requests.some(request => request.id === id &&
      (request.status === "queued" || request.status === "dispatching" || request.status === "uncertain")))
    if (waiting.length !== recovery.state.waiting.length) resident.snapshot = { ...resident.snapshot, control: { ...control,
      compactionRecovery: { ...recovery, state: { ...recovery.state, waiting } } } }
  }

  private async run(resident: Resident, recovery: CompactionRecovery): Promise<void> {
    const id = resident.snapshot.session.id, stop = this.host.stopMark(id)
    const expectedBinding = recovery.state.kind === "completed" ? recovery.state.bindingId : recovery.bindingId
    const owned = () => {
      const control = this.host.control(resident)
      return this.host.resident(id) === resident && control.activeBindingId === expectedBinding && control.compactionRecovery?.id === recovery.id &&
        compactionPending(control.compactionRecovery) && isDeepStrictEqual(control.compactionRecovery?.state, recovery.state) && this.host.stopMark(id) === stop && !this.host.admission.closed &&
        this.host.dependencies.signInAllowed?.(id) !== false && this.host.moves.executes(resident)
    }
    if (!owned()) return
    if (recovery.state.kind === "completed") {
      // A native success can arrive while our deadline cleanup is closing. This is not a person's Close:
      // its still-owned backlog may reopen the now-proven compacted source, under the usual native guards.
      if (!resident.driver && resident.snapshot.session.status === "closed") {
        resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, status: "ready", connection: "hibernated" } }
        this.host.flush(resident)
      }
      if (!resident.driver) await this.host.reopen(resident)
      if (owned()) this.host.drain(resident)
      return
    }
    if (!isDeepStrictEqual(recovery.target, compactionTarget(resident))) {
      if (this.withdraw(resident, "superseded")) this.host.flush(resident)
      return
    }
    if (recovery.origin !== "native" && recovery.state.kind === "reconcile") {
      if (Date.now() < recovery.state.at) return
      // The same durable deadline survives a crash; uncertainty never spends the one compact retry.
      await this.host.close(id)
      if (!owned()) return
      const binding = activeBinding(resident), driver = binding && this.host.dependencies.driver(binding.provider)
      const evidence = binding && driver?.resume.kind === "native" ? await driver.resume.inspect(binding) : undefined
      if (!owned()) return
      const refreshed = evidence?.kind === "available" && await this.parts.refresh(resident, recovery)
      if (!owned()) return
      const after = refreshed && binding && driver?.resume.kind === "native" ? await driver.resume.inspect(binding) : undefined
      if (!owned()) return
      if (!refreshed || evidence?.kind !== "available" || after?.kind !== "available" || evidence.checkpoint !== after.checkpoint) {
        if (!owned()) return
        resident.snapshot = { ...resident.snapshot, control: { ...this.host.control(resident), compactionRecovery: { ...recovery,
          state: { ...recovery.state, at: Date.now() + 30_000 } } } }
        this.host.flush(resident)
        return
      }
      if (!owned()) return
      resident.snapshot = { ...resident.snapshot, control: { ...this.host.control(resident), compactionRecovery: { ...recovery,
        state: { kind: "replace", transferId: this.replacementId(resident, recovery) } } } }
      this.host.flush(resident)
      return
    }
    if (recovery.state.kind === "retry" && recovery.origin !== "native") {
      const action = this.host.control(resident).actions?.find(item => item.input.id === recovery.retryActionId)
      // Saved dispatch/acceptance/uncertainty is never an invitation to issue compact again.
      if (action) return
      await this.parts.compact(id, recovery.retryActionId, recovery.id)
      return
    }
    if (recovery.state.kind !== "replace") return
    const transfer = this.host.control(resident).transfers.find(item => recovery.state.kind === "replace" && item.input.id === recovery.state.transferId)
    if (transfer) return
    // Release only this owned source. Its close fences callbacks and waits for native cleanup before any new start.
    await this.host.close(id)
    if (!owned()) return
    if (!isDeepStrictEqual(recovery.target, compactionTarget(resident))) return
    this.parts.replace(resident, recovery)
  }
}

/** The selected identity is pinned for an episode; waiting cannot silently change the account or model. */
function compactionTarget(resident: Resident): CompactionRecovery["target"] {
  const binding = activeBinding(resident), account = binding?.executionContext?.account
  const name = binding?.account ?? (account?.kind === "configured" ? account.name : undefined)
  const tuning = resident.snapshot.session.settings ?? binding?.tuning
  const modeId = resident.snapshot.session.currentMode ?? binding?.modeId
  return { provider: binding?.provider ?? resident.snapshot.session.harness,
    ...(name !== undefined && { account: name }), ...(tuning !== undefined && { tuning }), ...(modeId !== undefined && { modeId }) }
}
