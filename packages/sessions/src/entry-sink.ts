/**
 * How a decoder hands out what it read.
 *
 * Decoders assemble messages (`DecodedEntry`: a prompt, a reply with its
 * blocks, a marker) because that is how harnesses write them, and they
 * edit a message after pushing it as later records add to it. The sink
 * keeps those messages and turns them into entries (`entries.ts`) at its one
 * output, giving each entry the record it came from and an id taken from
 * that record.
 *
 * Records: a reader says which record it is reading (`reading`) before
 * passing it on. When the next record begins, every item of the messages
 * the last one touched whose size changed, and every new item, names that
 * record. A call named by its call line and then its result line names
 * both. Ids: the harness's own id where the item has one, else the place of
 * its first record (`@<offset>`, `<file>@<offset>`, `<table>:<key>`), with
 * `:<n>` for a record's nth entry. A second entry with the same native id
 * gets `#2`. Nothing in an id depends on decoder code.
 */
import { basename } from "node:path"
import { extractAttachmentEnvelope } from "./attachment-envelope.js"
import { isReplyEntry, type Entry, type EntryOf, type RecordRef } from "./entries.js"
import { withoutMakoFraming, type DecodedBlock, type DecodedEntry, type NativeRecordSample, type UnreadRecord, UNREAD_SAMPLE } from "./format.js"
import { AGENT_PLAN_TOOL } from "./tool-identity.js"
import type { z } from "zod"

/** What a decoder knew at a turn's start that reading from there needs: its own, as JSON. */
export type TurnState = z.infer<ReturnType<typeof z.json>>

/** What the sink knows of one pushed message: each item's size when last noted, and its record. */
interface Noted {
  sizes: number[]
  records: (RecordRef | undefined)[]
}

/** A record the reader couldn't read, where it stood: after `after` items of message `message`. */
interface UnreadMark {
  message: number
  after: number
  entry: EntryOf<"unread">
}

/**
 * Where a turn began: at message `message`, once `items` items and `marks`
 * unread records of the message before it were in (the unread records
 * before every message for the first), on the line at `byte`, with `unread`
 * counted by then.
 */
interface TurnStart {
  message: number
  items: number
  marks: number
  byte: number
  unread: UnreadRecord[] | undefined
  state: TurnState | undefined
}

/**
 * Where a fresh decoder can start again on a record and reproduce the rest
 * of a decode: the line its last turn began on, the entry that turn's first,
 * and the unread records counted before it. Nothing a decode emitted before
 * `entry` changed after that line, so a decode from `byte` holds every
 * entry from `entry` on; a record from after it that reaches back raises
 * `needsReset` instead.
 */
export interface TurnPoint {
  byte: number
  entry: number
  unread?: UnreadRecord[]
  /** What the decoder knew before that line, for one begun there. */
  state?: TurnState
}

/** One message's entries as last flattened, and the ids each was counted under in `idUses`. */
interface Flat {
  entries: Entry[]
  bases: string[]
}

export class EntrySink {
  private list: DecodedEntry[] = []
  private readonly noted = new WeakMap<DecodedEntry, Noted>()
  private readonly given = new WeakMap<DecodedEntry | DecodedBlock, RecordRef>()
  /** Messages pushed, replaced or edited since the last record was noted; the last message is always looked at. */
  private readonly changed = new Set<DecodedEntry>()
  private current: RecordRef | undefined
  private marks: UnreadMark[] = []
  /** Each message's entries as the last snapshot flattened them, after the unread records before the first. */
  private lead: Flat | undefined
  private flats: Flat[] = []
  /** How many entries took each id so far, over `lead` and `flats`, for `#2` and `:1`. */
  private readonly idUses = new Map<string, number>()
  /** The flat output, kept between snapshots so a follower's tick costs what changed. */
  private out: Entry[] = []
  /** The first message pushed, replaced, edited or cut since the last snapshot. */
  private touched = 0
  /** The last message at the last snapshot: it was still being written, so it is flattened again. */
  private open = 0
  private unchangedCount = 0
  private readonly unreadKinds = new Map<string, UnreadRecord>()
  /** Turns begun on this record's own lines whose start nothing since changed, oldest first. */
  private turns: TurnStart[] = []

