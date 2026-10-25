import type { ThreadListing, ThreadListings } from "@mako/protocol/thread-listing"
import type { ThreadListHeard } from "../usage/index.js"

/**
 * The account's Threads as every device lists them, held in step with the account's stream: the list `GET /v1/threads`
 * answered, then each change the stream says after it, in order, by its number. A change heard before the list
 * answered waits for it and applies only if it's newer; one heard twice, or older than the list, changes nothing.
 * So the list read and the stream can't disagree, whichever comes first.
 */
export class AccountThreads {
  readonly #threads = new Map<string, ThreadListing>()
  /** The stream's number the list stands at; undefined until it's been read. */
  #seq: number | undefined
  readonly #early: ThreadListHeard[] = []

  /** Whether the list has been read: until then a change heard only waits. */
  get known(): boolean {
    return this.#seq !== undefined
  }

  /** Every listed Thread, as the list now stands. */
  threads(): ReadonlyMap<string, ThreadListing> {
    return this.#threads
  }

  /** The whole list, as read: replaces what was held, then applies what the stream said after it. Whether anything changed. */
  listed(listings: ThreadListings): boolean {
    const before = this.#snapshot()
    this.#threads.clear()
    for (const thread of listings.threads) this.#threads.set(thread.threadId, thread)
    this.#seq = listings.seq
    const early = this.#early.splice(0).sort((left, right) => left.seq - right.seq)
    for (const heard of early) this.#apply(heard)
    return before !== this.#snapshot()
  }

  /** One change the stream said: whether it changed the list. */
  heard(heard: ThreadListHeard): boolean {
    if (this.#seq === undefined) {
      this.#early.push(heard)
      return false
    }
    return this.#apply(heard)
  }

  /** Forgets the list: signed out, or another account. */
  clear(): void {
    this.#threads.clear()
    this.#seq = undefined
    this.#early.length = 0
  }

  #apply({ seq, event }: ThreadListHeard): boolean {
    if (this.#seq === undefined || seq <= this.#seq) return false
    this.#seq = seq
    if (event.type === "thread-listed") {
      this.#threads.set(event.thread.threadId, event.thread)
      return true
    }
    return this.#threads.delete(event.threadId)
  }

  #snapshot(): string {
    return JSON.stringify([...this.#threads.values()].sort((left, right) => (left.threadId < right.threadId ? -1 : 1)))
  }
}
