/**
 * JSONL plumbing shared by every file-backed provider.
 *
 * The catalog's speed rests on three disciplines here: reads are *bounded*
 * (peeks read a head, never the whole file), reads are *incremental* (a
 * growing session re-reads only the appended bytes), and reads are
 * *streamed* (a full translation walks the file in fixed-size chunks —
 * session files reach gigabytes in the wild, and a gigabyte must never
 * become one JavaScript string).
 */

import { statSync } from "node:fs"
import { open } from "node:fs/promises"
import { EntrySink, type ThreadEntry } from "./format.js"
import type { SessionFollower, SessionUpdate } from "./providers/types.js"

const CHUNK = 512 * 1024
const MAX_LINE_BYTES = 16 * 1024 * 1024
const MAX_FOLLOW_RESET_BYTES = 64 * 1024 * 1024

export interface LineTranslator {
  push(raw: string): void
  snapshot(): ThreadEntry[]
  commitBatch?(): void
  readonly needsReset?: boolean
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

export function snapshotSink(sink: EntrySink): ThreadEntry[] {
  return sink.snapshot()
}

interface LineRead {
  nextByte: number
  reset: boolean
  size: number
  identity: string
}

/** Parse one JSONL line, returning null rather than throwing on torn writes. */
export function parseLine(line: string): JsonRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value: JsonValue = JSON.parse(trimmed)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

/** The first `bytes` of a file, decoded. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r")
  try {
    const size = (await handle.stat()).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.allocUnsafe(length)
    const read = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, read.bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

/**
 * Stream complete lines from `fromByte` to the end of the file, in chunks.
 *
 * Returns the offset *after the last newline consumed*, so a line still being
 * written is left for the next call rather than parsed half-formed, and a
 * follow-up costs one positional read of only the new bytes. Splitting is
 * done on the byte, not the decoded string, so a multi-byte character
 * straddling a chunk boundary can never be torn.
 *
 * A callback that returns `false` stops the read — that is how bounded scans
 * (peeks hunting for a title) avoid walking a gigabyte they do not need.
 *
 * If the file shrank below `fromByte` it was rewritten (compaction,
 * truncation); reading restarts from zero so offsets never point into a file
 * that no longer exists in that shape.
 */
export async function readLineBatch(
  path: string,
  fromByte: number,
  onLine: (line: string) => void | boolean,
  evidence?: { identity: string; strict: true }
): Promise<LineRead> {
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    if (evidence && evidence.identity !== `${info.dev}:${info.ino}`)
      throw new Error("Native evidence source changed while opening")
    const size = info.size
    const reset = size < fromByte
    let cursor = reset ? 0 : fromByte
    const end = size
    let consumed = cursor
    let carry: Buffer[] = []
    let carryBytes = 0
    let skipping = false
    if (cursor > 0) {
      const prior = Buffer.allocUnsafe(1)
      const read = await handle.read(prior, 0, 1, cursor - 1)
      skipping = read.bytesRead === 1 && prior[0] !== 0x0a
    }

    while (cursor < end) {
      const requested = Math.min(CHUNK, end - cursor)
      const chunk = Buffer.allocUnsafe(requested)
      const read = await handle.read(chunk, 0, requested, cursor)
      if (read.bytesRead === 0) break
      const startByte = cursor
      cursor += read.bytesRead
      let start = 0
      while (start < read.bytesRead) {
        const lineBreak = chunk.indexOf(0x0a, start)
        if (lineBreak === -1 || lineBreak >= read.bytesRead) {
          if (!skipping) {
            const segment = chunk.subarray(start, read.bytesRead)
            if (carryBytes + segment.length > MAX_LINE_BYTES) {
              if (evidence?.strict) throw new Error("Native evidence record exceeds the read limit")
              carry = []
              carryBytes = 0
              skipping = true
            } else {
              carry.push(Buffer.from(segment))
              carryBytes += segment.length
            }
          }
          break
        }
        const nextByte = startByte + lineBreak + 1
        if (skipping) {
          skipping = false
          carry = []
          carryBytes = 0
          consumed = nextByte
          start = lineBreak + 1
          continue
        }
        const segment = chunk.subarray(start, lineBreak)
        if (carryBytes + segment.length <= MAX_LINE_BYTES) {
          const line =
            carryBytes === 0
              ? segment.toString("utf8")
              : Buffer.concat([...carry, segment], carryBytes + segment.length).toString(
                  "utf8"
                )
          carry = []
          carryBytes = 0
          consumed = nextByte
          if (onLine(line) === false) {
            return {
              nextByte: consumed,
              reset,
              size,
              identity: `${info.dev}:${info.ino}`,
            }
          }
        } else {
          if (evidence?.strict) throw new Error("Native evidence record exceeds the read limit")
          carry = []
          carryBytes = 0
          consumed = nextByte
        }
        start = lineBreak + 1
      }
    }
    return {
      nextByte: consumed,
      reset,
      size,
      identity: `${info.dev}:${info.ino}`,
    }
  } finally {
    await handle.close()
  }
}

