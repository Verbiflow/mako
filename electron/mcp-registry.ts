import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import { z } from "zod"
import { accountEnv, selectedAccount } from "./accounts.js"
import { providerHost } from "./providers/index.js"
import type { ProviderMcpSource } from "./providers/mcp-source.js"
import { backendConnectionCredentials } from "./backend-connection.js"
import { environmentForExecutable, resolveExecutable } from "./executable.js"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import { projectedMcpServers } from "./contracts/mcp-reach.js"
import {
  migrateRetiredMakoMcpFile,
  retiredMakoMcp,
} from "./retired-mcp.js"
import type {
  McpProvider,
  McpRegistryProviderStatus,
  McpRegistrySnapshot,
  McpServerDefinition,
  McpServerOrigin,
  McpServerRecord,
  McpTransport,
} from "./shared.js"

const run = promisify(execFile)
const SECRET_KEY =
  /(?:authorization|api[-_]?key|access[-_]?token|bearer|credential|oauth|password|secret|token)/i
const MAX_CLI_OUTPUT = 4 * 1024 * 1024

const StringMapSchema = z.record(z.string(), z.string()).catch({})
const OptionalStringSchema = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined)
const RawTransportSchema = z
  .object({
    type: OptionalStringSchema,
    command: OptionalStringSchema,
    args: z.array(z.string()).catch([]),
    url: OptionalStringSchema,
    env: StringMapSchema,
    headers: StringMapSchema,
    http_headers: StringMapSchema,
    env_http_headers: StringMapSchema,
    env_vars: z.array(z.string()).catch([]),
    bearer_token_env_var: OptionalStringSchema,
  })
  .passthrough()
const RawDefinitionSchema = RawTransportSchema.extend({
  name: OptionalStringSchema,
  auth_status: OptionalStringSchema,
  transport: RawTransportSchema.optional(),
})
const JsonMapSchema = z.record(z.string(), z.json())
const NamedRootSchema = z
  .object({
    mcpServers: JsonMapSchema.optional(),
    mcp_servers: JsonMapSchema.optional(),
    mcp: JsonMapSchema.optional(),
    servers: JsonMapSchema.optional(),
  })
  .catchall(z.json())
const OpenCodeRootSchema = z.object({
  mcp: z
    .record(
      z.string(),
      z
        .object({
          type: OptionalStringSchema,
          command: z.array(z.string()).optional(),
          url: OptionalStringSchema,
          env: StringMapSchema.optional(),
          environment: StringMapSchema.optional(),
          headers: StringMapSchema.optional(),
        })
        .passthrough()
    )
    .optional(),
})

interface CleanUrlResult {
  url: string
  inlineSecret: boolean
}

export interface McpInternalDefinition extends McpServerDefinition {
  env?: Record<string, string>
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
}

export interface McpDiscoveredDefinition {
  definition: McpInternalDefinition
  origin: McpServerOrigin
}

export interface McpDiscoveryRoute {
  provider: McpProvider
  account: string
  cwd: string
  env: NodeJS.ProcessEnv
  command: string | null
  readsCli: boolean
  write: ProviderMcpSource["write"]
  userFiles: string[]
  workspaceFiles: string[]
}

function cleanUrl(value: string): CleanUrlResult {
  try {
    const url = new URL(value)
    let inlineSecret = Boolean(url.username || url.password)
    url.username = ""
    url.password = ""
    for (const key of url.searchParams.keys()) {
      if (!SECRET_KEY.test(key)) continue
      url.searchParams.delete(key)
      inlineSecret = true
    }
    return { url: url.toString(), inlineSecret }
  } catch {
    return { url: value, inlineSecret: SECRET_KEY.test(value) }
  }
}

function transportValue(
  value: string | undefined,
  fallback: McpTransport
): McpTransport {
  if (value === "stdio") return "stdio"
  if (value === "sse") return "sse"
  if (
    value === "http" ||
    value === "streamable_http" ||
    value === "streamable-http"
  )
    return "http"
  return fallback
}

