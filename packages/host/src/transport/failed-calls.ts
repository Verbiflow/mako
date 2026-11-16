import { hostWarn } from "../base/host-log.js"
import { errorMessage, type FailureBoundary } from "../contracts/error-message.js"

/** How long the same failure of the same channel is folded into one line, its repeats counted. */
export const FAILED_CALL_FOLD_MS = 60_000

/** What a failed call is said with in the host's log: what kind of error it threw, and its first line. */
export interface FailedCallWords {
  error: string
  reason: string
}

/** The kind and first line of what a call threw, as the host's log keeps them. */
export function failedCallWords(failure: FailureBoundary): FailedCallWords {
  const first = errorMessage(failure).split("\n", 1)[0] ?? ""
  return { error: failure.error instanceof Error ? failure.error.name : "thrown", reason: first.length > 300 ? `${first.slice(0, 299)}…` : first }
}

/**
 * What the host answered a call with when it failed, kept in the host's log: the words a window shows (or hides) are
 * the host's, and until now nothing counted them. The same failure of the same channel is said once a minute at most,
 * with how many times it came meanwhile, so a window retrying a broken read doesn't fill the log.
 */
export class FailedCalls {
  readonly #seen = new Map<string, { at: number; repeats: number }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  note(channel: string, failure: FailureBoundary): void {
    const words = failedCallWords(failure)
    const key = `${channel}\0${words.reason}`
    const now = this.#now()
    const seen = this.#seen.get(key)
    if (seen && now - seen.at < FAILED_CALL_FOLD_MS) {
      seen.repeats += 1
      return
    }
    // Bounded: a host up for weeks meets a few hundred distinct failures at most.
    if (this.#seen.size > 500) this.#seen.clear()
    this.#seen.set(key, { at: now, repeats: 0 })
    hostWarn("methods", "a call failed", { channel, ...words, ...(seen?.repeats && { repeats: seen.repeats }) })
  }
}
