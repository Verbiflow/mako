import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import { numberValue, objectValue, stringValue } from "./codex-app-json.js"
import type { UsageTokenCounts } from "./usage-pricing.js"

/**
 * What every reader of a harness's usage records shares: which files it
 * reads, from where the last read stopped, and one event per model call,
 * keyed so a call read twice counts once.
 */

/** The days a usage summary covers, today included. */
export const DAYS = 30

/** A line longer than this is reported unread rather than held in memory. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024

const CHUNK_BYTES = 4 * 1024 * 1024
const NEWLINE = 0x0a

export interface FileCandidate {
  path: string
  /** The file's identity on disk: a replaced file is read from its start, a moved one from where it stopped. */
  identity: string
  mtimeMs: number
  size: number
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

/**
 * One append-only JSONL format. A file is read once and then from where the
 * last read stopped, so its state is kept between reads and must be JSON.
 */
export interface JsonlReader<State extends JsonValue> {
  /** Lines holding none of these strings are skipped without being decoded. */
  needles: readonly string[]
  /** The state the file's first line starts from. */
  start(file: FileCandidate): State
  /** Validates a persisted cursor's state before this reader continues from it. */
  restore(state: JsonValue): State
  /** One line's events; it may change `state`, which the file's next line and next read continue from. */
  line(line: string, state: State, file: FileCandidate): UsageEvent | UsageEvent[] | null | undefined
}

/** What one harness's records add to a usage summary; see `ProviderUsageHistory`. */
export interface UsageScan {
  /** The user's home, under which each harness keeps its own store. */
  homeRoot: string
  /** The harness's name as the usage table shows it; keys start with it. */
  source: string
  /** Epoch ms of the summary's first day: older records are not read. */
  since: number
  /** One model call's usage; a key read again keeps the larger counts. */
  record(event: UsageEvent): void
  /** Reads every `.jsonl` file under `roots` (named `name`, when given) changed since `since`. */
  jsonl<State extends JsonValue>(roots: readonly string[], reader: JsonlReader<State>, name?: string): Promise<void>
  /**
   * A store read by query rather than by file. `read` gets where its last
   * read stopped and returns where this one did; records it repeats merge.
   */
  store(id: string, read: (cursor: number | undefined) => Promise<number | undefined>): Promise<void>
  /** Records that could not be read; the summary says some are missing. */
  unreadable(path: string, reason: string): void
}

/** Every `.jsonl` file under `roots` modified at or after `since`, newest first; a hard-linked file once. */
export async function discover(roots: readonly string[], since: number, name?: string): Promise<FileCandidate[]> {
  const files: FileCandidate[] = []
  const seen = new Set<string>()
  const walk = async (root: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || (name && entry.name !== name)) continue
      try {
        const info = await stat(path)
        if (info.mtimeMs < since) continue
        const identity = info.ino === 0 ? `path:${path}` : `${info.dev}:${info.ino}:${info.birthtimeMs}`
        if (seen.has(identity)) continue
        seen.add(identity)
        files.push({ path, identity, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // One unreadable transcript must not hide the rest of local history.
      }
    }
  }
  for (const root of roots) await walk(root)
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))
}

export interface AppendedRead {
  /** The offset after the last complete line read; the next read starts here. */
  end: number
  /** Lines over `MAX_LINE_BYTES` holding a needle, skipped: usage left unread. */
  oversized: number
}

/**
 * A line that runs past the chunk it began in. Its pieces are joined only
 * if it holds a needle; past `MAX_LINE_BYTES` they are dropped and only
 * whether it held one is kept.
 */
class LongLine {
  private pieces: Buffer[] = []
  private bytes = 0
  private tail: Buffer = Buffer.alloc(0)
  private readonly patterns: readonly Buffer[]
  private readonly overlap: number
  matches = false
  overlong = false

  constructor(patterns: readonly Buffer[], overlap: number) {
    this.patterns = patterns
    this.overlap = overlap
  }

  get empty(): boolean {
    return this.bytes === 0 && !this.overlong
  }

  add(piece: Buffer): void {
    if (!this.matches) {
      const seam = this.tail.length ? Buffer.concat([this.tail, piece.subarray(0, this.overlap)]) : undefined
      this.matches = holds(piece, this.patterns) || (seam !== undefined && holds(seam, this.patterns))
    }
    if (this.overlap) {
      const joined = piece.length >= this.overlap ? piece : Buffer.concat([this.tail, piece])
      this.tail = Buffer.from(joined.subarray(Math.max(joined.length - this.overlap, 0)))
    }
    if (this.overlong) return
    this.bytes += piece.length
    if (this.bytes > MAX_LINE_BYTES) {
      this.overlong = true
      this.pieces = []
    } else this.pieces.push(Buffer.from(piece))
  }

  text(): string {
    return Buffer.concat(this.pieces, this.bytes).toString("utf8")
  }
}

function holds(data: Buffer, patterns: readonly Buffer[]): boolean {
  return patterns.some((pattern) => data.includes(pattern))
}

/**
 * Visits each complete line from `start` holding one of `needles`, in file
 * order, decoding only those. A last line without its newline is still
 * being written unless it parses, so it is left for the next read.
 */
export async function readAppended(
  path: string,
  start: number,
  needles: readonly string[],
  visit: (line: string) => void
): Promise<AppendedRead> {
  const patterns = needles.map((needle) => Buffer.from(needle))
  const overlap = Math.max(0, ...patterns.map((pattern) => pattern.length - 1))
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
  const handle = await open(path, "r")
  let position = start
  let end = start
  let oversized = 0
  let line = new LongLine(patterns, overlap)
  try {
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data = chunk.subarray(0, bytesRead)
      const first = data.indexOf(NEWLINE)
      if (first < 0) {
        line.add(data)
        continue
      }
      let from = 0
      if (!line.empty) {
        line.add(data.subarray(0, first))
        if (line.matches && line.overlong) oversized += 1
        else if (line.matches) visit(line.text())
        line = new LongLine(patterns, overlap)
        from = first + 1
      }
      const last = data.lastIndexOf(NEWLINE)
      matchingLines(data, from, last + 1, patterns, visit)
      end = position - (bytesRead - last - 1)
      if (last + 1 < bytesRead) line.add(data.subarray(last + 1))
    }
    if (!line.empty && line.matches && !line.overlong) {
      const text = line.text()
      if (parseObject(text)) {
        visit(text)
        end = position
      }
    }
  } finally {
    await handle.close()
  }
  return { end, oversized }
}

/** The lines in `data[from, to)` holding a pattern, in order; `to` follows a newline. */
function matchingLines(data: Buffer, from: number, to: number, patterns: readonly Buffer[], visit: (line: string) => void): void {
  const next = patterns.map((pattern) => data.indexOf(pattern, from))
  let cursor = from
  for (;;) {
    let at = -1
    for (let index = 0; index < patterns.length; index += 1) {
      if (next[index] >= 0 && next[index] < cursor) next[index] = data.indexOf(patterns[index], cursor)
      if (next[index] >= 0 && next[index] < to && (at < 0 || next[index] < at)) at = next[index]
    }
    if (at < 0) return
    const lineStart = data.lastIndexOf(NEWLINE, at) + 1
    const lineEnd = data.indexOf(NEWLINE, at)
    visit(data.toString("utf8", lineStart, lineEnd))
    cursor = lineEnd + 1
  }
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
