import { z } from "zod"
import type { UtilityConnection } from "../contracts/utility-models.js"

export interface UtilityTokenInput {
  instructions: string
  prompt: string
  signal: AbortSignal
}

export type UtilityTokenCounter = (
  input: UtilityTokenInput
) => Promise<number | null>

const countSchema = z.object({
  totalTokens: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
})

export function utilityTokenCounter(
  connection: UtilityConnection,
  apiKey: string,
  request: typeof fetch = fetch
): UtilityTokenCounter {
  return async ({ instructions, prompt, signal }) => {
    signal.throwIfAborted()
    if (connection.provider === "openai-compatible") return null
    try {
      const headers = new Headers({ "Content-Type": "application/json" })
      let url: string
      let body: string
      switch (connection.provider) {
        case "google":
          url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(connection.model)}:countTokens`
          headers.set("x-goog-api-key", apiKey)
          body = JSON.stringify({
            generateContentRequest: {
              model: `models/${connection.model}`,
              systemInstruction: { parts: [{ text: instructions }] },
              contents: [{ role: "user", parts: [{ text: prompt }] }],
            },
          })
          break
        case "anthropic":
          url = "https://api.anthropic.com/v1/messages/count_tokens"
          headers.set("x-api-key", apiKey)
          headers.set("anthropic-version", "2023-06-01")
          body = JSON.stringify({
            model: connection.model,
            system: instructions,
            messages: [{ role: "user", content: prompt }],
          })
          break
        case "openai":
          url = "https://api.openai.com/v1/responses/input_tokens"
          headers.set("Authorization", `Bearer ${apiKey}`)
          body = JSON.stringify({
            model: connection.model,
            instructions,
            input: [{ role: "user", content: prompt }],
          })
          break
      }
      const response = await request(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        return null
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > 64 * 1024) return null
          chunks.push(part.value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      const parsed = countSchema.safeParse(
        JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
      )
      return parsed.success
        ? (parsed.data.totalTokens ?? parsed.data.input_tokens ?? null)
        : null
    } catch {
      signal.throwIfAborted()
      return null
    }
  }
}
