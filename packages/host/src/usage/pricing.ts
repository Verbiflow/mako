import { CURRENT_PRICE_TABLE, type CostEstimate } from "../contracts/usage-ledger.js"

export interface UsageTokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The part of `cacheWrite` written to a one-hour cache, which Anthropic prices apart. */
  cacheWrite1h?: number
  /** Summed over a turn's calls, so a per-call long-context price can't be told from them and isn't applied. */
  summed?: boolean
  /** Made in the provider's fast mode (Claude's `speed: "fast"`, Codex's fast service tier), which costs a multiple of the list price. */
  fast?: boolean
}

interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
}

interface ModelPrice extends Rates {
  /** Rates for a whole request whose input passes `threshold` tokens. */
  longContext?: Rates & { threshold: number }
  /** What fast mode multiplies every rate by; a model without one has no fast price, so a fast call of it is unpriced. */
  fast?: number
  /** A price the provider has announced from a day on (epoch ms), latest last: a call is priced as of when it was made. */
  from?: readonly { at: number; price: ModelPrice }[]
}

/** Anthropic's list: a five-minute cache write is 1.25x input and a one-hour write 2x; the cache read rate is each model's own. */
function anthropic(input: number, output: number, cacheRead: number, extra: Pick<ModelPrice, "fast" | "longContext"> = {}): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2, ...extra }
}

/**
 * OpenAI's list. A model with a long-context price charges a whole request
 * over 272K input tokens twice the input and cache rates and 1.5x the output.
 * A model with a 30-minute cache write price charges it at 1.25x input; one
 * without bills cache writes as input.
 */
function openai(input: number, output: number, cacheRead: number, extra: { long?: boolean; writes?: boolean; fast?: number } = {}): ModelPrice {
  const cacheWrite = extra.writes ? input * 1.25 : input
  const price: ModelPrice = { input, output, cacheRead, cacheWrite }
  if (extra.long) price.longContext = { threshold: 272_000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 }
  if (extra.fast) price.fast = extra.fast
  return price
}

/** A model OpenAI prices without a cached-input rate: cached input is billed as input. */
function uncached(input: number, output: number, long = false): ModelPrice {
  return openai(input, output, input, { long })
}

/**
 * Standard API prices in USD per million tokens, read for
 * `CURRENT_PRICE_TABLE` from docs.claude.com/en/docs/about-claude/pricing:
 * model prices, cache multipliers, fast mode and long context. Changing a
 * price means a new table there, so estimates already made keep the table
 * they name.
 */
const CLAUDE_PRICES = new Map<string, ModelPrice>([
  ["claude-fable-5-1", anthropic(10, 50, 0.25)],
  ["claude-fable-5", anthropic(10, 50, 1)],
  ["claude-opus-5-5", anthropic(4, 20, 0.2, { fast: 2 })],
  ["claude-opus-5", anthropic(5, 25, 0.5, { fast: 2 })],
  ["claude-sonnet-5-5", anthropic(2, 10, 0.1)],
  ["claude-sonnet-5", anthropic(2, 10, 0.2)],
  ["claude-opus-4-8", anthropic(5, 25, 0.5, { fast: 2 })],
  ["claude-opus-4-current", anthropic(5, 25, 0.5)],
  ["claude-opus-4-legacy", anthropic(15, 75, 1.5)],
  ["claude-opus-3", anthropic(15, 75, 1.5)],
  ["claude-sonnet-4-6", anthropic(3, 15, 0.3)],
  ["claude-sonnet-4", anthropic(3, 15, 0.3, { longContext: { threshold: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12 } })],
  ["claude-sonnet-3", anthropic(3, 15, 0.3)],
  [
    "claude-haiku-5-5",
    anthropic(0.1, 0.5, 0.01, { longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } }),
  ],
  ["claude-haiku-4", anthropic(1, 5, 0.1)],
  ["claude-haiku-3.5", anthropic(0.8, 4, 0.08)],
  ["claude-haiku-3", { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3, cacheWrite1h: 0.5 }],
])

