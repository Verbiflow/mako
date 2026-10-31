import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { ThreadPage } from "@mako/sessions"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import { HISTORY_VIEW_EXPIRED, type LiveHistoryAddress, type LiveHistoryRead, type LiveHistoryChunk, type LiveHistoryCursor } from "../contracts/live-history.js"
import { HistoryRecords, HistoryVersions, historyCapture, historyPage, historyRange, isPartial, type HistoryValue } from "../contracts/history-pages.js"
import { nativeHistoryRevision } from "./native-history.js"
import { cutOffRequests, mergedBaseSteps } from "./stream-merging.js"
import { inSlices } from "../base/slices.js"
import { ContentWeights } from "../contracts/residency.js"
import type { Entry } from "@mako/sessions/entries"
import { readOriginal, readStreamOriginal, type EntryOriginal } from "@mako/sessions/record-original"
import { hostLog } from "../base/host-log.js"
import { pagedOf, pagedWeight } from "./paged-entries.js"

/** A conversation's newest views: the one its windows hold, and ones a read still in flight names. */
const VIEWS_PER_CONVERSATION = 4
/** What views keep alive beyond what memory holds of their conversations anyway. */
const VIEW_BYTES = 128 * 1024 * 1024
/** How long a read may go without weighing the views again; a capture always does. */
const PRUNE_MS = 30_000
/** Views let go, remembered by token so a read naming one says why. */
const GONE_KEPT = 256
const IDLE_MS = 10 * 60_000
interface View { id: string; snapshot: LiveSnapshot; used: number }
/** Where an entry's bytes are read: its record by the catalog, and Mako's streams folder. */
interface Originals {
  record(path: string, id: string): Promise<EntryOriginal | null>
  streams: string
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
  private readonly records = new HistoryRecords()
  private readonly versions = new HistoryVersions()
  private readonly weights = new ContentWeights(pagedWeight)
  private readonly nativePage?: (path: string, before?: number) => Promise<ThreadPage | null>
  private readonly nativeEntry?: (path: string, id: string) => Promise<Entry | null>
  private readonly originals?: Originals
  /** What memory holds of a conversation now, without reading one only on disk back in. */
  private readonly held?: (id: string) => LiveSnapshot | undefined
  private readonly gone = new Map<string, { id: string; why: string; at: number }>()
  private pruned = 0
  /** A weighing of the views a capture asked for, still to run (`pruneSoon`). */
  private pruneDue?: ReturnType<typeof setImmediate>

  constructor(
    nativePage?: (path: string, before?: number) => Promise<ThreadPage | null>,
    nativeEntry?: (path: string, id: string) => Promise<Entry | null>,
    originals?: Originals,
    held?: (id: string) => LiveSnapshot | undefined,
  ) { this.nativePage = nativePage; this.nativeEntry = nativeEntry; this.originals = originals; this.held = held }

  /**
   * Conversation `id`'s entries were paged (`paged-entries.ts`): its views of
   * earlier revisions hold the paged entries too, so what they keep alive is
   * what memory keeps of the conversation, not its whole history again.
   */
  paged(id: string): void {
    const held = this.held?.(id)
    for (const view of this.views.values()) {
      if (view.id !== id) continue
      if (view.snapshot.blocks !== held?.blocks) swapPaged(view.snapshot.blocks)
      const entries = view.snapshot.base?.entries
      if (entries && entries !== held?.base?.entries) swapPaged(entries)
    }
  }

  /** Conversation `id` was let go: its views go with it, and a window reading one reads the conversation again. */
  released(id: string): void {
    for (const [token, view] of Array.from(this.views)) if (view.id === id) this.letGo(token, view, "its conversation was let go")
  }

  /** The captures this reader holds of conversation `id`, newest last: what its views keep alive, for a diagnostic. */
  viewsOf(id: string): LiveSnapshot[] {
    return Array.from(this.views.values()).flatMap((view) => (view.id === id ? [view.snapshot] : []))
  }

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
    this.pruneSoon()
    return historyCapture(token, snapshot, this.versions, from)
  }

  async read(id: string, input: LiveHistoryRead, snapshot: () => Promise<LiveSnapshot | null>): Promise<LiveHistoryChunk> {
    if (this.pruneDue) this.prunePending()
    else if (Date.now() - this.pruned > PRUNE_MS) this.pruneViews()
    this.records.prune()
    if (input.kind === "part") return this.records.part(id, input.record, input.offset)
    if (this.records.busy())
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
          const merged = await inSlices(mergedBaseSteps({ ...base, entries: [...earlier.entries, ...base.entries], start: earlier.start, hasEarlier: earlier.hasEarlier },
            blocks, baseCoveredBlocks ?? 0, baseLiveStart, { cutOff: cutOffRequests(requests) }))
          // Another read of this page may have prepended it meanwhile.
          if (view.snapshot.base === base) view.snapshot = { ...view.snapshot, base: merged.base }
        }
        value = input.kind === "range" ? historyRange(input.token, view.snapshot, input.from, input.to, this.versions)
          : historyPage(input.token, view.snapshot, input.before, this.versions)
      }
      else if (input.kind === "original") value = await this.original(view.snapshot, input.at)
      else if (input.at.kind === "live") {
        value = view.snapshot.blocks[input.at.index]
        if (value?.type === "tool") value = { ...value, historyVersion: this.versions.of(value) }
      } else {
        const base = view.snapshot.base
        const id = input.at.id
        value = base?.entries.find(entry => entry.id === id)
        const version = value?.type === "tool" ? this.versions.of(value) : undefined
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
    return this.records.open(id, value)
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

  /**
   * The views weighed once what a capture serves has gone out, on a turn of
   * the loop of its own: weighing a conversation of 150MB and its views takes
   * 20ms, and in the same stretch as the capture's first chunks it held the
   * loop past 50. A read before then weighs them first, as it would have.
   */
  private pruneSoon(): void {
    this.pruneDue ??= setImmediate(() => this.prunePending())
  }

  private prunePending(): void {
    if (!this.pruneDue) return
    clearImmediate(this.pruneDue)
    this.pruneDue = undefined
    this.pruneViews()
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
      if (held) this.weights.share(held, shared)
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
        this.weights.share(view.snapshot, shared)
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
}

/** Puts each entry's paged copy where `entries` holds the entry warm, so the warm one can go. */
function swapPaged(entries: Entry[]): void {
  for (let index = 0; index < entries.length; index++) {
    const paged = pagedOf(entries[index]!)
    if (paged) entries[index] = paged
  }
}
