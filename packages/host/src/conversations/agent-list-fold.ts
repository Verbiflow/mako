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

/**
 * Where a listed Fin stands for its Apex. Attention: something open to act on (a question, an action, a decision), or
 * at work, waiting on something outside its tree, or blocked; such a row is always listed, whatever the budget. Then idle,
 * then ended with nothing open.
 */
function rankOf(strip: AgentStrip): Rank {
  const { state } = strip
  if (strip.pendingQuestions || strip.pendingActions || strip.custodyActions || strip.waiting) return "attention"
  if (state.kind === "idle") return "idle"
  if (state.kind === "ended") return state.decision ? "attention" : "ended"
  return "attention"
}

/** When a Fin last moved: its quiet time when the list knows it, else its last report, else its start. */
function lastMoved(strip: AgentStrip, now: number): number {
  if (strip.idleFor !== undefined) return now - strip.idleFor * 1000
  return strip.report?.at ?? strip.startedAt
}

/** An idle or ended row without its bulk, for a list over its budget: its pull requests are `agents_read`'s to give. */
function shed(strip: AgentStrip): AgentStrip {
  if (!strip.openPRs) return strip
  const rest = { ...strip }
  delete rest.openPRs
  return rest
}

const size = (strip: AgentStrip) => JSON.stringify(strip).length + 1

/**
 * The rows an Apex's list shows and what it folds (`AgentsListFolded`). A Fin that ended over `LIST_ENDED_FOR_MS` ago with
 * nothing open always folds; one needing attention never does, even past `budget`. The rest, idle then ended, newest
 * first, are kept while the rows fit `budget` characters of JSON, so the whole answer fits `LIST_BUDGET_CHARS` unless what
 * needs attention alone doesn't; past it they first lose their bulk (`shed`), and only then fold. The rows kept stay in
 * the list's order.
 */
export function foldList(strips: readonly AgentStrip[], now: number, budget = LIST_BUDGET_CHARS - ENVELOPE_CHARS): ListFold {
  const folded = { idle: 0, ended: 0 }
  const kept = new Map<number, AgentStrip>()
  const rest: { strip: AgentStrip; index: number; rank: Rank; moved: number }[] = []
  let used = 0
  strips.forEach((strip, index) => {
    const rank = rankOf(strip)
    if (rank === "attention") {
      kept.set(index, strip)
      used += size(strip)
    } else if (rank === "ended" && now - lastMoved(strip, now) > LIST_ENDED_FOR_MS) folded.ended++
    else rest.push({ strip, index, rank, moved: lastMoved(strip, now) })
  })
  rest.sort((a, b) => (a.rank === b.rank ? 0 : a.rank === "idle" ? -1 : 1) || b.moved - a.moved)
  // Everything fits whole, or the rest go without their bulk before any of them folds.
  const whole = rest.reduce((sum, each) => sum + size(each.strip), used) <= budget
  for (const each of rest) {
    const strip = whole ? each.strip : shed(each.strip)
    const weight = size(strip)
    if (used + weight > budget) {
      folded[each.rank === "idle" ? "idle" : "ended"]++
      continue
    }
    used += weight
    kept.set(each.index, strip)
  }
  const children = [...kept].sort((a, b) => a[0] - b[0]).map(([, strip]) => strip)
  const left = folded.idle + folded.ended
  if (!left) return { children }
  const parts = [folded.idle && `${folded.idle} idle`, folded.ended && `${folded.ended} ended`].filter(Boolean)
  return { children, folded: { ...folded, note: `${left} more ${FIN_WORD}s not listed (${parts.join(", ")}); agents_list with scope all lists every one.` } }
}