/** Standard API prices in USD per million tokens, from developers.openai.com/api/docs/pricing, its Fast tier as a multiple, for `CURRENT_PRICE_TABLE`. */
const OPENAI_PRICES = new Map<string, ModelPrice>([
  ["gpt-6-astra", openai(10, 50, 1, { long: true, writes: true, fast: 2 })],
  ["gpt-6.1-sol", openai(2, 10, 0.1, { long: true, writes: true, fast: 2 })],
  ["gpt-6.1-terra", openai(1, 5, 0.05, { long: true, writes: true, fast: 2 })],
  ["gpt-6-sol", openai(2, 10, 0.2, { long: true, writes: true, fast: 2 })],
  ["gpt-6-luna", openai(0.1, 0.5, 0.01, { long: true, writes: true, fast: 2 })],
  // GPT-5.6 Sol's promotional price, which OpenAI says holds at least through 2026-11-21.
  ["gpt-5.6-sol", openai(4, 20, 0.4, { long: true, writes: true, fast: 2 })],
  ["gpt-5.6-terra", openai(2, 12, 0.2, { long: true, writes: true, fast: 2 })],
  ["gpt-5.6-luna", openai(0.2, 1.2, 0.02, { long: true, writes: true, fast: 2 })],
  ["gpt-5.5-pro", uncached(30, 180, true)],
  ["gpt-5.5", openai(5, 30, 0.5, { long: true, fast: 2.5 })],
  ["gpt-5.4-pro", uncached(30, 180, true)],
  ["gpt-5.4-mini", openai(0.75, 4.5, 0.075, { fast: 2 })],
  ["gpt-5.4-nano", openai(0.2, 1.25, 0.02)],
  ["gpt-5.4", openai(2.5, 15, 0.25, { long: true, fast: 2 })],
  ["gpt-5.3", openai(1.75, 14, 0.175, { fast: 2 })],
  ["gpt-5.2-pro", uncached(21, 168)],
  ["gpt-5.2", openai(1.75, 14, 0.175, { fast: 2 })],
  ["gpt-5.1", openai(1.25, 10, 0.125, { fast: 2 })],
  ["gpt-5-pro", uncached(15, 120)],
  ["gpt-5-mini", openai(0.25, 2, 0.025, { fast: 1.8 })],
  ["gpt-5-nano", openai(0.05, 0.4, 0.005)],
  ["gpt-5", openai(1.25, 10, 0.125, { fast: 2 })],
  ["gpt-4.1-mini", openai(0.4, 1.6, 0.1, { fast: 1.75 })],
  ["gpt-4.1", openai(2, 8, 0.5, { fast: 1.75 })],
  ["gpt-4o-mini", openai(0.15, 0.6, 0.075)],
  ["gpt-4o", openai(2.5, 10, 1.25, { fast: 1.7 })],
  ["o3-pro", uncached(20, 80)],
  ["o3", openai(2, 8, 0.5, { fast: 1.75 })],
  ["o4-mini", openai(1.1, 4.4, 0.275)],
  ["codex-mini", openai(1.5, 6, 0.375)],
])

/** Gemini API paid-tier prices in USD per million tokens, from ai.google.dev/gemini-api/docs/pricing; Gemini bills no cache write. */
const GOOGLE_PRICES = new Map<string, ModelPrice>([
  ["gemini-3.8-flash", { ...uncached(0.75, 3.75), cacheRead: 0.075, from: [{ at: Date.UTC(2027, 0, 1), price: { ...uncached(1.5, 7.5), cacheRead: 0.15 } }] }],
])

/** Mako's price for a call or turn from the current table, as of `at` (epoch ms), naming it; `null` for a model the table doesn't list. */
export function priceEstimate(model: string | undefined, usage: UsageTokenCounts, at = Date.now()): CostEstimate | null {
  const amount = estimateUsageCost(model, usage, at)
  return amount === null ? null : { amount, currency: "USD", table: CURRENT_PRICE_TABLE.id }
}

export function estimateUsageCost(
  model: string | undefined,
  usage: UsageTokenCounts,
  at = Date.now()
): number | null {
  const key = pricingKey(model)
  if (key === null) return null
  const listed = CLAUDE_PRICES.get(key) ?? OPENAI_PRICES.get(key) ?? GOOGLE_PRICES.get(key)
  if (!listed) return null
  const price = (listed.from ?? []).reduce<ModelPrice>((current, change) => (change.at <= at ? change.price : current), listed)
  const fast = usage.fast || fastModel(model)
  if (fast && !price.fast) return null

  const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
  const active: Rates =
    price.longContext && !usage.summed && contextTokens > price.longContext.threshold
      ? price.longContext
      : price
  const hour = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite)
  const cost =
    (usage.input * active.input +
      usage.output * active.output +
      usage.cacheRead * active.cacheRead +
      (usage.cacheWrite - hour) * active.cacheWrite +
      hour * (active.cacheWrite1h ?? active.cacheWrite)) /
    1_000_000
  return fast ? cost * (price.fast ?? 1) : cost
}

/** A model id that names its fast mode, as Cursor's `claude-opus-5-5-fast` does. */
function fastModel(model: string | undefined): boolean {
  return /-fast(?:$|[^a-z])/.test(model?.toLowerCase() ?? "")
}

