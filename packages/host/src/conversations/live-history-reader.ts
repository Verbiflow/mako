import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { ThreadPage } from "@mako/sessions"
import { isTurnStart } from "@mako/sessions/live-content"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import { HISTORY_VIEW_EXPIRED, LIVE_HISTORY_CHUNK_CHARS, type LiveHistoryAddress, type LiveHistoryRead, type LiveHistoryChunk, type LiveHistoryCursor, type LiveHistoryPage, type LiveHistorySnapshot } from "../contracts/live-history.js"
import { historyJsonChunks } from "./live-history-json.js"
import { nativeHistoryRevision } from "./native-history.js"
import { cutOffRequests, mergedBase } from "./stream-merging.js"
import { ContentWeights } from "../contracts/residency.js"
import type { Entry } from "@mako/sessions/entries"
import { mediaFacts } from "@mako/sessions/turn-media"
import { readOriginal, readStreamOriginal, type EntryOriginal } from "@mako/sessions/record-original"
import { hostLog } from "../base/host-log.js"

const PAGE_CHARS = 192 * 1024
const PAGE_ITEMS = 80
const TOOL_PREVIEW = 2048
/** A conversation's newest views: the one its windows hold, and ones a read still in flight names. */
const VIEWS_PER_CONVERSATION = 4
/** What views keep alive beyond what memory holds of their conversations anyway. */
const VIEW_BYTES = 128 * 1024 * 1024
/** How long a read may go without weighing the views again; a capture always does. */
const PRUNE_MS = 30_000
/** Views let go, remembered by token so a read naming one says why. */
const GONE_KEPT = 256
const MAX_RECORDS = 8
const MAX_ACTIVE_READS = 32
const IDLE_MS = 10 * 60_000
interface View { id: string; snapshot: LiveSnapshot; used: number }
/** Where an entry's bytes are read: its record by the catalog, and Mako's streams folder. */
interface Originals {
  record(path: string, id: string): Promise<EntryOriginal | null>
  streams: string
}
type HistoryValue = LiveHistorySnapshot | LiveHistoryPage | Entry | EntryOriginal
interface RecordValue {
  id: string
  value: HistoryValue
  reader: Generator<string>
  next: IteratorResult<string>
  offset: number
  recent: Map<number, LiveHistoryChunk>
  used: number
}

const snapshotIdentity = z.object({
  session: z.object({ id: z.string() }), revision: z.number(), createdAt: z.number(),
  // These are already typed internal arrays. Check the response category
  // without cloning/validating every retained block on the host's main loop.
  blocks: z.custom<LiveSnapshot["blocks"]>(Array.isArray),
  permissions: z.custom<LiveSnapshot["permissions"]>(Array.isArray),
  requests: z.custom<LiveSnapshot["requests"]>(Array.isArray),
  base: z.object({ entries: z.custom<Entry[]>(Array.isArray), start: z.number() }).nullable(),
})
const snapshotContainer = z.object({ snapshot: snapshotIdentity.nullable() })
const resultArray = z.array(z.unknown())

/** The journal stays complete. Only display windows and explicitly requested
 * details cross the bridge; every read is pinned to an immutable capture. */
export class LiveHistoryReader {
  private readonly views = new Map<string, View>()
  private readonly records = new Map<string, RecordValue>()
  private readonly versions = new WeakMap<Entry, string>()
  private readonly weights = new ContentWeights()
  private readonly nativePage?: (path: string, before?: number) => Promise<ThreadPage | null>
  private readonly nativeEntry?: (path: string, id: string) => Promise<Entry | null>
  private readonly originals?: Originals
  /** What memory holds of a conversation now, without reading one only on disk back in. */
  private readonly held?: (id: string) => LiveSnapshot | undefined
  private readonly gone = new Map<string, { id: string; why: string; at: number }>()
  private pruned = 0

  constructor(
    nativePage?: (path: string, before?: number) => Promise<ThreadPage | null>,
    nativeEntry?: (path: string, id: string) => Promise<Entry | null>,
    originals?: Originals,
    held?: (id: string) => LiveSnapshot | undefined,
  ) { this.nativePage = nativePage; this.nativeEntry = nativeEntry; this.originals = originals; this.held = held }

