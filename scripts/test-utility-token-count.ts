import assert from "node:assert/strict"
import { utilityTokenCounter } from "@mako/host/git/utility-token-count"

const input = {
  instructions: "All changes must be considered.",
  prompt: "Complete raw diff including the final change.",
  signal: AbortSignal.timeout(5_000),
}
const providers = [
  {
    provider: "google",
    model: "gemini-3.8-flash",
    path: "/v1beta/models/gemini-3.8-flash:countTokens",
    header: "x-goog-api-key",
  },
  {
    provider: "openai",
    model: "gpt-6-astra",
    path: "/v1/responses/input_tokens",
    header: "authorization",
  },
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    path: "/v1/messages/count_tokens",
    header: "x-api-key",
  },
] as const
for (const provider of providers) {
  let calls = 0
  const request: typeof fetch = async (url, options) => {
    calls += 1
    assert.equal(new URL(String(url)).pathname, provider.path)
    assert.equal(new URL(String(url)).search, "")
    assert.equal(options?.method, "POST")
    assert.equal(options?.redirect, "error")
    assert.ok(
      new Headers(options?.headers)
        .get(provider.header)
        ?.includes("synthetic-token-key")
    )
    assert.ok(String(options?.body).includes(input.instructions))
    assert.ok(String(options?.body).includes(input.prompt))
    assert.ok(String(options?.body).includes(provider.model))
    return Response.json(
      provider.provider === "google"
        ? { totalTokens: 123 }
        : { input_tokens: 123 }
    )
  }
  const count = utilityTokenCounter(
    {
      provider: provider.provider,
      model: provider.model,
      contextTokens: 128_000,
    },
    "synthetic-token-key",
    request
  )
  assert.equal(await count(input), 123)
  assert.equal(calls, 1)
}
let customCalled = false
const custom = utilityTokenCounter(
  { provider: "openai-compatible", model: "local", contextTokens: 32_000 },
  "synthetic-token-key",
  async () => {
    customCalled = true
    return Response.json({ input_tokens: 10 })
  }
)
assert.equal(await custom(input), null)
assert.equal(customCalled, false)
for (const response of [
  Response.json({ input_tokens: -1 }),
  Response.json({ error: "synthetic-secret-must-not-escape" }, { status: 403 }),
  new Response("x".repeat(65_537)),
  new Response("invalid"),
]) {
  const count = utilityTokenCounter(
    { provider: "openai", model: "gpt-6-astra", contextTokens: 128_000 },
    "synthetic-token-key",
    async () => response
  )
  assert.equal(await count(input), null)
}
await assert.rejects(
  custom({ ...input, signal: AbortSignal.abort() }),
  /abort/i
)
console.log(
  "Token counting: Google, OpenAI and Anthropic request formats, complete input, secret-safe fallback, bounded responses, unsupported custom endpoints and cancellation passed"
)