function parseDefinition(
  name: string,
  value: JsonValue
): McpInternalDefinition | null {
  const parsed = RawDefinitionSchema.safeParse(value)
  if (!parsed.success) return null
  const root = parsed.data
  const source = root.transport ?? root
  const command = source.command
  const rawUrl = source.url
  if (!command && !rawUrl) return null
  let redactNextArgument = false
  const args = source.args.map((argument) => {
    if (redactNextArgument) {
      redactNextArgument = false
      return "[redacted]"
    }
    if (!SECRET_KEY.test(argument)) return argument
    redactNextArgument = !argument.includes("=")
    return "[redacted]"
  })
  const env = source.env
  const headers = { ...source.headers, ...source.http_headers }
  const envNames = new Set([
    ...Object.keys(env),
    ...source.env_vars,
    ...Object.values(source.env_http_headers),
  ])
  const headerNames = new Set([
    ...Object.keys(headers),
    ...Object.keys(source.env_http_headers),
  ])
  const bearerTokenEnvVar = source.bearer_token_env_var
  if (bearerTokenEnvVar) envNames.add(bearerTokenEnvVar)
  const cleaned = rawUrl ? cleanUrl(rawUrl) : undefined
  const blockReasons: string[] = []
  if (Object.keys(env).length > 0)
    blockReasons.push("contains inline environment values")
  if (Object.keys(headers).length > 0)
    blockReasons.push("contains inline header values")
  if (bearerTokenEnvVar)
    blockReasons.push("uses a provider-owned bearer-token environment mapping")
  if (Object.keys(source.env_http_headers).length > 0)
    blockReasons.push("uses provider-owned environment header mappings")
  if (args.some((argument) => argument === "[redacted]"))
    blockReasons.push("contains credentials in command arguments")
  if (cleaned?.inlineSecret)
    blockReasons.push("contains credentials in its URL")
  const fallback: McpTransport = command ? "stdio" : "http"
  const result: McpInternalDefinition = {
    name,
    transport: transportValue(source.type ?? root.type, fallback),
    envNames: [...envNames].sort(),
    headerNames: [...headerNames].sort(),
    portable: blockReasons.length === 0,
  }
  if (command) {
    result.command = command
    result.args = args
  }
  if (cleaned) result.url = cleaned.url
  if (blockReasons.length > 0) result.blockReason = blockReasons.join("; ")
  if (Object.keys(env).length > 0) result.env = env
  if (Object.keys(headers).length > 0) result.headers = headers
  if (bearerTokenEnvVar) result.bearerTokenEnvVar = bearerTokenEnvVar
  return result
}

function parseNamedMap(value: JsonValue): McpInternalDefinition[] {
  const parsedRoot = NamedRootSchema.safeParse(value)
  if (!parsedRoot.success) return []
  const root = parsedRoot.data
  const servers =
    root.mcpServers ?? root.mcp_servers ?? root.mcp ?? root.servers ?? root
  const parsed: McpInternalDefinition[] = []
  for (const [name, definition] of Object.entries(servers)) {
    const item = parseDefinition(name, definition)
    if (item) parsed.push(item)
  }
  return parsed
}

export function parseProviderJson(
  provider: McpProvider,
  contents: string
): McpInternalDefinition[] {
  const value = z.json().parse(JSON.parse(contents))
  if (provider === "opencode") {
    const parsed = OpenCodeRootSchema.safeParse(value)
    if (!parsed.success) return []
    return Object.entries(parsed.data.mcp ?? {}).flatMap(
      ([name, definition]) => {
        const normalized: JsonObject = {
          args: definition.command?.slice(1) ?? [],
          env: definition.environment ?? definition.env ?? {},
        }
        const command = definition.command?.[0]
        if (command) normalized.command = command
        if (definition.type) normalized.type = definition.type
        if (definition.url) normalized.url = definition.url
        if (definition.headers) normalized.headers = definition.headers
        const item = parseDefinition(name, normalized)
        return item ? [item] : []
      }
    )
  }
  if ((provider === "codex" || provider === "grok") && Array.isArray(value)) {
    return value.flatMap((entry) => {
      const parsed = RawDefinitionSchema.safeParse(entry)
      if (!parsed.success || !parsed.data.name) return []
      const definition = parseDefinition(parsed.data.name, entry)
      return definition ? [definition] : []
    })
  }
  return parseNamedMap(value)
}

function safeDefinition(
  definition: McpInternalDefinition
): McpServerDefinition {
  const safe: McpServerDefinition = {
    name: definition.name,
    transport: definition.transport,
    envNames: [...definition.envNames],
    headerNames: [...definition.headerNames],
    portable: definition.portable,
  }
  if (definition.command) safe.command = definition.command
  if (definition.args) safe.args = [...definition.args]
  if (definition.url) safe.url = definition.url
  if (definition.blockReason) safe.blockReason = definition.blockReason
  return safe
}

