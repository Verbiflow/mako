/**
 * How every surface says a token count and a dollar amount: the composer's
 * meter, Settings › Usage, a compaction's marker, the Fins panel, the phone
 * and the web alike, so one number reads the same wherever it shows.
 */

const UNITS = [
  { size: 1e12, suffix: "T" },
  { size: 1e9, suffix: "B" },
  { size: 1e6, suffix: "M" },
  { size: 1e3, suffix: "K" },
] as const

/**
 * A count of tokens in at most three significant figures, in K, M, B or T
 * as it grows: 940, 1.2K, 12.4K, 124K, 1.24M, 20.7B. A count that rounds up
 * to the next unit is said in it (999,960 is 1M, not 1000K), and one past a
 * thousand trillion keeps its digits grouped in T.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "—"
  const value = Math.max(0, Math.round(count))
  if (value < 1_000) return String(value)
  for (const [index, unit] of UNITS.entries()) {
    if (value < unit.size) continue
    const scaled = value / unit.size
    const shown = Number(scaled.toPrecision(3))
    const larger = UNITS[index - 1]
    if (larger && shown >= 1_000) return `${Number((value / larger.size).toPrecision(3))}${larger.suffix}`
    return shown >= 1_000 ? `${Math.round(scaled).toLocaleString("en-US")}${unit.suffix}` : `${shown}${unit.suffix}`
  }
  return String(value)
}

/**
 * Dollars as a person reads a price: cents below $10 ($0.42, $3.07), whole
 * dollars grouped from there ($12, $1,294, $2,063,540), and an amount that
 * isn't zero but rounds to it as "<$0.01".
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00"
  if (amount < 0.005) return "<$0.01"
  if (amount < 9.995) return `$${amount.toFixed(2)}`
  return `$${Math.round(amount).toLocaleString("en-US")}`
}
