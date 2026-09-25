import { randomUUID } from "node:crypto"
import { approvalAnswerDigest } from "./providers/approval-evidence.js"
import { isDeepStrictEqual } from "node:util"
import { ApprovalSubmissionSchema, NativeApprovalDecisionSchema, sameNativeApproval, type NativeApprovalDecision, type NativeApprovalIdentity, type ApprovalEndSource, type ApprovalOrigin, type ApprovalResponse, type ApprovalSubmission } from "./contracts/approval-response.js"
import type { LivePermissionRequest, LivePermissionResponse } from "./contracts/providers-acp.js"
import type { LiveAccess, Resident } from "./live-runtime.js"

interface SubmissionEvidence { state?: ApprovalSubmission }

/** One durable answer intent per observed approval, independent of provider transport. */
export class LiveApprovals {
  private readonly epoch = randomUUID()
  private readonly host: LiveAccess
  constructor(host: LiveAccess) { this.host = host }

  private origin(resident: Resident, nativeRequestId: string, observationId?: string, native?: NativeApprovalIdentity): ApprovalOrigin {
    const bindingId = this.host.control(resident).activeBindingId
    const origin: ApprovalOrigin = {
      nativeRequestId, observationId, bindingId, epoch: this.epoch,
      generation: resident.generation,
      connectionGeneration: resident.bindingGenerations.get(bindingId) ?? 0,
      runId: resident.snapshot.requests.find(request => request.status === "dispatching")?.id
        ?? resident.snapshot.session.nativeRunId,
    }
    if (native) origin.native = native
    return origin
  }

  observe(resident: Resident, request: LivePermissionRequest): void {
    const origin = this.origin(resident, request.id, request.observationId, request.native)
    const control = this.host.control(resident)
    // Native occurrence identity survives callback/connection replacement. A new
    // callback is not permission to replay an answer with uncertain delivery.
    const sameOccurrence = (prior: ApprovalOrigin | undefined) =>
      prior?.bindingId === origin.bindingId && origin.native !== undefined
        ? sameNativeApproval(prior.native, origin.native)
        : isDeepStrictEqual(prior, origin)
    if (origin.native && control.approvalObservations?.some(item => item.decision && item.bindingId === origin.bindingId && sameNativeApproval(item.identity, origin.native))) return
    if (control.approvalResponses?.some(receipt => sameOccurrence(receipt.origin) &&
      (receipt.nativeDecision || receipt.state.kind !== "not-submitted" || !receipt.state.pending))) return
    const previous = resident.snapshot.permissions.find(item => sameOccurrence(item.origin))
    resident.snapshot = {
      ...resident.snapshot,
      control: origin.native && !(control.approvalObservations ?? []).some(item => item.bindingId === origin.bindingId && sameNativeApproval(item.identity, origin.native)) && (control.approvalObservations?.length ?? 0) < 2000
        ? { ...control, approvalObservations: [...(control.approvalObservations ?? []), { bindingId: origin.bindingId, identity: origin.native }] }
        : control,
      permissions: [
        ...resident.snapshot.permissions.filter(item => item !== previous),
        { ...request, id: previous?.id ?? randomUUID(), origin },
      ],
    }
  }

  /** Native evidence settles only its exact binding and native occurrence. */
  decision(resident: Resident, bindingId: string, raw: NativeApprovalDecision): void {
    const control = this.host.control(resident)
    const binding = control.bindings.find(item => item.id === bindingId)
    if (!binding || this.host.dependencies.driver(binding.provider)?.approvalEvidence.kind !== "native-decisions") return
    const decision = NativeApprovalDecisionSchema.parse(raw)
    const matches = control.approvalResponses?.filter(receipt => receipt.origin.bindingId === bindingId &&
      receipt.origin.native && sameNativeApproval(receipt.origin.native, decision.identity)) ?? []
    const observations = control.approvalObservations?.filter(item => item.bindingId === bindingId && sameNativeApproval(item.identity, decision.identity)) ?? []
    // Keep observed native questions after their transient UI row disappears.
    // Native output and decision observation can arrive in either order.
    if (observations.length > 1 || observations[0]?.decision || matches.length > 1 || (!observations.length && matches.length !== 1)) return
    resident.snapshot = { ...resident.snapshot,
      permissions: resident.snapshot.permissions.filter(request => request.origin?.bindingId !== bindingId || !sameNativeApproval(request.origin.native, decision.identity)),
      control: { ...control,
        approvalObservations: control.approvalObservations?.map(item => item === observations[0] ? { ...item, decision } : item),
        approvalResponses: control.approvalResponses?.map(receipt => receipt === matches[0] && !receipt.nativeDecision ? { ...receipt, nativeDecision: decision } : receipt),
      },
    }
  }

  /** Exact occurrence reconciliation. A bare native ID may name a newer request. */
  end(
    resident: Resident,
    bindingId: string,
    event: { requestId: string; observationId: string; source: ApprovalEndSource }
  ): void {
    const matches = (origin: ApprovalOrigin | undefined) =>
      origin?.observationId === event.observationId &&
      origin.nativeRequestId === event.requestId &&
      origin.bindingId === bindingId &&
      origin.epoch === this.epoch &&
      origin.generation === resident.generation &&
      origin.connectionGeneration === (resident.bindingGenerations.get(bindingId) ?? 0)
    const control = this.host.control(resident)
    resident.snapshot = {
      ...resident.snapshot,
      permissions: resident.snapshot.permissions.filter(request => !matches(request.origin)),
      control: {
        ...control,
        approvalResponses: control.approvalResponses?.map(receipt => {
          if (!matches(receipt.origin) || receipt.ended) return receipt
          return {
            ...receipt,
            ended: { source: event.source, observedAt: Date.now() },
            state: receipt.state.kind === "dispatching"
              ? { kind: "uncertain", reason: "The approval request ended before answer submission was confirmed." }
              : receipt.state,
          }
        }),
      },
    }
  }

