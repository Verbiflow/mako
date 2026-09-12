import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
  APICallError,
  extractJsonMiddleware,
  generateText,
  NoObjectGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  wrapLanguageModel,
  type LanguageModel,
} from "ai"
import { z } from "zod"
import type { UtilityConnectionInput, UtilityProviderInfo } from "./shared.js"

export const utilityProviders: UtilityProviderInfo[] = [
  {
    id: "google",
    name: "Google",
    description: "Gemini with a Google AI Studio API key",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models with an OpenAI API key",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude with an Anthropic API key",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    description: "OpenRouter, local models, or your own endpoint",
  },
]

export const utilityProviderSchema = z.enum([
  "google",
  "openai",
  "anthropic",
  "openai-compatible",
])

export const connectionSchema = z.object({
  provider: utilityProviderSchema,
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/),
  baseUrl: z.string().max(2_048).optional(),
  contextTokens: z.number().int().min(8_192).max(2_000_000),
})

export function parseConnection(input: UtilityConnectionInput) {
  const parsed = connectionSchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      "Choose a model ID and a context limit between 8,192 and 2,000,000 tokens."
    )
  return { ...parsed.data, baseUrl: parseUtilityEndpoint(parsed.data) }
}

export function parseUtilityEndpoint(
  connection: Pick<UtilityConnectionInput, "provider" | "baseUrl">
): string | undefined {
  if (connection.provider !== "openai-compatible") {
    if (connection.baseUrl)
      throw new Error(
        "Custom endpoints require an OpenAI-compatible connection."
      )
    return undefined
  }
  let url: URL
  try {
    url = new URL(connection.baseUrl ?? "")
  } catch {
    throw new Error(
      "Enter the endpoint's full base URL, including /v1 if required."
    )
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use HTTPS, or HTTP on localhost. The endpoint URL cannot contain credentials, a query, or a fragment."
    )
  return url.href.replace(/\/$/, "")
}

const privateFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error" })

/** A provider model instance; gateway model-id strings are never used for utility calls. */
export type UtilityLanguageModel = Exclude<LanguageModel, string>

export function utilityLanguageModel(
  connection: UtilityConnectionInput,
  apiKey: string,
  request: typeof fetch = privateFetch
): UtilityLanguageModel {
  const options = { apiKey, fetch: request }
  switch (connection.provider) {
    case "google":
      return createGoogleGenerativeAI(options)(connection.model)
    case "openai":
      return createOpenAI(options)(connection.model)
    case "anthropic":
      return createAnthropic(options)(connection.model)
    case "openai-compatible":
      return createOpenAICompatible({
        ...options,
        name: "custom",
        baseURL: connection.baseUrl!,
        // Send response_format json_schema (OpenRouter, Ollama, LM Studio, vLLM) instead of
        // the bare json_object mode the SDK falls back to with a warning.
        supportsStructuredOutputs: true,
      })(connection.model)
  }
}

type UtilityErrorKind =
  "context" | "auth" | "rate-limit" | "timeout" | "output" | "request"

export class UtilityModelError extends Error {
  readonly kind: UtilityErrorKind

  constructor(kind: UtilityErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = "UtilityModelError"
  }
}

function outputLimitError(): UtilityModelError {
  return new UtilityModelError(
    "output",
    "The model reached its output limit. Try a non-reasoning model or retry with shorter instructions."
  )
}

/** Names the failing field, never the model's text, so the message stays safe to show and log. */
export function describeStructuredFailure(error: NoObjectGeneratedError): string {
  const cause = error.cause
  if (TypeValidationError.isInstance(cause)) {
    // SAFETY: Output.object validates with the zod schema passed to completeUtilityText, so a
    // TypeValidationError's cause is a ZodError whose issues carry path and message; every
    // field is read optionally, so any other cause degrades to the generic wording below.
    const issues = (cause.cause as { issues?: { path?: PropertyKey[]; message?: string }[] } | undefined)?.issues
    const first = issues?.[0]
    if (first)
      return `${first.path?.length ? first.path.map(String).join(".") : "response"}: ${first.message ?? "invalid"}`
    return "response did not match the schema"
  }
  if (!error.text?.trim()) return "no text was returned"
  return "the reply was not valid JSON"
}

