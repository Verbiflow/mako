import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { savedModelNamer, UtilityModelCatalog } from "../electron/utility-model-catalog.ts"
import { UtilityModelStore } from "../electron/utility-model-store.ts"
import { memorySecrets } from "../electron/secrets.ts"

const root = await mkdtemp(join(tmpdir(), "mako-model-catalog-"))
const store = new UtilityModelStore(root, memorySecrets({ durable: false }))
const textModel = {
  name: "New model",
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 1_048_576, output: 65_536 },
  release_date: "2026-09-02",
}
const publicData = {
  google: {
    models: {
      "gemini-3.8-flash": {
        ...textModel,
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
      },
      "gemini-2.5-flash": {
        ...textModel,
        id: "gemini-2.5-flash",
        release_date: "2025-06-17",
      },
      "future-flash": {
        ...textModel,
        id: "future-flash",
        release_date: "2026-10-01",
      },
      embedding: {
        ...textModel,
        id: "embedding",
        modalities: { input: ["text"], output: [] },
      },
      image: {
        ...textModel,
        id: "image",
        modalities: { input: ["text"], output: ["image", "text"] },
      },
      retired: { ...textModel, id: "retired", status: "deprecated" },
    },
  },
  openai: {
    models: {
      "gpt-6-astra": {
        ...textModel,
        id: "gpt-6-astra",
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    },
  },
  anthropic: {
    models: { "claude-fable-5-1": { ...textModel, id: "claude-fable-5-1" } },
  },
}
let publicCalls = 0
let failPublic = false
let repeatPage = false
let providerCalls = 0
const keys: string[] = []
const request: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const headers = new Headers(init?.headers)
  assert.equal(init?.redirect, "error")
  assert.ok(init?.signal)
  if (url.hostname === "models.dev") {
    publicCalls += 1
    assert.equal(
      [...headers].some(([name]) => /key|authorization/.test(name)),
      false
    )
    if (failPublic) throw new Error("Simulated offline")
    return Response.json(publicData)
  }
  providerCalls += 1
  const key =
    headers.get("x-goog-api-key") ??
    headers.get("x-api-key") ??
    headers.get("authorization") ??
    ""
  keys.push(key)
  assert.equal(url.searchParams.has("key"), false)
  if (key.includes("invalid"))
    return Response.json(
      { error: { message: "SECRET_RESPONSE_DO_NOT_RETURN" } },
      { status: 401 }
    )
  if (url.hostname === "generativelanguage.googleapis.com") {
    if (url.searchParams.has("pageToken") && !repeatPage)
      return Response.json({
        models: [
          {
            name: "models/account-new-model",
            displayName: "Account new model",
            inputTokenLimit: 99_000,
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      })
    return Response.json({
      models: [
        {
          name: "models/gemini-3.8-flash",
          displayName: "Gemini 3.8 Flash",
          inputTokenLimit: 1_048_576,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/text-embedding",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
      nextPageToken: "page-two",
    })
  }
  if (url.hostname === "api.anthropic.com") {
    assert.equal(headers.get("anthropic-version"), "2023-06-01")
    return Response.json({
      data: [
        {
          id: "claude-fable-5-1",
          display_name: "Claude Fable 5.1",
          max_input_tokens: 1_000_000,
        },
      ],
      has_more: false,
    })
  }
  if (url.hostname === "api.openai.com")
    return Response.json({
      data: [
        { id: "gpt-6-astra" },
        { id: "gpt-new-model" },
        { id: "text-embedding-3-large" },
        { id: "gpt-realtime" },
      ],
    })
  assert.equal(url.href, "http://localhost:11434/v1/models")
  return Response.json({
    data: [
      { id: "local-model", name: "My local model", context_length: 32_000 },
    ],
  })
}
try {
  const catalog = new UtilityModelCatalog(store, request)
  const [google, openai] = await Promise.all([
    catalog.list({ provider: "google", source: "catalog" }),
    catalog.list({ provider: "openai", source: "catalog" }),
  ])
  assert.equal(publicCalls, 1)
  assert.equal(google.source, "catalog")
  assert.equal(google.models[0]?.id, "future-flash")
  assert.ok(google.models.some((model) => model.id === "gemini-3.8-flash"))
  assert.equal(google.models.length, 3)
  assert.equal(openai.models[0]?.contextTokens, 922_000)
  const account = await catalog.list({
    source: "provider",
    provider: "google",
    apiKey: "synthetic-first",
  })
  assert.equal(account.source, "provider")
  assert.deepEqual(
    new Set(account.models.map((model) => model.id)),
    new Set(["gemini-3.8-flash", "account-new-model"])
  )
  await catalog.list({
    source: "provider",
    provider: "google",
    apiKey: "synthetic-second",
  })
  assert.deepEqual(keys.slice(0, 4), [
    "synthetic-first",
    "synthetic-first",
    "synthetic-second",
    "synthetic-second",
  ])
  assert.doesNotMatch(JSON.stringify(account), /synthetic/)
  const claude = await catalog.list({
    source: "provider",
    provider: "anthropic",
    apiKey: "synthetic-key",
  })
  assert.equal(claude.models[0]?.contextTokens, 1_000_000)
  const gpt = await catalog.list({
    source: "provider",
    provider: "openai",
    apiKey: "synthetic-key",
  })
  assert.equal(gpt.models.length, 2)
  const local = await catalog.list({
    source: "provider",
    provider: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
  })
  assert.equal(local.models[0]?.id, "local-model")
  assert.equal(local.models[0]?.contextTokens, 32_000)
  const before = providerCalls
  await assert.rejects(
    catalog.list({
      source: "provider",
      provider: "google",
      apiKey: "invalid-key",
    }),
    (error: Error) => {
      assert.match(error.message, /API key/)
      assert.doesNotMatch(error.message, /SECRET_RESPONSE|invalid-key/)
      return true
    }
  )
  assert.equal(providerCalls, before + 1)
  await assert.rejects(
    catalog.list({
      source: "provider",
      provider: "google",
      apiKey: `synthetic-secret${String.fromCharCode(1)}invalid`,
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /synthetic-secret/)
      return true
    }
  )
  assert.equal(providerCalls, before + 1)
  repeatPage = true
  await assert.rejects(
    catalog.list({
      source: "provider",
      provider: "google",
      apiKey: "synthetic-key",
    }),
    /pagination/
  )
  repeatPage = false
  failPublic = true
  const stale = await catalog.list({
    source: "catalog",
    provider: "google",
    refresh: true,
  })
  assert.equal(stale.stale, true)
  assert.ok(stale.notice)
  assert.equal(stale.fetchedAt, google.fetchedAt)
  assert.equal(stale.models.length, google.models.length)
  await assert.rejects(
    new UtilityModelCatalog(store, request).list({
      source: "catalog",
      provider: "google",
    }),
    /catalog/
  )
  await assert.rejects(
    catalog.list({
      source: "provider",
      provider: "openai-compatible",
      baseUrl: "https://name:password@example.test/v1",
    }),
    /credentials/
  )
  const oversized = new UtilityModelCatalog(
    store,
    async () => new Response("x".repeat(2_000_001))
  )
  await assert.rejects(
    oversized.list({
      source: "provider",
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080/v1",
    }),
    /size limit/
  )
  const malformed = new UtilityModelCatalog(store, async () =>
    Response.json({ unexpected: "SECRET_RESPONSE_DO_NOT_RETURN" })
  )
  await assert.rejects(
    malformed.list({
      source: "provider",
      provider: "openai",
      apiKey: "synthetic-key",
    }),
    (error: Error) => {
      assert.match(error.message, /unsupported model catalog/)
      assert.doesNotMatch(error.message, /SECRET_RESPONSE/)
      return true
    }
  )
  let pages = 0
  const endless = new UtilityModelCatalog(store, async () => {
    pages += 1
    return Response.json({
      data: [{ id: `model-${pages}` }],
      has_more: true,
      last_id: `page-${pages}`,
    })
  })
  const partial = await endless.list({
    source: "provider",
    provider: "anthropic",
    apiKey: "synthetic-key",
  })
  assert.equal(pages, 10)
  assert.ok(partial.notice)
  const truncated = new UtilityModelCatalog(store, async () =>
    Response.json({
      data: Array.from({ length: 2_001 }, (_, index) => ({
        id: `model-${index}`,
      })),
    })
  )
  const capped = await truncated.list({
    source: "provider",
    provider: "openai",
    apiKey: "synthetic-key",
  })
  assert.equal(capped.models.length, 2_000)
  assert.ok(capped.notice)
  // Keys saved before names were kept: catalog names, once per key, never custom ids or endpoints.
  failPublic = false
  repeatPage = false
  const renamed: string[] = []
  const name = savedModelNamer(new UtilityModelCatalog(store, request), {
    nameModel: async (provider, model, label) => {
      renamed.push(`${provider}/${model}=${label}`)
      return true
    },
  })
  const saved = [
    { provider: "google", model: "gemini-3.8-flash", contextTokens: 1_048_576 },
    { provider: "anthropic", model: "custom-id", contextTokens: 200_000 },
    { provider: "openai-compatible", model: "local", baseUrl: "http://127.0.0.1:1/v1", contextTokens: 32_000 },
    { provider: "openai", model: "gpt-6-astra", name: "Already named", contextTokens: 922_000 },
  ] as const
  assert.equal(await name(saved), true)
  assert.deepEqual(renamed, ["google/gemini-3.8-flash=Gemini 3.8 Flash"])
  assert.equal(await name(saved), false, "Each key is tried once per run")
  assert.equal(renamed.length, 1)
  const offline = savedModelNamer(new UtilityModelCatalog(store, async () => { throw new Error("offline") }), {
    nameModel: async () => assert.fail("Nothing to name without a catalog"),
  })
  assert.equal(await offline(saved), false)
  if (process.argv.includes("--live")) {
    const live = new UtilityModelCatalog(store)
    const providers = ["google", "openai", "anthropic"] as const
    const results = await Promise.all(
      providers.map(async (provider) => {
        const result = await live.list({ source: "catalog", provider })
        assert.ok(result.models.length > 0)
        if (provider === "google")
          assert.ok(
            result.models.some((model) => model.id === "gemini-3.8-flash")
          )
        return {
          provider,
          models: result.models.length,
          newest: result.models[0]?.name,
        }
      })
    )
    console.log("Live public catalogs:", results)
  }
  console.log(
    "Model catalogs: current IDs, future IDs without code changes, modality filtering, metadata, pagination, per-key isolation, caching, offline fallback, secret-safe failures, names for keys saved without one passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
