import { z } from "zod"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { EntryOriginal } from "@mako/sessions/record-original"
import { isTurnStart } from "@mako/sessions/live-content"
import { mediaFacts } from "@mako/sessions/turn-media"
import type { JsonObject, JsonValue } from "./json.js"
import type { LiveSnapshot } from "./live-conversations.js"
import { LIVE_HISTORY_CHUNK_CHARS, type LiveHistoryChunk, type LiveHistoryCursor, type LiveHistoryPage, type LiveHistorySnapshot } from "./live-history.js"

/**
 * How a view of a conversation's history goes to a window, whichever reader holds the view: a host's of its own
 * conversations (`LiveHistoryReader`), or a copy's, on a Mac or in a browser (`CopyHistory`). Pages of at most
 * `PAGE_ITEMS` items and about `PAGE_CHARS`, each large call as its head (`detail` reads the whole), and every read's
 * answer in frames of `LIVE_HISTORY_CHUNK_CHARS` (`HistoryRecords`).
 */
export const PAGE_CHARS = 192 * 1024
export const PAGE_ITEMS = 80
const TOOL_PREVIEW = 2048
/** How much of each string a preview's input keeps (`previewInput`). */
const INPUT_STRING_PREVIEW = 256
const MAX_RECORDS = 8
const MAX_ACTIVE_READS = 32
const IDLE_MS = 10 * 60_000

/** A version for each large call a view serves, so a window knows the whole it reads is the one its preview was cut from. */
export class HistoryVersions {
  readonly #versions = new WeakMap<Entry, string>()

  of(block: Entry): string {
    const held = this.#versions.get(block)
    if (held) return held
    const version = crypto.randomUUID()
    this.#versions.set(block, version)
    return version
  }
}

/** The page of `source` ending at `before`: its live blocks back from there, then its saved entries once they're done. */
export function historyPage(token: string, source: LiveSnapshot, before: LiveHistoryCursor, versions: HistoryVersions): LiveHistoryPage {
  const covered = source.baseCoveredBlocks ?? 0
  const baseOrigin = source.base?.start ?? 0
  if (before.blocks > source.blocks.length || before.blocks < covered || before.base < baseOrigin ||
    before.base > baseOrigin + (source.base?.entries.length ?? 0))
    throw new Error("Invalid retained history cursor")
  const blocks: Entry[] = []
  const entries: Entry[] = []
  let chars = 0
  let blockStart = before.blocks
  let baseStart = before.base
  while (blockStart > covered && blocks.length < PAGE_ITEMS) {
    const original = source.blocks[blockStart - 1]!
    const preview = previewLive(original, blockStart - 1)
    const block = preview.type === "tool" && preview.historyRest ? { ...preview, historyVersion: versions.of(original) } : preview
    const size = JSON.stringify(block).length
    if (blocks.length && chars + size > PAGE_CHARS) break
    blocks.push(block)
    chars += size
    blockStart--
  }
  if (blockStart === covered) {
    while (baseStart > baseOrigin && entries.length + blocks.length < PAGE_ITEMS) {
      const original = source.base!.entries[baseStart - baseOrigin - 1]!
      const preview = previewSaved(original)
      const entry = preview.type === "tool" && isPartial(preview) ? { ...preview, historyVersion: versions.of(original) } : preview
      const size = JSON.stringify(entry).length
      if (entries.length + blocks.length > 0 && chars + size > PAGE_CHARS) break
      entries.push(entry)
      chars += size
      baseStart--
    }
  }
  let turnStart = 0
  const earlierRequests: string[] = []
  for (let index = 0; index < blockStart; index++) {
    const block = source.blocks[index]
    if (block?.type === "user" && block.requestId) earlierRequests.push(block.requestId)
    if (index >= covered && isTurnStart(block)) turnStart++
  }
  const base: ThreadPage | null = source.base ? {
    ...source.base, entries: entries.reverse(), start: baseStart,
    hasEarlier: baseStart > baseOrigin || source.base.hasEarlier,
  } : null
  return {
    blocks: blocks.reverse(), base,
    history: { token, ranges: true, blockStart, blockEnd: before.blocks, turnStart, earlierRequests,
      before: blockStart > covered || baseStart > baseOrigin || source.base?.hasEarlier ? { blocks: blockStart, base: baseStart } : null },
  }
}

