import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import type { JsonValue } from "./codex-app-json.js"

export {
  discoverMcpRegistry,
  mergeMcpDefinitions,
  parseProviderJson,
  projectPortableDefinitions,
  projectRuntimeDefinitions,
} from "./mcp-registry.js"
export {
  acpMcpServers,
  codexMcpConfig,
  mergeCodexConfig,
} from "./mcp-runtime.js"
export { applyMcpSync, previewMcpSync } from "./mcp-sync.js"

const JsonObjectSchema = z.record(z.string(), z.json())
const queues = new Map<string, Promise<void>>()

/**
 * Merge several portable definitions without losing a concurrent merge.
 * Provider sync uses preview hashes; this queued helper covers batch writers and
 * keeps the final rename atomic within the destination directory.
 */
export async function atomicMergeMcpJson(
  file: string,
  additions: Readonly<Record<string, JsonValue>>
): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const root = await readJsonObject(file)
      const parsedServers = JsonObjectSchema.safeParse(root.mcpServers)
      const existing = parsedServers.success ? parsedServers.data : {}
      root.mcpServers = { ...existing, ...additions }
      await mkdir(dirname(file), { recursive: true })
      const temporary = join(
        dirname(file),
        `.${basename(file)}.${randomUUID()}.tmp`
      )
      try {
        await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        })
        await rename(temporary, file)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    })
  queues.set(file, operation)
  try {
    await operation
  } finally {
    if (queues.get(file) === operation) queues.delete(file)
  }
}

async function readJsonObject(
  file: string
): Promise<Record<string, JsonValue>> {
  if (!existsSync(file)) return {}
  return JsonObjectSchema.parse(JSON.parse(await readFile(file, "utf8")))
}
