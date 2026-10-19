import type { ResumeVerdict } from "../contracts/conversation-control.js"
import { keptByRecords, ledgerReply, resumeLedger } from "../contracts/thread-continuation.js"
import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "../contracts/host-events-boot.js"
import {
  planContinuation,
  type ContinuationPlan,
  type ContinuationResolution,
  type OwnerResolution,
} from "../contracts/thread-continuation.js"

/** Ownership is resolved once before consulting provider-native resume policy. */
export interface ContinuationDependencies<Snapshot = unknown> {
  ref(path: string): Promise<ThreadRef | undefined>
  resolveOwner?(ref: ThreadRef): Promise<OwnerResolution<Snapshot>>
  assessResume?(ref: ThreadRef): Promise<ResumeVerdict | undefined>
  live(provider: string): { available: boolean; canResume: boolean } | null
  nativeInstalled(provider: string): boolean
  running(path: string): boolean
  external(path: string): ExternalThreadActivity["status"] | null
  /** Why this host may not resume a native session (`SessionMemory.resumeRefusal`, which `hold` throws at send); null when it may. */
  resumeRefusal?(): string | null
}

export type AttachedResolution<Snapshot = unknown> = Extract<ContinuationResolution<Snapshot>, { transport: "attached" }>

export interface ContinuationPlanner<Snapshot = unknown> {
  resolve(path: string): Promise<ContinuationResolution<Snapshot>>
  /**
   * Only the Mako owner, for viewing: no process probe and no read of the
   * native record. A conversation whose live session was ended takes over
   * nothing; its saved history is read.
   */
  owner(path: string): Promise<AttachedResolution<Snapshot> | null>
  plan(path: string): Promise<ContinuationPlan>
  /** Throws unless the plan reopens `path` live on `provider` as `nativeId`. */
  assertLive(path: string, provider: string, nativeId: string): Promise<void>
  /** Throws unless the plan runs `path` through its own CLI. */
  assertNative(path: string): Promise<void>
}

export function createContinuationPlanner<Snapshot>(
  dependencies: ContinuationDependencies<Snapshot>
): ContinuationPlanner<Snapshot> {
  const resolve = async (path: string): Promise<ContinuationResolution<Snapshot>> => {
    const ref = await dependencies.ref(path)
    if (!ref)
      return {
        transport: "refused",
        reason: "This session is no longer in the catalog.",
      }
    // A session its harness deleted whose records Mako keeps resumes natively: the assessment restores them first (`restoringResume`). Only Mako's copy can't.
    const kept = keptByRecords(ref)
    const owner = ref.archived && !kept ? undefined : await dependencies.resolveOwner?.(ref)
    if (owner?.kind === "attached") {
      const attached: AttachedResolution<Snapshot> = { transport: "attached", provider: owner.provider, conversationId: owner.conversationId, snapshot: owner.snapshot, bindingId: owner.bindingId }
      // A conversation here that isn't running wakes by resuming its session; the same rule decides what a reply does.
      const refusal = owner.running === false ? dependencies.resumeRefusal?.() : null
      if (!refusal) return attached
      const reply = ledgerReply(owner.provider, refusal, dependencies.live(owner.provider))
      return { ...attached, reason: reply.reason, makoUpdate: true, notice: reply.notice }
    }
    if (owner?.kind === "unavailable") return { transport: "unavailable", reason: owner.reason }
    const live = dependencies.live(ref.harness)
    // Decided before the resume is assessed: a kept session's assessment would restore it, and resuming needs the hold this host can't take.
    const refusal = dependencies.resumeRefusal?.()
    if (refusal) return resumeLedger(owner?.kind === "unowned" ? { ...ref, heldBy: undefined } : ref, refusal, live)
    const running = dependencies.running(path)
    const assessment = (!ref.archived || kept) && !ref.resumeUnavailable && (live?.canResume || dependencies.nativeInstalled(ref.harness)) && !running
      ? await dependencies.assessResume?.(ref) ?? { kind: "unavailable" as const, reason: "Native session recovery evidence is unavailable. Reconnect the host before replying." } : undefined
    if (assessment?.kind === "held") return { transport: "refused", reason: `This session is open in ${assessment.by}. Wait for it to finish before replying.` }
    if (assessment?.kind === "unavailable") return { transport: "unavailable", reason: assessment.reason }
    if (assessment?.kind === "closed") return { transport: "handoff", provider: ref.harness, reason: assessment.reason, ...assessment.outdated && { outdated: assessment.outdated } }
    const owned = owner?.kind === "unowned" ? { ...ref, heldBy: undefined } : ref
    // Restored, the session is its harness's own again.
    const currentRef = kept && assessment?.kind === "resumable" ? { ...owned, archived: undefined } : owned
    const plan = planContinuation(assessment?.kind === "resumable" ? { ...currentRef, locked: false } : currentRef, {
      live,
      nativeInstalled: dependencies.nativeInstalled(ref.harness),
      running,
      external: assessment?.kind === "resumable" ? null : dependencies.external(path),
    })
    return plan
  }
  const plan = async (path: string): Promise<ContinuationPlan> => {
    const result = await resolve(path)
    if (result.transport !== "attached") return result
    const plain: ContinuationPlan = { transport: "attached", provider: result.provider, conversationId: result.conversationId }
    if (result.reason) plain.reason = result.reason
    if (result.makoUpdate) plain.makoUpdate = true
    if (result.notice) plain.notice = result.notice
    return plain
  }
  const owner = async (path: string): Promise<AttachedResolution<Snapshot> | null> => {
    const ref = await dependencies.ref(path)
    if (!ref || ref.archived) return null
    const found = await dependencies.resolveOwner?.(ref)
    return found?.kind === "attached" && !found.ended
      ? { transport: "attached", provider: found.provider, conversationId: found.conversationId, snapshot: found.snapshot, bindingId: found.bindingId }
      : null
  }
  return {
    resolve,
    owner,
    plan,
    async assertLive(path, provider, nativeId) {
      const decided = await plan(path)
      if (
        decided.transport === "live" &&
        decided.provider === provider &&
        decided.nativeId === nativeId
      )
        return
      throw new Error(describeMismatch(decided, `${provider} cannot reopen this session live`))
    },
    async assertNative(path) {
      const decided = await plan(path)
      if (decided.transport === "native") return
      throw new Error(describeMismatch(decided, "This session is not continued through its CLI"))
    },
  }
}

function describeMismatch(plan: ContinuationPlan, refusal: string): string {
  switch (plan.transport) {
    case "attached":
      return "This conversation already has a Mako owner. Attach to it before sending."
    case "unavailable":
    case "refused":
      return plan.reason
    case "handoff":
      return `${refusal}: ${plan.reason}`
    case "live":
      return `${refusal}: it reopens live on ${plan.provider}. Retry from the thread.`
    case "native":
      return `${refusal}: it continues through the ${plan.provider} CLI. Retry from the thread.`
  }
}