/** The pages of `source` from `from` to `to`, as one: what a window that let pages go reads back. */
export function historyRange(token: string, source: LiveSnapshot, from: LiveHistoryCursor, to: LiveHistoryCursor, versions: HistoryVersions): LiveHistoryPage {
  if (from.blocks > to.blocks || from.base > to.base) throw new Error("Invalid retained history range")
  const parts: LiveHistoryPage[] = []
  let cursor = to
  while (cursor.blocks > from.blocks || cursor.base > from.base) {
    const page = historyPage(token, source, cursor, versions)
    parts.push(page)
    const next = { blocks: page.history.blockStart, base: page.base?.start ?? 0 }
    if (next.blocks === cursor.blocks && next.base === cursor.base) throw new Error("That retained history range is unavailable.")
    cursor = next
  }
  if (!parts.length) throw new Error("Invalid empty history range")
  parts.reverse()
  const first = parts[0]!, last = parts.at(-1)!
  const allBlocks = parts.flatMap(part => part.blocks)
  const allEntries = parts.flatMap(part => part.base?.entries ?? [])
  const base = last.base ? { ...last.base, entries: allEntries.slice(from.base - (first.base?.start ?? 0)), start: from.base,
    hasEarlier: from.base > 0 || Boolean(source.base?.hasEarlier) } : null
  // Recompute the prefix's turn numbering from a page ending at `from`.
  const prefix = historyPage(token, source, from, versions)
  const turnStart = prefix.history.turnStart + prefix.blocks.filter(isTurnStart).length
  return { blocks: allBlocks.slice(from.blocks - first.history.blockStart), base,
    history: { ...last.history, blockStart: from.blocks, blockEnd: to.blocks, turnStart,
      before: from.blocks > (source.baseCoveredBlocks ?? 0) || base?.hasEarlier ? from : null } }
}

/** A capture's newest page, and the pages back to `from` when a window held those: the snapshot a read answers. */
export function historyCapture(token: string, snapshot: LiveSnapshot, versions: HistoryVersions, from?: LiveHistoryCursor): LiveSnapshot {
  const tail = historyPage(token, snapshot, { blocks: snapshot.blocks.length,
    base: snapshot.base ? snapshot.base.start + snapshot.base.entries.length : 0 }, versions)
  // A background refresh keeps the range the reader explicitly loaded. It
  // must not throw away earlier pages while a large live event arrives.
  if (!from) return { ...snapshot, ...tail }
  const target = { blocks: Math.max(snapshot.baseCoveredBlocks ?? 0, from.blocks), base: from.base }
  const pages = [tail]
  let page = tail
  while (page.history.before && (page.history.blockStart > target.blocks || (page.base?.start ?? 0) > target.base)) {
    if (page.history.before.blocks === (snapshot.baseCoveredBlocks ?? 0) && page.history.before.base === snapshot.base?.start) break
    page = historyPage(token, snapshot, page.history.before, versions)
    pages.push(page)
  }
  pages.reverse()
  return { ...snapshot, blocks: pages.flatMap(part => part.blocks),
    base: tail.base ? { ...tail.base, entries: pages.flatMap(part => part.base?.entries ?? []),
      start: page.base!.start, hasEarlier: page.base!.hasEarlier } : null,
    history: { ...tail.history, blockStart: page.history.blockStart, turnStart: page.history.turnStart, before: page.history.before } }
}

function previewLive(block: Entry, index: number): Entry {
  if (block.type !== "tool" || !largeTool(block)) return block
  // What the turn made stays: its shelf reads the preview's media facts.
  return { ...block, input: previewInput(block.input), output: block.output?.slice(0, TOOL_PREVIEW),
    details: undefined, attachments: undefined, effects: undefined, ...mediaFacts(block, TOOL_PREVIEW),
    historyRest: { index, length: block.output?.length ?? 0 } }
}