  /** Ending a connection/turn is not evidence that its pending answer arrived. */
  settle(resident: Resident, bindingId: string): void {
    const control = this.host.control(resident)
    if (!control.approvalResponses?.some(receipt => receipt.origin.bindingId === bindingId && receipt.state.kind === "dispatching")) return
    resident.snapshot = { ...resident.snapshot, control: { ...control,
      approvalResponses: control.approvalResponses.map(receipt => receipt.origin.bindingId === bindingId && receipt.state.kind === "dispatching"
        ? { ...receipt, state: { kind: "uncertain", reason: "The connection or turn ended before answer submission was confirmed." } } : receipt),
    } }
  }

  private save(resident: Resident, receipt: ApprovalResponse): void {
    const previous = resident.snapshot
    const control = this.host.control(resident)
    resident.snapshot = {
      ...previous,
      permissions: receipt.nativeDecision || receipt.state.kind === "submitted" || (receipt.state.kind === "not-submitted" && !receipt.state.pending)
        ? previous.permissions.filter(request => request.id !== receipt.id)
        : receipt.state.kind === "not-submitted" && receipt.state.pending
          ? previous.permissions.map(request => request.id === receipt.id ? { ...request, id: randomUUID() } : request)
          : previous.permissions,
      control: { ...control, approvalResponses: [
        ...(control.approvalResponses ?? []).filter(item => item.id !== receipt.id), receipt,
      ] },
    }
    try { this.host.flush(resident) } catch (error) {
      resident.snapshot = previous
      this.host.storageFailed(resident, { error })
      throw error
    }
  }

  async respond(id: string, requestId: string, response: LivePermissionResponse): Promise<void> {
    const resident = this.host.require(id)
    const digest = approvalAnswerDigest(response)
    const control = this.host.control(resident)
    const existing = control.approvalResponses?.find(item => item.id === requestId)
    if (existing) {
      if (existing.digest !== digest) throw new Error("This approval already has a different saved answer")
      if (existing.nativeDecision || existing.state.kind === "submitted" || existing.state.kind === "not-submitted") return
      throw new Error("This approval answer was already saved. Delivery is unconfirmed; it will not be sent again.")
    }
    const request = resident.snapshot.permissions.find(item => item.id === requestId)
    const driver = resident.driver
    if (!request?.origin || !driver || resident.closing || resident.opening || resident.transferring || resident.storageFault ||
      !isDeepStrictEqual(request.origin, this.origin(resident, request.origin.nativeRequestId, request.origin.observationId, request.origin.native)))
      throw new Error("That approval is no longer pending on this connection")
    if (response.kind === "choice") {
      if (response.optionId !== null && !request.options.some(option => option.optionId === response.optionId))
        throw new Error("That approval option is unavailable")
    } else if (!request.questions || Object.keys(response.answers).some(key => !request.questions?.some(question => question.id === key))) {
      throw new Error("Those answers do not belong to this approval")
    }
    if ((control.approvalResponses?.length ?? 0) >= 2000)
      throw new Error("This conversation has reached its saved approval limit. Continue in a new fork.")
    const receipt: ApprovalResponse = {
      id: request.id, origin: request.origin, digest, createdAt: Date.now(), state: { kind: "dispatching" },
    }
    const nativeAnswerDigest = driver.approvalAnswerDigest?.(request, response)
    if (nativeAnswerDigest !== undefined) receipt.nativeAnswerDigest = nativeAnswerDigest
    this.save(resident, receipt)
    const evidence: SubmissionEvidence = {}
    try {
      await driver.permission(request.origin.bindingId, request.origin.nativeRequestId, response, {
        report: result => {
          if (!evidence.state) evidence.state = ApprovalSubmissionSchema.parse(result)
        },
        assertCurrent: () => {
          if (resident.driver !== driver || resident.closing || resident.storageFault ||
            !resident.snapshot.permissions.some(item => item.id === requestId) ||
            !isDeepStrictEqual(request.origin, this.origin(resident, receipt.origin.nativeRequestId, receipt.origin.observationId, receipt.origin.native)))
            throw new Error("That approval is no longer pending on this connection")
        },
      })
    } catch {
      // Provider errors can contain answers; keep them out of the durable receipt.
    }
    const state = evidence.state ?? { kind: "uncertain", reason: "The connection did not confirm submission of this approval answer. It will not be sent again automatically." }
    if (resident.generation !== receipt.origin.generation ||
      (resident.bindingGenerations.get(receipt.origin.bindingId) ?? 0) !== receipt.origin.connectionGeneration ||
      this.host.control(resident).activeBindingId !== receipt.origin.bindingId)
      throw new Error("The approval owner changed. Its saved answer will not be sent again.")
    const latest = this.host.control(resident).approvalResponses?.find(item => item.id === receipt.id)
    const settled = { ...receipt, ended: latest?.ended, state }
    if (latest?.nativeDecision) settled.nativeDecision = latest.nativeDecision
    this.save(resident, settled)
    if (state.kind === "uncertain" && !latest?.nativeDecision) throw new Error(state.reason)
  }
}