function bodyKey(definition: McpServerDefinition): string {
  return JSON.stringify({
    transport: definition.transport,
    command: definition.command ?? null,
    args: definition.args ?? [],
    url: definition.url ?? null,
    envNames: definition.envNames,
    headerNames: definition.headerNames,
  })
}

export function mergeMcpDefinitions(
  definitions: McpDiscoveredDefinition[]
): McpServerRecord[] {
  const grouped = new Map<string, McpServerRecord>()
  const namesByBody = new Map<string, Set<string>>()
  const bodiesByName = new Map<string, Set<string>>()
  for (const item of definitions) {
    if (
      retiredMakoMcp(item.definition.name, item.definition)
    )
      continue
    const safe = safeDefinition(item.definition)
    const body = bodyKey(safe)
    namesByBody.set(body, (namesByBody.get(body) ?? new Set()).add(safe.name))
    bodiesByName.set(
      safe.name,
      (bodiesByName.get(safe.name) ?? new Set()).add(body)
    )
    const existing = grouped.get(body)
    if (existing) {
      if (!existing.origins.some((origin) => sameOrigin(origin, item.origin)))
        existing.origins.push(item.origin)
      continue
    }
    grouped.set(body, {
      ...safe,
      id: createHash("sha256").update(body).digest("hex").slice(0, 16),
      origins: [item.origin],
    })
  }
  const records = [...grouped.values()]
  for (const record of records) {
    const body = bodyKey(record)
    if ((bodiesByName.get(record.name)?.size ?? 0) > 1)
      record.conflict = "drift"
    else if ((namesByBody.get(body)?.size ?? 0) > 1) record.conflict = "name"
  }
  return records.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
}

function sameOrigin(left: McpServerOrigin, right: McpServerOrigin): boolean {
  return (
    left.provider === right.provider &&
    left.account === right.account &&
    left.scope === right.scope &&
    left.provenance === right.provenance
  )
}

async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  return resolveExecutable(command, env)
}

async function canExecute(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  return (await findExecutable(command, env)) !== null
}

export async function mcpDiscoveryRoute(
  provider: McpProvider,
  cwd: string
): Promise<McpDiscoveryRoute> {
  const source = providerHost.mcpSources.get(provider)
  if (!source)
    throw new Error(`Provider ${provider} has no MCP discovery source`)
  const env = await accountEnv(provider, process.env)
  const selected = await selectedAccount(provider)
  return {
    provider,
    account: selected.name,
    cwd,
    env,
    command: source.command(env),
    readsCli: source.readsCli,
    write: source.write,
    userFiles: source.userFiles(selected),
    workspaceFiles: source.workspaceFiles(cwd),
  }
}

async function readJsonDefinitions(
  route: McpDiscoveryRoute
): Promise<McpDiscoveredDefinition[]> {
  const definitions: McpDiscoveredDefinition[] = []
  for (const [scope, files] of [
    ["user", route.userFiles],
    ["workspace", route.workspaceFiles],
  ] as const) {
    for (const file of files) {
      try {
        const parsed = parseProviderJson(
          route.provider,
          await readFile(file, "utf8")
        )
        if (
          parsed.some((definition) =>
            retiredMakoMcp(definition.name, definition)
          )
        )
          await migrateRetiredMakoMcpFile(file).catch(() => false)
        for (const definition of parsed) {
          if (retiredMakoMcp(definition.name, definition))
            continue
          definitions.push({
            definition,
            origin: {
              provider: route.provider,
              account: route.account,
              scope,
              provenance: file,
            },
          })
        }
      } catch {
        continue
      }
    }
  }
  return definitions
}

async function readCliDefinitions(
  route: McpDiscoveryRoute
): Promise<McpDiscoveredDefinition[]> {
  if (!route.readsCli || !route.command) return []
  const command = route.command
  const executable = await findExecutable(command, route.env)
  if (!executable) return []
  try {
    const { stdout } = await run(executable, ["mcp", "list", "--json"], {
      cwd: route.cwd,
      env: environmentForExecutable(executable, route.env),
      timeout: 8_000,
      maxBuffer: MAX_CLI_OUTPUT,
      windowsHide: true,
    })
    const parsed = parseProviderJson(route.provider, stdout)
    return parsed
      .filter(
        (definition) =>
          !retiredMakoMcp(definition.name, definition)
      )
      .map((definition) => ({
        definition,
        origin: {
          provider: route.provider,
          account: route.account,
          scope: "effective",
          provenance: `${command} mcp list --json`,
        },
      }))
  } catch {
    return []
  }
}

