import { createHash } from "node:crypto"
import { z } from "zod"
import { hostWarn } from "../base/host-log.js"

/** A call about one thing names it first, and a read says its kind second. */
const NamedCall = z.tuple([z.string()]).rest(z.unknown())
const ReadKind = z.object({ kind: z.string() })

/** What a call is about: the conversation or other thing its first argument names, and for a history read its kind. */
function subject(channel: string, args: readonly unknown[]): string | undefined {
  const named = NamedCall.safeParse(args)
  if (!named.success) return undefined
  const [first, second] = named.data
  const kind = ReadKind.safeParse(second).data?.kind
  // A long read arrives in parts, one call each; reading them is one read.
  if (channel === "mako:live-read" && kind === "part") return undefined
  return kind ? `${first} ${kind}` : first
}

/**
 * A client making the same call, arguments and all, over and over: a window stuck rereading one conversation is named
 * here by client, method and subject, instead of showing only as its effects in other scopes' lines. Reading one page
 * after another is no repeat, since each names its own cursor. Said once a minute while it lasts.
 */
export class RepeatedCalls {
  readonly #calls = new Map<string, { count: number; since: number; said: number }>()
  readonly #window: number
  readonly #limit: number

  constructor(options: { windowMs?: number; limit?: number } = {}) {
    this.#window = options.windowMs ?? 10_000
    this.#limit = options.limit ?? 40
  }

  note(client: string, channel: string, args: readonly unknown[], correlationId?: string, now = Date.now()): void {
    const about = subject(channel, args)
    if (about === undefined) return
    const key = `${client}\n${channel}\n${createHash("sha1").update(JSON.stringify(args)).digest("base64")}`
    const held = this.#calls.get(key)
    const calls = held && now - held.since <= this.#window ? held : { count: 0, since: now, said: held?.said ?? -Infinity }
    calls.count++
    this.#calls.delete(key)
    this.#calls.set(key, calls)
    if (calls.count === this.#limit && now - calls.said >= 60_000) {
      calls.said = now
      hostWarn("rpc", "a client keeps making the same call", {
        client, channel, subject: about, calls: calls.count, seconds: Math.max(1, Math.round((now - calls.since) / 1000)),
        ...correlationId && { correlationId },
      })
    }
    if (this.#calls.size > 512) for (const [stale, entry] of this.#calls) {
      if (this.#calls.size <= 384) break
      if (now - entry.since > this.#window && now - entry.said >= 60_000) this.#calls.delete(stale)
    }
  }
}
