import { z } from "zod"

/**
 * One token count as a harness reports it. A count left out, or one that is
 * not a count, reads as nothing, so the rest of its reading still counts.
 */
export const tokenCount = z.number().nonnegative().nullish().catch(undefined)

/**
 * A call's or a turn's tokens in Mako's names, for the live meter, the saved
 * turn and the 30-day usage history alike. `input` is what neither cache
 * supplied; `output` includes reasoning.
 */
export interface HarnessTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The part of `output` spent reasoning, when the harness says. */
  reasoning?: number
}

/** A harness's own counts, before they are put in Mako's terms. */
export interface ReportedTokens {
  input?: number | null
  output?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  reasoning?: number | null
}

/**
 * Counts from a harness whose `input` includes the input the cache read and
 * wrote. Neither cache can supply more than the input, so a cache count past
 * it is cut to it instead of being priced twice.
 */
export function inclusiveTokens(counts: ReportedTokens): HarnessTokens {
  const input = counts.input ?? 0
  const cacheRead = Math.min(counts.cacheRead ?? 0, input)
  const cacheWrite = Math.min(counts.cacheWrite ?? 0, input - cacheRead)
  return withReasoning({ input: input - cacheRead - cacheWrite, output: counts.output ?? 0, cacheRead, cacheWrite }, counts.reasoning)
}

/** Counts from a harness whose `input` already leaves out what the cache supplied. */
export function exclusiveTokens(counts: ReportedTokens): HarnessTokens {
  return withReasoning({
    input: counts.input ?? 0,
    output: counts.output ?? 0,
    cacheRead: counts.cacheRead ?? 0,
    cacheWrite: counts.cacheWrite ?? 0,
  }, counts.reasoning)
}

export function tokenSum(tokens: HarnessTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

function withReasoning(tokens: HarnessTokens, reasoning: number | null | undefined): HarnessTokens {
  if (reasoning) tokens.reasoning = reasoning
  return tokens
}
