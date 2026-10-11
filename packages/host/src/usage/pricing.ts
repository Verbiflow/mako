export interface UsageTokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The part of `cacheWrite` written to a one-hour cache, which Anthropic prices apart. */
  cacheWrite1h?: number
  /** Summed over a turn's calls, so a per-call long-context price can't be told from them and isn't applied. */
  summed?: boolean
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
}

/** Anthropic's list: a five-minute cache write is 1.25x input and a one-hour write 2x. */
function anthropic(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 }
}

/** OpenAI's GPT-6 list: over 272K input tokens, input and cache rates double and output is 1.5x. */
function gpt6(input: number, output: number, cacheRead: number): ModelPrice {
  const cacheWrite = input * 1.25
  return {
    input, output, cacheRead, cacheWrite,
    longContext: { threshold: 272_000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 },
  }
}

/** Standard API prices in USD per million tokens, from docs.claude.com/en/docs/about-claude/pricing (2026-10-06). */
const CLAUDE_PRICES = new Map<string, ModelPrice>([
  ["claude-fable-5-1", anthropic(10, 50, 0.25)],
  ["claude-fable-5", anthropic(10, 50, 1)],
  ["claude-opus-5-5", anthropic(4, 20, 0.2)],
  ["claude-opus-5", anthropic(5, 25, 0.5)],
  ["claude-sonnet-5", anthropic(2, 10, 0.2)],
  ["claude-opus-4-current", anthropic(5, 25, 0.5)],
  ["claude-opus-4-legacy", anthropic(15, 75, 1.5)],
  ["claude-opus-3", anthropic(15, 75, 1.5)],
  ["claude-sonnet-4-6", anthropic(3, 15, 0.3)],
  [
    "claude-sonnet-4",
    { ...anthropic(3, 15, 0.3), longContext: { threshold: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12 } },
  ],
  ["claude-sonnet-3", anthropic(3, 15, 0.3)],
  ["claude-haiku-4", anthropic(1, 5, 0.1)],
  ["claude-haiku-3.5", anthropic(0.8, 4, 0.08)],
  ["claude-haiku-3", { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3, cacheWrite1h: 0.5 }],
])

/** Standard API prices in USD per million tokens; GPT-6 from developers.openai.com/api/docs/pricing (2026-10-06). */
const OPENAI_PRICES = new Map<string, ModelPrice>([
  ["gpt-4.1", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
  ["gpt-4o", { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }],
  ["o3", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
  ["o4-mini", { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 }],
  ["codex-mini", { input: 1.5, output: 6, cacheRead: 0.375, cacheWrite: 1.5 }],
  ["gpt-5", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  ["gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  ["gpt-5.2", { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 }],
  ["gpt-5.3", { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 }],
  ["gpt-5.4", { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 }],
  ["gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 }],
  ["gpt-5.4-nano", { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 }],
  ["gpt-5.4-pro", { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 }],
  ["gpt-5.5", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 }],
  [
    "gpt-5.6-sol",
    {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      longContext: { threshold: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
    },
  ],
  [
    "gpt-5.6-terra",
    {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      longContext: { threshold: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
    },
  ],
  [
    "gpt-5.6-luna",
    {
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
      longContext: { threshold: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
    },
  ],
  ["gpt-6-astra", gpt6(10, 50, 1)],
  ["gpt-6.1-sol", gpt6(2, 10, 0.1)],
  ["gpt-6-luna", gpt6(0.1, 0.5, 0.01)],
])

export function estimateUsageCost(
  model: string | undefined,
  usage: UsageTokenCounts
): number | null {
  const key = pricingKey(model)
  if (key === null) return null
  const price = CLAUDE_PRICES.get(key) ?? OPENAI_PRICES.get(key)
  if (!price) return null

  const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
  const active: Rates =
    price.longContext && !usage.summed && contextTokens > price.longContext.threshold
      ? price.longContext
      : price
  const hour = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite)
  return (
    (usage.input * active.input +
      usage.output * active.output +
      usage.cacheRead * active.cacheRead +
      (usage.cacheWrite - hour) * active.cacheWrite +
      hour * (active.cacheWrite1h ?? active.cacheWrite)) /
    1_000_000
  )
}

function pricingKey(model: string | undefined): string | null {
  if (!model) return null
  const normalized = model.toLowerCase().trim()
  const separator = normalized.search(/[/:]/)
  const provider = separator >= 0 ? normalized.slice(0, separator) : undefined
  if (provider && provider !== "anthropic" && provider !== "openai") return null
  const value = (separator >= 0 ? normalized.slice(separator + 1) : normalized)
    .replace(/\./g, "-")
    .replace(/\((minimal|low|medium|high|xhigh|max|auto|none)\)$/, "")
    .replace(/-(minimal|low|medium|high|xhigh|max|auto|none)$/, "")

  if (value.includes("fable-5-1") || value.includes("mythos-5-1")) return "claude-fable-5-1"
  if (value.includes("fable-5") || value.includes("5-fable") || value.includes("mythos-5"))
    return "claude-fable-5"
  if (value.includes("opus-5-5")) return "claude-opus-5-5"
  if (value.includes("opus-5")) return "claude-opus-5"
  if (value.includes("sonnet-5")) return "claude-sonnet-5"
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

  if (value.startsWith("gpt-6-astra")) return "gpt-6-astra"
  if (value.startsWith("gpt-6-1-sol")) return "gpt-6.1-sol"
  if (value.startsWith("gpt-6-luna")) return "gpt-6-luna"
  if (value.startsWith("gpt-4-1")) return "gpt-4.1"
  if (value.startsWith("gpt-4o")) return "gpt-4o"
  if (value === "o3" || value.startsWith("o3-")) return "o3"
  if (value.startsWith("o4-mini")) return "o4-mini"
  if (value.startsWith("codex-mini")) return "codex-mini"
  if (value.startsWith("gpt-5-6-terra")) return "gpt-5.6-terra"
  if (value.startsWith("gpt-5-6-luna")) return "gpt-5.6-luna"
  if (value === "gpt-5-6" || value.startsWith("gpt-5-6-sol"))
    return "gpt-5.6-sol"
  if (value.startsWith("gpt-5-5")) return "gpt-5.5"
  if (value.startsWith("gpt-5-4-mini")) return "gpt-5.4-mini"
  if (value.startsWith("gpt-5-4-nano")) return "gpt-5.4-nano"
  if (value.startsWith("gpt-5-4-pro")) return "gpt-5.4-pro"
  if (value.startsWith("gpt-5-4")) return "gpt-5.4"
  if (value.startsWith("gpt-5-3")) return "gpt-5.3"
  if (value.startsWith("gpt-5-2")) return "gpt-5.2"
  if (value.startsWith("gpt-5-1")) return "gpt-5.1"
  if (value === "gpt-5" || value.startsWith("gpt-5-codex")) return "gpt-5"
  return null
}
