import { z } from "zod"
import type { UtilityConnection, UtilityConnectionInput, UtilityProviderInfo } from "./shared.js"

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
  name: z.string().trim().min(1).max(300).optional(),
  baseUrl: z.string().max(2_048).optional(),
  contextTokens: z.number().int().min(8_192).max(2_000_000),
})

export function parseConnection(input: UtilityConnectionInput): UtilityConnection {
  const parsed = connectionSchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      "Choose a model ID and a context limit between 8,192 and 2,000,000 tokens."
    )
  // A name that only repeats the id says nothing; the id shows on its own.
  const { name, ...connection } = parsed.data
  const named = name && name !== connection.model ? { ...connection, name } : connection
  return { ...named, baseUrl: parseUtilityEndpoint(parsed.data) }
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

export { UtilityModelError } from "./utility-model-error.js"
