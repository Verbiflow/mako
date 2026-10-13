import { sameUsageLimit, type UsageLimit } from "@mako/sessions/events"
import type { ChatMessage } from "@/lib/types"
import type { Exchange, ExchangeNote } from "@/lib/exchanges"

/**
 * One usage limit said once. When an account's limit refuses work, every
 * background agent it stopped reports back, and the provider starts a turn
 * on each report that the same limit refuses again: a Claude Code
 * orchestrator with eight agents drew sixteen rows for one fact. The line
 * that first reported the limit stays; each later report of the same limit
 * goes, and so does each turn the provider started on its own that the limit
 * refused, whether it is an exchange of its own or a cause stacked into one.
 * What went is kept under the line (`Exchange.refused`).
 *
 * The limit is said again after anything else happens: a prompt, an answer,
 * another kind of marker, or a different limit (`sameUsageLimit`).
 */
export function foldUsageLimits(exchanges: Exchange[]): Exchange[] {
  if (!saysLimit(exchanges)) return exchanges
  const out: Exchange[] = []
  const refusedAt = new Map<number, Record<string, ChatMessage[]>>()
  let changed = false
  let said: Said | undefined
  const refuse = (opener: ChatMessage) => {
    const into = said!
    const byNote = refusedAt.get(into.at) ?? {}
    const list = (byNote[into.note.id] ??= into.header ? [into.header] : [])
    list.push(opener)
    refusedAt.set(into.at, byNote)
    changed = true
  }

  for (const exchange of exchanges) {
    const at = out.length
    if (exchange.prompt) said = undefined
    else if (said) said = { ...said, after: 0 }
    // The provider's own turn, while a limit stands: refused if that limit is the first thing in it.
    let header = said && exchange.opener ? exchange.opener : undefined
    let headerRefused = false
    let pending: ExchangeNote | undefined
    const kept: ExchangeNote[] = []
    const settle = () => {
      if (pending) kept.push(pending)
      pending = undefined
      header = undefined
    }
    for (const note of exchange.system) {
      const { message } = note
      const limit = message.note?.limit
      if (said && note.after > said.after) {
        settle()
        said = undefined
      }
      if (said && limit && sameUsageLimit(said.limit, limit)) {
        changed = true
        if (pending) refuse(pending.message)
        else if (header) {
          refuse(header)
          headerRefused = true
        }
        pending = undefined
        header = undefined
        continue
      }
      if (said && message.opensTurn) {
        settle()
        pending = note
        continue
      }
      const opening = kept.length === 0 && !pending && note.after === 0 && !exchange.prompt ? exchange.opener : undefined
      settle()
      kept.push(note)
      if (limit) said = { at, note: message, limit, after: note.after, header: opening }
      else if (message.note) said = undefined
    }
    if (header && said && exchange.response.length === 0 && stoppedBy(header, said.limit)) {
      refuse(header)
      headerRefused = true
    }
    settle()
    if (said && said.after < exchange.response.length) said = undefined
    // Nothing of a refused turn is left to draw: it is only what its limit's line keeps.
    if (headerRefused && kept.length === 0 && exchange.response.length === 0) continue
    out.push(kept.length === exchange.system.length ? exchange : { ...exchange, system: kept })
  }
  if (!changed) return exchanges
  return out.map((exchange, index) => {
    const refused = refusedAt.get(index)
    return refused ? { ...exchange, refused } : exchange
  })
}

/** Whether any note reports a limit; projections run on every update, and almost none do. */
function saysLimit(exchanges: readonly Exchange[]): boolean {
  for (const exchange of exchanges)
    for (const note of exchange.system) if (note.message.note?.limit) return true
  return false
}

/** The line a limit was last said on, while nothing else has happened since. */
interface Said {
  /** Its exchange's index in the folded list. */
  at: number
  note: ChatMessage
  limit: UsageLimit
  /** The response messages before it in its exchange; any answer after them ends the limit's run. */
  after: number
  /** The provider's own turn the line opened, which counts among what the limit refused once anything else does. */
  header: ChatMessage | undefined
}

/** An agent that `limit` ended, by what it reported. */
function stoppedBy(opener: ChatMessage, limit: UsageLimit): boolean {
  const cause = opener.note?.cause
  return cause?.kind === "agent" && cause.limit !== undefined && sameUsageLimit(cause.limit, limit)
}
