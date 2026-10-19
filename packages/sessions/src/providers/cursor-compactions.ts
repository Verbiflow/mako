import type { DatabaseSync, StatementSync } from "node:sqlite"
import { eachField, parseBlobDataRow, parseRoot, parseRootContext, parseRootExtent, readCursorMessage } from "./cursor-records.js"

/**
 * Where Cursor summarized a conversation, and what its context held just
 * before, read the same way from the roots the live child sees and from the
 * roots a saved store kept.
 *
 * Cursor (SDK 1.0.31) summarizes on its server mid-turn and streams nothing
 * about it: the only trace is the checkpoint root, whose `summary_archives`
 * (field 13) gains the window the summary replaced. That root still carries
 * the reading from before the summary (verified 2026-10-17 on 8 of 8
 * single-window compactions in a real 51-compaction store), so what the
 * summary left is measured only by the checkpoint after the next model call;
 * a marker drawn where the summary happened can say only what came before.
 *
 * A saved store keeps every root, content-addressed, in `blobs` in the order
 * it was written (`rowid`), with the agent's subagents' roots between them.
 * A main root is told from a subagent's by its first message (the run's
 * system prompt) and by naming a workspace (field 9); a window, which also
 * starts with the system prompt, names none.
 */

/** The summary an archived window was replaced by: its field 2. Every one of 492 windows in 20 local stores had one. */
export function windowSummary(data: Uint8Array): string | undefined {
  let summary: string | undefined
  eachField(data, (field, value) => {
    if (field === 2 && value instanceof Uint8Array) summary = Buffer.from(value).toString("utf8").trim()
  })
  return summary || undefined
}

/** Windows `next` archived that `previous` had not, oldest first. */
export function newWindows(previous: readonly string[], next: readonly string[]): string[] {
  const known = new Set(previous)
  return next.filter((window) => !known.has(window))
}

/**
 * Where a run archived a window: what the context held just before, and
 * the calls of the last step the first root holding it records. Cursor
 * keeps a run's latest steps verbatim after the summary, so the summary
 * came after that step, not after the last one the window holds, and the
 * live child saw its root land once that step's calls had ended.
 */
export interface CursorCompactionPlace {
  tokensBefore?: number
  /**
   * What the summary left: the run's first reading from that root on that
   * isn't the one from before, the call after the summary's input and
   * output, in the meter's unit, as Codex's `tokensAfter` is its compacted
   * call's `total_tokens`. Absent when the run ended, or archived another
   * window, before measuring it.
   */
  tokensAfter?: number
  after: string[]
  /** The run that archived it, which made the summary; the live child marked it in that run's stream. */
  run?: string
}

/** One run as the SDK's index records it: the root it started from and the one it checkpointed last. */
export interface CursorCompactionRun {
  runId?: string
  startRootId?: string
  rootId?: string
}

interface Step {
  row: number
  windows: string[]
  used?: number
}

/** A main root: what a run checkpointed, as opposed to a subagent's root or a window. */
function mainStep(row: number, data: Uint8Array, lineage: string): Step | undefined {
  if (data[0] !== 0x0a || data[1] !== 0x20) return undefined
  let first: string | undefined
  let workspace = false
  eachField(data, (field, value) => {
    if (!(value instanceof Uint8Array)) return
    if (field === 1 && first === undefined) first = Buffer.from(value).toString("hex")
    else if (field === 9) workspace = true
  })
  if (first !== lineage || !workspace) return undefined
  const used = parseRootContext(data)?.used
  return { row, windows: parseRootExtent(data).windows, ...used !== undefined && { used } }
}

const ROWS_PER_PAGE = 64

/**
 * `tokensBefore` for each window in `wanted` that a run archived: the
 * reading of the last main root before the first root holding it, else the
 * reading the run started from. Each window is found by binary search over
 * the run's rows, so a store of gigabytes is read a few dozen blobs per
 * window. A window no run archived (one an imported store already had) has
 * no entry, as the live child never saw it happen.
 */
