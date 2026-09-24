import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { JsonObject } from "./codex-app-json.js"
import {
  mcpDiscoveryRoute,
  type McpDiscoveryRoute,
} from "./mcp-registry.js"
import type {
  McpRegistrySnapshot,
  McpServerDefinition,
  McpServerRecord,
  McpSyncPreview,
  McpSyncTarget,
} from "./shared.js"

interface CachedPreview {
  hash: string
  path?: string
}

const run = promisify(execFile)
const JsonObjectSchema = z.record(z.string(), z.json())
const previews = new Map<string, CachedPreview>()
const writes = new Map<string, Promise<void>>()

function previewKey(serverId: string, target: McpSyncTarget): string {
  return `${serverId}\0${target.provider}\0${target.account}\0${target.scope}`
}

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}

async function readExisting(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, "utf8") : ""
}

function directPath(
  route: McpDiscoveryRoute,
  scope: "user" | "workspace"
): string | null {
  if (route.write.kind !== "file") return null
  return scope === "user"
    ? (route.userFiles[0] ?? null)
    : (route.workspaceFiles[0] ?? null)
}

function serializableDefinition(
  definition: McpServerDefinition,
  provider: "claude" | "cursor" | "opencode" = "cursor"
): JsonObject {
  if (definition.transport === "stdio") {
    const env = {}
    if (provider === "opencode") {
      const result: JsonObject = {
        type: "local",
        command: [definition.command ?? "", ...(definition.args ?? [])],
      }
      if (Object.keys(env).length > 0) result.environment = env
      return result
    }
    const result: JsonObject = { command: definition.command ?? "" }
    if (definition.args?.length) result.args = definition.args
    if (Object.keys(env).length > 0) result.env = env
    return result
  }
  const result: JsonObject = { url: definition.url ?? "" }
  if (provider === "opencode") result.type = "remote"
  if (provider === "claude") {
    result.type = definition.transport === "sse" ? "sse" : "http"
  }
  return result
}

function parseConfig(contents: string): JsonObject {
  return contents.trim() ? JsonObjectSchema.parse(JSON.parse(contents)) : {}
}

function serverMap(
  config: JsonObject,
  provider: "claude" | "cursor" | "opencode"
): JsonObject {
  const parsed = JsonObjectSchema.safeParse(
    provider === "opencode" ? config.mcp : config.mcpServers
  )
  return parsed.success ? { ...parsed.data } : {}
}

export function mergeJsonMcpConfig(
  contents: string,
  definition: McpServerDefinition,
  provider: "claude" | "cursor" | "opencode" = "cursor"
): string {
  const config = parseConfig(contents)
  const servers = serverMap(config, provider)
  servers[definition.name] = serializableDefinition(definition, provider)
  const next =
    provider === "opencode"
      ? { ...config, mcp: servers }
      : { ...config, mcpServers: servers }
  return `${JSON.stringify(next, null, 2)}\n`
}

export async function atomicJsonMcpMerge(
  path: string,
  expectedHash: string,
  definition: McpServerDefinition,
  provider: "claude" | "cursor" | "opencode" = "cursor"
): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readExisting(path)
      if (hash(current) !== expectedHash)
        throw new Error(
          "The MCP config changed after preview; review it again before syncing"
        )
      const next = mergeJsonMcpConfig(current, definition, provider)
      await mkdir(dirname(path), { recursive: true })
      if (current) {
        const backup = `${path}.mako-backup-${Date.now()}`
        await copyFile(path, backup)
        await chmod(backup, 0o600)
      }
      const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, next, { mode: 0o600 })
        await chmod(temporary, 0o600)
        if (hash(await readExisting(path)) !== expectedHash)
          throw new Error(
            "The MCP config changed during sync; preview it again before writing"
          )
        await rename(temporary, path)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
    })
  writes.set(path, operation)
  try {
    await operation
  } finally {
    if (writes.get(path) === operation) writes.delete(path)
  }
}

function findServer(
  snapshot: McpRegistrySnapshot,
  serverId: string
): McpServerRecord {
  const server = snapshot.servers.find((entry) => entry.id === serverId)
  if (!server) throw new Error("That MCP server is no longer in the registry")
  return server
}

function definitionEqual(
  left: McpServerDefinition,
  right: McpServerDefinition
): boolean {
  return (
    JSON.stringify(serializableDefinition(left)) ===
    JSON.stringify(serializableDefinition(right))
  )
}

