import type { ThreadRef } from "./format.js"
import { ThreadRefSchema } from "./thread-schema.js"

export interface CacheEntry {
  bytes: number
  mtimeMs: number
  revision?: string
  /** The provider's `peekVersion` when this entry was written; a newer rule re-peeks the file. */
  peek?: number
  ref: ThreadRef | null
}

/** Bump when a peek rule change would leave stale rows in a warm cache. */
export const CATALOG_CACHE_VERSION = 14

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

export function parseCache(raw: string): Map<string, CacheEntry> | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    if (
      !isJsonRecord(value) ||
      readNumber(value, "version") !== CATALOG_CACHE_VERSION
    )
      return null
    const stored = value.entries
    if (!isJsonRecord(stored)) return null
    const entries = new Map<string, CacheEntry>()
    for (const [path, candidate] of Object.entries(stored)) {
      const entry = parseCacheEntry(candidate)
      if (!entry) return null
      entries.set(path, entry)
    }
    return entries
  } catch {
    return null
  }
}

function parseCacheEntry(value: JsonValue | undefined): CacheEntry | null {
  if (!isJsonRecord(value)) return null
  const bytes = readNumber(value, "bytes")
  const mtimeMs = readNumber(value, "mtimeMs")
  if (bytes === undefined || mtimeMs === undefined) return null
  const revision = readString(value, "revision")
  const peek = readNumber(value, "peek")
  const entry: CacheEntry = { bytes, mtimeMs, revision, ref: null }
  if (peek !== undefined) entry.peek = peek
  if (value.ref === null) return entry
  const ref = parseCachedThreadRef(value.ref)
  return ref ? { ...entry, ref } : null
}

/**
 * A cached ref is the whole ref. The reader once listed the fields it knew
 * and dropped `settings`, so every host restart forgot each thread's
 * reasoning level and options until its file changed and was peeked again.
 */
function parseCachedThreadRef(value: JsonValue | undefined): ThreadRef | null {
  const parsed = ThreadRefSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isStringValue(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return isStringValue(value) ? value : undefined
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