export async function readLines(
  path: string,
  fromByte: number,
  onLine: (line: string) => void | boolean
): Promise<number> {
  return (await readLineBatch(path, fromByte, onLine)).nextByte
}

export function createJsonlFollower(
  path: string,
  fromByte: number,
  createTranslator: () => LineTranslator
): SessionFollower {
  let parser = createTranslator()
  let cursor = fromByte
  let identity: string | null = null
  let synchronized = false
  try {
    const info = statSync(path)
    identity = `${info.dev}:${info.ino}`
  } catch {
    identity = null
  }
  let previousValues: string[] = []

  const serializeEntries = (entries: ThreadEntry[]): string[] =>
    entries.map((entry) => JSON.stringify(entry))
  const remember = (entries: ThreadEntry[]) => {
    previousValues = serializeEntries(entries)
  }
  const cloneEntries = (entries: ThreadEntry[]): ThreadEntry[] =>
    structuredClone(entries)

  return {
    get offset() {
      return cursor
    },
    async next(): Promise<SessionUpdate> {
      let read = await readLineBatch(path, cursor, parser.push)
      if (read.reset || (identity !== null && read.identity !== identity)) {
        parser = createTranslator()
        read = await readLineBatch(
          path,
          Math.max(0, read.size - MAX_FOLLOW_RESET_BYTES),
          parser.push
        )
        parser.commitBatch?.()
        cursor = read.nextByte
        identity = read.identity
        synchronized = true
        const current = parser.snapshot()
        remember(current)
        return {
          entries: cloneEntries(current),
          nextByte: cursor,
          replace: true,
          replaceFrom: 0,
          reset: true,
        }
      }

      parser.commitBatch?.()
      if (!synchronized && parser.needsReset) {
        parser = createTranslator()
        read = await readLineBatch(
          path,
          Math.max(0, read.size - MAX_FOLLOW_RESET_BYTES),
          parser.push
        )
        parser.commitBatch?.()
        cursor = read.nextByte
        identity = read.identity
        synchronized = true
        const current = parser.snapshot()
        remember(current)
        return {
          entries: cloneEntries(current),
          nextByte: cursor,
          replace: true,
          replaceFrom: 0,
          reset: true,
        }
      }

      cursor = Math.max(cursor, read.nextByte)
      identity = read.identity
      const current = parser.snapshot()
      const currentValues = serializeEntries(current)
      const appended =
        current.length >= previousValues.length &&
        previousValues.every((entry, index) => entry === currentValues[index])
      let replaceFrom: number | undefined
      if (!appended) {
        replaceFrom = 0
        const shared = Math.min(previousValues.length, current.length)
        while (
          replaceFrom < shared &&
          previousValues[replaceFrom] === currentValues[replaceFrom]
        ) {
          replaceFrom += 1
        }
      }
      const entries = appended
        ? current.slice(previousValues.length)
        : current.slice(replaceFrom)
      const update: SessionUpdate = {
        entries: cloneEntries(entries),
        nextByte: cursor,
        replace: !appended,
      }
      if (replaceFrom !== undefined) update.replaceFrom = replaceFrom
      previousValues = currentValues
      return update
    },
  }
}

/** Recursively list files under a root, bounded, without following links. */
export async function walkFiles(
  root: string,
  matches: (name: string) => boolean,
  maxDepth = 5
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const found: string[] = []
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) return visit(path, depth + 1)
        if (entry.isFile() && matches(entry.name)) found.push(path)
      })
    )
  }
  await visit(root, 0)
  return found
}