  /** `after` is the id of the entry before the first this sink emits, for a sink that continues a decode at a `ResumePoint`. */
  constructor(private readonly after?: string) {}

  /**
   * The messages the sink holds, oldest first: the decoder's to read back.
   * Change them through `push`, `replace` and `truncate`; a message pushed
   * earlier than the last and then changed in place must be reported with
   * `edited`.
   */
  get entries(): readonly DecodedEntry[] {
    return this.list
  }

  /** Where the next message pushed sits. */
  get position(): number {
    return this.list.length
  }

  /**
   * How many leading entries the last snapshot returned as the one before it
   * did. The last message's never count: it is the one still being written.
   */
  get unchanged(): number {
    return this.unchangedCount
  }

  /**
   * The record the decoder reads next: what it adds or changes from here
   * until the next call names it. Undefined for content no record holds.
   */
  reading(record: RecordRef | undefined): void {
    this.note()
    this.current = record
  }

  /** The record being read, as `reading` last named it. */
  get record(): RecordRef | undefined {
    return this.current
  }

  /**
   * Names the records an item came from, for a decoder that assembles one
   * from records it read before pushing it. They stand instead of what the
   * sink noted for the item.
   */
  recorded(item: DecodedEntry | DecodedBlock, record: RecordRef | undefined): void {
    if (record) this.given.set(item, record)
  }

  /**
   * The record being read begins a turn: a decode can start again from it,
   * knowing `state`. Only a line of the record's own file, read whole, can
   * begin one.
   */
  turn(state?: TurnState): void {
    const record = this.current
    const range = record?.ranges?.length === 1 ? record.ranges[0] : undefined
    if (!record || record.file !== undefined || !range) return
    this.note()
    const before = this.list.length - 1
    this.turns.push({
      message: this.list.length,
      items: before < 0 ? 0 : itemsOf(this.list[before]!).length,
      marks: this.marks.reduce((count, mark) => count + (mark.message === before ? 1 : 0), 0),
      byte: range[0],
      unread: this.unreadKinds.size ? structuredClone([...this.unreadKinds.values()]) : undefined,
      state,
    })
  }

  /**
   * The latest turn a decode can start again from, as of the last snapshot;
   * undefined before one began or once each was changed behind.
   */
  get resume(): TurnPoint | undefined {
    const turn = this.turns.at(-1)
    if (!turn) return undefined
    const starts = this.starts()
    const before = turn.message - 1
    const entry = before < 0 ? turn.marks : (starts[before] ?? this.out.length) + turn.items + turn.marks
    const point: TurnPoint = { byte: turn.byte, entry }
    if (turn.unread) point.unread = turn.unread
    if (turn.state !== undefined) point.state = turn.state
    return point
  }

  /** Message `message` changed from item `after` on: turns that began after it can't be started again from. */
  private behind(message: number, after = 0): void {
    while (this.turns.length) {
      const turn = this.turns.at(-1)!
      if (message >= turn.message || (message === turn.message - 1 && after >= turn.items)) return
      this.turns.pop()
    }
  }

  /** Records that a pushed message changed in place. */
  edited(entry: DecodedEntry): void {
    const index = this.list.lastIndexOf(entry)
    if (index < 0) return
    this.changed.add(entry)
    this.touched = Math.min(this.touched, index)
    this.behind(index)
  }

  push(entry: DecodedEntry): void {
    // The message being written until now may have changed since it was last looked at.
    const last = this.list.at(-1)
    if (last) this.changed.add(last)
    this.touched = Math.min(this.touched, this.list.length)
    this.list.push(entry)
    this.changed.add(entry)
  }

  replace(index: number, entry: DecodedEntry): void {
    this.list[index] = entry
    this.changed.add(entry)
    this.touched = Math.min(this.touched, index)
    this.behind(index)
  }