  /** Shared response boundary for operations that return a snapshot. */
  present<Result>(value: Result): Result {
    const array = resultArray.safeParse(value)
    if (array.success) {
      // SAFETY: mapping preserves this internal response's array shape; each
      // snapshot keeps its public contract with optional history metadata.
      return array.data.map(item => this.present(item)) as Result
    }
    if (snapshotContainer.safeParse(value).success) {
      // SAFETY: the container parser established the snapshot property. Its
      // typed internal producer owns all remaining fields, preserved below.
      const container = value as Result & { snapshot: LiveSnapshot | null }
      return { ...container, snapshot: this.present(container.snapshot) }
    }
    if (!snapshotIdentity.safeParse(value).success) return value
    // SAFETY: only typed internal LiveSnapshot producers reach this boundary; native
    // data is validated by its provider/journal before becoming a snapshot.
    const snapshot = value as Result & LiveSnapshot
    if (snapshot.history) return value
    // SAFETY: capture preserves every required LiveSnapshot field and adds a
    // display window. No other host result satisfies snapshotIdentity.
    return this.capture(snapshot) as Result
  }

  capture(snapshot: LiveSnapshot, from?: LiveHistoryCursor): LiveSnapshot {
    const held = [...this.views].find(([, view]) => view.id === snapshot.session.id &&
      view.snapshot.epoch === snapshot.epoch && view.snapshot.revision === snapshot.revision)
    const token = held?.[0] ?? randomUUID()
    if (held) { this.touchView(held[0], held[1]); snapshot = held[1].snapshot }
    else this.views.set(token, { id: snapshot.session.id, snapshot, used: Date.now() })
    this.pruneViews()
    const tail = this.page(token, snapshot, { blocks: snapshot.blocks.length,
      base: snapshot.base ? snapshot.base.start + snapshot.base.entries.length : 0 })
    // A background refresh keeps the range the reader explicitly loaded. It
    // must not throw away earlier pages while a large live event arrives.
    if (!from) return { ...snapshot, ...tail }
    const target = { blocks: Math.max(snapshot.baseCoveredBlocks ?? 0, from.blocks), base: from.base }
    const pages = [tail]
    let page = tail
    while (page.history.before && (page.history.blockStart > target.blocks || (page.base?.start ?? 0) > target.base)) {
      if (page.history.before.blocks === (snapshot.baseCoveredBlocks ?? 0) && page.history.before.base === snapshot.base?.start) break
      page = this.page(token, snapshot, page.history.before)
      pages.push(page)
    }
    pages.reverse()
    return { ...snapshot, blocks: pages.flatMap(part => part.blocks),
      base: tail.base ? { ...tail.base, entries: pages.flatMap(part => part.base?.entries ?? []),
        start: page.base!.start, hasEarlier: page.base!.hasEarlier } : null,
      history: { ...tail.history, blockStart: page.history.blockStart, turnStart: page.history.turnStart, before: page.history.before } }
  }