function pricingKey(model: string | undefined): string | null {
  if (!model) return null
  const normalized = model.toLowerCase().trim()
  const separator = normalized.search(/[/:]/)
  const provider = separator >= 0 ? normalized.slice(0, separator) : undefined
  if (provider && provider !== "anthropic" && provider !== "openai" && provider !== "google") return null
  const value = (separator >= 0 ? normalized.slice(separator + 1) : normalized)
    .replace(/\./g, "-")
    .replace(/\((minimal|low|medium|high|xhigh|max|auto|none)\)$/, "")
    .replace(/-(minimal|low|medium|high|xhigh|max|auto|none)$/, "")
    .replace(/-fast$/, "")

  if (value.includes("fable-5-1") || value.includes("mythos-5-1")) return "claude-fable-5-1"
  if (value.includes("fable-5") || value.includes("5-fable") || value.includes("mythos-5"))
    return "claude-fable-5"
  if (value.includes("opus-5-5")) return "claude-opus-5-5"
  if (value.includes("opus-5")) return "claude-opus-5"
  if (value.includes("sonnet-5-5")) return "claude-sonnet-5-5"
  if (value.includes("sonnet-5")) return "claude-sonnet-5"
  if (value.includes("haiku-5-5")) return "claude-haiku-5-5"
  if (value.includes("opus-4-8")) return "claude-opus-4-8"
  if (value.includes("opus-4-1")) return "claude-opus-4-legacy"
  if (/opus-4(?:$|-thinking$|-20\d{6}(?:-thinking)?$|@20\d{6}$)/.test(value))
    return "claude-opus-4-legacy"
  if (value.includes("opus-4")) return "claude-opus-4-current"
  if (value.includes("opus-3") || value.includes("3-opus"))
    return "claude-opus-3"
  if (value.includes("sonnet-4-6")) return "claude-sonnet-4-6"
  if (value.includes("sonnet-4")) return "claude-sonnet-4"
  if (
    value.includes("sonnet-3-7") ||
    value.includes("sonnet-3-5") ||
    value.includes("3-7-sonnet") ||
    value.includes("3-5-sonnet")
  )
    return "claude-sonnet-3"
  if (value.includes("haiku-4-5")) return "claude-haiku-4"
  if (value.includes("haiku-3-5") || value.includes("3-5-haiku"))
    return "claude-haiku-3.5"
  if (value.includes("haiku-3") || value.includes("3-haiku"))
    return "claude-haiku-3"

  if (value.startsWith("gemini-3-8-flash")) return "gemini-3.8-flash"

  for (const [prefix, key] of OPENAI_PREFIXES) if (value === prefix || value.startsWith(`${prefix}-`)) return key
  return null
}

/**
 * OpenAI's model ids as the table keys them, a variant (`-mini`, `-pro`)
 * before the model it names, so a variant never takes its base model's
 * price. An id matches its prefix whole or followed by a dash: a dated
 * snapshot (`gpt-4o-2024-08-06`) or Codex's `gpt-5-codex`.
 */
const OPENAI_PREFIXES: readonly (readonly [string, string])[] = [
  ["gpt-6-astra", "gpt-6-astra"],
  ["gpt-6-1-sol", "gpt-6.1-sol"],
  ["gpt-6-1-terra", "gpt-6.1-terra"],
  ["gpt-6-sol", "gpt-6-sol"],
  ["gpt-6-luna", "gpt-6-luna"],
  ["gpt-5-6-terra", "gpt-5.6-terra"],
  ["gpt-5-6-luna", "gpt-5.6-luna"],
  ["gpt-5-6-sol", "gpt-5.6-sol"],
  ["gpt-5-6", "gpt-5.6-sol"],
  ["gpt-5-5-pro", "gpt-5.5-pro"],
  ["gpt-5-5", "gpt-5.5"],
  ["gpt-5-4-mini", "gpt-5.4-mini"],
  ["gpt-5-4-nano", "gpt-5.4-nano"],
  ["gpt-5-4-pro", "gpt-5.4-pro"],
  ["gpt-5-4", "gpt-5.4"],
  ["gpt-5-3", "gpt-5.3"],
  ["gpt-5-2-pro", "gpt-5.2-pro"],
  ["gpt-5-2", "gpt-5.2"],
  ["gpt-5-1", "gpt-5.1"],
  ["gpt-5-pro", "gpt-5-pro"],
  ["gpt-5-mini", "gpt-5-mini"],
  ["gpt-5-nano", "gpt-5-nano"],
  ["gpt-5", "gpt-5"],
  ["gpt-4-1-mini", "gpt-4.1-mini"],
  ["gpt-4-1", "gpt-4.1"],
  ["gpt-4o-mini", "gpt-4o-mini"],
  ["gpt-4o", "gpt-4o"],
  ["o3-pro", "o3-pro"],
  ["o3", "o3"],
  ["o4-mini", "o4-mini"],
  ["codex-mini", "codex-mini"],
]
