import type { ThreadEntry } from "@/lib/types"
import type { Exchange } from "@/lib/exchanges"
import { promptLabel } from "@/lib/exchanges"
import type { LiveBlock } from "@mako/sessions/live-content"

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
export function historyTurns(exchanges: readonly Exchange[], blocks: readonly LiveBlock[], blockStart: number,
  base: readonly ThreadEntry[], baseStart: number): ReleasedTurn[] {
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

const EMPTY_BLOCK: LiveBlock = { type: "text", text: "" }
/** Keep only opener identity and a short navigator label. All body references,
 * including expanded tools, attachments, and projected messages, can go. */
export function releaseBlocks(blocks: readonly LiveBlock[], start: number, turns: readonly ReleasedTurn[]): LiveBlock[] {
  const ranges = turns.filter(turn => turn.blocks.end > turn.blocks.start).toSorted((a, b) => a.blocks.start - b.blocks.start)
  let at = 0
  return blocks.map((block, local) => {
    const index = start + local
    while (ranges[at] && index >= ranges[at]!.blocks.end) at++
    const turn = ranges[at]
    if (!turn || index < turn.blocks.start) return block
    if (index === turn.blocks.start && block.type === "user")
      return { type: "user", requestId: block.requestId, provider: block.provider, text: turn.label }
    if (index === turn.blocks.start && block.type === "provider-turn") return block
    return EMPTY_BLOCK
  })
}

export function releaseEntries(entries: readonly ThreadEntry[], start: number, turns: readonly ReleasedTurn[]): ThreadEntry[] {
  const ranges = turns.filter(turn => turn.base.end > turn.base.start).toSorted((a, b) => a.base.start - b.base.start)
  let at = 0
  return entries.map((entry, local) => {
    const index = start + local
    while (ranges[at] && index >= ranges[at]!.base.end) at++
    const turn = ranges[at]
    if (!turn || index < turn.base.start) return entry
    if (index === turn.base.start && entry.kind === "user")
      return { kind: "user", id: entry.id, at: entry.at, text: turn.label }
    if (index === turn.base.start && entry.kind === "event" && entry.opensTurn)
      return { kind: "event", id: entry.id, at: entry.at, label: turn.label, opensTurn: true }
    return { kind: "assistant", id: entry.id, at: entry.at, blocks: [] }
  })
}
