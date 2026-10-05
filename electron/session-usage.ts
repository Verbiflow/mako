import type { LiveSessionUsage, TokenCounts } from "./contracts/providers-acp.js"

/**
 * What a harness can say about usage, in its own unit. Harnesses report
 * different things at different moments (a call's tokens, a turn's total, a
 * running total, their own context reading), so each reader says which it
 * has and the meter keeps the one reading the desk shows.
 */
export type UsageObservation =
  /** One model call by the main agent: its tokens are what is in context now. */
  | { kind: "call"; tokens: TokenCounts }
  /** The harness's own context reading. */
  | { kind: "context"; used: number; size?: number }
  /** The window of the model now answering. */
  | { kind: "window"; size: number }
  /** Tokens spent since the session started, as a running total the harness keeps. */
  | { kind: "total"; tokens: TokenCounts }
  /** Tokens one turn or call spent, added to what the meter has counted. */
  | { kind: "spent"; tokens: TokenCounts }
  /** Spend since the session started, as a running total the harness keeps. */
  | { kind: "cost"; amount: number; currency: string }
  /** Spend for one turn, added to what the meter has counted. */
  | { kind: "costSpent"; amount: number; currency: string }
  /** The context was compacted; `after` when the harness says how much is left. */
  | { kind: "compacted"; after?: number }
  /** The harness started a new conversation in place: nothing is in context. */
  | { kind: "reset" }

/**
 * One live session's usage, folded from what its harness reports. Pure: the
 * same observations give the same reading, so a recorded session replays
 * exactly. A context reading waits for the window it is measured against,
 * since some harnesses name the window only after the call (Claude's result).
 */
export class SessionUsage {
  private reading: LiveSessionUsage = {}
  private used?: number
  private window?: number

  get current(): LiveSessionUsage | undefined {
    return empty(this.reading) ? undefined : this.reading
  }

  /** The new reading, or `undefined` when these observations changed nothing. */
  observe(...observations: UsageObservation[]): LiveSessionUsage | undefined {
    const before = this.reading
    for (const observation of observations) this.apply(observation)
    return sameUsage(before, this.reading) ? undefined : this.reading
  }

  private apply(observation: UsageObservation): void {
    const next = { ...this.reading }
    switch (observation.kind) {
      case "call":
        this.used = contextOf(observation.tokens)
        delete next.compacted
        break
      case "context":
        this.used = observation.used
        if (observation.size) this.window = observation.size
        delete next.compacted
        break
      case "window":
        this.window = observation.size
        break
      case "total":
        next.tokens = { ...observation.tokens }
        break
      case "spent":
        next.tokens = addTokens(next.tokens, observation.tokens)
        break
      case "cost":
        next.cost = { amount: observation.amount, currency: observation.currency }
        break
      case "costSpent":
        if (!next.cost || next.cost.currency === observation.currency)
          next.cost = { amount: (next.cost?.amount ?? 0) + observation.amount, currency: observation.currency }
        break
      case "compacted":
        if (observation.after !== undefined) {
          this.used = observation.after
          delete next.compacted
        } else if (this.used !== undefined) next.compacted = true
        break
      case "reset":
        this.used = undefined
        delete next.compacted
        break
    }
    if (this.used !== undefined && this.window) {
      next.used = this.used
      next.size = this.window
    } else {
      delete next.used
      delete next.size
    }
    this.reading = next
  }
}

function sameUsage(left: LiveSessionUsage, right: LiveSessionUsage): boolean {
  return left.used === right.used &&
    left.size === right.size &&
    left.compacted === right.compacted &&
    left.cost?.amount === right.cost?.amount &&
    left.cost?.currency === right.cost?.currency &&
    sameTokens(left.tokens, right.tokens)
}

function sameTokens(left: TokenCounts | undefined, right: TokenCounts | undefined): boolean {
  if (!left || !right) return left === right
  return left.input === right.input &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.output === right.output &&
    left.reasoning === right.reasoning
}

/**
 * The reading after a native session's process changed. A process that has
 * reported nothing yet leaves the context as full as it was, since the
 * conversation is the same; what was spent belonged to the process that ended.
 */
export function carriedUsage(
  previous: { harness: string; nativeId?: string; usage?: LiveSessionUsage },
  next: { harness: string; nativeId?: string; usage?: LiveSessionUsage }
): LiveSessionUsage | undefined {
  const before = previous.usage
  if (next.usage || !before?.used || !before.size || !next.nativeId || previous.nativeId !== next.nativeId || previous.harness !== next.harness)
    return next.usage
  return { used: before.used, size: before.size, ...(before.compacted && { compacted: true }) }
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

/**
 * Counts where input includes cached input and output includes reasoning,
 * the OpenAI convention Codex, Grok's turn totals, Cursor and Devin follow.
 */
export function fromInclusiveCounts(counts: {
  input: number
  cacheRead?: number
  cacheWrite?: number
  output: number
  reasoning?: number
}): TokenCounts {
  const cacheRead = counts.cacheRead ?? 0
  const cacheWrite = counts.cacheWrite ?? 0
  const tokens: TokenCounts = {
    input: Math.max(0, counts.input - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: counts.output,
  }
  if (counts.reasoning) tokens.reasoning = counts.reasoning
  return tokens
}

function empty(reading: LiveSessionUsage): boolean {
  return reading.used === undefined && reading.tokens === undefined && reading.cost === undefined
}

/** What one request spent: tokens by kind, and cost in USD. */
export interface RequestSpend {
  tokens?: TokenCounts
  cost?: number
}

const TOKEN_KINDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const

/**
 * What a session spent between two of its readings, for one request. A
 * later reading below the earlier one is a meter that started over (a new
 * process), so everything it has counted is this request's.
 */
export function spendBetween(
  from: LiveSessionUsage | undefined,
  to: LiveSessionUsage | undefined
): RequestSpend {
  const spend: RequestSpend = {}
  const now = to?.tokens
  if (now) {
    const base = from?.tokens
    const restarted = !base || TOKEN_KINDS.some((kind) => (now[kind] ?? 0) < (base[kind] ?? 0))
    const tokens: TokenCounts = restarted ? { ...now } : {
      input: now.input - base.input,
      cacheRead: now.cacheRead - base.cacheRead,
      cacheWrite: now.cacheWrite - base.cacheWrite,
      output: now.output - base.output,
    }
    if (!restarted && now.reasoning !== undefined) tokens.reasoning = now.reasoning - (base.reasoning ?? 0)
    if (contextOf(tokens) > 0) spend.tokens = tokens
  }
  if (to?.cost && to.cost.currency === "USD") {
    const base = from?.cost?.currency === "USD" ? from.cost.amount : 0
    const cost = to.cost.amount >= base ? to.cost.amount - base : to.cost.amount
    if (cost > 0) spend.cost = cost
  }
  return spend
}
