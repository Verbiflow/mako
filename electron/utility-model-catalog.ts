import { z } from "zod"
import type {
  UtilityCatalog,
  UtilityCatalogInput,
  UtilityConnection,
  UtilityModel,
  UtilityProvider,
} from "./shared.js"
import type { UtilityModelStore } from "./utility-model-store.js"
import { utilityProviders } from "./utility-models.js"

const MAX_MODELS = 2_000
const CACHE_TTL = 5 * 60_000
const MAX_STALE = 24 * 60 * 60_000
const identifier = z.string().min(1).max(200)
const tokenLimit = z.number().int().nonnegative().nullish()
const catalogModel = z.object({
  id: identifier,
  name: z.string().max(300),
  release_date: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  modalities: z
    .object({ input: z.array(z.string()), output: z.array(z.string()) })
    .optional(),
  limit: z.object({ context: tokenLimit, input: tokenLimit }).optional(),
})
const catalogProvider = z
  .object({ models: z.record(z.string(), catalogModel) })
  .optional()
const publicCatalog = z.object({
  google: catalogProvider,
  openai: catalogProvider,
  anthropic: catalogProvider,
})
const googlePage = z.object({
  models: z
    .array(
      z.object({
        name: z.string().max(250),
        displayName: z.string().max(300).optional(),
        inputTokenLimit: tokenLimit,
        supportedGenerationMethods: z.array(z.string()).optional(),
      })
    )
    .max(5_000)
    .default([]),
  nextPageToken: z.string().max(4_096).optional(),
})
const apiPage = z.object({
  data: z
    .array(
      z.object({
        id: identifier,
        display_name: z.string().max(300).optional(),
        name: z.string().max(300).optional(),
        created_at: z.string().max(40).optional(),
        context_length: tokenLimit,
        max_input_tokens: tokenLimit,
      })
    )
    .max(5_000),
  has_more: z.boolean().optional(),
  last_id: z.string().max(300).nullable().optional(),
})
const nonTextModel =
  /(?:^|[-/_.])(?:embedding|embed|image|imagen|veo|tts|transcribe|transcription|whisper|audio|realtime|live|moderation|dall-e|sora)(?:[-/_.]|$)/i

/**
 * Names keys saved before names were kept, from the catalog, with one try per
 * key while the host runs. Each call waits up to `waitMs` and says whether a
 * key was named by then; a slow catalog finishes in the background.
 */
export function savedModelNamer(
  catalog: Pick<UtilityModelCatalog, "nameOf">,
  models: Pick<UtilityModelStore, "nameModel">,
  waitMs = 1_500
): (connections: readonly UtilityConnection[]) => Promise<boolean> {
  const tried = new Set<string>()
  return async (connections) => {
    const unnamed = connections.filter((connection) => !connection.name && !tried.has(`${connection.provider}/${connection.model}`))
    if (!unnamed.length) return false
    for (const connection of unnamed) tried.add(`${connection.provider}/${connection.model}`)
    const naming = Promise.all(unnamed.map(async (connection) => {
      const name = await catalog.nameOf(connection.provider, connection.model)
      return name ? models.nameModel(connection.provider, connection.model, name).catch(() => false) : false
    })).then((named) => named.includes(true))
    return Promise.race([naming, new Promise<false>((resolve) => setTimeout(resolve, waitMs, false))])
  }
}

interface CatalogCache {
  fetchedAt: number
  providers: Map<UtilityProvider, UtilityModel[]>
}

export class UtilityModelCatalog {
  private cache: CatalogCache | undefined
  private pending: Promise<CatalogCache> | undefined
  private readonly store: UtilityModelStore
  private readonly request: typeof fetch

  constructor(store: UtilityModelStore, request: typeof fetch = fetch) {
    this.store = store
    this.request = request
  }

