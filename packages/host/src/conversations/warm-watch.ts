import type { HostJobs } from "../base/host-jobs.js"
import type { FinCapacity } from "./fin-capacity-host.js"
import type { LiveConversations } from "./live-conversations.js"
import type { Dependencies } from "./live-runtime.js"
import { WARM_FLOOR, warmLimit } from "./warm-limit.js"
import { CREDENTIAL_REFRESH_MS, type HarnessAccounts } from "../harnesses/index.js"

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

/** The job that takes warm conversations' held account reads again. */
export const ACCOUNT_WATCH_JOB = "keep warm conversations' account readings fresh"

export interface AccountWatchDeps {
  jobs: Pick<HostJobs, "every" | "demand">
  accounts: Pick<HarnessAccounts, "refreshCredentials">
  /** The conversations, once they're made. */
  live(): Pick<LiveConversations, "warmHarnesses"> | undefined
}

/**
 * Keeps what a message's admission reads of its account standing while a provider is warm. A warm conversation's next
 * message is admitted against its launch account's credential revision, and on Claude part of that is a Keychain read
 * that costs a process (`CredentialRevisions`): held a few seconds, it had lapsed by most sends, and the send waited
 * for it. While any provider rests warm, a job has those held reads checked every `CREDENTIAL_REFRESH_MS` against
 * their store's own stamp, which reads no secret and so asks the person for nothing, and a read its store vouches
 * for stands on. The admission itself is unchanged: it still reads the selection and the revision as the message
 * goes, takes only a read that stood inside the hold, and refuses a changed selection or sign-in before anything
 * reaches the harness. With no provider warm, or nothing held that can be checked, the job holds no timer. Returns
 * what `LiveConversations` is made with.
 */
export function keepAccountsFresh(deps: AccountWatchDeps): Required<Pick<Dependencies, "cameToRest">> {
  const warm = deps.jobs.demand("a provider whose account reading is held rests warm")
  deps.jobs.every(ACCOUNT_WATCH_JOB, CREDENTIAL_REFRESH_MS, () => {
    const harnesses = deps.live()?.warmHarnesses() ?? new Set<string>()
    warm.set(harnesses.size > 0 && deps.accounts.refreshCredentials(harnesses) > 0)
  }, { needs: [warm], firstAfterMs: 0 })
  return { cameToRest: () => warm.set(true) }
}