export function cursorCompactionReadings(database: DatabaseSync, runs: readonly CursorCompactionRun[], wanted: ReadonlySet<string>): Map<string, CursorCompactionPlace> {
  const found = new Map<string, CursorCompactionPlace>()
  if (!wanted.size) return found
  const blob = database.prepare("SELECT rowid AS row, data FROM blobs WHERE id = ?")
  const forward = database.prepare("SELECT rowid AS row, data FROM blobs WHERE rowid >= ? AND rowid <= ? ORDER BY rowid LIMIT ?")
  const backward = database.prepare("SELECT rowid AS row, data FROM blobs WHERE rowid >= ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
  const at = database.prepare("SELECT data FROM blobs WHERE rowid = ?")
  const messages = database.prepare("SELECT data FROM blobs WHERE id = ?")
  const read = (id: string | undefined) => {
    if (!id) return undefined
    const result = blob.get(id)
    const row = Number(result?.["row"])
    const data = parseBlobDataRow(result)?.data
    return data && Number.isInteger(row) ? { row, data } : undefined
  }
  /** A run's start and latest roots and its main roots by row; each run is read once. */
  const spans = new Map<number, RunSpan | null>()
  const span = (index: number): RunSpan | null => {
    const known = spans.get(index)
    if (known !== undefined) return known
    const run = runs[index]
    const latest = read(run?.rootId)
    let lineage: string | undefined
    if (latest) eachField(latest.data, (field, value) => {
      if (lineage === undefined && field === 1 && value instanceof Uint8Array) lineage = Buffer.from(value).toString("hex")
    })
    const made = latest && lineage ? { latest, start: read(run?.startRootId), first: (from: number, to: number) => firstMain(forward, from, to, lineage!) } : null
    spans.set(index, made)
    return made
  }
  for (const [index] of runs.entries()) {
    if (found.size === wanted.size) break
    const made = span(index)
    if (!made) continue
    const { latest, start, first } = made
    const archived = newWindows(start ? parseRootExtent(start.data).windows : [], parseRootExtent(latest.data).windows).filter((window) => wanted.has(window))
    if (!archived.length) continue
    const opening = start ? parseRootContext(start.data)?.used : undefined
    for (const window of archived) {
      // `low` never holds the window and `high` always does: the run's start and latest roots to begin with.
      let low: Step | undefined = start && { row: start.row, windows: [], ...opening !== undefined && { used: opening } }
      let high = latest.row
      for (;;) {
        const floor = low?.row ?? 0
        const middle = Math.floor((floor + high) / 2)
        const probe = (middle > floor ? first(middle, high - 1) : undefined) ?? (middle - 1 > floor ? first(floor + 1, middle - 1) : undefined)
        if (!probe) break
        if (probe.windows.includes(window)) high = probe.row
        else low = probe
      }
      const tokensBefore = low?.used ?? lastReadingBefore(backward, start?.row ?? 0, low?.row ?? high, latest.data) ?? opening
      const boundary = parseBlobDataRow(at.get(high))?.data
      const holds = new Set(boundary ? parseRootExtent(boundary).windows : [window])
      // The step the root after the summary ends on; one after the run's last step keeps none, so the window's last.
      const kept = boundary ? lastStepCalls(messages, parseRoot(boundary).hashes) : []
      const archive = kept.length ? undefined : parseBlobDataRow(blob.get(window))?.data
      const after = archive ? lastStepCalls(messages, parseRoot(archive).hashes) : kept
      // A summary after the run's last step is measured by the agent's next run, unless a newer summary comes first.
      let reading = measured(first, high, latest.row, tokensBefore, holds)
      for (let later = index + 1; reading === undefined && later < runs.length; later++) {
        const next = span(later)
        if (next) reading = measured(next.first, next.start?.row ?? latest.row, next.latest.row, tokensBefore, holds)
      }
      const tokensAfter = reading === "newer" ? undefined : reading
      const run = runs[index]?.runId
      found.set(window, { after, ...run !== undefined && { run }, ...tokensBefore !== undefined && { tokensBefore }, ...tokensAfter !== undefined && { tokensAfter } })
    }
  }
  return found
}

interface RunSpan {
  latest: { row: number; data: Uint8Array }
  start: { row: number; data: Uint8Array } | undefined
  first: (from: number, to: number) => Step | undefined
}

/**
 * The first reading at rows `from` to `to` that isn't `before`, as the live
 * child writes it next; `newer` once a root archives a window `holds` lacks,
 * whose own marker that reading belongs to; nothing when the rows end first.
 */
function measured(first: (from: number, to: number) => Step | undefined, from: number, to: number, before: number | undefined, holds: ReadonlySet<string>): number | "newer" | undefined {
  for (let step = first(from, to); step; step = step.row < to ? first(step.row + 1, to) : undefined) {
    if (step.windows.some((window) => !holds.has(window))) return "newer"
    if (step.used !== undefined && step.used !== before) return step.used
  }
  return undefined
}

/** `lastReading` in the lineage of the run whose latest root is `latest`. */
function lastReadingBefore(rows: StatementSync, floor: number, before: number, latest: Uint8Array): number | undefined {
  let lineage: string | undefined
  eachField(latest, (field, value) => {
    if (lineage === undefined && field === 1 && value instanceof Uint8Array) lineage = Buffer.from(value).toString("hex")
  })
  return lineage ? lastReading(rows, floor, before, lineage) : undefined
}

/** The calls of the last step in `hashes` that made any. */
function lastStepCalls(messages: StatementSync, hashes: readonly string[]): string[] {
  for (let index = hashes.length - 1; index >= 0; index--) {
    const hash = hashes[index]
    const message = hash === undefined ? null : readCursorMessage(messages, hash)
    if (message?.role !== "assistant") continue
    const calls = message.content.flatMap((part) => part.type === "tool-call" && part.toolCallId ? [part.toolCallId] : [])
    if (calls.length) return calls
  }
  return []
}

/** The first main root at rows `from` to `to`. */
function firstMain(rows: StatementSync, from: number, to: number, lineage: string): Step | undefined {
  for (let at = from; at <= to;) {
    const page = rows.all(at, to, ROWS_PER_PAGE)
    for (const row of page) {
      const data = parseBlobDataRow(row)?.data
      const step = data && mainStep(Number(row["row"]), data, lineage)
      if (step) return step
    }
    if (page.length < ROWS_PER_PAGE) return undefined
    at = Number(page.at(-1)?.["row"]) + 1
  }
  return undefined
}

/** The reading of the last main root holding one, at rows from `floor` up to `before`. */
function lastReading(rows: StatementSync, floor: number, before: number, lineage: string): number | undefined {
  for (let at = before; at > floor;) {
    const page = rows.all(floor, at, ROWS_PER_PAGE)
    for (const row of page) {
      const data = parseBlobDataRow(row)?.data
      const used = data && mainStep(Number(row["row"]), data, lineage)?.used
      if (used !== undefined) return used
    }
    if (page.length < ROWS_PER_PAGE) return undefined
    at = Number(page.at(-1)?.["row"])
  }
  return undefined
}