  async list(input: UtilityCatalogInput): Promise<UtilityCatalog> {
    if (input.source === "provider") return this.fromProvider(input)
    if (input.provider === "openai-compatible")
      throw new CatalogError(
        "Enter an endpoint and fetch its models, or use a custom model ID."
      )
    try {
      if (
        input.refresh ||
        !this.cache ||
        Date.now() - this.cache.fetchedAt >= CACHE_TTL
      ) {
        this.pending ??= this.refresh().finally(() => {
          this.pending = undefined
        })
        this.cache = await this.pending
      }
      return this.snapshot(input.provider, this.cache, false)
    } catch {
      if (this.cache && Date.now() - this.cache.fetchedAt < MAX_STALE)
        return this.snapshot(input.provider, this.cache, true)
      throw new CatalogError(
        "The model catalog could not be loaded. Retry, fetch models with your API key, or enter a custom model ID."
      )
    }
  }

  /** The catalog's name for `model`, or nothing when the catalog doesn't list it or can't be read. */
  async nameOf(provider: UtilityProvider, model: string): Promise<string | undefined> {
    if (provider === "openai-compatible") return undefined
    const listed = await this.list({ source: "catalog", provider }).catch(() => undefined)
    return listed?.models.find((entry) => entry.id === model)?.name
  }

  private snapshot(
    provider: UtilityProvider,
    cache: CatalogCache,
    stale: boolean
  ): UtilityCatalog {
    const models = cache.providers.get(provider) ?? []
    return {
      source: "catalog",
      models,
      fetchedAt: cache.fetchedAt,
      stale,
      notice: stale
        ? "Catalog refresh failed. Showing the last successful catalog; account access is not verified."
        : undefined,
    }
  }

  private async refresh(): Promise<CatalogCache> {
    const data = await readCatalogPage(
      this.request,
      new URL("https://models.dev/api.json"),
      new Headers(),
      publicCatalog,
      AbortSignal.timeout(15_000),
      16_000_000
    )
    const providers = new Map<UtilityProvider, UtilityModel[]>()
    for (const { id } of utilityProviders) {
      if (id === "openai-compatible") continue
      const source = data[id]
      if (!source) throw new CatalogError("Provider missing from model catalog")
      const models = Object.values(source.models)
        .filter(
          (model) =>
            model.status !== "deprecated" &&
            model.modalities?.input.includes("text") &&
            model.modalities.output.length === 1 &&
            model.modalities.output[0] === "text" &&
            !nonTextModel.test(model.id)
        )
        .map((model) => ({
          id: model.id,
          name: model.name,
          releaseDate: model.release_date,
          contextTokens:
            model.limit?.input || model.limit?.context || undefined,
        }))
      providers.set(id, sortModels(models).slice(0, MAX_MODELS))
    }
    return { fetchedAt: Date.now(), providers }
  }