  truncate(length: number): void {
    if (length >= this.list.length) return
    this.list.length = length
    this.marks = this.marks.filter((mark) => mark.message < length)
    this.touched = Math.min(this.touched, length)
    // A turn that began at `length` is cut back to its start, which stands.
    this.turns = this.turns.filter((turn) => turn.message <= length)
    const last = this.turns.at(-1)
    if (last && last.message === length && length > 0 && itemsOf(this.list[length - 1]!).length !== last.items) this.turns.pop()
  }

  /** Drops every message from `position` on. */
  rewind(position: number): void {
    this.truncate(Math.max(0, position))
  }

  /** A native record this sink's reader couldn't draw: an entry where it stood, and a count by kind for diagnostics. */
  unread(kind: string, reason: UnreadRecord["reason"], sample?: NativeRecordSample): void {
    this.place(this.unreadEntry(kind, reason, sample))
  }

  /**
   * `unread` for a reader that holds what it read before pushing it: the
   * record being read, counted, as an entry for `place` to put where it
   * stood once the messages around it are pushed.
   */
  unreadEntry(kind: string, reason: UnreadRecord["reason"], sample?: NativeRecordSample): EntryOf<"unread"> {
    const entry: EntryOf<"unread"> = { type: "unread", kind, reason }
    const text = sample === undefined ? undefined : JSON.stringify(sample)
    if (text !== undefined) entry.raw = JSON.parse(text)
    if (this.current) entry.record = this.current
    const key = `${reason}\0${kind}`
    const known = this.unreadKinds.get(key)
    if (known) known.count++
    else {
      const record: UnreadRecord = { kind, reason, count: 1 }
      if (text !== undefined) record.sample = text.length > UNREAD_SAMPLE ? `${text.slice(0, UNREAD_SAMPLE)}… (${text.length} characters)` : JSON.parse(text)
      this.unreadKinds.set(key, record)
    }
    return entry
  }

  /** Puts an unread record's entry after `after` items of message `message` (-1: before every message); by default, after everything pushed so far. */
  place(entry: EntryOf<"unread">, message = this.list.length - 1, after = message < 0 ? 0 : itemsOf(this.list[message]!).length): void {
    this.marks.push({ message, after, entry })
    this.touched = Math.min(this.touched, message < 0 ? -1 : message)
    this.behind(message, after)
  }

  /** Takes back what `place` put. */
  unplace(entry: EntryOf<"unread">): void {
    const index = this.marks.findIndex((mark) => mark.entry === entry)
    if (index < 0) return
    const [mark] = this.marks.splice(index, 1)
    this.touched = Math.min(this.touched, mark!.message < 0 ? -1 : mark!.message)
    this.behind(mark!.message, -1)
  }

  /** What `unread` counted, in the order each kind first came; undefined when every record was read. */
  get unreadRecords(): UnreadRecord[] | undefined {
    return this.unreadKinds.size ? [...this.unreadKinds.values()] : undefined
  }

  /** Every entry so far, oldest first. */
  snapshot(): Entry[] {
    this.note()
    const last = this.list.length - 1
    // Messages before the first that changed, and before the one still being written at the last snapshot, keep their entries and ids.
    const from = Math.min(this.touched, this.open, this.flats.length)
    for (const flat of from < 0 ? [this.lead, ...this.flats] : this.flats.slice(from))
      for (const base of flat?.bases ?? []) {
        const uses = (this.idUses.get(base) ?? 0) - 1
        if (uses > 0) this.idUses.set(base, uses)
        else this.idUses.delete(base)
      }
    let kept = 0
    if (from < 0) this.lead = undefined
    else kept = this.flats.slice(0, from).reduce((sum, flat) => sum + flat.entries.length, this.lead?.entries.length ?? 0)
    this.flats.length = Math.max(0, from)
    this.out.length = kept
    let previous = this.out.at(-1)?.id ?? this.after
    if (!this.lead) {
      this.lead = { entries: [], bases: [] }
      for (const mark of this.marks)
        if (mark.message < 0) previous = this.add(this.lead, mark.entry, undefined, mark.entry.record, previous)
      this.out.push(...this.lead.entries)
    }
    for (let index = Math.max(0, from); index <= last; index++) {
      const message = this.list[index]!
      cleanEntry(message)
      const flat: Flat = { entries: [], bases: [] }
      const noted = this.noted.get(message)
      const marks = this.marks.filter((mark) => mark.message === index)
      let mark = 0
      const items = flatItems(message)
      for (let item = 0; item <= items.length; item++) {
        for (; mark < marks.length && (item === items.length || marks[mark]!.after <= item); mark++)
          previous = this.add(flat, marks[mark]!.entry, undefined, marks[mark]!.entry.record, previous)
        const next = items[item]
        if (next) previous = this.add(flat, next.entry, next.native, this.given.get(next.source) ?? noted?.records[item], previous)
      }
      this.flats.push(flat)
      this.out.push(...flat.entries)
    }
    this.unchangedCount = kept
    this.touched = this.list.length
    this.open = Math.max(0, last)
    return this.out.slice()
  }