/** A saved entry as a page carries it: a large call's head, or an unread record without its raw body; `detail` reads the whole. */
function previewSaved(entry: Entry): Entry {
  if (entry.type === "unread") {
    if (entry.raw === undefined || JSON.stringify(entry.raw).length <= TOOL_PREVIEW) return entry
    const preview = { ...entry, rawOmitted: true as const }
    delete preview.raw
    return preview
  }
  if (entry.type !== "tool" || !largeTool(entry)) return entry
  return { ...entry, input: previewInput(entry.input), output: entry.output?.slice(0, TOOL_PREVIEW) ?? "",
    outputLength: entry.outputLength ?? entry.output?.length ?? 0, contentOmitted: true,
    details: undefined, attachments: undefined, effects: undefined, ...mediaFacts(entry, TOOL_PREVIEW) }
}

/**
 * A large call's input as a preview carries it: still the call's own JSON,
 * each long string cut to its head, so what names the call (an agent's
 * description, a command, a path) reads on its row before the rest is
 * fetched. A plain cut at the preview's length left JSON that no longer
 * parsed, and an agent started with a long prompt read only "Agent" while it
 * ran. Input that isn't JSON, or is still too long once cut, keeps its head.
 * The row's detail reads the whole (`detail`).
 */
function previewInput(input: string | undefined): string | undefined {
  if (input === undefined || input.length <= TOOL_PREVIEW) return input
  try {
    const parsed = PreviewJson.safeParse(JSON.parse(input))
    const cut = parsed.success ? JSON.stringify(parsed.data) : undefined
    if (cut !== undefined && cut.length <= TOOL_PREVIEW) return cut
  } catch {
    // Not JSON: a raw command line, a patch. Its head is what there is to show.
  }
  return input.slice(0, TOOL_PREVIEW)
}

/** A JSON value with each string past `INPUT_STRING_PREVIEW` cut to its head and marked so. */
const PreviewJson: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().transform((text) => (text.length > INPUT_STRING_PREVIEW ? `${text.slice(0, INPUT_STRING_PREVIEW)}…` : text)),
  z.number(), z.boolean(), z.null(), z.array(PreviewJson), z.record(z.string(), PreviewJson),
]))

/** Whether a page carries `entry` as its head only: `detail` reads the whole. */
export function isPartial(entry: Entry): boolean {
  if (entry.type === "unread") return Boolean(entry.rawOmitted)
  return entry.type === "tool" && (Boolean(entry.contentOmitted || entry.attachmentsOmitted) ||
    (entry.outputLength ?? 0) > (entry.output?.length ?? 0))
}

function largeTool(block: { input?: string; output?: string; details?: unknown; attachments?: unknown }): boolean {
  return (block.input?.length ?? 0) > TOOL_PREVIEW || (block.output?.length ?? 0) > TOOL_PREVIEW ||
    JSON.stringify([block.details, block.attachments]).length > TOOL_PREVIEW
}

/**
 * The history a reader serializes: typed internal values (a snapshot, a page,
 * an entry, an original), JSON-shaped all the way down. Its top is checked to
 * be a JSON value; what is under it is told apart value by value below, by
 * what each is, without a schema run on each: one run on every value of a
 * large conversation's snapshot held the host's loop for a tenth of a second
 * a read, all of it on the loop.
 */
const JsonTop = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
const HistoryJsonSchema = z.custom<JsonValue>((value) => JsonTop.safeParse(value).success)

/** Serialize trusted JSON-shaped history without allocating an entire giant
 * tool result's encoded string. Splitting strings before escaping preserves
 * even surrogate pairs and control characters across frame boundaries. An
 * own `__proto__` key is data, and kept. */
function* pieces(input: JsonValue | undefined): Generator<string> {
  if (isString(input)) {
    yield '"'
    for (let start = 0; start < input.length; start += 16 * 1024)
      yield JSON.stringify(input.slice(start, start + 16 * 1024)).slice(1, -1)
    yield '"'
  } else if (input === null || is(input, "Boolean") || (is(input, "Number") && Number.isFinite(input))) {
    yield JSON.stringify(input)
  } else if (Array.isArray(input)) {
    yield "["
    for (let index = 0; index < input.length; index++) {
      if (index) yield ","
      yield* pieces(input[index] ?? null)
    }
    yield "]"
  } else if (isJsonObject(input)) {
    yield "{"
    let comma = false
    for (const [key, item] of Object.entries(input)) {
      if (item === undefined) continue
      if (comma) yield ","
      comma = true
      yield JSON.stringify(key) + ":"
      yield* pieces(item)
    }
    yield "}"
  } else throw new Error("History holds a value JSON can't carry")
}