function targetExisting(
  snapshot: McpRegistrySnapshot,
  definition: McpServerDefinition,
  target: McpSyncTarget
): McpServerDefinition | undefined {
  return snapshot.servers.find(
    (entry) =>
      entry.name === definition.name &&
      entry.origins.some(
        (origin) =>
          origin.provider === target.provider &&
          origin.account === target.account &&
          origin.scope === target.scope
      )
  )
}

function blockedPreview(
  serverId: string,
  target: McpSyncTarget,
  blockReason: string
): McpSyncPreview {
  return {
    serverId,
    target,
    action: "blocked",
    summary: `Cannot sync to ${target.provider}`,
    blockReason,
  }
}

export async function previewMcpSync(
  snapshot: McpRegistrySnapshot,
  serverId: string,
  target: McpSyncTarget
): Promise<McpSyncPreview> {
  const definition = findServer(snapshot, serverId)
  if (definition.managed)
    return blockedPreview(
      serverId,
      target,
      "Mako-managed tools attach only to sessions launched by Mako"
    )
  const status = snapshot.providers.find(
    (entry) => entry.id === target.provider
  )
  if (!status || status.account !== target.account)
    return blockedPreview(
      serverId,
      target,
      "target account is not the selected account"
    )
  if (!definition.portable || definition.conflict)
    return blockedPreview(
      serverId,
      target,
      definition.blockReason ?? "resolve this server conflict before syncing"
    )
  const route = await mcpDiscoveryRoute(target.provider, snapshot.cwd)
  if (route.write.kind === "none")
    return blockedPreview(
      serverId,
      target,
      `${target.provider} does not expose a reliable MCP write path`
    )
  if (
    route.write.kind === "cli" &&
    route.write.scopes === "user" &&
    target.scope === "workspace"
  )
    return blockedPreview(
      serverId,
      target,
      `${target.provider} does not support project-scoped MCP writes`
    )
  const existing = targetExisting(snapshot, definition, target)
  const action = existing
    ? definitionEqual(existing, definition)
      ? "unchanged"
      : "replace"
    : "add"
  const path = directPath(route, target.scope)
  const contents = path ? await readExisting(path) : ""
  const cached: CachedPreview = { hash: hash(contents) }
  if (path) cached.path = path
  previews.set(previewKey(serverId, target), cached)
  return {
    serverId,
    target,
    action,
    summary:
      action === "unchanged"
        ? `${definition.name} already matches in ${target.provider}`
        : `${action === "add" ? "Add" : "Replace"} ${definition.name} in ${target.provider}`,
  }
}

export async function applyMcpSync(
  snapshot: McpRegistrySnapshot,
  serverId: string,
  target: McpSyncTarget
): Promise<void> {
  const definition = findServer(snapshot, serverId)
  if (definition.managed)
    throw new Error(
      "Mako-managed tools attach only to sessions launched by Mako"
    )
  if (!definition.portable || definition.conflict)
    throw new Error(
      definition.blockReason ?? "Resolve this server conflict before syncing"
    )
  const status = snapshot.providers.find(
    (entry) => entry.id === target.provider
  )
  if (!status || status.account !== target.account)
    throw new Error("The target account is no longer selected")
  const key = previewKey(serverId, target)
  const existing = targetExisting(snapshot, definition, target)
  if (existing && definitionEqual(existing, definition)) {
    previews.delete(key)
    return
  }
  const cached = previews.get(key)
  if (!cached) throw new Error("Preview this MCP sync before applying it")
  const route = await mcpDiscoveryRoute(target.provider, snapshot.cwd)
  if (cached.path) {
    if (route.write.kind !== "file") {
      previews.delete(key)
      throw new Error(`${target.provider} MCP write mode changed after preview`)
    }
    try {
      await atomicJsonMcpMerge(
        cached.path,
        cached.hash,
        definition,
        route.write.format
      )
    } finally {
      previews.delete(key)
    }
    return
  }
  const command = route.command
  if (!command || route.write.kind !== "cli") {
    previews.delete(key)
    throw new Error(
      `${target.provider} does not expose a reliable MCP write command`
    )
  }
  try {
    await run(
      command,
      route.write.args(
        definition,
        target.scope,
        {}
      ),
      {
        cwd: snapshot.cwd,
        env: route.env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }
    )
  } finally {
    previews.delete(key)
  }
}