  done(): Entry[] {
    return this.snapshot()
  }

  /** Where each message's entries begin in the last snapshot, by message. */
  starts(): number[] {
    const starts: number[] = []
    let at = this.lead?.entries.length ?? 0
    for (const flat of this.flats) {
      starts.push(at)
      at += flat.entries.length
    }
    return starts
  }

  /** The record being read, noted on every item the messages it touched gained or changed. */
  private note(): void {
    const last = this.list.at(-1)
    if (last) this.changed.add(last)
    for (const message of this.changed) {
      let noted = this.noted.get(message)
      if (!noted) this.noted.set(message, (noted = { sizes: [], records: [] }))
      const items = itemsOf(message)
      for (let index = 0; index < items.length; index++) {
        const size = sizeOf(items[index]!)
        if (index < noted.sizes.length && noted.sizes[index] === size) continue
        noted.sizes[index] = size
        noted.records[index] = joined(noted.records[index], this.current)
        // An item that grew or came after a turn began, in a message before it: that turn can't be started again from.
        if (this.turns.length) this.behind(this.list.lastIndexOf(message), -1)
      }
      noted.sizes.length = Math.min(noted.sizes.length, items.length)
      noted.records.length = Math.min(noted.records.length, items.length)
    }
    this.changed.clear()
  }

  /**
   * Adds `entry` to `flat` with its record and the id it takes here, which it
   * returns: its native id, or its record's place. One no record names
   * follows the entry before it.
   */
  private add(flat: Flat, entry: Entry, native: string | undefined, record: RecordRef | undefined, previous: string | undefined): string {
    if (record) entry.record = record
    const base = native ?? (record ? placeOf(record) : `${previous ?? "start"}+`)
    const uses = this.idUses.get(base) ?? 0
    this.idUses.set(base, uses + 1)
    entry.id = uses === 0 ? base : native === undefined ? `${base}:${uses}` : `${base}#${uses + 1}`
    if (entry.type === "proposed-plan" && native !== undefined && entry.id !== native) entry.plan = native
    flat.entries.push(entry)
    flat.bases.push(base)
    return entry.id
  }
}

/**
 * Messages an earlier build kept (archives, journal copies, decoders' own
 * scaffolding) as entries. No record names them; an item without its own id
 * takes its message's and its place in it.
 */
export { messagesFromEntries } from "./entry-groups.js"

export function entriesFromMessages(messages: readonly DecodedEntry[]): Entry[] {
  const entries: Entry[] = []
  const uses = new Map<string, number>()
  messages.forEach((message, index) => {
    for (const [item, { entry, native }] of flatItems(message).entries()) {
      const base = native ?? (message.id ? `${message.id}:${item}` : `#${index}:${item}`)
      const count = uses.get(base) ?? 0
      uses.set(base, count + 1)
      entry.id = count ? `${base}#${count + 1}` : base
      if (entry.type === "proposed-plan" && native !== undefined && entry.id !== native) entry.plan = native
      entries.push(entry)
    }
  })
  return entries
}

