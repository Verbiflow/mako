import { FIN_WORD } from "../contracts/agents.js"
import { LIST_BUDGET_CHARS, LIST_ENDED_FOR_MS, type AgentStrip, type AgentsListFolded, type ShiverMate } from "../contracts/agent-tools.js"

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

/** When a Fin last moved: the later of its quiet time and its last report, else its start. */
function lastMoved(strip: AgentStrip, now: number): number {
  return movedAt(strip, now) ?? strip.startedAt
}

/** The later of when a Fin went quiet and when it last reported, as far as the list knows either. */
function movedAt(fin: { idleFor?: number; report?: { at: number } }, now: number): number | undefined {
  const quiet = fin.idleFor === undefined ? undefined : now - fin.idleFor * 1000
  if (quiet === undefined) return fin.report?.at
  return fin.report ? Math.max(quiet, fin.report.at) : quiet
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
 * The rows an Apex's list shows and what it folds (`AgentsListFolded`). A Fin that ended or sat idle over
 * `LIST_ENDED_FOR_MS` ago with nothing open always folds; one needing attention never does, even past `budget`. The rest, idle then ended, newest
 * first, are kept while the rows fit `budget` characters of JSON, so the whole answer fits `LIST_BUDGET_CHARS` unless what
 * needs attention alone doesn't; past it they first lose their bulk (`shed`), and only then fold. The rows kept stay in
 * the list's order. `unlisted`: ended Fins the list folded before it built their rows (`Agents.unlisted`), counted with
 * the rest.
 */
export function foldList(strips: readonly AgentStrip[], now: number, budget = LIST_BUDGET_CHARS - ENVELOPE_CHARS, unlisted = 0): ListFold {
  const folded = { idle: 0, ended: unlisted }
  const kept = new Map<number, AgentStrip>()
  const rest: { strip: AgentStrip; index: number; rank: Rank; moved: number }[] = []
  let used = 0
  strips.forEach((strip, index) => {
    const rank = rankOf(strip)
    if (rank === "attention") {
      kept.set(index, strip)
      used += size(strip)
    } else if (now - lastMoved(strip, now) > LIST_ENDED_FOR_MS) folded[rank]++
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
  const note = foldedNote(folded)
  return note ? { children, folded: note } : { children }
}

/** The fold's one line: how many it left out, by where they stand, and how to list them. */
function foldedNote(folded: { idle: number; ended: number }): AgentsListFolded | undefined {
  const left = folded.idle + folded.ended
  if (!left) return undefined
  const parts = [folded.idle && `${folded.idle} idle`, folded.ended && `${folded.ended} ended`].filter(Boolean)
  return { ...folded, note: `${left} more ${FIN_WORD}s not listed (${parts.join(", ")}), with nothing open; agents_list with ended: true lists them.` }
}

/**
 * A Fin's Shiver as `scope: shiver` lists it: the other Fins that ended or sat idle over `LIST_ENDED_FOR_MS` ago with nothing
 * open (no decision, no wait) are counted, not listed. One whose age the host doesn't hold stays listed.
 */
export function foldShiver(shiver: readonly ShiverMate[], now: number): { shiver: ShiverMate[]; folded?: AgentsListFolded } {
  const folded = { idle: 0, ended: 0 }
  const listed = shiver.filter((mate) => {
    const { state } = mate
    const rank = state.kind === "ended" && !state.decision && !state.waitingOn?.length ? "ended" : state.kind === "idle" && !state.waitingOn?.length ? "idle" : undefined
    const moved = movedAt(mate, now)
    if (!rank || moved === undefined || now - moved <= LIST_ENDED_FOR_MS) return true
    folded[rank]++
    return false
  })
  const note = foldedNote(folded)
  return note ? { shiver: listed, folded: note } : { shiver: listed }
}
