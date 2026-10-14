import type { LiveSessionUsage, NativeTotals, TokenCounts } from "../contracts/providers-acp.js"
import { addTokens, contextOf } from "../contracts/usage-ledger.js"

// The spend algebra lives with the ledger contract, which the window reads too.
export { addTokens, contextOf, spendBetween, tokensSince, type RequestSpend } from "../contracts/usage-ledger.js"

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
  /**
   * The harness said what it just reported leaves spend out: `tokens` when
   * its counts miss calls (and its cost is left out with them), `cost` when
   * only some calls' cost is.
   */
  | { kind: "unrecorded"; of: "tokens" | "cost" }
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
  /** The reading's spend, kept apart from its fill so each reading is built whole rather than deleted from. */
  private spend: Omit<LiveSessionUsage, "used" | "size" | "compactedFrom"> = {}
  private used?: number
  private window?: number
  /** What the context held before a compaction that said nothing of what it left; cleared by the next measurement. */
  private compactedFrom?: number

  get current(): LiveSessionUsage | undefined {
    return empty(this.reading) ? undefined : this.reading
  }

  /** The tokens in context as last reported, which a compaction starts from whether or not the window is known yet. */
  get context(): number | undefined {
    return this.used ?? this.compactedFrom
  }

  /** The new reading, or `undefined` when these observations changed nothing. */
  observe(...observations: UsageObservation[]): LiveSessionUsage | undefined {
    const before = this.reading
    for (const observation of observations) this.apply(observation)
    return sameUsage(before, this.reading) ? undefined : this.reading
  }

  private apply(observation: UsageObservation): void {
    const next = { ...this.spend }
    switch (observation.kind) {
      case "call":
        this.used = contextOf(observation.tokens)
        this.compactedFrom = undefined
        break
      case "context":
        this.used = observation.used
        if (observation.size) this.window = observation.size
        this.compactedFrom = undefined
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
      case "unrecorded":
        next.unrecorded = {
          tokens: (next.unrecorded?.tokens ?? 0) + (observation.of === "tokens" ? 1 : 0),
          cost: (next.unrecorded?.cost ?? 0) + 1,
        }
        break
      case "compacted":
        // What the context held is no reading of what it holds now: without
        // the harness's own number the meter waits for the next reply.
        if (observation.after !== undefined) {
          this.used = observation.after
          this.compactedFrom = undefined
        } else if (this.used !== undefined) {
          this.compactedFrom = this.used
          this.used = undefined
        }
        break
      case "reset":
        this.used = undefined
        this.compactedFrom = undefined
        break
    }
    this.spend = next
    this.reading = this.window && this.used !== undefined
      ? { ...next, used: this.used, size: this.window }
      : this.window && this.compactedFrom !== undefined
        ? { ...next, compactedFrom: this.compactedFrom, size: this.window }
        : next
  }
}

function sameUsage(left: LiveSessionUsage, right: LiveSessionUsage): boolean {
  return left.used === right.used &&
    left.size === right.size &&
    left.compactedFrom === right.compactedFrom &&
    left.unrecorded?.tokens === right.unrecorded?.tokens &&
    left.unrecorded?.cost === right.unrecorded?.cost &&
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
  } else if (before.compactedFrom && before.size) {
    carried.compactedFrom = before.compactedFrom
    carried.size = before.size
  }
  if (before.native) carried.native = before.native
  return carried.size !== undefined || carried.native ? carried : undefined
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

function empty(reading: LiveSessionUsage): boolean {
  return reading.used === undefined && reading.compactedFrom === undefined && reading.tokens === undefined && reading.cost === undefined && reading.unrecorded === undefined
}
