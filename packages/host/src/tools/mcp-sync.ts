import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import { AuthoringFiles, boundedRead, revisionOf } from "./authoring-files.js"
import { parseJsonc, setJsonValue } from "./authoring-text.js"
import type { McpJsonFormat } from "./mcp-source.js"
import type { McpDiscoveryRoute, McpRegistry } from "./mcp-registry.js"
import type { ToolHarnesses } from "./harnesses.js"
import type { McpRegistrySnapshot, McpServerDefinition, McpServerRecord, McpSyncPreview, McpSyncTarget } from "../contracts/mcp-skills-integrations.js"

interface CachedPreview {
  hash: string
  path?: string
}

const run = promisify(execFile)
const JsonObjectSchema = z.record(z.string(), z.json())

function previewKey(serverId: string, target: McpSyncTarget): string {
  return `${serverId}\0${target.provider}\0${target.account}\0${target.scope}`
}

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}

async function readExisting(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, "utf8") : ""
}

/** The file a sync writes: the first of the harness's files for the scope that exists, else the first. */
function directPath(
  route: McpDiscoveryRoute,
  scope: "user" | "workspace"
): string | null {
  if (route.write.kind !== "file") return null
  const files = scope === "user" ? route.userFiles : route.workspaceFiles
  return files.find((file) => existsSync(file)) ?? files[0] ?? null
}

/** Two definitions are the same server when they serialize alike in the format that keeps every transport field. */
const COMPARISON_FORMAT: McpJsonFormat = { root: ["mcpServers"], command: "string", remote: "transport" }

function serializableDefinition(
  definition: McpServerDefinition,
  encoding: McpJsonFormat
): JsonObject {
  if (definition.transport === "stdio") {
    if (encoding.command === "array")
      return {
        type: "local",
        command: [definition.command ?? "", ...(definition.args ?? [])],
      }
    const result: JsonObject = { command: definition.command ?? "" }
    if (definition.args?.length) result.args = definition.args
    return result
  }
  const result: JsonObject = { url: definition.url ?? "" }
  if (encoding.remote === "remote") result.type = "remote"
  if (encoding.remote === "transport")
    result.type = definition.transport === "sse" ? "sse" : "http"
  return result
}

const TRANSPORT_KEYS = ["type", "command", "args", "url"] as const

/**
 * A server written into a JSON config at the format's root. Transport fields
 * are replaced together; the target's own enablement, credentials, timeouts
 * and unknown options stay, and so do comments and everything else in the
 * file, which is edited in place.
 */
export function mergeJsonMcpConfig(
  contents: string,
  definition: McpServerDefinition,
  format: McpJsonFormat
): string {
  const path = [...format.root, definition.name]
  let entry: JsonValue | undefined = parseJsonc(contents, "the MCP config")
  for (const key of path) entry = JsonObjectSchema.safeParse(entry).data?.[key]
  const existing = JsonObjectSchema.safeParse(entry).data
  const next = serializableDefinition(definition, format)
  if (!existing) return setJsonValue(contents, path, next)
  let merged = contents
  for (const key of TRANSPORT_KEYS) if (key in existing && !(key in next)) merged = setJsonValue(merged, [...path, key], undefined)
  for (const [key, value] of Object.entries(next)) merged = setJsonValue(merged, [...path, key], value)
  return merged
}

/** Merges a server into JSON configs, one write per file at a time, each refused if the file changed since its preview. */
export type JsonMcpMerge = (path: string, expectedHash: string, definition: McpServerDefinition, format: McpJsonFormat) => Promise<void>

/** MCP configs hold credentials, so a merged file is left readable by its owner only; the file as it was goes to Mako's backups. */
export function jsonMcpMerge(files: AuthoringFiles): JsonMcpMerge {
  return async (path, expectedHash, definition, format) => {
    const current = await boundedRead(path)
    if (hash(current ?? "") !== expectedHash)
      throw new Error("The MCP config changed after preview; review it again before syncing")
    const next = mergeJsonMcpConfig(current ?? "", definition, format)
    await files.write(dirname(path), path, revisionOf(current), next, 0o600)
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
    JSON.stringify(serializableDefinition(left, COMPARISON_FORMAT)) ===
    JSON.stringify(serializableDefinition(right, COMPARISON_FORMAT))
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

/** Copying a server into another harness's config: a preview first, then the write it promised. */
export interface McpSync {
  preview(snapshot: McpRegistrySnapshot, serverId: string, target: McpSyncTarget): Promise<McpSyncPreview>
  apply(snapshot: McpRegistrySnapshot, serverId: string, target: McpSyncTarget): Promise<void>
}

export function mcpSync(harnesses: ToolHarnesses, registry: McpRegistry, files: AuthoringFiles): McpSync {
  const previews = new Map<string, CachedPreview>()
  const merge = jsonMcpMerge(files)

  async function preview(
    snapshot: McpRegistrySnapshot,
    serverId: string,
    target: McpSyncTarget
  ): Promise<McpSyncPreview> {
    const definition = findServer(snapshot, serverId)
    if (
      !harnesses.mcpEditing.get(target.provider)?.imports
    )
      return blockedPreview(
        serverId,
        target,
        "MCP configuration editing is not implemented for this harness"
      )
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
    const route = await registry.route(target.provider, snapshot.cwd)
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

  async function apply(
    snapshot: McpRegistrySnapshot,
    serverId: string,
    target: McpSyncTarget
  ): Promise<void> {
    const definition = findServer(snapshot, serverId)
    if (
      !harnesses.mcpEditing.get(target.provider)?.imports
    )
      throw new Error(
        "MCP configuration editing is not implemented for this harness"
      )
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
    const route = await registry.route(target.provider, snapshot.cwd)
    if (cached.path) {
      if (route.write.kind !== "file") {
        previews.delete(key)
        throw new Error(`${target.provider} MCP write mode changed after preview`)
      }
      try {
        await merge(
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
      await run(command, route.write.args(definition, target.scope, {}), {
        cwd: snapshot.cwd,
        env: route.env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    } finally {
      previews.delete(key)
    }
  }

  return { preview, apply }
}