  private async fromProvider(
    input: Extract<UtilityCatalogInput, { source: "provider" }>
  ): Promise<UtilityCatalog> {
    const credentials = await this.store.credentials(input)
    const known = new Map(
      this.cache?.providers
        .get(input.provider)
        ?.map((model) => [model.id, model])
    )
    const signal = AbortSignal.timeout(20_000)
    const headers = new Headers({ Accept: "application/json" })
    let endpoint: URL
    switch (credentials.provider) {
      case "google":
        endpoint = new URL(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
        )
        headers.set("x-goog-api-key", credentials.apiKey)
        break
      case "anthropic":
        endpoint = new URL("https://api.anthropic.com/v1/models?limit=1000")
        headers.set("x-api-key", credentials.apiKey)
        headers.set("anthropic-version", "2023-06-01")
        break
      case "openai":
        endpoint = new URL("https://api.openai.com/v1/models")
        headers.set("Authorization", `Bearer ${credentials.apiKey}`)
        break
      case "openai-compatible":
        endpoint = new URL(`${credentials.baseUrl}/models`)
        if (credentials.apiKey)
          headers.set("Authorization", `Bearer ${credentials.apiKey}`)
        break
    }
    const models = new Map<string, UtilityModel>()
    const cursors = new Set<string>()
    for (let page = 0; page < 10; page += 1) {
      let next: string | undefined
      if (input.provider === "google") {
        const data = await readCatalogPage(
          this.request,
          endpoint,
          headers,
          googlePage,
          signal
        )
        for (const model of data.models) {
          const id = model.name.replace(/^models\//, "")
          if (
            !model.supportedGenerationMethods?.includes("generateContent") ||
            nonTextModel.test(id)
          )
            continue
          models.set(id, {
            id,
            name: model.displayName ?? known.get(id)?.name ?? id,
            contextTokens:
              model.inputTokenLimit || known.get(id)?.contextTokens,
            releaseDate: known.get(id)?.releaseDate,
          })
        }
        next = data.nextPageToken
        if (next) endpoint.searchParams.set("pageToken", next)
      } else {
        const data = await readCatalogPage(
          this.request,
          endpoint,
          headers,
          apiPage,
          signal
        )
        for (const model of data.data) {
          if (nonTextModel.test(model.id)) continue
          const metadata = known.get(model.id)
          models.set(model.id, {
            id: model.id,
            name:
              model.display_name ?? model.name ?? metadata?.name ?? model.id,
            contextTokens:
              model.max_input_tokens ||
              model.context_length ||
              metadata?.contextTokens,
            releaseDate: model.created_at ?? metadata?.releaseDate,
          })
        }
        if (data.has_more) {
          next = data.last_id ?? data.data.at(-1)?.id
          if (!next)
            throw new CatalogError(
              "The provider returned invalid model pagination. Enter a model ID or retry."
            )
          endpoint.searchParams.set(
            input.provider === "anthropic" ? "after_id" : "after",
            next
          )
        }
      }
      if (next && cursors.has(next))
        throw new CatalogError(
          "The provider repeated model pagination. Enter a model ID or retry."
        )
      if (next) cursors.add(next)
      const truncated =
        models.size > MAX_MODELS ||
        Boolean(next && (models.size >= MAX_MODELS || page === 9))
      if (!next || truncated)
        return {
          source: "provider",
          models: sortModels([...models.values()]).slice(0, MAX_MODELS),
          fetchedAt: Date.now(),
          stale: false,
          notice: truncated
            ? "The provider returned more models than can be listed. You can still enter an unlisted model ID."
            : undefined,
        }
    }
    throw new CatalogError("Model pagination could not complete. Try again.")
  }
}

function sortModels(models: UtilityModel[]): UtilityModel[] {
  return models.sort(
    (left, right) =>
      (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "") ||
      left.name.localeCompare(right.name, undefined, { numeric: true })
  )
}

class CatalogError extends Error {}

async function readCatalogPage<T>(
  request: typeof fetch,
  url: URL,
  headers: Headers,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  limit = 2_000_000
): Promise<T> {
  try {
    const response = await request(url, { headers, signal, redirect: "error" })
    if (!response.ok) {
      await response.body?.cancel()
      if ([400, 401, 403].includes(response.status))
        throw new CatalogError(
          "The provider could not list models with this API key. Check the key and its permissions, or use the public catalog."
        )
      throw new CatalogError(
        `Model discovery returned HTTP ${response.status}. Check the endpoint and retry, or enter a model ID.`
      )
    }
    if (!response.body)
      throw new CatalogError("The model catalog response was empty.")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > limit)
          throw new CatalogError(
            "The model catalog response exceeded the size limit. Enter a model ID instead."
          )
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const parsed = schema.safeParse(
      JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
    )
    if (!parsed.success)
      throw new CatalogError(
        "The endpoint returned an unsupported model catalog. Check its URL or enter a model ID."
      )
    return parsed.data
  } catch (error) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError(
      signal.aborted
        ? "Model discovery timed out. Retry or enter a model ID."
        : "Could not load the model catalog. Check the endpoint and connection, then retry."
    )
  }
}
