import type { ListedSession, SessionListings } from "@mako/protocol/thread-listing"
import type { ThreadListHeard } from "../usage/index.js"

/**
 * The account's Sessions as every device lists them, held in step with the account's stream: the list
 * `GET /v1/sessions` answered, then each change the stream says after it, in order, by its number. A change heard
 * before the list answered waits for it and applies only if it's newer; one heard twice, or older than the list,
 * changes nothing. So the list read and the stream can't disagree, whichever comes first. The cloud already held each
 * row to the one-owner rule; this keeps whatever it said last.
 */
export class AccountSessions {
  readonly #sessions = new Map<string, ListedSession>()
  /** The stream's number the list stands at; undefined until it's been read. */
  #seq: number | undefined
  readonly #early: ThreadListHeard[] = []

  /** Whether the list has been read: until then a change heard only waits. */
  get known(): boolean {
    return this.#seq !== undefined
  }

  /** Every listed Session, as the list now stands. */
  sessions(): ReadonlyMap<string, ListedSession> {
    return this.#sessions
  }

  /** The whole list, as read: replaces what was held, then applies what the stream said after it. Whether anything changed. */
  listed(listings: SessionListings): boolean {
    const before = this.#snapshot()
    this.#sessions.clear()
    for (const session of listings.sessions) this.#sessions.set(session.session, session)
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
    this.#sessions.clear()
    this.#seq = undefined
    this.#early.length = 0
  }

  #apply({ seq, event }: ThreadListHeard): boolean {
    if (this.#seq === undefined || seq <= this.#seq) return false
    this.#seq = seq
    if (event.type === "sessions-listed") {
      for (const session of event.sessions) this.#sessions.set(session.session, session)
      return true
    }
    let changed = false
    for (const session of event.sessions) changed = this.#sessions.delete(session) || changed
    return changed
  }

  #snapshot(): string {
    return JSON.stringify([...this.#sessions.values()].sort((left, right) => (left.session < right.session ? -1 : 1)))
  }
}
