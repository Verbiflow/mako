import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "./contracts/host-events-boot.js"
import {
  planContinuation,
  type ContinuationPlan,
} from "./contracts/thread-continuation.js"

/**
 * The host's side of the continuation plan: gathers what the plan needs and
 * holds the two entry points to it. The renderer asks `plan`; `live-start`
 * with a resume id and `native-submit` each assert that the plan agrees, so
 * a request built from stale renderer state fails with the reason instead of
 * running on another transport.
 */
export interface ContinuationDependencies {
  ref(path: string): Promise<ThreadRef | undefined>
  attached?(ref: ThreadRef): Promise<string | null>
  live(provider: string): { available: boolean; canResume: boolean } | null
  nativeInstalled(provider: string): boolean
  running(path: string): boolean
  external(path: string): ExternalThreadActivity["status"] | null
}

export interface ContinuationPlanner {
  plan(path: string): Promise<ContinuationPlan>
  /** Throws unless the plan reopens `path` live on `provider` as `nativeId`. */
  assertLive(path: string, provider: string, nativeId: string): Promise<void>
  /** Throws unless the plan runs `path` through its own CLI. */
  assertNative(path: string): Promise<void>
}

export function createContinuationPlanner(
  dependencies: ContinuationDependencies
): ContinuationPlanner {
  const plan = async (path: string): Promise<ContinuationPlan> => {
    const ref = await dependencies.ref(path)
    if (!ref)
      return {
        transport: "refused",
        reason: "This session is no longer in the catalog.",
      }
    return planContinuation(ref, {
      attached: ref.archived ? null : await dependencies.attached?.(ref),
      live: dependencies.live(ref.harness),
      nativeInstalled: dependencies.nativeInstalled(ref.harness),
      running: dependencies.running(path),
      external: dependencies.external(path),
    })
  }
  return {
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
