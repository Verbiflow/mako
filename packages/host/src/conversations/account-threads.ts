import type { ArchivedThread, ListedSession, SessionListings } from "@mako/protocol/thread-listing"
import type { WaitingMessage } from "@mako/protocol/waiting"
import type { ThreadListHeard } from "../usage/index.js"

/**
 * The account's Sessions as every device lists them, held in step with the account's stream: the list
 * `GET /v1/sessions` answered, then each change the stream says after it, in order, by its number. A change heard
 * before the list answered waits for it and applies only if it's newer; one heard twice, or older than the list,
 * changes nothing. So the list read and the stream can't disagree, whichever comes first. The cloud already held each
 * row to the one-owner rule; this keeps whatever it said last. Which devices are quiet is kept beside the rows, once
 * per device, as the cloud says it.
 */
export class AccountSessions {
  readonly #sessions = new Map<string, ListedSession>()
  /** Each Session's messages waiting for its owner, as the list and the stream said them last. */
  readonly #waiting = new Map<string, WaitingMessage[]>()
  /** Each quiet device, by ID: when the cloud last heard from it (`QuietDevice`). */
  readonly #quiet = new Map<string, string>()
  /** The account's archived cloud Threads, by cloud Thread: its own objects' word, never this Mac's. */
  readonly #archived = new Map<string, ArchivedThread>()
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

  /** A Session's messages waiting for its owner, oldest first; none when nothing waits. */
  waiting(session: string): readonly WaitingMessage[] {
    return this.#waiting.get(session) ?? []
  }

  /** When the cloud last heard from a quiet device; undefined for one it hears. */
  quietSince(deviceId: string): string | undefined {
    return this.#quiet.get(deviceId)
  }

  /** Every Session with messages waiting, and them. */
  allWaiting(): ReadonlyMap<string, readonly WaitingMessage[]> {
    return this.#waiting
  }

  /** The account's archived cloud Threads, by cloud Thread, as the list and the stream said them last. */
  archived(): ReadonlyMap<string, ArchivedThread> {
    return this.#archived
  }

  /** The whole list, as read: replaces what was held, then applies what the stream said after it. Whether anything changed. */
  listed(listings: SessionListings): boolean {
    const before = this.#snapshot()
    this.#sessions.clear()
    for (const session of listings.sessions) this.#sessions.set(session.session, session)
    this.#waiting.clear()
    for (const message of listings.waiting ?? []) this.#waiting.set(message.session, [...(this.#waiting.get(message.session) ?? []), message])
    this.#quiet.clear()
    for (const { deviceId, since } of listings.quiet ?? []) this.#quiet.set(deviceId, since)
    this.#archived.clear()
    for (const archived of listings.archived ?? []) this.#archived.set(archived.thread, archived)
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
    this.#waiting.clear()
    this.#quiet.clear()
    this.#archived.clear()
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
    if (event.type === "messages-waiting") {
      if (event.messages.length) this.#waiting.set(event.session, event.messages)
      else this.#waiting.delete(event.session)
      return true
    }
    if (event.type === "device-quiet") {
      if (event.since === null) return this.#quiet.delete(event.deviceId)
      const changed = this.#quiet.get(event.deviceId) !== event.since
      this.#quiet.set(event.deviceId, event.since)
      return changed
    }
    if (event.type === "thread-archived") {
      this.#archived.set(event.thread.thread, event.thread)
      return true
    }
    if (event.type === "thread-unarchived") return this.#archived.delete(event.thread)
    let changed = false
    for (const session of event.sessions) changed = this.#sessions.delete(session) || changed
    return changed
  }

  #snapshot(): string {
    const waiting = [...this.#waiting].sort(([left], [right]) => (left < right ? -1 : 1))
    const quiet = [...this.#quiet].sort(([left], [right]) => (left < right ? -1 : 1))
    const archived = [...this.#archived.keys()].sort()
    return JSON.stringify([[...this.#sessions.values()].sort((left, right) => (left.session < right.session ? -1 : 1)), waiting, quiet, archived])
  }
}
