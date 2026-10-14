import { LEAD_EXCHANGE_ID, type Exchange as ExchangeData } from "@/lib/exchanges"
import { threadToMessages } from "@/lib/foreign-thread"
import type { ViewedThread } from "@/state/thread-state"

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
 * the same input are idempotent, while an append converts only the new suffix
 * and a streamed replacement rebuilds only the exchange containing the edit.
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

    let next = built.exchanges
    const entryToExchange = [...built.entryToExchange]
    for (
      let entryIndex = built.count;
      entryIndex < entries.length;
      entryIndex += 1
    ) {
      const fresh = threadToMessages(
        [entries[entryIndex]!],
        thread.pageStart + entryIndex,
        thread.ref.harness
      )
      for (const message of fresh) {
        if (message.role === "user") {
          next = [
            ...next,
            {
              id: message.id,
              prompt: message,
              response: [],
              system: [],
              timestamp: message.timestamp,
            },
          ]
          continue
        }

        // A turn the provider started itself opens its own exchange, as
        // `toExchanges` draws it; under a prompt nothing has answered yet,
        // it was delivered with that prompt and stays under it.
        if (message.role === "system" && message.opensTurn) {
          const previous = next.at(-1)
          next =
            previous && previous.id !== LEAD_EXCHANGE_ID && previous.response.length === 0
              ? [...next.slice(0, -1), { ...previous, system: [...previous.system, { message, after: 0 }] }]
              : [...next, { id: message.id, opener: message, response: [], system: [], timestamp: message.timestamp }]
          continue
        }

        const last = next.at(-1)
        if (!last) {
          next = [
            message.role === "system"
              ? {
                  id: LEAD_EXCHANGE_ID,
                  response: [],
                  system: [{ message, after: 0 }],
                  timestamp: message.timestamp,
                }
              : {
                  id: LEAD_EXCHANGE_ID,
                  response: [message],
                  system: [],
                  timestamp: message.timestamp,
                },
          ]
          continue
        }

        const grown =
          message.role === "system"
            ? {
                ...last,
                system: [
                  ...last.system,
                  { message, after: last.response.length },
                ],
              }
            : { ...last, response: [...last.response, message] }
        next = [...next.slice(0, -1), grown]
      }
      entryToExchange[entryIndex] = Math.max(0, next.length - 1)
    }

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
