import type { ResumeVerdict } from "./contracts/conversation-control.js"
import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "./contracts/host-events-boot.js"
import {
  planContinuation,
  type ContinuationPlan,
  type ContinuationResolution,
  type OwnerResolution,
} from "./contracts/thread-continuation.js"

/** Ownership is resolved once before consulting provider-native resume policy. */
export interface ContinuationDependencies<Snapshot = unknown> {
  ref(path: string): Promise<ThreadRef | undefined>
  resolveOwner?(ref: ThreadRef): Promise<OwnerResolution<Snapshot>>
  assessResume?(ref: ThreadRef): Promise<ResumeVerdict | undefined>
  live(provider: string): { available: boolean; canResume: boolean } | null
  nativeInstalled(provider: string): boolean
  running(path: string): boolean
  external(path: string): ExternalThreadActivity["status"] | null
}

export type AttachedResolution<Snapshot = unknown> = Extract<ContinuationResolution<Snapshot>, { transport: "attached" }>

export interface ContinuationPlanner<Snapshot = unknown> {
  resolve(path: string): Promise<ContinuationResolution<Snapshot>>
  /** Only the Mako owner, for viewing: no process probe and no read of the native record. */
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
    const owner = ref.archived ? undefined : await dependencies.resolveOwner?.(ref)
    if (owner?.kind === "attached") return { transport: "attached", provider: owner.provider, conversationId: owner.conversationId, snapshot: owner.snapshot, bindingId: owner.bindingId }
    if (owner?.kind === "unavailable") return { transport: "unavailable", reason: owner.reason }
    const live = dependencies.live(ref.harness)
    const running = dependencies.running(path)
    const assessment = !ref.archived && !ref.resumeUnavailable && live?.available && live.canResume && ref.liveResume !== false && !running
      ? await dependencies.assessResume?.(ref) : undefined
    if (assessment?.kind === "held") return { transport: "refused", reason: `This session is open in ${assessment.by}. Wait for it to finish before replying.` }
    if (assessment?.kind === "unavailable") return { transport: "unavailable", reason: assessment.reason }
    const currentRef = owner?.kind === "unowned" ? { ...ref, heldBy: undefined } : ref
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
    return result.transport === "attached"
      ? { transport: "attached", provider: result.provider, conversationId: result.conversationId }
      : result
  }
  const owner = async (path: string): Promise<AttachedResolution<Snapshot> | null> => {
    const ref = await dependencies.ref(path)
    if (!ref || ref.archived) return null
    const found = await dependencies.resolveOwner?.(ref)
    return found?.kind === "attached"
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