/** What a value is by its tag, as `base/json-values` tells it: a boxed string is a string. */
function is(value: JsonValue | undefined, tag: "String" | "Number" | "Boolean" | "Object"): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`
}

function isString(value: JsonValue | undefined): value is string {
  return is(value, "String")
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && !Array.isArray(value) && is(value, "Object")
}

export function* historyJsonChunks<Value>(value: Value, size: number): Generator<string> {
  let pending = ""
  for (const piece of pieces(HistoryJsonSchema.parse(value))) {
    pending += piece
    while (pending.length >= size) {
      yield pending.slice(0, size)
      pending = pending.slice(size)
    }
  }
  if (pending) yield pending
}

/** What a history read answers: a snapshot, a page, an entry whole, or the record an entry was read from. */
export type HistoryValue = LiveHistorySnapshot | LiveHistoryPage | Entry | EntryOriginal

interface HistoryRecord {
  id: string
  value: HistoryValue
  reader: Generator<string>
  next: IteratorResult<string>
  offset: number
  recent: Map<number, LiveHistoryChunk>
  used: number
}

/**
 * What reads answered, each framed as it's asked (`historyJsonChunks`) from the value it pinned: a window reads a
 * large answer part by part, and a part asked again comes from the same value, never a newer one.
 */
export class HistoryRecords {
  readonly #records = new Map<string, HistoryRecord>()

  /** Whether as many reads as may run at once are still being read. */
  busy(): boolean {
    return [...this.#records.values()].filter(record => !record.next.done).length >= MAX_ACTIVE_READS
  }

  /** A read's answer for conversation `id`, held: its first part. */
  open(id: string, value: HistoryValue): LiveHistoryChunk {
    const key = crypto.randomUUID()
    const reader = historyJsonChunks(value, LIVE_HISTORY_CHUNK_CHARS)
    const held: HistoryRecord = { id, value, reader, next: reader.next(), offset: 0, recent: new Map(), used: Date.now() }
    this.#records.set(key, held)
    this.prune()
    return this.#part(key, held, 0)
  }

  /** The part at `offset` of answer `key`, which conversation `id` was read for. */
  part(id: string, key: string, offset: number): LiveHistoryChunk {
    const record = this.#records.get(key)
    if (!record || record.id !== id) throw new Error("This history read expired. Open the conversation again to refresh it.")
    return this.#part(key, record, offset)
  }

  prune(): void {
    const now = Date.now()
    for (const [key, value] of this.#records) if (now - value.used > IDLE_MS) this.#records.delete(key)
    const completed = [...this.#records].filter(([, value]) => value.next.done).sort((a, b) => a[1].used - b[1].used)
    let bytes = 0
    for (const [index, [key, record]] of completed.reverse().entries()) {
      const weight = record.offset * 2
      if (index > 0 && (index >= MAX_RECORDS || bytes + weight > 32 * 1024 * 1024)) this.#records.delete(key)
      else bytes += weight
    }
  }

  #part(key: string, record: HistoryRecord, offset: number): LiveHistoryChunk {
    if (offset % LIVE_HISTORY_CHUNK_CHARS !== 0)
      throw new Error("Invalid history read position")
    record.used = Date.now()
    const cached = record.recent.get(offset)
    if (cached) return cached
    if (offset !== record.offset) {
      // Re-reading an older part is harmless. Rebuild its stream from the
      // pinned value with bounded memory, never from a newer journal snapshot.
      record.reader = historyJsonChunks(record.value, LIVE_HISTORY_CHUNK_CHARS)
      record.next = record.reader.next()
      record.offset = 0
      while (record.offset < offset && !record.next.done) {
        record.offset += record.next.value.length
        record.next = record.reader.next()
      }
    }
    if (record.next.done || record.offset !== offset) throw new Error("Invalid history read position")
    const data = record.next.value
    record.offset += data.length
    record.next = record.reader.next()
    const chunk = { record: key, offset, data, total: record.next.done ? record.offset : undefined,
      next: record.next.done ? null : record.offset }
    record.recent.set(offset, chunk)
    if (record.recent.size > 2) record.recent.delete(record.recent.keys().next().value!)
    return chunk
  }
}
