import type { HarnessTurn, LiveRequest, SpentThrough } from "./live-conversations.js"
import type { LiveSessionUsage, TokenCounts } from "./providers-acp.js"

/**
 * What a conversation spent, kept apart from what its context holds.
 *
 * Three numbers answer three questions, and none stands in for another:
 * - occupancy, `LiveSessionUsage.used` of `size`: what the model's window
 *   holds now, from the harness's last reading;
 * - spend, each request's `spend`: what answering it cost, measured by Mako
 *   between two of the harness's readings and kept in the journal;
 * - the harness's own total, `LiveSessionUsage.native`: what the harness
 *   counts for its native session, wherever it ran.
 *
 * A cost is either the harness's (`cost`) or Mako's estimate from a price
 * table (`estimate`), never a sum of both passed off as one. Neither is a
 * bill: a harness's cost is what it priced the tokens at, and a
 * subscription is billed by its plan.
 */

/** A price list Mako estimates cost from: when it was read, and from where. */
export interface PriceTable {
  /** The day the prices were read; an estimate names it. */
  id: string
  sources: readonly string[]
}

/**
 * Every price table an estimate may name, newest first. A table is added,
 * never edited: an estimate keeps the table it was made with, so repricing
 * never rewrites an old one.
 */
export const PRICE_TABLES: readonly PriceTable[] = [
  {
    id: "2026-10-06",
    sources: ["docs.claude.com/en/docs/about-claude/pricing", "developers.openai.com/api/docs/pricing"],
  },
]

export const CURRENT_PRICE_TABLE: PriceTable = PRICE_TABLES[0]!

/** A cost Mako worked out from a price table: always shown with "≈" and its table, never as a harness's or a bill. */
export interface CostEstimate {
  amount: number
  currency: "USD"
  /** The `PriceTable.id` it was priced from. */
  table: string
}

/**
 * Files and lines a turn, a session or a thread changed, shown beside what
 * it spent. The attribution journal (`@mako/protocol`'s `AttributionTracker`)
 * names each change's `Author` by thread, session and turn, and counts its
 * lines; until its counts reach the host's methods, the slot stays empty and
 * the window shows nothing for it rather than a zero.
 */
export interface ChangeCounts {
  files: number
  added: number
  removed: number
  /** Whose: a Thread's counts cover every Session of it. */
  scope?: "thread"
  /** The files by what happened to them. */
  kinds?: { created: number; changed: number; deleted: number; renamed: number }
  /** Commands its calls ran. */
  commands?: number
  /** Paths outside its checkouts it touched, as a count: the weak ones are too noisy to list. */
  outside?: number
  /** Files changed while its turns ran that might be its, or the person's: counted apart from `files`. */
  maybe?: number
}

/** What change counts are asked for: a turn by its request id, a session, or a thread. */
export type ChangeScope = { turn: string } | { session: string } | { thread: string }

/** What answering one request spent, as the journal keeps it. */
export interface TurnSpend {
  provider: string
  model?: string
  at: number
  tokens?: TokenCounts
  /** USD the harness itself reported. */
  cost?: number
  /** Mako's price for `tokens` when the harness reported no cost. */
  estimate?: CostEstimate
  /** The harness said this turn's report left spend out: `tokens`, or only `cost`, may be low. */
  unrecorded?: "tokens" | "cost"
}

/** What started a turn, from the request's own record: who sent it and on whose behalf. */
export type TurnTrigger = "message" | "goal" | "review" | "continuation" | "agent" | "service"

export function turnTrigger(request: Pick<LiveRequest, "actor" | "goal" | "review" | "continues">): TurnTrigger {
  if (request.review) return "review"
  if (request.goal?.step === "continue") return "goal"
  if (request.continues) return "continuation"
  if (request.actor?.kind === "agent") return "agent"
  if (request.actor?.kind === "service") return request.actor.name === "goal" ? "goal" : "service"
  return "message"
}

