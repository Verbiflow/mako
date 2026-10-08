import type { Capability } from "./harness-capabilities.js"

/**
 * What a harness reports about usage, one field for each thing the window
 * shows. The composer's meter, Settings › Usage and the account rows read
 * these instead of reacting to whatever data arrives, so "Cursor doesn't
 * report how full its context is" is Cursor's declaration, not an empty
 * reading. Each is a `Capability`:
 * - `implemented`: the harness reports it; `via` names where.
 * - `default` (compaction only): the harness says nothing about what a
 *   compaction left, so the meter keeps its earlier reading, marked, until
 *   the next reply measures again.
 * - `absent`: the harness reports none (`by: "harness"`), or reports one
 *   Mako doesn't read yet (`by: "mako"`, a gap), with the reason the window
 *   shows.
 *
 * `test-usage-declarations.ts` replays every recording through its
 * harness's decoder and fails on a reading the declaration rules out, or a
 * declared one no recording shows.
 */
export interface HarnessUsage {
  /** How full the context is: the harness's own reading, or the main agent's last call. */
  context: Capability
  /** The window the fill is measured against. */
  window: Capability
  /** Tokens the session spent, by kind. */
  tokens: Capability
  /** What the session cost, as the harness prices it. */
  cost: Capability
  /** The harness says when a report left calls out, so its totals are a floor. */
  missedCalls: Capability
  /** What the meter reads after a compaction: what is left, or its earlier reading until the next reply. */
  compaction: Capability
  /** An itemized account of the context; the live driver's `contextBreakdown`. */
  contextBreakdown: Capability
  /** Settings › Usage counts sessions run outside Mako, read from the harness's own store; its `usageHistory`. */
  outsideMako: Capability
  /** Early resets of the account's plan limits, spent from its row; its accounts' `useResetCredit`. */
  resetCredits: Capability
}
export type HarnessUsageKey = keyof HarnessUsage

/** What a harness definition declares; the rest is read from the families that implement it. */
export type UsageDeclaration = Omit<HarnessUsage, "contextBreakdown" | "outsideMako">

/** The order the window, the audit and the checklist list them in. */
export const HARNESS_USAGE_KEYS: readonly HarnessUsageKey[] = [
  "context", "window", "compaction", "contextBreakdown", "tokens", "cost", "missedCalls", "outsideMako", "resetCredits",
]

export const HARNESS_USAGE_LABELS = {
  context: "Context fill",
  window: "Window size",
  compaction: "After compaction",
  contextBreakdown: "Context breakdown",
  tokens: "Tokens spent",
  cost: "Cost",
  missedCalls: "Missed calls",
  outsideMako: "Spend outside Mako",
  resetCredits: "Reset credits",
} satisfies Record<HarnessUsageKey, string>

/** What each field asks of a new harness, in the words the checklist shows. */
export const HARNESS_USAGE_ASKS = {
  context: "Where the context fill comes from: the harness's own reading (`context` observations), or the main agent's last call (`call`).",
  window: "Where the window size comes from: the harness's reports (`window`, or a reading's `size`), or its model catalog.",
  compaction: "After a compaction, whether the harness says what is left (`compacted` with `after`) or the meter waits for the next reply.",
  contextBreakdown: "The live driver's `contextBreakdown`.",
  tokens: "Tokens the session spent (`spent` or `total` observations).",
  cost: "What the session cost (`cost` or `costSpent`).",
  missedCalls: "Whether the harness says a report left calls out (`unrecorded`).",
  outsideMako: "The `usageHistory` family.",
  resetCredits: "The accounts' `useResetCredit`, offered on the account's row.",
} satisfies Record<HarnessUsageKey, string>
