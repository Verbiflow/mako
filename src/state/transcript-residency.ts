import type { Exchange } from "@/lib/exchanges"
import { promptLabel } from "@/lib/exchanges"
import type { Entry } from "@mako/sessions/entries"


/** Coordinates survive releasing a body. Placeholders are display metadata,
 * never provider input, fork evidence, or a replacement for persisted history. */
export interface ReleasedTurn {
  id: string
  label: string
  blocks: { start: number; end: number }
  base: { start: number; end: number }
}

export function releasedExchanges(exchanges: Exchange[], released: readonly ReleasedTurn[] = []): Exchange[] {
  if (!released.length) return exchanges
  const byId = new Map(released.map(turn => [turn.id, turn]))
  return exchanges.map(exchange => {
    const turn = byId.get(exchange.id)
    return turn ? { ...exchange, response: [], system: [], unloaded: turn.label } : exchange
  })
}

/** Complete turns only. The leading partial answer and the newest turn can
 * cross the loaded/source boundary; neither is a disposable page. */
export function historyTurns(exchanges: readonly Exchange[], blocks: readonly Entry[], blockStart: number,
  base: readonly Entry[], baseStart: number): ReleasedTurn[] {
  const byRequest = new Map<string, number>()
  for (const [index, block] of blocks.entries())
    if (block.type === "user" && block.requestId && !block.steeringFor) byRequest.set(block.requestId, blockStart + index)
  const at = (exchange: Exchange): { kind: "base" | "live"; index: number } | undefined => {
    const opening = exchange.prompt ?? exchange.opener
    if (!opening) return undefined
    if (opening.anchor) return { kind: "base", index: opening.anchor.index }
    const request = opening.requestId && byRequest.get(opening.requestId)
    if (request !== undefined && request !== "") return { kind: "live", index: request }
    const index = /^acp-(?:user|turn)-(\d+)$/.exec(opening.id)?.[1]
    return index ? { kind: "live", index: Number(index) } : undefined
  }
  const result: ReleasedTurn[] = []
  for (let index = 0; index < exchanges.length - 1; index++) {
    const exchange = exchanges[index]!
    if (exchange.unloaded !== undefined) continue
    const start = at(exchange), end = at(exchanges[index + 1]!)
    if (!start || !end || (start.kind === "live" && end.kind === "base")) continue
    result.push({ id: exchange.id, label: promptLabel(exchange).slice(0, 512),
      blocks: { start: start.kind === "live" ? start.index : blockStart,
        end: end.kind === "live" ? end.index : blockStart },
      base: { start: start.kind === "base" ? start.index : baseStart + base.length,
        end: end.kind === "base" ? end.index : baseStart + base.length } })
  }
  return result
}

/**
 * Keep only opener identity and a short navigator label. All body
 * references, including expanded tools, attachments, and projected
 * messages, can go. `side` says which of a turn's ranges `entries` are
 * in: the live blocks or the native base. Every entry keeps its id, which
 * an anchor or a detail read names it by.
 */
export function releaseEntries(entries: readonly Entry[], start: number, turns: readonly ReleasedTurn[], side: "blocks" | "base"): Entry[] {
  const ranges = turns.map(turn => ({ ...turn[side], label: turn.label })).filter(range => range.end > range.start).toSorted((a, b) => a.start - b.start)
  let at = 0
  return entries.map((entry, local) => {
    const index = start + local
    while (ranges[at] && index >= ranges[at]!.end) at++
    const range = ranges[at]
    if (!range || index < range.start) return entry
    const kept = { ...entry.id !== undefined && { id: entry.id }, ...entry.at !== undefined && { at: entry.at } }
    if (index === range.start && entry.type === "user")
      return { type: "user", ...kept, ...entry.requestId && { requestId: entry.requestId }, ...entry.provider && { provider: entry.provider }, text: range.label }
    if (index === range.start && entry.type === "provider-turn")
      return { type: "provider-turn", ...kept, reason: entry.reason, ...entry.cause && { cause: entry.cause } }
    return { type: "text", ...kept, text: "" }
  })
}