export const TURN_TRIGGER_LABELS = {
  message: "Your message",
  goal: "Goal continuation",
  review: "Code review",
  continuation: "Continued after an interruption",
  agent: "Sent by another agent",
  service: "Sent by Mako",
} satisfies Record<TurnTrigger, string>

/** A conversation's spend, summed from its turns. */
export interface ConversationSpend {
  /** Turns that recorded any spend. */
  turns: number
  tokens?: TokenCounts
  /** The part of the cost harnesses reported, in USD. */
  cost?: number
  /** The part Mako estimated, with the tables it used. */
  estimate?: { amount: number; tables: string[] }
  /** Turns with tokens but no cost and no price: the cost is a floor. */
  unpriced: number
  /** Turns whose harness said its report left out calls (`tokens`), or only their cost (`cost`). */
  unrecorded: { tokens: number; cost: number }
  /** The turn running now, measured so far; already inside the sums. */
  running?: TurnSpend
  /** Spent since the last turn by work still going (a background subagent), which the next turn counts; already inside the sums. */
  since?: TurnSpend
  last?: TurnSpend
}

/**
 * Every turn's spend added up, the running one included as far as it has
 * gone: Mako's requests, the turns the harness ran on its own
 * (`harnessTurns`), and what was spent since the last turn ended
 * (`spentThrough`), which the next turn counts. Reads only the
 * conversation's own records, so a reopened conversation sums the same as
 * a live one, and every token the meter read is in one turn.
 */
export function conversationSpend(
  requests: readonly LiveRequest[],
  usage?: LiveSessionUsage,
  harness?: string,
  outside: { harnessTurns?: readonly HarnessTurn[]; spentThrough?: SpentThrough; running?: boolean } = {}
): ConversationSpend {
  const total: ConversationSpend = { turns: 0, unpriced: 0, unrecorded: { tokens: 0, cost: 0 } }
  const add = (spend: TurnSpend, counts = true) => {
    if (!spend.tokens && spend.cost === undefined && !spend.estimate) return
    if (counts) total.turns += 1
    if (spend.tokens) total.tokens = addTokens(total.tokens, spend.tokens)
    if (spend.cost !== undefined) total.cost = (total.cost ?? 0) + spend.cost
    else if (spend.estimate) {
      const tables = total.estimate?.tables ?? []
      total.estimate = {
        amount: (total.estimate?.amount ?? 0) + spend.estimate.amount,
        tables: tables.includes(spend.estimate.table) ? tables : [...tables, spend.estimate.table],
      }
    } else if (spend.tokens) total.unpriced += 1
    if (spend.unrecorded) total.unrecorded[spend.unrecorded] += 1
  }
  const ended = [
    ...requests.flatMap((request) => (request.spend ? [request.spend] : [])),
    ...(outside.harnessTurns ?? []).map((turn) => turn.spend),
  ].sort((a, b) => a.at - b.at)
  for (const spend of ended) {
    add(spend)
    total.last = spend
  }
  const dispatching = requests.find((request) => request.status === "dispatching")
  if (harness && dispatching) {
    const spend = spendBetween(dispatching.usageFrom, usage)
    if (spend.tokens || spend.cost !== undefined) {
      total.running = { provider: harness, at: Date.now(), ...spend }
      add(total.running)
    }
  } else if (harness && outside.spentThrough) {
    // A turn the harness runs on its own, or work going on between turns, counts from the last turn's end.
    const spend = spendBetween(outside.spentThrough.usage, usage)
    if (spend.tokens || spend.cost !== undefined) {
      const measured: TurnSpend = { provider: harness, at: Date.now(), ...spend }
      if (outside.running) {
        total.running = measured
        add(measured)
      } else {
        total.since = measured
        add(measured, false)
      }
    }
  }
  return total
}

