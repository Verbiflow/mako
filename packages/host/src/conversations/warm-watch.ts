import type { HostJobs } from "../base/host-jobs.js"
import type { FinCapacity } from "./fin-capacity-host.js"
import type { LiveConversations } from "./live-conversations.js"
import type { Dependencies } from "./live-runtime.js"
import { WARM_FLOOR, warmLimit } from "./warm-limit.js"

/** The job that reads the machine's memory while idle providers past the floor stay warm. */
export const WARM_WATCH_JOB = "read memory for the warm providers"
/** How often it reads: the engine's own pace of looking at the machine while Fins work. */
export const WARM_LOOK_MS = 10_000
/** How soon after a provider past the floor comes to rest: the last reading may be from before the machine filled. */
export const WARM_FIRST_LOOK_MS = 1_000

export interface WarmWatchDeps {
  jobs: Pick<HostJobs, "every" | "demand">
  /** This machine's reading for the rule (`FinCapacity.warm`), its look at memory alone, and its word of pressure. */
  capacity: Pick<FinCapacity, "warm" | "look" | "subscribeMemoryPressure">
  /** The conversations, once they're made: they're given what this returns. */
  live(): Pick<LiveConversations, "warmProviders" | "memoryPressed"> | undefined
  now?(): number
}

/**
 * Sizes the warm providers from this machine's memory (`warmLimit`) and keeps them to it. The number is read at each
 * decision from what capacity last read. While more than the floor are warm, a job reads memory pressure every
 * `WARM_LOOK_MS`, since with no Fin at work nothing else looks at the machine; with the floor or fewer it holds no
 * timer. Every reading that finds memory short, the engine's or this job's, lets the excess go at once
 * (`LiveConversations.memoryPressed`). Returns what `LiveConversations` is made with.
 */
export function watchWarmProviders(deps: WarmWatchDeps): Required<Pick<Dependencies, "warmLimit" | "warmKept">> {
  const pastFloor = deps.jobs.demand("idle providers warm past the floor")
  deps.jobs.every(WARM_WATCH_JOB, WARM_LOOK_MS, async () => {
    await deps.capacity.look()
    pastFloor.set((deps.live()?.warmProviders() ?? 0) > WARM_FLOOR)
  }, { needs: [pastFloor], firstAfterMs: WARM_FIRST_LOOK_MS })
  deps.capacity.subscribeMemoryPressure(() => deps.live()?.memoryPressed())
  return {
    warmLimit: () => warmLimit(deps.capacity.warm(), deps.now?.() ?? Date.now()),
    warmKept: (count) => pastFloor.set(count > WARM_FLOOR),
  }
}