/** An item as an entry, the harness's own id for it when it has one, and the decoded item it came from. */
interface FlatItem {
  entry: Entry
  native: string | undefined
  source: DecodedEntry | DecodedBlock
}

/** A message's items: the prompt or marker itself, or each block of a reply. */
function itemsOf(message: DecodedEntry): readonly (DecodedEntry | DecodedBlock)[] {
  return message.kind === "assistant" ? message.blocks : [message]
}

function flatItems(message: DecodedEntry): FlatItem[] {
  const at = message.at === undefined ? undefined : Date.parse(message.at)
  const when = at === undefined || Number.isNaN(at) ? undefined : at
  if (message.kind === "user") {
    const entry: EntryOf<"user"> = { type: "user", text: message.text }
    if (message.steeringFor) entry.steeringFor = message.steeringFor
    if (message.attachments?.length) entry.attachments = message.attachments
    if (when !== undefined) entry.at = when
    return [{ entry, native: message.id, source: message }]
  }
  if (message.kind === "event") {
    if (message.opensTurn) {
      const entry: EntryOf<"provider-turn"> = { type: "provider-turn", reason: message.label }
      if (message.source) entry.source = message.source
      if (message.cause) entry.cause = message.cause
      if (message.body) entry.body = message.body
      if (message.detail !== undefined) entry.detail = message.detail
      if (message.tone) entry.tone = message.tone
      if (when !== undefined) entry.at = when
      return [{ entry, native: message.id ?? message.source?.record, source: message }]
    }
    const entry: EntryOf<"event"> = { type: "event", label: message.label }
    if (message.source) entry.source = message.source
    if (message.detail !== undefined) entry.detail = message.detail
    if (message.body !== undefined) entry.body = message.body
    if (message.tone) entry.tone = message.tone
    if (message.setup) entry.setup = message.setup
    if (message.cause) entry.cause = message.cause
    if (message.limit) entry.limit = message.limit
    if (when !== undefined) entry.at = when
    return [{ entry, native: message.id ?? message.source?.record, source: message }]
  }
  const items = message.blocks.map((block): FlatItem => {
    const item = blockItem(block)
    if (when !== undefined) item.entry.at = when
    return item
  })
  const first = items[0]?.entry
  const last = items.at(-1)?.entry
  if (message.model && first && isReplyEntry(first)) first.model = message.model
  if (message.usage && last && isReplyEntry(last)) last.usage = message.usage
  return items
}

function blockItem(block: DecodedBlock): FlatItem {
  switch (block.type) {
    case "text":
    case "thinking":
      return { entry: { type: block.type, text: block.text }, native: block.id, source: block }
    case "attachment":
      return { entry: { type: "attachment", attachment: block }, native: undefined, source: block }
    case "proposed-plan": {
      const entry: EntryOf<"proposed-plan"> = { type: "proposed-plan", id: block.id, text: block.text, status: block.status }
      if (block.truncated) entry.truncated = true
      return { entry, native: block.id, source: block }
    }
    case "tool": {
      const plan = block.name === AGENT_PLAN_TOOL && block.details?.length === 1 && block.details[0]!.type === "plan" ? block.details[0] : undefined
      if (plan?.type === "plan" && !block.id && !block.input && !block.output && !block.attachments?.length) return { entry: { type: "plan", entries: plan.entries }, native: undefined, source: block }
      const entry: EntryOf<"tool"> = { type: "tool", id: block.id ?? "", name: block.name }
      if (block.title !== undefined) entry.title = block.title
      if (block.toolKind !== undefined) entry.toolKind = block.toolKind
      const status = block.status ?? (block.canceled ? "canceled" : block.error ? "failed" : block.output !== undefined ? "completed" : undefined)
      if (status !== undefined) entry.status = status
      if (block.input !== undefined) entry.input = block.input
      if (block.output !== undefined) entry.output = block.output
      if (block.outputLength !== undefined) entry.outputLength = block.outputLength
      if (block.contentOmitted) entry.contentOmitted = true
      if (block.attachmentsOmitted !== undefined) entry.attachmentsOmitted = block.attachmentsOmitted
      if (block.historyVersion !== undefined) entry.historyVersion = block.historyVersion
      if (block.details?.length) entry.details = block.details
      if (block.attachments?.length) entry.attachments = block.attachments
      if (block.effects?.length) entry.effects = block.effects
      return { entry, native: block.id, source: block }
    }
  }
}