function managedRuntimeEnvironment(): NodeJS.ProcessEnv {
  const backend = backendConnectionCredentials()
  return backend ? { MAKO_BACKEND_URL: backend.url, MAKO_BACKEND_TOKEN: backend.token } : {}
}

export async function managedMcpDefinitions(env?: NodeJS.ProcessEnv): Promise<McpDiscoveredDefinition[]> {
  const runtimeEnv = env ?? managedRuntimeEnvironment()
  const backendUrl = runtimeEnv.MAKO_BACKEND_URL
  const backend = Boolean(backendUrl && runtimeEnv.MAKO_BACKEND_TOKEN)
  const definitions: Array<
    McpInternalDefinition & { availability: boolean; detail: string }
  > = [
    {
      name: "mako-backend",
      transport: "http",
      url: backendUrl ?? "https://mako-pearl.vercel.app/api/mcp",
      envNames: [],
      headerNames: ["Authorization"],
      portable: false,
      availability: backend,
      detail: backend
        ? "Authenticated Mako MCP, skills, and integration control plane"
        : "Mako backend token is not configured",
    },
  ]
  return definitions.map(({ availability, detail, ...definition }) => {
    if (!availability) definition.blockReason = detail
    return {
      definition,
      origin: {
        provider: "mako",
        account: "local",
        scope: "managed",
        provenance: availability
          ? `Mako managed (${detail})`
          : `Mako managed (unavailable: ${detail})`,
      },
    }
  })
}

function providerStatus(
  provider: McpProvider,
  route: McpDiscoveryRoute,
  available: boolean
): McpRegistryProviderStatus {
  return {
    id: provider,
    label: providerHost.profiles.get(provider)?.label ?? provider,
    account: route.account,
    available,
    source: route.userFiles[0] ?? `${provider} mcp list --json`,
  }
}

async function discoverProviderDefinitions(cwd: string) {
  const routes = await Promise.all(
    providerHost.mcpSources
      .list()
      .map((source) => mcpDiscoveryRoute(source.provider, cwd))
  )
  const [available, groups] = await Promise.all([
    Promise.all(
      routes.map((route) =>
        route.command ? canExecute(route.command, route.env) : false
      )
    ),
    Promise.all(
      routes.map(async (route) => [
        ...(await readJsonDefinitions(route)),
        ...(await readCliDefinitions(route)),
      ])
    ),
  ])
  return { routes, available, discovered: groups.flat() }
}

export async function discoverMcpRegistry(
  cwd: string
): Promise<McpRegistrySnapshot> {
  const [{ routes, available, discovered }, managed] = await Promise.all([
    discoverProviderDefinitions(cwd),
    managedMcpDefinitions(),
  ])
  const servers = mergeMcpDefinitions([...discovered, ...managed])
  await Promise.all(
    servers.map(async (server) => {
      const managedOrigin = server.origins.find(
        (origin) => origin.provider === "mako"
      )
      if (managedOrigin) {
        server.managed = true
        server.availability = managedOrigin.provenance.includes("(unavailable:")
          ? "unavailable"
          : "available"
        server.detail = managedOrigin.provenance.replace(
          /^Mako managed \(|\)$/g,
          ""
        )
        return
      }
      if (server.transport === "stdio" && server.command) {
        server.availability = (await canExecute(server.command, process.env))
          ? "available"
          : "unavailable"
        return
      }
      server.availability = "unknown"
    })
  )
  return {
    cwd,
    generatedAt: Date.now(),
    servers,
    providers: routes.map((route, index) =>
      providerStatus(route.provider, route, available[index] ?? false)
    ),
  }
}

export function projectPortableDefinitions(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerDefinition[] {
  const nativeNames = new Set(
    snapshot.servers
      .filter((server) =>
        server.origins.some((origin) => origin.provider === provider)
      )
      .map((server) => server.name)
  )
  return snapshot.servers
    .filter(
      (server) =>
        server.portable &&
        !server.origins.some((origin) => origin.provider === "mako") &&
        !server.conflict &&
        server.availability !== "unavailable" &&
        transports.includes(server.transport) &&
        !nativeNames.has(server.name)
    )
    .map(safeDefinition)
}

export function projectRuntimeDefinitions(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerDefinition[] {
  return projectedMcpServers(snapshot, provider, transports).map(safeDefinition)
}
