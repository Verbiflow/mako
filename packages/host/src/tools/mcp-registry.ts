import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import { z } from "zod"
import { cliListingCache, type CliListingCache } from "./mcp-cli-cache.js"
import type { McpReadFormat, ProviderMcpSource } from "./mcp-source.js"
import type { ToolHarnesses } from "./harnesses.js"
import { environmentForExecutable, resolveExecutable } from "../base/executable.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import { projectedMcpServers } from "../contracts/mcp-reach.js"
import { parseJsonc } from "./authoring-text.js"
import {
  migrateRetiredMakoMcpFile,
  retiredMakoMcp,
} from "./retired-mcp.js"
import type { McpProvider, McpRegistryProviderStatus, McpRegistrySnapshot, McpServerDefinition, McpServerOrigin, McpServerRecord, McpTransport } from "../contracts/mcp-skills-integrations.js"

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
  enabled: z.boolean().optional(),
  disabled: z.boolean().optional(),
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
/** One OpenCode server: `mcp.servers.<name>` in 2.x (`disabled`), or 1.x's `mcp.<name>` (`enabled`). */
const OpenCodeServerSchema = z
  .object({
    type: OptionalStringSchema,
    command: z.array(z.string()).optional(),
    url: OptionalStringSchema,
    env: StringMapSchema.optional(),
    environment: StringMapSchema.optional(),
    headers: StringMapSchema.optional(),
    enabled: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough()
/** Keys of OpenCode's `mcp` that aren't servers. */
const OPENCODE_MCP_KEYS = new Set(["servers", "timeout"])

interface CleanUrlResult {
  url: string
  inlineSecret: boolean
}

export interface McpInternalDefinition extends McpServerDefinition {
  enabled?: boolean
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
  /** The files `<command> mcp list --json` reads, when the harness's CLI is its reader. */
  cliInputs: string[] | null
  readFormat: McpReadFormat
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

export function parseMcpDefinition(
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
  if (root.enabled !== undefined) result.enabled = root.enabled
  else if (root.disabled !== undefined) result.enabled = !root.disabled
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
    const item = parseMcpDefinition(name, definition)
    if (item) parsed.push(item)
  }
  return parsed
}

export function parseProviderJson(
  format: McpReadFormat,
  contents: string
): McpInternalDefinition[] {
  const value = parseJsonc(contents, "the MCP config")
  if (format === "command-array-map") {
    const mcp = JsonMapSchema.safeParse(JsonMapSchema.safeParse(value).data?.mcp).data ?? {}
    const servers = [
      ...Object.entries(JsonMapSchema.safeParse(mcp.servers).data ?? {}),
      ...Object.entries(mcp).filter(([name]) => !OPENCODE_MCP_KEYS.has(name)),
    ]
    return servers.flatMap(([name, entry]) => {
      const parsed = OpenCodeServerSchema.safeParse(entry)
      if (!parsed.success) return []
      const definition = parsed.data
      const normalized: JsonObject = {
        args: definition.command?.slice(1) ?? [],
        env: definition.environment ?? definition.env ?? {},
      }
      const command = definition.command?.[0]
      if (command) normalized.command = command
      if (definition.type) normalized.type = definition.type
      if (definition.url) normalized.url = definition.url
      if (definition.headers) normalized.headers = definition.headers
      const enabled = definition.disabled !== undefined ? !definition.disabled : definition.enabled
      if (enabled !== undefined) normalized.enabled = enabled
      const item = parseMcpDefinition(name, normalized)
      return item ? [item] : []
    })
  }
  if (format === "named-map-or-list" && Array.isArray(value)) {
    return value.flatMap((entry) => {
      const parsed = RawDefinitionSchema.safeParse(entry)
      if (!parsed.success || !parsed.data.name) return []
      const definition = parseMcpDefinition(parsed.data.name, entry)
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
    const origin = item.definition.enabled === undefined ? item.origin : { ...item.origin, enabled: item.definition.enabled }
    const body = bodyKey(safe)
    namesByBody.set(body, (namesByBody.get(body) ?? new Set()).add(safe.name))
    bodiesByName.set(
      safe.name,
      (bodiesByName.get(safe.name) ?? new Set()).add(body)
    )
    const existing = grouped.get(body)
    if (existing) {
      const previous = existing.origins.findIndex((candidate) => sameOrigin(candidate, origin))
      if (previous === -1) existing.origins.push(origin)
      else existing.origins[previous] = origin
      continue
    }
    grouped.set(body, {
      ...safe,
      id: createHash("sha256").update(body).digest("hex").slice(0, 16),
      origins: [origin],
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
          route.readFormat,
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
  cliListings: CliListingCache<string>,
  route: McpDiscoveryRoute
): Promise<McpDiscoveredDefinition[]> {
  if (!route.cliInputs || !route.command) return []
  const command = route.command
  const executable = await findExecutable(command, route.env)
  if (!executable) return []
  try {
    const stdout = await cliListings.read(
      [route.provider, route.account, route.cwd, executable].join("\0"),
      [executable, ...route.cliInputs],
      async () =>
        (
          await run(executable, ["mcp", "list", "--json"], {
            cwd: route.cwd,
            env: environmentForExecutable(executable, route.env),
            timeout: 8_000,
            maxBuffer: MAX_CLI_OUTPUT,
            windowsHide: true,
          })
        ).stdout
    )
    const parsed = parseProviderJson(route.readFormat, stdout)
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

/** Every harness's MCP servers, as its own config and CLI list them. */
export interface McpRegistry {
  discover(cwd: string): Promise<McpRegistrySnapshot>
  /** Where `provider` reads and writes its servers for `cwd`, as its selected account. */
  route(provider: McpProvider, cwd: string): Promise<McpDiscoveryRoute>
}

/** A harness's CLI listing is kept until a file it reads changes, or for five minutes. */
export function mcpRegistry(harnesses: ToolHarnesses): McpRegistry {
  const cliListings = cliListingCache<string>({ refreshAfterMs: 5 * 60_000, limit: 64 })

  async function route(provider: McpProvider, cwd: string): Promise<McpDiscoveryRoute> {
    const source = harnesses.mcpSources.get(provider)
    if (!source)
      throw new Error(`Provider ${provider} has no MCP discovery source`)
    const { env, account } = await harnesses.account(provider)
    return {
      provider,
      account: account.name,
      cwd,
      env,
      command: source.command(env),
      cliInputs: source.cliList?.inputs(env, cwd) ?? null,
      readFormat: source.readFormat,
      write: source.write,
      userFiles: source.userFiles(account),
      workspaceFiles: source.workspaceFiles(cwd),
    }
  }

  async function discover(cwd: string): Promise<McpRegistrySnapshot> {
    const routes = await Promise.all(
      harnesses.mcpSources.list().map((source) => route(source.provider, cwd))
    )
    const [available, groups] = await Promise.all([
      Promise.all(
        routes.map((entry) =>
          entry.command ? canExecute(entry.command, entry.env) : false
        )
      ),
      Promise.all(
        routes.map(async (entry) => [
          ...(await readJsonDefinitions(entry)),
          ...(await readCliDefinitions(cliListings, entry)),
        ])
      ),
    ])
    const servers = mergeMcpDefinitions(groups.flat())
    await Promise.all(
      servers.map(async (server) => {
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
      providers: routes.map((entry, index): McpRegistryProviderStatus => ({
        id: entry.provider,
        label: harnesses.label(entry.provider),
        account: entry.account,
        available: available[index] ?? false,
        source: entry.userFiles[0] ?? `${entry.provider} mcp list --json`,
      })),
    }
  }

  return { discover, route }
}

export function projectPortableDefinitions(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerDefinition[] {
  return projectedMcpServers(snapshot, provider, transports)
    .filter((server) => !server.origins.some((origin) => origin.provider === "mako"))
    .map(safeDefinition)
}

export function projectRuntimeDefinitions(
  snapshot: McpRegistrySnapshot,
  provider: McpProvider,
  transports: readonly McpTransport[]
): McpServerDefinition[] {
  return projectedMcpServers(snapshot, provider, transports).map(safeDefinition)
}
