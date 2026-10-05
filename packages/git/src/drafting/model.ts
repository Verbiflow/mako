import type { z } from "zod"
import { jsonSchema, parseReply, type JsonSchema } from "./replies.js"

/**
 * A model that writes from Git evidence. The host's model system supplies it,
 * whether a harness's light model or a connection's; this package never
 * chooses one.
 */
export interface DraftingModel {
  /** What the model reads at once; requests are cut to fit. */
  contextTokens: number
  /** The same for every run of the same model and endpoint; summaries are kept by it. */
  identity: string
  countTokens?(input: { instructions: string; prompt: string; signal: AbortSignal }): Promise<number | null | undefined>
  complete(request: { instructions: string; prompt: string; schema?: JsonSchema; maxOutputTokens: number; reasoning: "low" | "high" }, signal: AbortSignal): Promise<string>
}

/** Fast answers from what the summaries say; deep lets the model read the original patches too. */
export type DraftMode = "fast" | "deep"

export interface DraftOptions {
  model: DraftingModel
  mode?: DraftMode
  /** The person's style; the built-in one when absent. */
  style?: string
  signal: AbortSignal
  /** Whether a model's error means its request was too long; such a draft is retried in smaller pieces. */
  tooLong?: (error: Error) => boolean
}

/** A request that won't fit the model. Drafting splits the evidence finer and starts again. */
export class ContextOverflow extends Error {
  constructor() {
    super("The request exceeds this model's context window.")
    this.name = "ContextOverflow"
  }
}

/** Model requests one draft may make, retries included. */
export const MAX_CALLS = 80

export class ModelSession {
  readonly options: DraftOptions
  readonly outputTokens: number
  readonly reasoning: "low" | "high"
  calls = 0

  constructor(options: DraftOptions) {
    this.options = options
    const deep = options.mode === "deep"
    this.outputTokens = Math.min(deep ? 8_192 : 2_048, Math.floor(options.model.contextTokens / 4))
    this.reasoning = deep ? "high" : "low"
  }

  get deep(): boolean {
    return this.options.mode === "deep"
  }

  /** The largest piece of evidence one request carries, from what the model reads. */
  get chunkBytes(): number {
    return Math.min(1_048_576, Math.max(4_096, (this.options.model.contextTokens - this.outputTokens - 2_048) * 4))
  }

  remaining(): number {
    return MAX_CALLS - this.calls
  }

  /** One request; the reply parsed as `schema`, or undefined when it isn't JSON of that shape. */
  async ask<T>(instructions: string, prompt: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const { model, signal } = this.options
    signal.throwIfAborted()
    if (this.calls >= MAX_CALLS) throw new Error("Model-call budget reached; completed summaries are kept for a retry. No draft was created.")
    this.calls += 1
    const sent = jsonSchema(schema)
    const full = `${instructions}\nReturn only JSON matching this schema:\n${JSON.stringify(sent)}`
    const budget = model.contextTokens - this.outputTokens - 256
    if (Buffer.byteLength(full) + Buffer.byteLength(prompt) > budget) {
      const tokens = await model.countTokens?.({ instructions: full, prompt, signal })
      if (tokens != null && tokens > budget) throw new ContextOverflow()
    }
    let reply: string
    try {
      reply = await model.complete({ instructions: full, prompt, schema: sent, maxOutputTokens: this.outputTokens, reasoning: this.reasoning }, signal)
    } catch (error) {
      if (!signal.aborted && error instanceof Error && this.options.tooLong?.(error)) throw new ContextOverflow()
      throw error
    }
    return parseReply(schema, reply)
  }
}
