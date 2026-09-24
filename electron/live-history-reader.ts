import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { BlockAddress, EntryBlock, ThreadEntry, ThreadPage } from "@mako/sessions"
import type { LiveBlock } from "./contracts/live-content.js"
import type { LiveSnapshot } from "./contracts/live-conversations.js"
import { LIVE_HISTORY_CHUNK_CHARS, type LiveHistoryRead, type LiveHistoryChunk, type LiveHistoryCursor, type LiveHistoryPage, type LiveHistorySnapshot } from "./contracts/live-history.js"
import { historyJsonChunks } from "./live-history-json.js"
import { nativeHistoryRevision } from "./native-history.js"

const PAGE_CHARS = 192 * 1024
const PAGE_ITEMS = 80
const TOOL_PREVIEW = 2048
const MAX_VIEWS = 32
const MAX_RECORDS = 8
const MAX_ACTIVE_READS = 32
const IDLE_MS = 10 * 60_000
interface View { id: string; snapshot: LiveSnapshot; used: number }
type HistoryValue = LiveHistorySnapshot | LiveHistoryPage | LiveBlock | EntryBlock
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
  base: z.object({ entries: z.custom<ThreadEntry[]>(Array.isArray), start: z.number() }).nullable(),
})
const snapshotContainer = z.object({ snapshot: snapshotIdentity.nullable() })
const resultArray = z.array(z.unknown())

/** The journal stays complete. Only display windows and explicitly requested
 * details cross the bridge; every read is pinned to an immutable capture. */
export class LiveHistoryReader {
  private readonly views = new Map<string, View>()
  private readonly records = new Map<string, RecordValue>()
  private readonly versions = new WeakMap<LiveBlock | EntryBlock, string>()
  private readonly nativePage?: (path: string, before?: number) => Promise<ThreadPage | null>
  private readonly nativeBlock?: (path: string, at: BlockAddress) => Promise<EntryBlock | null>

