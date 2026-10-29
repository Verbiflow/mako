import { isContinuation, LEAD_EXCHANGE_ID, type Exchange as ExchangeData } from "@/lib/exchanges"
import { entriesToMessages } from "@/lib/entry-messages"
import type { ViewedThread } from "@/state/thread-state"
import type { ChatMessage } from "@/lib/types"

interface ExchangeCache {
  path: string | null
  revision: number
  count: number
  exchanges: ExchangeData[]
  entryToExchange: number[]
}

function emptyExchangeCache(
  path: string | null = null,
  revision = 0
): ExchangeCache {
  return {
    path,
    revision,
    count: 0,
    exchanges: [],
    entryToExchange: [],
  }
}

/**
 * One conversation's incremental exchange builder.
 *
 * The closure is owned by a single Conversation instance. Repeated calls with
 * the same input are idempotent, while an append converts again from the
 * last exchange's first entry, where a new entry can join the reply it
 * continues, and a streamed replacement rebuilds only the exchange
 * containing the edit.
 */
export function createExchangeBuilder() {
  let built = emptyExchangeCache()

  return (thread: ViewedThread | null): ExchangeData[] => {
    if (!thread) {
      built = emptyExchangeCache()
      return built.exchanges
    }

    const { entries } = thread
    const revision = thread.streamRevision ?? 0
    if (built.path !== thread.ref.path || entries.length < built.count) {
      built = emptyExchangeCache(thread.ref.path, revision)
    } else if (built.revision !== revision) {
      const replaceFrom = thread.streamReplaceFrom ?? 0
      const exchangeIndex = built.entryToExchange[replaceFrom] ?? 0
      let entryStart = replaceFrom
      while (
        entryStart > 0 &&
        built.entryToExchange[entryStart - 1] === exchangeIndex
      ) {
        entryStart -= 1
      }
      built = {
        path: thread.ref.path,
        revision,
        count: entryStart,
        exchanges: built.exchanges.slice(0, exchangeIndex),
        entryToExchange: built.entryToExchange.slice(0, entryStart),
      }
    }

    if (entries.length === built.count) return built.exchanges

    const lastExchange = built.exchanges.length - 1
    let from = built.count
    while (from > 0 && built.entryToExchange[from - 1] === lastExchange) from -= 1
    const next = from < built.count ? built.exchanges.slice(0, lastExchange) : [...built.exchanges]
    const entryToExchange = built.entryToExchange.slice(0, from)
    const { messages, starts } = entriesToMessages(entries.slice(from), {
      kind: "saved",
      start: thread.pageStart + from,
      provider: thread.ref.harness,
      path: thread.ref.path,
    })
    messages.forEach((message, index) => {
      draw(next, message)
      const end = index + 1 < messages.length ? starts[index + 1]! - thread.pageStart : entries.length
      for (let entry = starts[index]! - thread.pageStart; entry < end; entry += 1) entryToExchange[entry] = Math.max(0, next.length - 1)
    })

    built = {
      path: thread.ref.path,
      revision,
      count: entries.length,
      exchanges: next,
      entryToExchange,
    }
    return next
  }
}

/** Draw `message` into `exchanges`, as `toExchanges` draws it; an exchange it joins is replaced, not changed. */
function draw(exchanges: ExchangeData[], message: ChatMessage): void {
  const last = exchanges.at(-1)
  // Mako's words picking up a turn cut short go on in the turn on screen, as one turn (`isContinuation`).
  if (message.role === "user" && isContinuation(message)) {
    if (last) exchanges[exchanges.length - 1] = { ...last, response: [...last.response, message] }
    else exchanges.push({ id: LEAD_EXCHANGE_ID, response: [message], system: [], timestamp: message.timestamp })
    return
  }
  if (message.role === "user") {
    exchanges.push({ id: message.id, prompt: message, response: [], system: [], timestamp: message.timestamp })
    return
  }
  // A turn the provider started itself opens its own exchange; under a
  // prompt nothing has answered yet, it was delivered with that prompt and
  // stays under it.
  if (message.role === "system" && message.opensTurn) {
    if (last && last.id !== LEAD_EXCHANGE_ID && last.response.length === 0)
      exchanges[exchanges.length - 1] = { ...last, system: [...last.system, { message, after: 0 }] }
    else exchanges.push({ id: message.id, opener: message, response: [], system: [], timestamp: message.timestamp })
    return
  }
  if (!last) {
    exchanges.push(message.role === "system"
      ? { id: LEAD_EXCHANGE_ID, response: [], system: [{ message, after: 0 }], timestamp: message.timestamp }
      : { id: LEAD_EXCHANGE_ID, response: [message], system: [], timestamp: message.timestamp })
    return
  }
  exchanges[exchanges.length - 1] = message.role === "system"
    ? { ...last, system: [...last.system, { message, after: last.response.length }] }
    : { ...last, response: [...last.response, message] }
}
