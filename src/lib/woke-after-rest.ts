import { ASLEEP_AFTER_MS } from "@mako/host/contracts/session-choice"
import { isContinuation, type Exchange } from "@/lib/exchanges"
import type { ChatMessage } from "@/lib/types"

/** A person's message that reached a session after it rested: for how long, when its turn before ended, whose it was. */
export interface WokeAfterRest {
  restedMs: number
  lastAt: number
  harness?: string
}

/**
 * Each exchange whose prompt, the person's, came a day or more (`ASLEEP_AFTER_MS`) after the turn before it last
 * moved, by its ID. Read from the transcript's own times, so a session reloaded or opened on another device says the
 * same. A live prompt's time is its request's (`askedAt`): its blocks don't carry one. A released turn's times aren't
 * held: what follows one isn't judged.
 */
export function wokeAfterRest(exchanges: readonly Exchange[], askedAt?: ReadonlyMap<string, number>): ReadonlyMap<string, WokeAfterRest> {
  const timeOf = (message: ChatMessage | undefined) => message?.timestamp ?? (message?.requestId ? askedAt?.get(message.requestId) : undefined)
  const woke = new Map<string, WokeAfterRest>()
  for (let index = 1; index < exchanges.length; index += 1) {
    const before = exchanges[index - 1]!
    const { prompt } = exchanges[index]!
    const at = timeOf(prompt)
    if (before.unloaded !== undefined || !prompt || !at || isContinuation(prompt)) continue
    const lastAt = before.response.findLast((message) => message.timestamp)?.timestamp ?? timeOf(before.prompt ?? before.opener)
    if (!lastAt || at - lastAt < ASLEEP_AFTER_MS) continue
    const harness = before.response.findLast((message) => message.provider)?.provider
    woke.set(exchanges[index]!.id, { restedMs: at - lastAt, lastAt, ...(harness && { harness }) })
  }
  return woke
}