  async read(id: string, input: LiveHistoryRead, snapshot: () => Promise<LiveSnapshot | null>): Promise<LiveHistoryChunk> {
    if (Date.now() - this.pruned > PRUNE_MS) this.pruneViews()
    this.pruneRecords()
    if (input.kind === "part") {
      const record = this.records.get(input.record)
      if (!record || record.id !== id) throw new Error("This history read expired. Open the conversation again to refresh it.")
      return this.part(input.record, record, input.offset)
    }
    if ([...this.records.values()].filter(record => !record.next.done).length >= MAX_ACTIVE_READS)
      throw new Error("Other history reads are still finishing. Try this read again shortly.")
    let value: HistoryValue | undefined
    if (input.kind === "snapshot") {
      const captured = await snapshot()
      if (!captured) value = null
      else {
        const held = input.ifCurrent && this.views.get(input.ifCurrent.token)
        if (held?.id === id && input.epoch !== undefined && held.snapshot.epoch === input.epoch && captured.epoch === input.epoch &&
            captured.revision === input.ifCurrent?.revision) {
          this.touchView(input.ifCurrent.token, held)
          value = { kind: "unchanged", token: input.ifCurrent.token, revision: captured.revision, epoch: captured.epoch }
        } else value = this.capture(captured, input.epoch !== undefined && input.epoch === captured.epoch ? input.from : undefined)
      }
    } else {
      const view = this.views.get(input.token)
      if (!view || view.id !== id) throw this.expired(id, input.token, view)
      this.touchView(input.token, view)
      if (input.kind === "earlier" || input.kind === "range") {
        const before = input.kind === "earlier" ? input.before : input.to
        const base = view.snapshot.base
        if (base?.hasEarlier && before.base === base.start && before.blocks === (view.snapshot.baseCoveredBlocks ?? 0)) {
          const earlier = await this.nativePage?.(base.ref.path, base.start)
          if (!earlier || earlier.start + earlier.entries.length !== base.start ||
              nativeHistoryRevision(earlier) !== nativeHistoryRevision(base))
            throw new Error("The native history changed since this capture. Open the current conversation before loading earlier messages.")
          const { blocks, baseCoveredBlocks, baseLiveStart, requests } = view.snapshot
          view.snapshot = { ...view.snapshot, base: mergedBase({ ...base, entries: [...earlier.entries, ...base.entries], start: earlier.start, hasEarlier: earlier.hasEarlier },
            blocks, baseCoveredBlocks ?? 0, baseLiveStart, { cutOff: cutOffRequests(requests) }).base }
        }
        value = input.kind === "range" ? this.range(input.token, view.snapshot, input.from, input.to)
          : this.page(input.token, view.snapshot, input.before)
      }
      else if (input.kind === "original") value = await this.original(view.snapshot, input.at)
      else if (input.at.kind === "live") {
        value = view.snapshot.blocks[input.at.index]
        if (value?.type === "tool") value = { ...value, historyVersion: this.version(value) }
      } else {
        const base = view.snapshot.base
        const id = input.at.id
        value = base?.entries.find(entry => entry.id === id)
        const version = value?.type === "tool" ? this.version(value) : undefined
        if (base && value && isPartial(value)) {
          const before = await this.nativePage?.(base.ref.path)
          if (!before || nativeHistoryRevision(before) !== nativeHistoryRevision(base))
            throw new Error("The native history changed. Open the conversation again before reading this output.")
          const full = await this.nativeEntry?.(base.ref.path, id)
          const after = await this.nativePage?.(base.ref.path)
          if (!full || full.type !== value.type || isPartial(full) || !after || nativeHistoryRevision(after) !== nativeHistoryRevision(base))
            throw new Error("The whole entry could not be read from the captured native history.")
          value = value.stream ? { ...full, stream: value.stream } : full
        }
        if (value?.type === "tool") value = { ...value, historyVersion: version }
      }
      if (value === undefined) throw new Error("That retained history item is unavailable.")
    }
    const record = randomUUID()
    const reader = historyJsonChunks(value, LIVE_HISTORY_CHUNK_CHARS)
    const held: RecordValue = { id, value, reader, next: reader.next(), offset: 0, recent: new Map(), used: Date.now() }
    this.records.set(record, held)
    this.pruneRecords()
    return this.part(record, held, 0)
  }

  /**
   * What `at` was read from, as the view holds it: a base entry's record
   * (the catalog's reading, which knows a session the harness deleted), and
   * the stream lines any entry names. One the record no longer holds by its
   * id is read by the bytes the view names.
   */
  private async original(snapshot: LiveSnapshot, at: LiveHistoryAddress): Promise<EntryOriginal> {
    const base = snapshot.base
    const entry = at.kind === "live" ? snapshot.blocks[at.index] : base?.entries.find((each) => each.id === at.id)
    if (!entry) throw new Error("That retained history item is unavailable.")
    const record = at.kind === "base" && base && entry.record
      ? await this.originals?.record(base.ref.path, at.id).catch(() => null) ?? await readOriginal(base.ref.path, entry.record)
      : undefined
    const stream = entry.stream && this.originals ? await readStreamOriginal(this.originals.streams, entry.stream) : undefined
    return { kept: record?.kept ?? false, parts: record?.parts ?? [], ...stream && { stream } }
  }

