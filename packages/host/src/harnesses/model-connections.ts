import { stoppingSignal } from "../base/host-stopping.js"
import { hostFetch } from "../base/host-stopping.js"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Secrets } from "../base/secrets.js"
import { GrantedSecrets } from "../base/secret-grants.js"
import { publishFile } from "../base/published-files.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import {
  MODEL_CONNECTION_PROVIDERS,
  type ConnectionModel,
  type LocalModelServer,
  type ModelConnection,
  type ModelConnectionCheck,
  type ModelConnectionCheckInput,
  type ModelConnectionInput,
  type ModelConnectionProvider,
  type ModelConnectionsSnapshot,
  type ModelConnectionTest,
  type ModelConnectionView,
} from "../contracts/model-connections.js"
import { MODEL_WIRES, routeAccepted, type HarnessModelRoutes, type ModelRoute, type ModelRoutesCapability } from "../contracts/model-routes.js"
import type { RoutedLaunch } from "./model-routes.js"

/** A saved connection's key is the saved key `connection/<id>`. */
const SECRET_PREFIX = "connection/"
const MAX_CONNECTIONS = 64
const MAX_MODELS = 1_000
const LIST_BYTES = 8_000_000
const LIST_MS = 20_000
const LOCAL_MS = 1_500

const apiKeySchema = z.string().trim().min(1).max(16_384).regex(/^[\x20-\x7e]*$/)
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
/** OpenCode names a model `provider/model#variant`, so an id holds no `#`. */
const modelIdSchema = z.string().trim().min(1).max(300).regex(/^[^\s#]+$/)
const modelSchema = z.object({
  id: modelIdSchema,
  name: z.string().trim().min(1).max(300).optional(),
  contextTokens: z.number().int().positive().max(100_000_000).optional(),
})
const storedSchema = z.object({
  id: idSchema,
  provider: z.string().min(1).max(64),
  kind: z.enum(["subscription", "gateway", "local", "custom"]),
  name: z.string().trim().min(1).max(120),
  // Every connection before routes spoke OpenAI's chat API.
  wire: z.enum(MODEL_WIRES).default("openai-chat"),
  baseUrl: z.string().max(2_048),
  models: z.array(modelSchema).max(MAX_MODELS),
  enabled: z.boolean(),
  credential: z.object({ kind: z.literal("keychain"), name: z.string().max(300) }).nullable(),
  addedAt: z.string().max(40),
})
const fileSchema = z.object({ connections: z.array(z.unknown()).max(MAX_CONNECTIONS) })

/** One model as an OpenAI-compatible `/models` lists it; gateways add a name and a context limit of their own. */
const listedModel = z.looseObject({
  id: z.string().min(1).max(300),
  name: z.string().max(300).optional().catch(undefined),
  display_name: z.string().max(300).optional().catch(undefined),
  context_length: z.number().int().positive().optional().catch(undefined),
  context_window: z.number().int().positive().optional().catch(undefined),
})
/** `{ data: [...] }`, or the bare array some gateways answer with. */
const listing = z.union([
  z.object({ data: z.array(z.unknown()).max(20_000) }).transform((page) => page.data),
  z.array(z.unknown()).max(20_000),
])

export class ConnectionError extends Error {}


export function connectionProvider(id: string): ModelConnectionProvider | undefined {
  return MODEL_CONNECTION_PROVIDERS.find((provider) => provider.id === id)
}

/**
 * A connection's base URL as the person entered it: HTTPS, or HTTP on this
 * Mac, with no credentials, query or fragment. A local server is only ever on
 * this Mac, and a gateway's URL keeps to the gateway's own host.
 */
export function connectionUrl(provider: ModelConnectionProvider, entered: string | undefined): string {
  const raw = (entered?.trim() || provider.baseUrl || "").replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConnectionError("Enter the endpoint's full base URL, including /v1 if it needs one.")
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash)
    throw new ConnectionError("Use HTTPS, or HTTP on this Mac. The URL can't hold credentials, a query or a fragment.")
  if (provider.kind === "local" && !local)
    throw new ConnectionError("A local server is one on this Mac: localhost, 127.0.0.1 or [::1].")
  const home = provider.kind === "gateway" ? new URL(provider.baseUrl ?? provider.urlHint ?? "").hostname : undefined
  if (home && url.hostname !== home) throw new ConnectionError(`${provider.name}'s URL is on ${home}.`)
  if (provider.urlHint && /<[^>]*>/.test(raw))
    throw new ConnectionError(`Fill in your own ${provider.name} URL: ${provider.urlHint}`)
  return url.href.replace(/\/+$/, "")
}

/** What `/models` at `baseUrl` lists, bounded in bytes, time and rows. */
export async function listConnectionModels(
  request: typeof fetch,
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs = LIST_MS
): Promise<{ models: ConnectionModel[]; truncated: boolean }> {
  const headers = new Headers({ Accept: "application/json" })
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`)
  const signal = stoppingSignal(AbortSignal.timeout(timeoutMs))
  let body: unknown
  try {
    const response = await request(`${baseUrl}/models`, { headers, signal, redirect: "error" })
    if (!response.ok) {
      await response.body?.cancel()
      if ([401, 403].includes(response.status)) throw new ConnectionError("The endpoint refused this key. Check the key and its permissions.")
      throw new ConnectionError(`The endpoint answered HTTP ${response.status} when asked for its models. Check the URL.`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new ConnectionError("The endpoint sent an empty model list.")
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > LIST_BYTES) throw new ConnectionError("The endpoint's model list is too large to read.")
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
  } catch (error) {
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError(signal.aborted ? "The endpoint didn't answer in time." : "Couldn't reach the endpoint. Check the URL and that it's running.")
  }
  const parsed = listing.safeParse(body)
  if (!parsed.success) throw new ConnectionError("The endpoint didn't answer with an OpenAI-compatible model list. Check the URL.")
  const models = new Map<string, ConnectionModel>()
  for (const entry of parsed.data) {
    const model = listedModel.safeParse(entry)
    if (!model.success || !modelIdSchema.safeParse(model.data.id).success) continue
    const name = model.data.name ?? model.data.display_name
    const contextTokens = model.data.context_length ?? model.data.context_window
    models.set(model.data.id, {
      id: model.data.id,
      ...(name && name !== model.data.id && { name }),
      ...(contextTokens && { contextTokens }),
    })
  }
  const sorted = [...models.values()].sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id, undefined, { numeric: true }))
  return { models: sorted.slice(0, MAX_MODELS), truncated: sorted.length > MAX_MODELS }
}

/**
 * The person's model connections: what each is in a file of the user root
 * (no secret in it), and each key in the host's secrets under the name the
 * connection's credential names. Changes go one at a time.
 */
export interface ModelConnectionsOptions {
  /** What each harness's driver declares it takes; Settings shows a connection under every harness that takes it. */
  harnesses?: () => HarnessModelRoutes[]
  request?: typeof fetch
}

export class ModelConnections {
  private writes: Promise<unknown> = Promise.resolve()
  private readonly path: string
  private readonly secrets: Secrets
  private readonly request: typeof fetch
  private readonly harnesses: () => HarnessModelRoutes[]

  constructor(path: string, secrets: Secrets, options: ModelConnectionsOptions = {}) {
    this.path = path
    this.secrets = secrets
    this.request = options.request ?? hostFetch
    this.harnesses = options.harnesses ?? (() => [])
  }

  async snapshot(): Promise<ModelConnectionsSnapshot> {
    const [connections, secureStorage] = await Promise.all([this.read(), this.secrets.durable()])
    const issues: ModelConnectionsSnapshot["issues"] = []
    for (const connection of connections)
      if (connection.enabled && connection.credential && !secureStorage)
        issues.push({ id: connection.id, message: "Your keychain is locked, so no harness can use this key. Unlock it, then start a new conversation." })
    const harnesses = this.harnesses()
    return { connections: connections.map((connection) => view(connection, harnesses)), issues, secureStorage, harnesses }
  }

  /**
   * The routes a launch of a harness that declares `capability` takes: every
   * model of each connection turned on whose wire and kind it accepts, with
   * each key opened for that launch alone. A connection whose key won't open
   * is left out; the rest still go.
   */
  async routes(capability: ModelRoutesCapability, launch?: { thread: string; repository: string; correlationId: string }): Promise<RoutedLaunch> {
    const routes: ModelRoute[] = []
    const keys = new Map<string, string>()
    for (const connection of await this.read().catch(() => [])) {
      if (!connection.enabled || !routeAccepted(capability, connection.kind, connection.wire)) continue
      if (connection.credential) {
        try {
          const lent = launch && this.secrets instanceof GrantedSecrets
            ? await this.secrets.lend("saved-key", connection.credential.name, { thread: launch.thread, repository: launch.repository }, `the ${connection.name ?? connection.id} connection's key for a launch`, `${launch.correlationId}:${connection.id}`)
            : undefined
          if (lent && "refusal" in lent) {
            hostWarn("model-connections", "a connection's key wasn't lent", { id: connection.id, refused: lent.refusal.refused })
            continue
          }
          const record = lent ? lent.record : await this.secrets.read("saved-key", connection.credential.name)
          if (!record) {
            hostWarn("model-connections", "a connection's key is missing", { id: connection.id })
            continue
          }
          keys.set(connection.credential.name, record.value)
        } catch {
          hostWarn("model-connections", "a connection's key could not be opened", { id: connection.id })
          continue
        }
      }
      for (const model of connection.models)
        routes.push({
          connection: connection.id,
          connectionName: connection.name,
          kind: connection.kind,
          wire: connection.wire,
          baseUrl: connection.baseUrl,
          model: model.id,
          ...(model.name && { name: model.name }),
          ...(model.contextTokens && { contextTokens: model.contextTokens }),
          credential: connection.credential,
        })
    }
    return { routes, key: (route) => (route.credential ? keys.get(route.credential.name) : undefined) }
  }

  /** Check access: the models `input` lists with the key given, before anything is saved. */
  async check(input: ModelConnectionCheckInput): Promise<ModelConnectionCheck> {
    const provider = this.provider(input.provider)
    const baseUrl = connectionUrl(provider, input.baseUrl)
    const apiKey = this.key(provider, input.apiKey)
    const { models, truncated } = await listConnectionModels(this.request, baseUrl, apiKey)
    return {
      baseUrl,
      models,
      ...(truncated && { notice: `It lists more than ${MAX_MODELS.toLocaleString("en-US")} models; the first ${MAX_MODELS.toLocaleString("en-US")} are shown.` }),
      ...(!models.length && { notice: provider.kind === "local" ? "The server is running but has no models loaded." : "The endpoint lists no models." }),
    }
  }

  async add(input: ModelConnectionInput): Promise<ModelConnectionView> {
    const provider = this.provider(input.provider)
    const baseUrl = connectionUrl(provider, input.baseUrl)
    const apiKey = this.key(provider, input.apiKey)
    const models = z.array(modelSchema).min(1, "Keep at least one model.").max(MAX_MODELS).safeParse(input.models)
    if (!models.success) throw new ConnectionError(models.error.issues[0]?.message ?? "Choose the models this connection serves.")
    if (apiKey && !(await this.secrets.durable()))
      throw new ConnectionError("Your keychain is locked, so Mako can't keep this key. Unlock it, then add the connection.")
    const name = z.string().trim().min(1).max(120).safeParse(input.name).data ?? provider.name
    return this.change(async (connections) => {
      if (connections.length >= MAX_CONNECTIONS) throw new ConnectionError("That's as many connections as Mako keeps. Remove one first.")
      const id = provider.kind === "custom" || provider.id === "local" ? `${provider.id === "local" ? "local" : "custom"}-${randomBytes(3).toString("hex")}` : provider.id
      if (connections.some((connection) => connection.id === id)) throw new ConnectionError(`${provider.name} is already connected. Remove it to connect it again.`)
      const credential = apiKey ? { kind: "keychain" as const, name: `${SECRET_PREFIX}${id}` } : null
      if (credential && apiKey) await this.secrets.write("saved-key", credential.name, apiKey)
      const connection: ModelConnection = {
        id,
        provider: provider.id,
        kind: provider.kind,
        name,
        wire: provider.wire ?? "openai-chat",
        baseUrl,
        models: models.data.map(stripModel),
        enabled: true,
        credential,
        addedAt: new Date().toISOString(),
      }
      hostLog("model-connections", "added", { id, provider: provider.id, models: connection.models.length })
      return { next: [...connections, connection], result: view(connection, this.harnesses()) }
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.change(async (connections) => {
      const found = connections.find((connection) => connection.id === id)
      if (!found) throw new ConnectionError("That connection is gone. Refresh to see your connections.")
      return { next: connections.map((connection) => (connection.id === id ? { ...connection, enabled } : connection)), result: undefined }
    })
  }

  /** The key goes first: a removal that stops halfway leaves the connection listed to remove again, never a key nothing names. */
  async remove(id: string): Promise<void> {
    await this.change(async (connections) => {
      const found = connections.find((connection) => connection.id === id)
      if (!found) return { next: connections, result: undefined }
      if (found.credential) await this.secrets.delete("saved-key", found.credential.name)
      hostLog("model-connections", "removed", { id })
      return { next: connections.filter((connection) => connection.id !== id), result: undefined }
    })
  }

  /** What a saved connection's endpoint lists now, with its saved key, against what it serves. */
  async test(id: string): Promise<ModelConnectionTest> {
    const connection = (await this.read()).find((entry) => entry.id === id)
    if (!connection) throw new ConnectionError("That connection is gone. Refresh to see your connections.")
    let apiKey: string | undefined
    if (connection.credential) {
      const record = await this.secrets.read("saved-key", connection.credential.name).catch(() => {
        throw new ConnectionError("Mako can't open this connection's key. Unlock your keychain and test again.")
      })
      if (!record) throw new ConnectionError("This connection's key is gone. Remove it and add it again.")
      apiKey = record.value
    }
    const { models } = await listConnectionModels(this.request, connection.baseUrl, apiKey)
    const listed = new Set(models.map((model) => model.id))
    return { listed: models.length, missing: connection.models.map((model) => model.id).filter((model) => !listed.has(model)) }
  }

  /** Ollama and LM Studio on their usual ports, and what each has loaded. */
  async detectLocal(): Promise<LocalModelServer[]> {
    const servers = MODEL_CONNECTION_PROVIDERS.filter((provider) => provider.kind === "local" && provider.key === "none" && provider.baseUrl)
    return Promise.all(servers.map(async (provider) => {
      try {
        const { models } = await listConnectionModels(this.request, provider.baseUrl!, undefined, LOCAL_MS)
        return { provider: provider.id, running: true, models }
      } catch {
        return { provider: provider.id, running: false, models: [] }
      }
    }))
  }

  private provider(id: string): ModelConnectionProvider {
    const provider = connectionProvider(id)
    if (!provider || provider.kind === "subscription")
      throw new ConnectionError("Subscriptions connect through their harness's own sign-in.")
    return provider
  }

  private key(provider: ModelConnectionProvider, entered: string | undefined): string | undefined {
    if (provider.key === "none") return undefined
    if (!entered?.trim()) {
      if (provider.key === "required") throw new ConnectionError(`Paste your ${provider.name} API key.`)
      return undefined
    }
    const parsed = apiKeySchema.safeParse(entered)
    if (!parsed.success) throw new ConnectionError("That doesn't look like an API key: paste it again without spaces or line breaks.")
    return parsed.data
  }

  /** Every connection as the file holds it; one in a shape this build doesn't read is left out, never a reason the rest aren't. */
  private async read(): Promise<ModelConnection[]> {
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    }
    const file = fileSchema.safeParse(JSON.parse(raw))
    if (!file.success) return []
    return file.data.connections.flatMap((entry) => {
      const parsed = storedSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
  }

  private change<T>(edit: (connections: ModelConnection[]) => Promise<{ next: ModelConnection[]; result: T }>): Promise<T> {
    const write = this.writes.then(async () => {
      const { next, result } = await edit(await this.read())
      await publishFile(this.path, JSON.stringify({ connections: next }), { mode: 0o600, dirMode: 0o700 })
      return result
    })
    this.writes = write.catch(() => {})
    return write
  }
}

/** Where a user root keeps its connections. */
export function modelConnectionsPath(userRoot: string): string {
  return join(userRoot, "model-connections.json")
}

function stripModel({ id, name, contextTokens }: ConnectionModel): ConnectionModel {
  return { id, ...(name && { name }), ...(contextTokens && { contextTokens }) }
}

/** A connection with every harness whose declared adapter takes it. */
function view(connection: ModelConnection, harnesses: readonly HarnessModelRoutes[]): ModelConnectionView {
  const serves = connection.enabled
    ? harnesses.filter(({ routes }) => routeAccepted(routes, connection.kind, connection.wire)).map(({ harness }) => ({ harness, models: connection.models.length }))
    : []
  return { ...connection, serves }
}
