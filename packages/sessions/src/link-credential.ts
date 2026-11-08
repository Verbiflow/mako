import type { RecordsLink } from "./record-sync.js"

/** How long a call waits for the host to answer a link it asked to renew; past it the call goes with what it holds. */
export const LINK_RENEWED_WITHIN_MS = 10_000

/**
 * A records link as the catalog's process holds it, renewed in place. Its token is the host's, which only the host
 * can renew: a call asks for its header here (`authorization`), and a link due by the `renewAt` the host measured
 * (`renewAtMs`) is asked of the host again (`ask`, which the daemon says as a `link-due` event) and waited for. A call
 * the gateway refused with a 401 asks once more (`renew`) and goes again with what comes. Before, the daemon pushed
 * with whatever token the host last gave it: a host too busy to send the next one left six Fins' Sessions "not synced"
 * on "The connection token has expired".
 */
export class LinkCredential {
  #current: RecordsLink
  readonly #ask: (() => void) | undefined
  readonly #now: () => number
  /** Calls waiting for a renewed link, and when the ask they wait on was made. */
  #waiting: { since: number; done: Promise<void>; resolve: () => void } | undefined

  constructor(link: RecordsLink, ask?: () => void, now: () => number = Date.now) {
    this.#current = link
    this.#ask = ask
    this.#now = now
  }

  get current(): RecordsLink {
    return this.#current
  }

  /** The host's link, renewed or not: a new token answers whoever waits for one. */
  set current(link: RecordsLink) {
    const renewed = link.authorization !== this.#current.authorization
    this.#current = link
    if (renewed) this.#answered()
  }

  /** The header a call carries: the link's own, once a renewal it's due for has come or been waited out. */
  async authorization(): Promise<string> {
    const { renewAt } = this.#current
    if (renewAt !== undefined && renewAt <= this.#now()) await this.#renewal()
    return this.#current.authorization
  }

  /** The gateway refused the link's token: asks the host for another and waits for it. */
  async renew(): Promise<void> {
    await this.#renewal()
  }

  #renewal(): Promise<void> {
    if (!this.#ask) return Promise.resolve()
    const now = this.#now()
    if (this.#waiting && now - this.#waiting.since < LINK_RENEWED_WITHIN_MS) return this.#waiting.done
    let resolve = () => {}
    const done = new Promise<void>((settle) => (resolve = settle))
    const timer = setTimeout(() => this.#answered(), LINK_RENEWED_WITHIN_MS)
    timer.unref?.()
    this.#waiting = { since: now, done, resolve: () => {
      clearTimeout(timer)
      resolve()
    } }
    this.#ask()
    return done
  }

  #answered(): void {
    const waiting = this.#waiting
    this.#waiting = undefined
    waiting?.resolve()
  }
}
