import type { LiveSessionUsage, NativeTotals, TokenCounts } from "./contracts/providers-acp.js"

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
  /**
   * Tokens this harness process has spent, as a running total it keeps. A
   * total that outlives the process (Codex's thread total, OpenCode's session
   * total, Claude's restored totals) is not one: report what each reading
   * adds as `spent`.
   */
  | { kind: "total"; tokens: TokenCounts }
  /** Tokens one turn or call spent, added to what the meter has counted. */
  | { kind: "spent"; tokens: TokenCounts }
  /** This harness process's spend, as a running total it keeps; scoped like `total`. */
  | { kind: "cost"; amount: number; currency: string }
  /** Spend for one turn, added to what the meter has counted. */
  | { kind: "costSpent"; amount: number; currency: string }
  /** The harness's own totals for the native session, kept for the next process that may restore them. */
  | { kind: "native"; totals: NativeTotals }
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
      case "native":
        next.native = observation.totals
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
    sameTokens(left.tokens, right.tokens) &&
    left.native?.cost === right.native?.cost &&
    sameTokens(left.native?.tokens, right.native?.tokens)
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
 * conversation is the same, and keeps the harness's own session totals; what
 * was spent belonged to the process that ended.
 */
export function carriedUsage(
  previous: { harness: string; nativeId?: string; usage?: LiveSessionUsage },
  next: { harness: string; nativeId?: string; usage?: LiveSessionUsage }
): LiveSessionUsage | undefined {
  const before = previous.usage
  if (next.usage || !before || !next.nativeId || previous.nativeId !== next.nativeId || previous.harness !== next.harness)
    return next.usage
  const carried: LiveSessionUsage = {}
  if (before.used && before.size) {
    carried.used = before.used
    carried.size = before.size
    if (before.compacted) carried.compacted = true
  }
  if (before.native) carried.native = before.native
  return carried.used !== undefined || carried.native ? carried : undefined
}

/** The harness's last session totals for this native session, which a resumed process may restore. */
export function restorableTotals(
  session: { harness: string; nativeId?: string; usage?: LiveSessionUsage },
  binding: { provider: string; nativeId?: string; nativeUsage?: NativeTotals }
): NativeTotals | undefined {
  return (runsBinding(session, binding) ? session.usage?.native : undefined) ?? binding.nativeUsage
}

/** A binding the conversation moves off, keeping its native session's totals for a resume after other harnesses ran. */
export function departedBinding<Binding extends { provider: string; nativeId?: string; nativeUsage?: NativeTotals }>(
  binding: Binding,
  session: { harness: string; nativeId?: string; usage?: LiveSessionUsage }
): Binding {
  const native = runsBinding(session, binding) ? session.usage?.native : undefined
  return native ? { ...binding, nativeUsage: native } : binding
}

function runsBinding(session: { harness: string; nativeId?: string }, binding: { provider: string; nativeId?: string }): boolean {
  return session.harness === binding.provider && session.nativeId !== undefined && session.nativeId === binding.nativeId
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
    const tokens = (from?.tokens && tokensSince(from.tokens, now)) ?? { ...now }
    if (contextOf(tokens) > 0) spend.tokens = tokens
  }
  if (to?.cost && to.cost.currency === "USD") {
    const base = from?.cost?.currency === "USD" ? from.cost.amount : 0
    const cost = to.cost.amount >= base ? to.cost.amount - base : to.cost.amount
    if (cost > 0) spend.cost = cost
  }
  return spend
}