export async function completeUtilityText(
  model: UtilityLanguageModel,
  instructions: string,
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens = 2_048,
  outputSchema?: z.ZodType,
  reasoning: "low" | "high" = "low"
): Promise<string> {
  try {
    // Structured calls ask the provider for JSON natively (Gemini responseSchema, OpenAI
    // json_schema, Anthropic output_format or JSON tool, OpenAI-compatible json_object) and
    // strip Markdown fences before parsing. Prompt-only "return JSON" is not enough: Gemini
    // wraps replies in ```json fences in plain text mode.
    const structured = outputSchema
      ? {
          model: wrapLanguageModel({ model, middleware: extractJsonMiddleware() }),
          output: Output.object({ schema: outputSchema }),
        }
      : { model }
    const result = await generateText({
      ...structured,
      instructions,
      prompt,
      maxOutputTokens,
      reasoning,
      maxRetries: 1,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
      // Non-strict json_schema keeps OpenAI and OpenAI-compatible endpoints from rejecting
      // Kiri's length and range keywords. The compatible provider reads its options under
      // the name given to createOpenAICompatible ("custom").
      providerOptions: {
        openai: { store: false, strictJsonSchema: false },
        custom: { strictJsonSchema: false },
      },
      include: {
        requestBody: false,
        requestMessages: false,
        responseBody: false,
      },
    })
    if (result.finishReason === "length") throw outputLimitError()
    if (outputSchema) return JSON.stringify(result.output)
    const text = result.text.trim()
    if (!text)
      throw new UtilityModelError(
        "output",
        "The model returned no text. Check that this is a text-generation model and try again."
      )
    return text
  } catch (caught) {
    if (signal.aborted)
      throw new UtilityModelError(
        "timeout",
        signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
          ? "Generation timed out. Try again or stage fewer files."
          : "Generation cancelled."
      )
    const error = RetryError.isInstance(caught) ? caught.lastError : caught
    if (error instanceof UtilityModelError) throw error
    if (NoObjectGeneratedError.isInstance(error)) {
      if (error.finishReason === "length") throw outputLimitError()
      throw new UtilityModelError(
        "output",
        `The model returned an invalid structured response (${describeStructuredFailure(error)}). No partial draft was accepted.`
      )
    }
    if (APICallError.isInstance(error)) {
      const status = error.statusCode
      const message = `${error.message} ${error.responseBody ?? ""}`
      if (
        status === 413 ||
        ((status === 400 || status === 422) &&
          /context.{0,30}(length|window|limit)|token.{0,30}(limit|exceed|maximum)|too (many tokens|large|long)|input.{0,30}(long|exceed)/i.test(
            message
          ))
      )
        throw new UtilityModelError(
          "context",
          "The model's context limit was exceeded."
        )
      if (
        status === 401 ||
        status === 403 ||
        (status === 400 &&
          /api.key.{0,30}(invalid|not valid)|API_KEY_INVALID/i.test(message))
      )
        throw new UtilityModelError(
          "auth",
          "The provider rejected this API key. Check the key and its model access in Commit messages settings."
        )
      if (status === 429)
        throw new UtilityModelError(
          "rate-limit",
          "The provider's rate or quota limit was reached. Check billing or wait before retrying."
        )
      if (status === 404)
        throw new UtilityModelError(
          "request",
          "This model or endpoint was not found. Check the model ID and base URL in Commit messages settings."
        )
      throw new UtilityModelError(
        "request",
        `The provider rejected the request${status ? ` (HTTP ${status})` : ""}. Check the model settings and retry.`
      )
    }
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      throw new UtilityModelError(
        "timeout",
        "The model did not respond in time. Try again or choose a faster model."
      )
    throw new UtilityModelError(
      "request",
      "Could not reach the model. Check your connection and endpoint, then retry."
    )
  }
}
