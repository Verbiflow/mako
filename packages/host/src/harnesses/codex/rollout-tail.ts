import { closeSync, fstatSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs"
import { isJsonObject } from "../../base/json-values.js"
import type { JsonObject, JsonValue } from "../../contracts/json.js"

/** One record Codex appended to a thread's rollout, and where it sits in the file. */
export type RolloutRecord = {
  record: JsonObject
  /** The record's line, `[from, to)` in bytes, newline included. */
  from: number
  to: number
}

/** What one read takes from the file at most; the rest waits for the next read. */
const CHUNK = 512 * 1024
/** A record longer than this is skipped, as every reader skips one (`@mako/sessions/jsonl`). */
const MAX_RECORD = 16 * 1024 * 1024

/**
 * The records Codex appends to a thread's rollout while it runs, read
 * forward from where the last read stopped: the live side of the one
 * decoder (`@mako/sessions/codex-records`). Codex writes each record whole
 * as it happens, within a few milliseconds of the app-server notification
 * for the same item (docs/audits/2026-10-12/codex-one-decoder), so the
 * driver reads before it handles each notification and the transcript draws
 * the record, with the notification's streamed text shown under the same id
 * until it lands.
 *
 * What the rollout held when the tail opened is the thread's history, which
 * saved history draws. Each read costs what was appended: a `stat` when
 * nothing was, and at most `CHUNK` bytes kept between reads, a record over
 * `MAX_RECORD` skipped. A rollout that shrank or was replaced is read from
 * its start; the decoder only draws turns the app-server announced, so a
 * forked thread's copied history draws nothing.
 */
export class CodexRolloutTail {
  readonly path: string
  private offset: number
  private file: number | undefined
  /** A line still being written, kept until its newline arrives. */
  private carry: Buffer[] = []
  private carried = 0
  /** Skipping a record over `MAX_RECORD` until its newline. */
  private skipping = false
  private changed: (() => void) | undefined
  private watcher: FSWatcher | undefined

  constructor(path: string) {
    this.path = path
    try {
      const { size, ino } = statSync(path)
      this.offset = size
      this.file = ino
    } catch {
      // Codex writes the rollout with the thread's first record.
      this.offset = 0
    }
  }

  /** Where the next read starts: the bytes read so far, whole lines and the one still being written. */
  get position(): number {
    return this.offset
  }

  /**
   * Calls `changed` whenever the rollout is written between reads, so a
   * call's row shows when Codex records the call rather than when the
   * app-server next speaks. Watching starts once Codex has created the file.
   */
  follow(changed: () => void): void {
    this.changed = changed
    this.watchFile()
  }

  close(): void {
    this.changed = undefined
    this.watcher?.close()
    this.watcher = undefined
  }

  private watchFile(): void {
    if (!this.changed || this.watcher) return
    try {
      const watcher = watch(this.path, { persistent: false }, () => this.changed?.())
      watcher.on("error", () => {
        watcher.close()
        if (this.watcher === watcher) this.watcher = undefined
      })
      this.watcher = watcher
    } catch {
      // Not written yet: the next read tries again.
    }
  }

  /** Each record appended since the last read, in order. */
  read(): RolloutRecord[] {
    const records: RolloutRecord[] = []
    let size: number
    let ino: number
    try {
      ;({ size, ino } = statSync(this.path))
    } catch {
      return records
    }
    if (this.file !== undefined && (ino !== this.file || size < this.offset)) this.restart()
    this.file = ino
    this.watchFile()
    if (size <= this.offset) return records
    let fd: number | undefined
    try {
      fd = openSync(this.path, "r")
      if (fstatSync(fd).ino !== ino) return records
      while (this.offset < size) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - this.offset))
        const read = readSync(fd, chunk, 0, chunk.length, this.offset)
        if (read === 0) break
        this.lines(chunk.subarray(0, read), this.offset, records)
        this.offset += read
      }
    } catch {
      return records
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    return records
  }

  private restart(): void {
    // A replaced file is another inode, which the old watch no longer sees.
    this.watcher?.close()
    this.watcher = undefined
    this.offset = 0
    this.carry = []
    this.carried = 0
    this.skipping = false
  }

  private lines(chunk: Buffer, at: number, records: RolloutRecord[]): void {
    let start = 0
    for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, end)
      const from = at + start - this.carried
      if (!this.skipping && this.carried + piece.length <= MAX_RECORD) {
        const line = this.carried ? Buffer.concat([...this.carry, piece], this.carried + piece.length) : piece
        const record = parsed(line.toString("utf8"))
        if (record) records.push({ record, from, to: at + end + 1 })
      }
      this.carry = []
      this.carried = 0
      this.skipping = false
      start = end + 1
    }
    const rest = chunk.subarray(start)
    if (!rest.length || this.skipping) return
    if (this.carried + rest.length > MAX_RECORD) {
      this.carry = []
      this.carried = 0
      this.skipping = true
      return
    }
    this.carry.push(Buffer.from(rest))
    this.carried += rest.length
  }
}

/**
 * The records a read took from `bytes`, whole lines of the rollout from
 * offset `at`, as the tail took them: what a stream's `{ records: { rollout,
 * from, to } }` stands for.
 */
export function rolloutRecords(bytes: Buffer, at: number): RolloutRecord[] {
  const records: RolloutRecord[] = []
  let start = 0
  for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) {
    const record = end - start <= MAX_RECORD ? parsed(bytes.subarray(start, end).toString("utf8")) : undefined
    if (record) records.push({ record, from: at + start, to: at + end + 1 })
    start = end + 1
  }
  return records
}

/** A whole line as its record; a torn or foreign line is none. JSON alone, as the wire's lines are read. */
function parsed(line: string): JsonObject | undefined {
  let value: JsonValue
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  return isJsonObject(value) ? value : undefined
}

/**
 * Whether the rollout is read before the app-server's notification is
 * handled, or after. Codex writes an item's record before it notifies, so
 * reading first keeps the transcript in the order Codex wrote it; it writes
 * a turn's first record before `turn/started`, so that one reads after, once
 * the decoder knows the turn is the thread's.
 */
export function codexReadsBefore(method: string): boolean {
  return method !== "turn/started"
}
