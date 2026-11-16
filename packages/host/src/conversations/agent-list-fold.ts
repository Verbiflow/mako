import { FIN_WORD } from "../contracts/agents.js"
import { LIST_BUDGET_CHARS, LIST_ENDED_FOR_MS, type AgentStrip, type AgentsListFolded } from "../contracts/agent-tools.js"

/** What the answer holds besides its rows: the tree's counts and the fold's note. */
const ENVELOPE_CHARS = 1024

/** The rows a list keeps, and what it folds. */
export interface ListFold {
  children: AgentStrip[]
  folded?: AgentsListFolded
}

type Rank = "attention" | "idle" | "ended"

/** Where a listed Fin stands for its Apex: something to act on or at work, idle, or ended with nothing open. */
function rankOf(strip: AgentStrip): Rank {
  const { state } = strip
  if (strip.pendingQuestions || strip.pendingActions || strip.custodyActions) return "attention"
  if (state.kind === "idle") return "idle"
  if (state.kind === "ended") return state.decision ? "attention" : "ended"
  return "attention"
}

/** When a Fin last moved: its quiet time when the list knows it, else its last report, else its start. */
function lastMoved(strip: AgentStrip, now: number): number {
  if (strip.idleFor !== undefined) return now - strip.idleFor * 1000
  return strip.report?.at ?? strip.startedAt
}

/**
 * The rows an Apex's list shows and what it folds (`AgentsListFolded`): a Fin that ended over `LIST_ENDED_FOR_MS` ago
 * with nothing open always folds; the rest are kept, those needing attention first, then idle, then ended, each newest
 * first, while the rows fit `budget` characters of JSON, so the whole answer fits `LIST_BUDGET_CHARS`. The rows kept stay in the list's order.
 */
export function foldList(strips: readonly AgentStrip[], now: number, budget = LIST_BUDGET_CHARS - ENVELOPE_CHARS): ListFold {
  const folded = { attention: 0, idle: 0, ended: 0 }
  const order: Rank[] = ["attention", "idle", "ended"]
  const candidates = strips.flatMap((strip, index) => {
    const rank = rankOf(strip)
    if (rank === "ended" && now - lastMoved(strip, now) > LIST_ENDED_FOR_MS) {
      folded.ended++
      return []
    }
    return [{ strip, index, rank, moved: lastMoved(strip, now) }]
  })
  candidates.sort((a, b) => order.indexOf(a.rank) - order.indexOf(b.rank) || b.moved - a.moved)
  const kept = new Set<number>()
  let used = 0
  for (const candidate of candidates) {
    const size = JSON.stringify(candidate.strip).length + 1
    if (used + size > budget) {
      folded[candidate.rank]++
      continue
    }
    used += size
    kept.add(candidate.index)
  }
  const children = strips.filter((_, index) => kept.has(index))
  const left = folded.attention + folded.idle + folded.ended
  if (!left) return { children }
  const parts = [
    folded.attention && `${folded.attention} needing attention or at work`,
    folded.idle && `${folded.idle} idle`,
    folded.ended && `${folded.ended} ended`,
  ].filter(Boolean)
  return { children, folded: { ...folded, note: `${left} more ${FIN_WORD}s not listed (${parts.join(", ")}); agents_list with scope all lists every one.` } }
}