  private part(key: string, record: RecordValue, offset: number): LiveHistoryChunk {
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

  private pruneRecords(): void {
    const now = Date.now()
    for (const [key, value] of this.records) if (now - value.used > IDLE_MS) this.records.delete(key)
    const completed = [...this.records].filter(([, value]) => value.next.done).sort((a, b) => a[1].used - b[1].used)
    let bytes = 0
    for (const [index, [key, record]] of completed.reverse().entries()) {
      const weight = record.offset * 2
      if (index > 0 && (index >= MAX_RECORDS || bytes + weight > 32 * 1024 * 1024)) this.records.delete(key)
      else bytes += weight
    }
  }

  /**
   * Views stay while they cost little. A conversation's newest view stays while memory holds the conversation: it
   * shares what memory holds, so it keeps only what changed since alive. The rest stay most recently used first while
   * what they keep alive beyond memory fits `VIEW_BYTES`, and none past `VIEWS_PER_CONVERSATION` of one conversation,
   * so one conversation's stream never pushes out the view of another being read.
   */
  private pruneViews(): void {
    const now = Date.now()
    this.pruned = now
    const shared = new WeakSet<object>()
    const newer = new Map<string, number>()
    let bytes = 0
    let first = true
    for (const [key, view] of [...this.views].reverse().sort((a, b) => b[1].used - a[1].used)) {
      const count = newer.get(view.id) ?? 0
      const held = count === 0 ? this.held?.(view.id) : undefined
      if (held) this.weights.of(held, shared, true)
      const weight = this.weights.of(view.snapshot, shared)
      const why = count >= VIEWS_PER_CONVERSATION ? "newer views of its conversation"
        : first || held ? undefined
        : now - view.used > IDLE_MS ? "unused for ten minutes"
        : bytes + weight > VIEW_BYTES ? "views past their memory budget" : undefined
      first = false
      if (why) this.letGo(key, view, why)
      else {
        newer.set(view.id, count + 1)
        bytes += weight
        this.weights.of(view.snapshot, shared, true)
      }
    }
  }

  private letGo(token: string, view: View, why: string): void {
    this.views.delete(token)
    this.gone.set(token, { id: view.id, why, at: Date.now() })
    if (this.gone.size > GONE_KEPT) this.gone.delete(this.gone.keys().next().value!)
  }

  /** A read naming a view this host doesn't hold, said with why it went so a window that keeps asking is traceable. */
  private expired(id: string, token: string, view: View | undefined): Error {
    const gone = this.gone.get(token)
    hostLog("history", "a read named a view this host doesn't hold", {
      conversation: id,
      why: view ? "it belongs to another conversation" : gone ? gone.why : "never held here: a host that started since, or another host",
      ...gone && { goneMs: Date.now() - gone.at },
    })
    return new Error(HISTORY_VIEW_EXPIRED)
  }

  private touchView(token: string, view: View): void {
    view.used = Date.now()
    this.views.delete(token)
    this.views.set(token, view)
  }

  private range(token: string, source: LiveSnapshot, from: LiveHistoryCursor, to: LiveHistoryCursor): LiveHistoryPage {
    if (from.blocks > to.blocks || from.base > to.base) throw new Error("Invalid retained history range")
    const parts: LiveHistoryPage[] = []
    let cursor = to
    while (cursor.blocks > from.blocks || cursor.base > from.base) {
      const page = this.page(token, source, cursor)
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
    const prefix = this.page(token, source, from)
    const turnStart = prefix.history.turnStart + prefix.blocks.filter(isTurnStart).length
    return { blocks: allBlocks.slice(from.blocks - first.history.blockStart), base,
      history: { ...last.history, blockStart: from.blocks, blockEnd: to.blocks, turnStart,
        before: from.blocks > (source.baseCoveredBlocks ?? 0) || base?.hasEarlier ? from : null } }
  }

  private page(token: string, source: LiveSnapshot, before: LiveHistoryCursor): LiveHistoryPage {
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
      const block = preview.type === "tool" && preview.historyRest ? { ...preview, historyVersion: this.version(original) } : preview
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
        const entry = preview.type === "tool" && isPartial(preview) ? { ...preview, historyVersion: this.version(original) } : preview
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

  private version(block: Entry): string {
    const held = this.versions.get(block)
    if (held) return held
    const version = randomUUID()
    this.versions.set(block, version)
    return version
  }
}

function previewLive(block: Entry, index: number): Entry {
  if (block.type !== "tool" || !largeTool(block)) return block
  // What the turn made stays: its shelf reads the preview's media facts.
  return { ...block, input: block.input?.slice(0, TOOL_PREVIEW), output: block.output?.slice(0, TOOL_PREVIEW),
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
  return { ...entry, input: entry.input?.slice(0, TOOL_PREVIEW), output: entry.output?.slice(0, TOOL_PREVIEW) ?? "",
    outputLength: entry.outputLength ?? entry.output?.length ?? 0, contentOmitted: true,
    details: undefined, attachments: undefined, effects: undefined, ...mediaFacts(entry, TOOL_PREVIEW) }
}

function isPartial(entry: Entry): boolean {
  if (entry.type === "unread") return Boolean(entry.rawOmitted)
  return entry.type === "tool" && (Boolean(entry.contentOmitted || entry.attachmentsOmitted) ||
    (entry.outputLength ?? 0) > (entry.output?.length ?? 0))
}

function largeTool(block: { input?: string; output?: string; details?: unknown; attachments?: unknown }): boolean {
  return (block.input?.length ?? 0) > TOOL_PREVIEW || (block.output?.length ?? 0) > TOOL_PREVIEW ||
    JSON.stringify([block.details, block.attachments]).length > TOOL_PREVIEW
}
