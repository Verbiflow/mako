import { HANDLE_CODE_LENGTH, HANDLE_LENGTH, HANDLE_PREFIX_MIN, handleCode, threadCode } from "../contracts/thread-handles.js"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import type { ThreadStore } from "./store.js"

/** What a typed handle finds among the person's Threads: one, several that share what was typed, or none. */
export type HandleFound =
  | { kind: "found"; thread: string }
  /** The first of them, each with the fewest characters of its code that name it alone, and how many more there are. */
  | { kind: "ambiguous"; threads: { thread: string; length: number }[]; more: number }
  | { kind: "unknown" }

/** The Threads an ambiguous handle names in its answer; the rest are counted. */
const NAMED_MAX = 5

interface Coded {
  code: string
  thread: string
}

/**
 * Every Thread by its code (`threadCode`), for finding one by its handle: the one resolver, which the Thread store
 * keeps (`ThreadStore.handles`). Codes are filed under their first `HANDLE_PREFIX_MIN` characters, the fewest a
 * lookup takes, so one reads the handful of Threads that start as it does, never every Thread: 5,300 Threads lie in
 * 29,791 places. A Thread's code never changes and a Thread is never deleted, so the index only grows: the store adds
 * the Threads made since it last looked (`add`), each hashed once.
 */
export class ThreadHandles {
  readonly #byStart = new Map<string, Coded[]>()
  readonly #codes = new Map<string, string>()

  get size(): number {
    return this.#codes.size
  }

  add(threads: Iterable<string>): void {
    for (const thread of threads) {
      if (this.#codes.has(thread)) continue
      const code = threadCode(thread)
      this.#codes.set(thread, code)
      const start = code.slice(0, HANDLE_PREFIX_MIN)
      const filed = this.#byStart.get(start)
      if (filed) filed.push({ code, thread })
      else this.#byStart.set(start, [{ code, thread }])
    }
  }

  /**
   * The Thread `typed` names, or undefined when it isn't a handle (`handleCode`). `current` says which Thread an ID
   * is now, since one merged into another keeps its own code and is found as the Thread it became; undefined drops it.
   */
  find(typed: string, current: (thread: string) => string | undefined): HandleFound | undefined {
    const code = handleCode(typed)
    if (code === undefined) return undefined
    const found = new Set<string>()
    for (const filed of this.#byStart.get(code.slice(0, HANDLE_PREFIX_MIN)) ?? []) {
      const thread = filed.code.startsWith(code) ? current(filed.thread) : undefined
      if (thread !== undefined) found.add(thread)
    }
    const [first, ...rest] = found
    if (first === undefined) return { kind: "unknown" }
    if (!rest.length) return { kind: "found", thread: first }
    const named = [...found].slice(0, NAMED_MAX)
    return { kind: "ambiguous", threads: named.map((thread) => ({ thread, length: this.length(thread, current) })), more: found.size - named.length }
  }

  /**
   * The fewest characters of `thread`'s code that name it alone among the Threads indexed, `HANDLE_LENGTH` at least:
   * what a listing an agent addresses from writes, so the handle it copies finds one Thread.
   */
  length(thread: string, current: (thread: string) => string | undefined): number {
    const code = this.#codes.get(thread) ?? threadCode(thread)
    const own = current(thread) ?? thread
    let shared = 0
    for (const filed of this.#byStart.get(code.slice(0, HANDLE_PREFIX_MIN)) ?? []) {
      if (filed.thread === thread || current(filed.thread) === own) continue
      let same = HANDLE_PREFIX_MIN
      while (same < HANDLE_CODE_LENGTH && filed.code[same] === code[same]) same += 1
      shared = Math.max(shared, same)
    }
    return Math.min(HANDLE_CODE_LENGTH, Math.max(HANDLE_LENGTH, shared + 1))
  }
}

/**
 * The conversation a person's command names (`mako thread … --conversation`): its own ID as ever, or the newest
 * conversation here of the Thread a handle or a Thread's ID names. Words that name none go back as they came, for the
 * command to refuse as it does an unknown conversation; a handle several Threads share is refused with each one's code.
 */
export function conversationNamed(store: Pick<ThreadStore, "journalPlacement" | "thread" | "conversationsOf" | "threadByHandle">, named: string): { conversation: string } | { why: string } {
  if (store.journalPlacement(named)) return { conversation: named }
  const found = store.threadByHandle(named)
  if (found?.kind === "ambiguous") {
    const codes = found.threads.map(({ thread, length }) => threadCode(thread).slice(0, length))
    return { why: `${found.threads.length + found.more} Threads share the handle ${named.trim()}: ${codes.join(", ")}${found.more ? ` and ${found.more} more` : ""}. Name one with more of its characters.` }
  }
  const id = ThreadIdSchema.safeParse(found?.kind === "found" ? found.thread : named)
  const thread = id.success ? store.thread(id.data) : undefined
  if (!thread) return { conversation: named }
  const conversation = thread.sessions.flatMap((session) => store.conversationsOf(session).slice(-1)).at(-1)
  return conversation ? { conversation } : { why: "That Thread has no conversation on this device." }
}