/**
 * A cheap fingerprint of an item's content, which changes when a record
 * adds to it. Lengths, not contents: a record that rewrites a block to the
 * same length leaves it naming the records it had.
 */
function sizeOf(item: DecodedEntry | DecodedBlock): number {
  if ("kind" in item) {
    if (item.kind === "user") return item.text.length * 3 + (item.attachments?.length ?? 0)
    if (item.kind === "event") return item.label.length * 7 + (item.detail?.length ?? 0) * 3 + (item.body?.length ?? 0)
    return item.blocks.length
  }
  switch (item.type) {
    case "text":
    case "thinking":
    case "proposed-plan":
      return item.text.length + 1
    case "attachment":
      return 1
    case "tool":
      return 1 + (item.input?.length ?? 0) * 31 + (item.output?.length ?? 0) * 17 + (item.error ? 2 : 0) + (item.canceled ? 4 : 0) +
        (item.details?.length ?? 0) * 1009 + (item.attachments?.length ?? 0) * 7919 + (item.effects?.length ?? 0) * 104_729 + (item.status?.length ?? 0) * 13
  }
}

/**
 * `record` added to what an item already names, as a new reference: one an
 * entry already handed out never changes. Ranges stay sorted and merged. An
 * item names records of one file; a later file's record is left out.
 */
export function joined(held: RecordRef | undefined, record: RecordRef | undefined): RecordRef | undefined {
  if (!record) return held
  if (!held) return record
  if (held.file !== record.file) return held
  const next: RecordRef = {}
  if (held.file !== undefined) next.file = held.file
  if (held.ranges || record.ranges) {
    const ranges: [number, number][] = []
    for (const [from, to] of [...held.ranges ?? [], ...record.ranges ?? []].sort((a, b) => a[0] - b[0])) {
      const last = ranges.at(-1)
      if (last && from <= last[1]) last[1] = Math.max(last[1], to)
      else ranges.push([from, to])
    }
    next.ranges = ranges
  }
  if (held.rows || record.rows) {
    const rows = [...held.rows ?? []]
    for (const row of record.rows ?? []) if (!rows.some((kept) => kept.table === row.table && sameKey(kept.key, row.key))) rows.push(row)
    next.rows = rows
  }
  return next
}

function sameKey(left: Record<string, string | number>, right: Record<string, string | number>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

/** Where a record starts, as an id: `@<offset>` in the session's file, `<file>@<offset>` in another, `<table>:<key>` for a row. */
export function placeOf(record: RecordRef): string {
  const range = record.ranges?.[0]
  if (range) return `${record.file ? basename(record.file) : ""}@${range[0]}`
  const row = record.rows?.[0]
  if (row) return `${row.table}:${Object.values(row.key).join(":")}`
  return record.file ? basename(record.file) : "record"
}

/**
 * Takes Mako's own framing out of a message: the wrapper it sends around a
 * prompt, and attachments it carried in the text for a harness that takes
 * none. Running it again changes nothing.
 */
export function cleanEntry(entry: DecodedEntry): void {
  if (entry.kind === "user") {
    entry.text = withoutMakoFraming(entry.text)
    const portable = extractAttachmentEnvelope(entry.text)
    if (portable.attachments.length) {
      entry.text = portable.text
      entry.attachments = [...(entry.attachments ?? []), ...portable.attachments]
    }
  } else if (entry.kind === "assistant") {
    if (entry.blocks.some((block) => block.type === "text" && block.text.includes("<mako-attachments>")))
      entry.blocks = entry.blocks.flatMap((block): DecodedBlock[] => {
        if (block.type !== "text") return [block]
        const portable = extractAttachmentEnvelope(block.text)
        return portable.attachments.length ? [{ ...block, text: portable.text }, ...portable.attachments] : [block]
      })
  }
}