  constructor(
    nativePage?: (path: string, before?: number) => Promise<ThreadPage | null>,
    nativeBlock?: (path: string, at: BlockAddress) => Promise<EntryBlock | null>,
  ) { this.nativePage = nativePage; this.nativeBlock = nativeBlock }

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
    if (held) { held[1].used = Date.now(); snapshot = held[1].snapshot }
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
    this.pruneViews()
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
          held.used = Date.now()
          value = { kind: "unchanged", token: input.ifCurrent.token, revision: captured.revision, epoch: captured.epoch }
        } else value = this.capture(captured, input.epoch !== undefined && input.epoch === captured.epoch ? input.from : undefined)
      }
    } else {
      const view = this.views.get(input.token)
      if (!view || view.id !== id) throw new Error("This history view expired. Open the conversation again to refresh it.")
      view.used = Date.now()
      if (input.kind === "earlier") {
        const base = view.snapshot.base
        if (base?.hasEarlier && input.before.base === base.start && input.before.blocks === (view.snapshot.baseCoveredBlocks ?? 0)) {
          const earlier = await this.nativePage?.(base.ref.path, base.start)
          if (!earlier || earlier.start + earlier.entries.length !== base.start ||
              nativeHistoryRevision(earlier) !== nativeHistoryRevision(base))
            throw new Error("The native history changed since this capture. Open the current conversation before loading earlier messages.")
          view.snapshot = { ...view.snapshot, base: { ...base, entries: [...earlier.entries, ...base.entries], start: earlier.start, hasEarlier: earlier.hasEarlier } }
        }
        value = this.page(input.token, view.snapshot, input.before)
      }
      else if (input.at.kind === "live") {
        value = view.snapshot.blocks[input.at.index]
        if (value?.type === "tool") value = { ...value, historyVersion: this.version(value) }
      } else {
        const base = view.snapshot.base
        const entry = base?.entries[input.at.entry - (base?.start ?? 0)]
        value = entry?.kind === "assistant" ? entry.blocks[input.at.block] : undefined
        const version = value?.type === "tool" ? this.version(value) : undefined
        if (base && value?.type === "tool" && isPartialTool(value)) {
          const before = await this.nativePage?.(base.ref.path)
          if (!before || nativeHistoryRevision(before) !== nativeHistoryRevision(base))
            throw new Error("The native history changed. Open the conversation again before reading this output.")
          const full = await this.nativeBlock?.(base.ref.path, input.at)
          const after = await this.nativePage?.(base.ref.path)
          if (!full || full.type !== "tool" || full.name !== value.name || (value.id !== undefined && full.id !== value.id) ||
              isPartialTool(full) || !after || nativeHistoryRevision(after) !== nativeHistoryRevision(base))
            throw new Error("The complete tool output could not be read from the captured native history.")
          value = full
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
    for (const [key] of completed.slice(0, Math.max(0, completed.length - MAX_RECORDS))) this.records.delete(key)
  }

  private pruneViews(): void {
    if (this.views.size > MAX_VIEWS)
      for (const [key] of [...this.views].sort((a, b) => a[1].used - b[1].used).slice(0, this.views.size - MAX_VIEWS)) this.views.delete(key)
  }

  private page(token: string, source: LiveSnapshot, before: LiveHistoryCursor): LiveHistoryPage {
    const covered = source.baseCoveredBlocks ?? 0
    const baseOrigin = source.base?.start ?? 0
    if (before.blocks > source.blocks.length || before.blocks < covered || before.base < baseOrigin ||
      before.base > baseOrigin + (source.base?.entries.length ?? 0))
      throw new Error("Invalid retained history cursor")
    const blocks: LiveBlock[] = []
    const entries: ThreadEntry[] = []
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
        const entry = original.kind === "assistant" ? { ...original, blocks: original.blocks.map(block => {
          const preview = previewTool(block)
          return preview.type === "tool" && isPartialTool(preview) ? { ...preview, historyVersion: this.version(block) } : preview
        }) } : original
        const size = JSON.stringify(entry).length
        if (entries.length + blocks.length > 0 && chars + size > PAGE_CHARS) break
        entries.push(entry)
        chars += size
        baseStart--
      }
    }
    let turnStart = 0
    for (let index = covered; index < blockStart; index++) {
      const block = source.blocks[index]
      if (block?.type === "user" && !block.steeringFor) turnStart++
    }
    const base: ThreadPage | null = source.base ? {
      ...source.base, entries: entries.reverse(), start: baseStart,
      hasEarlier: baseStart > baseOrigin || source.base.hasEarlier,
    } : null
    return {
      blocks: blocks.reverse(), base,
      history: { token, blockStart, blockEnd: before.blocks, turnStart,
        before: blockStart > covered || baseStart > baseOrigin || source.base?.hasEarlier ? { blocks: blockStart, base: baseStart } : null },
    }
  }

  private version(block: LiveBlock | EntryBlock): string {
    const held = this.versions.get(block)
    if (held) return held
    const version = randomUUID()
    this.versions.set(block, version)
    return version
  }
}

function previewLive(block: LiveBlock, index: number): LiveBlock {
  if (block.type !== "tool" || !largeTool(block)) return block
  return { ...block, input: block.input?.slice(0, TOOL_PREVIEW), output: block.output?.slice(0, TOOL_PREVIEW),
    details: undefined, attachments: undefined,
    historyRest: { index, length: block.output?.length ?? 0 } }
}

function previewTool(block: EntryBlock): EntryBlock {
  if (block.type !== "tool" || !largeTool(block)) return block
  return { ...block, input: block.input?.slice(0, TOOL_PREVIEW), output: block.output?.slice(0, TOOL_PREVIEW) ?? "",
    outputLength: block.outputLength ?? block.output?.length ?? 0, contentOmitted: true,
    details: undefined, attachments: undefined }
}

function isPartialTool(value: EntryBlock | undefined | null): boolean {
  return value?.type === "tool" && (Boolean(value.contentOmitted || value.attachmentsOmitted) ||
    (value.outputLength ?? 0) > (value.output?.length ?? 0))
}

function largeTool(block: { input?: string; output?: string; details?: unknown; attachments?: unknown }): boolean {
  return (block.input?.length ?? 0) > TOOL_PREVIEW || (block.output?.length ?? 0) > TOOL_PREVIEW ||
    JSON.stringify([block.details, block.attachments]).length > TOOL_PREVIEW
}