/** Every token the call had in its window: what it read, cached or not, and what it wrote. */
export function contextOf(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

export function addTokens(left: TokenCounts | undefined, right: TokenCounts): TokenCounts {
  const sum: TokenCounts = {
    input: (left?.input ?? 0) + right.input,
    cacheRead: (left?.cacheRead ?? 0) + right.cacheRead,
    cacheWrite: (left?.cacheWrite ?? 0) + right.cacheWrite,
    output: (left?.output ?? 0) + right.output,
  }
  if (left?.reasoning !== undefined || right.reasoning !== undefined)
    sum.reasoning = (left?.reasoning ?? 0) + (right.reasoning ?? 0)
  return sum
}

const TOKEN_KINDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const

/** What a running total added since an earlier reading of it, or `undefined` when any kind went down: the total started over. */
export function tokensSince(before: TokenCounts, after: TokenCounts): TokenCounts | undefined {
  if (TOKEN_KINDS.some((kind) => (after[kind] ?? 0) < (before[kind] ?? 0))) return undefined
  const added: TokenCounts = {
    input: after.input - before.input,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    output: after.output - before.output,
  }
  if (after.reasoning !== undefined) added.reasoning = after.reasoning - (before.reasoning ?? 0)
  return added
}

/** What one request spent: tokens by kind, and cost in USD. */
export interface RequestSpend {
  tokens?: TokenCounts
  cost?: number
  /** The harness said this request's own turns left spend out, so `tokens`, or only `cost`, may be low. */
  unrecorded?: "tokens" | "cost"
}

/**
 * What a session spent between two of its readings, for one request. A
 * later reading below the earlier one is a meter that started over (a new
 * process), so everything it has counted is this request's.
 */
export function spendBetween(
  from: Pick<LiveSessionUsage, "tokens" | "cost" | "unrecorded"> | undefined,
  to: Pick<LiveSessionUsage, "tokens" | "cost" | "unrecorded"> | undefined
): RequestSpend {
  const spend: RequestSpend = {}
  const now = to?.tokens
  const tokens = now && ((from?.tokens && tokensSince(from.tokens, now)) ?? { ...now })
  if (tokens && contextOf(tokens) > 0) spend.tokens = tokens
  const marks = to?.unrecorded ?? { tokens: 0, cost: 0 }
  const marked = from?.unrecorded ?? { tokens: 0, cost: 0 }
  const restarted = (from?.tokens && now && !tokensSince(from.tokens, now)) || marks.tokens < marked.tokens || marks.cost < marked.cost
  const base = restarted ? { tokens: 0, cost: 0 } : marked
  if (marks.tokens > base.tokens) spend.unrecorded = "tokens"
  else if (marks.cost > base.cost) spend.unrecorded = "cost"
  if (to?.cost && to.cost.currency === "USD") {
    const base = from?.cost?.currency === "USD" ? from.cost.amount : 0
    const cost = to.cost.amount >= base ? to.cost.amount - base : to.cost.amount
    if (cost > 0) spend.cost = cost
  }
  return spend
}

/**
 * Why Mako called a model outside any conversation's turns. Each is a
 * separate line in Settings › Usage, so usage adds up: a session's turns, its
 * side questions, and these.
 */
export const HELPER_PURPOSES = ["commit-message", "connection-check"] as const
export type HelperPurpose = (typeof HELPER_PURPOSES)[number]

export const HELPER_PURPOSE_LABELS = {
  "commit-message": "Commit messages",
  "connection-check": "Model connection checks",
} satisfies Record<HelperPurpose, string>

/**
 * One model call, or one task's calls, that Mako made itself: what it was
 * for, what asked for it, where it ran, and what it spent as the provider
 * reported it. Kept in `usage/helper-runs/` under the data root; Settings ›
 * Usage reads it as a source of its own.
 */
export interface HelperRun {
  id: string
  /** When it started, epoch ms. */
  at: number
  purpose: HelperPurpose
  /** The action that asked for it, in the words its button or menu uses. */
  trigger: string
  /** The API connection it ran on, `provider/model`. */
  connection: string
  /** The folder it worked on, when it worked on one. */
  cwd?: string
  outcome: "completed" | "failed" | "cancelled"
  durationMs: number
  /** Model calls it made: a commit draft summarizes files before it writes. */
  calls: number
  /** Tokens as the provider's API reported them; absent when no call reported any. */
  tokens?: TokenCounts
  estimate?: CostEstimate
}
