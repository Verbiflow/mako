import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { createInterface } from "node:readline"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import { numberValue, objectValue, stringValue } from "./codex-app-json.js"
import type { UsageTokenCounts } from "./usage-pricing.js"

/**
 * What every reader of a harness's usage records shares: the files it may
 * read, how much of each, and one event per model call, keyed so a call
 * read twice counts once.
 */

/** What one harness's records add to a usage summary; see `ProviderUsageHistory`. */
export interface UsageScan {
  /** The user's home, under which each harness keeps its own store. */
  homeRoot: string
  /** The harness's name as the usage table shows it; keys and session names start with it. */
  source: string
  /** One model call's usage; a key read again keeps the larger counts. */
  record(event: UsageEvent): void
  /** A session that recorded usage. */
  session(id: string): void
}

export const DAYS = 30

export const MAX_FILES_PER_SOURCE = 1_000

export const MAX_BYTES_PER_FILE = 32 * 1024 * 1024

export const MAX_BYTES_PER_SOURCE = 128 * 1024 * 1024

export const MAX_DISCOVERY_ENTRIES = 25_000

export interface FileCandidate {
  path: string
  mtimeMs: number
  size: number
}

export interface DiscoveryState {
  entries: number
  truncated: boolean
  files: FileCandidate[]
  aliases: Set<string>
}

export interface UsageEvent extends UsageTokenCounts {
  key: string
  source: string
  session: string
  timestamp: string
  model: string
  cwd: string
  reportedCost?: number
}

export interface ScanResult {
  files: FileCandidate[]
  truncated: boolean
}

export async function discover(roots: string[], name?: string): Promise<ScanResult> {
  const state: DiscoveryState = {
    entries: 0,
    truncated: false,
    files: [],
    aliases: new Set(),
  }
  for (const root of roots) await walkJsonl(root, state)
  if (name) state.files = state.files.filter((file) => basename(file.path) === name)
  state.files.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
  )

  const files: FileCandidate[] = []
  let bytes = 0
  for (const file of state.files) {
    const readBytes = Math.min(file.size, MAX_BYTES_PER_FILE)
    if (
      files.length >= MAX_FILES_PER_SOURCE ||
      (files.length > 0 && bytes + readBytes > MAX_BYTES_PER_SOURCE)
    ) {
      state.truncated = true
      break
    }
    files.push(file)
    bytes += readBytes
    if (file.size > MAX_BYTES_PER_FILE) state.truncated = true
  }
  if (files.length < state.files.length) state.truncated = true
  return { files, truncated: state.truncated }
}

export async function walkJsonl(root: string, state: DiscoveryState): Promise<void> {
  if (state.entries >= MAX_DISCOVERY_ENTRIES) {
    state.truncated = true
    return
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((left, right) => right.name.localeCompare(left.name))
  for (const entry of entries) {
    if (state.entries >= MAX_DISCOVERY_ENTRIES) {
      state.truncated = true
      return
    }
    state.entries += 1
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await walkJsonl(path, state)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    try {
      const info = await stat(path)
      const alias = info.ino === 0 ? `path:${path}` : `${info.dev}:${info.ino}`
      if (state.aliases.has(alias)) continue
      state.aliases.add(alias)
      state.files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // One unreadable transcript must not hide the rest of local history.
    }
  }
}

export async function readLines(
  file: FileCandidate,
  visit: (line: string) => void
): Promise<boolean> {
  const start = Math.max(0, file.size - MAX_BYTES_PER_FILE)
  const input = createReadStream(file.path, {
    encoding: "utf8",
    start,
    end: Math.max(file.size - 1, 0),
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let first = true
  try {
    for await (const line of lines) {
      if (first && start > 0) {
        first = false
        continue
      }
      first = false
      visit(line)
    }
    return true
  } catch {
    return false
  }
}

export async function firstLine(path: string): Promise<string | undefined> {
  const input = createReadStream(path, { encoding: "utf8", start: 0, end: 65_535 })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      lines.close()
      input.destroy()
      return line
    }
  } catch {
    return undefined
  }
  return undefined
}

export function parseObject(line: string): JsonObject | undefined {
  try {
    const value: JsonValue = JSON.parse(line)
    return objectValue(value)
  } catch {
    return undefined
  }
}

export function tokenCounts(
  usage: JsonObject,
  inputKey: string,
  outputKey: string,
  cacheReadKey: string,
  cacheWriteKey: string
): UsageTokenCounts {
  return {
    input: tokenValue(usage[inputKey]),
    output: tokenValue(usage[outputKey]),
    cacheRead: tokenValue(usage[cacheReadKey]),
    cacheWrite: tokenValue(usage[cacheWriteKey]),
  }
}

export function tokenValue(value: JsonValue | undefined): number {
  const parsed = numberValue(value)
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function fingerprint(
  timestamp: string,
  model: string | undefined,
  usage: UsageTokenCounts
): string {
  return `${timestamp}:${model ?? "unknown"}:${usage.input},${usage.output},${usage.cacheRead},${usage.cacheWrite}`
}

export function tokenTotal(usage: UsageTokenCounts): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

export function validTimestamp(
  value: JsonValue | undefined,
  fallbackTime: number
): string {
  const timestamp = stringValue(value)
  if (timestamp && !Number.isNaN(Date.parse(timestamp)))
    return new Date(timestamp).toISOString()
  return new Date(fallbackTime).toISOString()
}

export async function yieldToMain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
