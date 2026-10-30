import { joined, type Entry, type EntryOf, type MakoCommand, type RecordRef } from "./entries.js"

/**
 * One history of a conversation's turns from its two truths: the entries
 * the live transport streamed (Mako's blocks, each naming its stream
 * frames) and the entries the harness's record holds. While a turn
 * streams, its entries come from the stream; once the record lands, the
 * record is authoritative for every item it holds, and the stream supplies
 * only what that harness's record never keeps, as its vocabulary declares
 * (`HarnessStorage.stream`). Each record entry the stream also streamed
 * names its frames beside its own bytes, and a prompt shows Mako's words
 * and facts. Anything else the two disagree on is a mismatch, returned
 * with both sides so the host logs it.
 *
 * The two align by content, never by position: adjacent text (or thinking)
 * entries are one item, as harnesses split a reply differently; a call by
 * its id; a prompt, a marker or a plan by what it says. Merging is
 * idempotent: an entry it supplied is held by the next merge's record side
 * and matches itself.
 */

/**
 * Where a harness's live transport and its record part ways, by design:
 *
 * - `stream`: only the transport says it; the record never keeps it. The
 *   merged history keeps it where it streamed.
 * - `record`: only the record keeps it.
 * - `order`: both hold it, in another order; the record's stands.
 * - `changed`: both hold it, worded otherwise; the record's stands.
 */
export interface StreamDifference {
  holds: "stream" | "record" | "order" | "changed"
  entry: EntryPattern
  /** Why, in words, with what it was checked against. */
  why: string
}

/**
 * What Mako draws of a harness's report on starting a session (an MCP
 * server that failed to start): said to the client on the transport, kept
 * in no harness's record.
 */
export const SETUP_NOTICES: StreamDifference = {
  holds: "stream",
  entry: { type: "event", setup: true },
  why: "A harness reports its servers' startup to the client it starts for and records none of it; the flows of 2026-10-15 saw an MCP server's failure live on Claude, Codex, Devin and Grok and in none of their records.",
}

/**
 * Mako's marker for a provider's retries of the model, measured as they
 * streamed: how many, how long, and whether the model answered or the
 * provider gave up. A record keeps at most each retry's own notice, never
 * that measure, so the marker stays where it streamed.
 */
export const RETRY_MARKERS: StreamDifference = {
  holds: "stream",
  entry: { type: "event", retries: true },
  why: "Mako sums up a provider's retries from the retry notices it streams and what ends them (Claude's api_retry, Codex's error with willRetry, Grok's retry_state, OpenCode's session.retry.scheduled, Devin's connection_retry); Codex keeps none of those notices in its rollout, and the decode pairs' server-error recordings on Codex, Grok and OpenCode hold no such marker in their stores.",
}

/**
 * A stopped turn's marker, which the record writes where the turn stopped;
 * live, the window draws the stop from the host's turn state, as the
 * footer the marker then sits beside (`notesBesideStop`).
 */
export const STOP_MARKER: StreamDifference = {
  holds: "record",
  entry: { type: "event", label: /^Interrupted$/ },
  why: "The stop is the host's turn state live and a marker in the record; the decode pairs' stopped-shell recordings hold it in the record alone.",
}

/**
 * Entries of one type; a marker or an opener by its label or reason, a
 * marker by its detail, whether
 * it is a setup notice, a prompt by the Mako command it sent or by being
 * steered into a running turn, and whether its turn was cut off: on the
 * stream's side, the turn holds a call that never returned a result
 * (`unfinished`), because the person stopped it or its process died. An
 * `order` difference of a steered prompt covers the prompt and every item
 * that moved across it.
 */
export interface EntryPattern {
  type: Entry["type"]
  label?: RegExp
  /** A marker's detail; for a `changed` difference, as the record words it. */
  detail?: RegExp
  setup?: true
  /** A marker summing up a provider's retries (`TranscriptEvent.retries`). */
  retries?: true
  command?: MakoCommand
  steered?: true
  cutOff?: true
}

/**
 * What a harness's record never keeps of a turn cut off under it, each type
 * one declaration scoped to such turns (`EntryPattern.cutOff`): the merge
 * keeps it where it streamed, so the work is shown, not lost, and the same
 * entries in a turn that ended are still a mismatch.
 */
export function cutOffTurn(types: readonly Entry["type"][], why: string): StreamDifference[] {
  return types.map((type) => ({ holds: "stream", entry: { type, cutOff: true }, why }))
}

export type StreamMismatchKind = "stream-only" | "record-only" | "changed" | "order"

export interface StreamMismatch {
  kind: StreamMismatchKind
  type: Entry["type"]
  /** What each side holds of it, as it holds it; an entry one side lacks has that side empty. */
  stream: Entry[]
  record: Entry[]
  /** The index of the first stream entry at or after it. */
  at: number
}

export interface StreamMerge {
  entries: Entry[]
  /** Entries the stream supplied that the record lacks, as declared. */
  supplied: number
  mismatches: StreamMismatch[]
  /** The two sides differed by more than an alignment is attempted for; the record stands alone. */
  unaligned?: true
}

/** Past this many entries in which the two sides differ, the record stands alone, and that is a mismatch of its own. */
export const MAX_STREAM_DIFFERENCES = 2_000

interface Unit {
  type: Entry["type"]
  /** Entries `[from, to)` of its side. */
  from: number
  to: number
  /** Text and thinking: the text joined, without whitespace; a prompt: its text so. */
  key?: string
}

type Step = { kind: "same"; record: number; stream: number } | { kind: "record"; record: number } | { kind: "stream"; stream: number }

/**
 * `cutOff`: the requests whose turns ended without their record keeping all
 * they streamed (stopped, failed, or lost with the process), as Mako's log
 * says. A turn is cut off when its prompt names one of them, or when it holds
 * a call that never returned a result.
 */
export function mergeStream(record: readonly Entry[], stream: readonly Entry[], differences: readonly StreamDifference[] = [], cutOff?: ReadonlySet<string>): StreamMerge {
  return finished(mergeStreamSteps(record, stream, differences, cutOff))
}

/**
 * Work that stops (`yield`) every few hundred items it goes through, so a
 * caller can run it at once (`finished`) or a slice at a time between other
 * work: a history of 150MB merged in one stretch held a host's loop for a
 * third of a second.
 */
export type Steps<Result> = Generator<void, Result, void>

/** `steps` run to their end at once. */
export function finished<Result>(steps: Steps<Result>): Result {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/** How many items a merge goes through between two stops. */
const ITEMS_PER_STEP = 256

/** `mergeStream` as `Steps`: the same merge, stopping every `ITEMS_PER_STEP` items. */
export function* mergeStreamSteps(record: readonly Entry[], stream: readonly Entry[], differences: readonly StreamDifference[] = [], cutOff?: ReadonlySet<string>): Steps<StreamMerge> {
  const cut = cutOffEntries(stream, cutOff)
  const left = yield* units(record)
  const right = yield* units(stream)
  const same = (a: number, b: number) => sameUnit(record, left[a]!, stream, right[b]!)
  const steps = yield* align(left.length, right.length, same)
  if (!steps) {
    return {
      entries: [...record],
      supplied: 0,
      mismatches: [{ kind: "changed", type: record[0]?.type ?? stream[0]?.type ?? "text", stream: [...stream], record: [...record], at: 0 }],
      unaligned: true,
    }
  }
  // An item both hold elsewhere in the same turn moved; what is left of a
  // run between two that agree pairs in order, kind by kind: one item said
  // twice, one way by the stream and another by the record. What the
  // harness declares only its stream says is no record item's other side.
  const partner = new Map<number, { stream: number; kind: "order" | "changed" | "paired" }>()
  const taken = new Set<number>()
  const turns = new Map<number, { records: number[]; streams: number[] }>()
  let turn = 0
  let items = 0
  for (const step of steps) {
    if (++items % ITEMS_PER_STEP === 0) yield
    if (step.kind === "same") {
      if (opensTurn(record[left[step.record]!.from]!)) turn++
      continue
    }
    const held = turns.get(turn) ?? { records: [], streams: [] }
    turns.set(turn, held)
    if (step.kind === "record") held.records.push(step.record)
    else held.streams.push(step.stream)
  }
  for (const { records, streams } of turns.values())
    for (const at of records)
      for (const candidate of streams) {
        if (++items % ITEMS_PER_STEP === 0) yield
        if (!taken.has(candidate) && same(at, candidate)) {
          partner.set(at, { stream: candidate, kind: "order" })
          taken.add(candidate)
          break
        }
      }
  for (let start = 0; start < steps.length; ) {
    if (++items % ITEMS_PER_STEP === 0) yield
    if (steps[start]!.kind === "same") {
      start++
      continue
    }
    let end = start
    while (end < steps.length && steps[end]!.kind !== "same") end++
    const streams: number[] = []
    for (const step of steps.slice(start, end))
      if (step.kind === "stream" && !taken.has(step.stream) && !declared(differences, "stream-only", stream[right[step.stream]!.from]!)) streams.push(step.stream)
    for (const step of steps.slice(start, end)) {
      if (step.kind !== "record" || partner.has(step.record)) continue
      const unit = left[step.record]!
      const candidate = streams.find((index) => !taken.has(index) && right[index]!.type === unit.type && pairable(unit.type))
      if (candidate === undefined) continue
      partner.set(step.record, { stream: candidate, kind: unit.type === "user" ? "paired" : "changed" })
      taken.add(candidate)
    }
    start = end
  }
  const entries: Entry[] = []
  const mismatches: StreamMismatch[] = []
  let supplied = 0
  let streamAt = 0
  const sides = (a: Unit | undefined, b: Unit | undefined) => ({
    record: a ? record.slice(a.from, a.to) : [],
    stream: b ? stream.slice(b.from, b.to) : [],
  })
  const note = (kind: StreamMismatchKind, a: Unit | undefined, b: Unit | undefined) => {
    const entry = (a ? record[a.from] : stream[b!.from])!
    if (declared(differences, kind, entry, !a && cut.has(b!.from)) || ((!a || wordless(a)) && (!b || wordless(b)))) return
    mismatches.push({ kind, type: entry.type, ...sides(a, b), at: b ? b.from : streamAt })
  }
  // Steered prompts both sides hold in place, by their record and stream items.
  // Only read where a harness declares a steer's order, so a merge of any other harness walks no step for them.
  const steers: (readonly [number, number])[] = []
  const steerOrder = differences.some((difference) => difference.holds === "order" && difference.entry.type === "user" && difference.entry.steered)
  if (steerOrder)
    for (const step of steps) {
      if (++items % ITEMS_PER_STEP === 0) yield
      if (step.kind !== "same") continue
      const entry = record[left[step.record]!.from]!
      if (entry.type === "user" && entry.steeringFor) steers.push([step.record, step.stream])
    }
  /** An item that moved across a steered prompt, where a declared steer's order explains it. */
  const acrossSteer = (at: number, streamed: number) => steerOrder && steers.some(([inRecord, inStream]) => (inRecord > at) !== (inStream > streamed))
  const fromRecord = (index: number) => {
    const a = left[index]!
    const pair = partner.get(index)
    if (!pair) {
      note("record-only", a, undefined)
      entries.push(...record.slice(a.from, a.to))
      return
    }
    const b = right[pair.stream]!
    if (pair.kind !== "paired" && !(pair.kind === "order" && acrossSteer(index, pair.stream))) note(pair.kind, a, b)
    entries.push(...merged(record, a, stream, b))
  }
  const fromStream = (index: number) => {
    const b = right[index]!
    streamAt = b.to
    if (taken.has(index)) return
    if (declared(differences, "stream-only", stream[b.from]!, cut.has(b.from))) {
      const kept = stream.slice(b.from, b.to).filter((entry, index) => index === 0 || !drawsNothing(entry))
      entries.push(...kept)
      supplied += kept.length
    } else note("stream-only", undefined, b)
  }
  for (let start = 0; start < steps.length; ) {
    if (++items % ITEMS_PER_STEP === 0) yield
    const step = steps[start]!
    if (step.kind === "same") {
      const b = right[step.stream]!
      streamAt = b.to
      entries.push(...merged(record, left[step.record]!, stream, b))
      start++
      continue
    }
    // In a run where the two differ, the record's items keep their order,
    // and what only the stream holds goes before the first of them whose
    // stream partner streamed after it.
    let end = start
    while (end < steps.length && steps[end]!.kind !== "same") end++
    const streamed: number[] = []
    for (let at = start; at < end; at++) {
      const item = steps[at]!
      if (item.kind === "stream") streamed.push(item.stream)
    }
    let next = 0
    for (let at = start; at < end; at++) {
      const item = steps[at]!
      if (item.kind !== "record") continue
      const pair = partner.get(item.record)
      if (pair) while (next < streamed.length && streamed[next]! < pair.stream) fromStream(streamed[next++]!)
      fromRecord(item.record)
    }
    while (next < streamed.length) fromStream(streamed[next++]!)
    start = end
  }
  return { entries, supplied, mismatches }
}

/**
 * Where in `record` the `live` entries begin when `inherited` holds the
 * history before them as another reading did: a fork's copy of its parent's
 * merged history, which keeps what the parent's stream supplied and the
 * fork's record lacks, and lacks what only the record keeps. The record's
 * place after the last item it shares with `inherited`, aligned against
 * both, so a fork's turn that repeats its parent's last pairs with its own
 * blocks. Undefined when the two differ past what an alignment is
 * attempted for.
 */
export function recordSpan(record: readonly Entry[], inherited: readonly Entry[], live: readonly Entry[]): number | undefined {
  return finished(recordSpanSteps(record, inherited, live))
}

/** `recordSpan` as `Steps`. */
export function* recordSpanSteps(record: readonly Entry[], inherited: readonly Entry[], live: readonly Entry[]): Steps<number | undefined> {
  const stream = [...inherited, ...live]
  const left = yield* units(record)
  // Units of their own, so a reply that ends the copy never joins one that starts the blocks.
  const right = [...yield* units(inherited), ...(yield* units(live)).map((unit) => ({ ...unit, from: unit.from + inherited.length, to: unit.to + inherited.length }))]
  const steps = yield* align(left.length, right.length, (a, b) => sameUnit(record, left[a]!, stream, right[b]!))
  if (!steps) return undefined
  let span = 0
  for (const step of steps) if (step.kind === "same" && right[step.stream]!.from < inherited.length) span = left[step.record]!.to
  return span
}

/**
 * Entries as the items they are compared by: a run of text, or of thinking,
 * is one. Text or thinking with no words draws nothing on either side (a
 * Claude model that hides its thinking streams it empty, and its transcript
 * keeps none), so it rides with the item before it: the record's is kept,
 * the stream's dropped, neither reported.
 */
function* units(entries: readonly Entry[]): Steps<Unit[]> {
  const found: Unit[] = []
  for (let index = 0; index < entries.length; index++) {
    if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield
    const entry = entries[index]!
    const last = found.at(-1)
    if (last && drawsNothing(entry)) {
      last.to++
      continue
    }
    if ((entry.type === "text" || entry.type === "thinking") && last?.type === entry.type && last.to === index) {
      last.to++
      last.key += spaceless(entry.text)
      continue
    }
    const unit: Unit = { type: entry.type, from: index, to: index + 1 }
    if (entry.type === "text" || entry.type === "thinking" || entry.type === "user") unit.key = spaceless(entry.text)
    found.push(unit)
  }
  return found
}

function drawsNothing(entry: Entry): boolean {
  return (entry.type === "text" || entry.type === "thinking") && !/\S/.test(entry.text)
}

/** Text or thinking with no words, which draws nothing. */
function wordless(unit: Unit): boolean {
  return (unit.type === "text" || unit.type === "thinking") && unit.key === ""
}

/** Text as compared: without its whitespace, so where either side split a reply, or how it spaced one, doesn't matter. */
function spaceless(text: string): string {
  return text.replace(/\s+/g, "")
}

function collapsed(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function sameUnit(record: readonly Entry[], a: Unit, stream: readonly Entry[], b: Unit): boolean {
  if (a.type !== b.type) return false
  if (a.key !== undefined) return a.key === b.key
  const left = record[a.from]!
  const right = stream[b.from]!
  switch (left.type) {
    case "tool":
      return right.type === "tool" && sameCall(left.id, right.id)
    case "event":
      return right.type === "event" &&
        ((left.id !== undefined && left.id === right.id) || (left.label === right.label && (left.detail ?? "") === (right.detail ?? "")))
    case "provider-turn":
      return right.type === "provider-turn" && ((left.id !== undefined && left.id === right.id) || collapsed(left.reason) === collapsed(right.reason))
    case "plan":
      return right.type === "plan" && JSON.stringify(left.entries) === JSON.stringify(right.entries)
    case "proposed-plan":
      return right.type === "proposed-plan" && (left.id === right.id || collapsed(left.text) === collapsed(right.text))
    case "attachment":
      return right.type === "attachment" && left.attachment.name === right.attachment.name && left.attachment.mimeType === right.attachment.mimeType
    case "unread":
      return left.id !== undefined && left.id === right.id
    default:
      return false
  }
}

/** One call: the same id, or one side's id scoped by what ran it (`<session>:<call>`). */
function sameCall(left: string, right: string): boolean {
  return left === right || left.endsWith(`:${right}`) || right.endsWith(`:${left}`)
}

/** The stream's entries in turns cut off under them: each turn holding a call that never returned a result. */
function cutOffEntries(stream: readonly Entry[], requests: ReadonlySet<string> | undefined): Set<number> {
  const cut = new Set<number>()
  // One pass, copying nothing: a merge runs on every open, and most turns ended.
  let start = 0
  let cutHere = false
  const close = (end: number) => {
    if (cutHere) for (let index = start; index < end; index++) cut.add(index)
  }
  for (let index = 0; index < stream.length; index++) {
    const entry = stream[index]!
    if (index > 0 && opensTurn(entry)) {
      close(index)
      start = index
      cutHere = false
    }
    if (index === start && entry.type === "user" && entry.requestId !== undefined && requests?.has(entry.requestId)) cutHere = true
    if (entry.type === "tool" && entry.unfinished) cutHere = true
  }
  close(stream.length)
  return cut
}

/** A prompt of its own or a turn the provider started: what a turn begins with. */
function opensTurn(entry: Entry): boolean {
  return (entry.type === "user" && !entry.steeringFor) || entry.type === "provider-turn"
}

/**
 * Kinds whose two sides pair in order where they disagree: each is one item
 * of its turn, said twice. A call is one call only by its id, or the record
 * would take another call's output.
 */
function pairable(type: Entry["type"]): boolean {
  return type !== "tool" && type !== "attachment" && type !== "unread"
}

/** Whether `differences` declare `entry` one its harness's record never keeps, so a merge takes it from the stream. */
export function declaredStreamOnly(differences: readonly StreamDifference[], entry: Entry): boolean {
  return declared(differences, "stream-only", entry)
}

function declared(differences: readonly StreamDifference[], kind: StreamMismatchKind, entry: Entry, cutOff = false): boolean {
  const holds = kind === "stream-only" ? "stream" : kind === "record-only" ? "record" : kind
  return differences.some((difference) => difference.holds === holds && matches(difference.entry, entry, cutOff))
}

function matches(pattern: EntryPattern, entry: Entry, cutOff: boolean): boolean {
  if (pattern.type !== entry.type) return false
  if (pattern.cutOff && !cutOff) return false
  if (pattern.setup && !(entry.type === "event" && entry.setup)) return false
  if (pattern.retries && !(entry.type === "event" && entry.retries)) return false
  if (pattern.command && !(entry.type === "user" && entry.command === pattern.command)) return false
  if (pattern.steered && !(entry.type === "user" && entry.steeringFor)) return false
  if (pattern.label) {
    const words = entry.type === "event" ? entry.label : entry.type === "provider-turn" ? entry.reason : undefined
    if (words === undefined || !pattern.label.test(words)) return false
  }
  if (pattern.detail && !(entry.type === "event" && pattern.detail.test(entry.detail ?? ""))) return false
  return true
}

/**
 * The record's entries of `a`, each naming the frames `b` streamed from;
 * a prompt with Mako's words and facts, and a call with what its record
 * left out.
 */
function merged(record: readonly Entry[], a: Unit, stream: readonly Entry[], b: Unit): Entry[] {
  let frames: RecordRef | undefined
  for (let index = b.from; index < b.to; index++) if (index === b.from || !drawsNothing(stream[index]!)) frames = joined(frames, stream[index]!.stream)
  const out: Entry[] = []
  for (let index = a.from; index < a.to; index++) {
    const entry = record[index]!
    const streamed = stream[b.from]!
    if (entry.type === "user" && streamed.type === "user") out.push(prompt(entry, streamed, frames))
    else if (entry.type === "tool" && streamed.type === "tool") out.push(call(entry, streamed, frames))
    else out.push(frames && !sameRef(entry.stream, frames) ? { ...entry, stream: frames } : entry)
  }
  return out
}

/** A prompt as Mako showed it, at the record's place: Mako's words and facts, the record's id, time and bytes. */
function prompt(entry: EntryOf<"user">, streamed: EntryOf<"user">, frames: RecordRef | undefined): Entry {
  if (streamed.requestId === undefined && !frames) return entry
  const next: EntryOf<"user"> = { ...entry }
  if (streamed.requestId !== undefined) {
    next.text = streamed.text
    next.requestId = streamed.requestId
    if (streamed.command !== undefined) next.command = streamed.command
    if (streamed.provider !== undefined) next.provider = streamed.provider
    if (streamed.contextFiles !== undefined) next.contextFiles = streamed.contextFiles
    const shown = streamed.attachments ?? []
    const kept = entry.attachments ?? []
    if (shown.length && shown.length === kept.length)
      next.attachments = kept.map((attachment, index) => ({ ...attachment, name: shown[index]!.name }))
    else if (shown.length && !kept.length) next.attachments = shown
  }
  if (frames) next.stream = frames
  return next
}

/** The record's call, with what its record left out taken from what streamed. */
function call(entry: EntryOf<"tool">, streamed: EntryOf<"tool">, frames: RecordRef | undefined): Entry {
  const next: EntryOf<"tool"> = { ...entry }
  let changed = false
  const fill = <Key extends "status" | "input" | "output" | "title" | "name" | "toolKind">(key: Key) => {
    if ((entry[key] === undefined || entry[key] === "") && streamed[key] !== undefined && streamed[key] !== "") {
      next[key] = streamed[key]
      changed = true
    }
  }
  fill("status")
  fill("input")
  fill("output")
  fill("title")
  fill("toolKind")
  if (!entry.details?.length && streamed.details?.length) { next.details = streamed.details; changed = true }
  if (!entry.attachments?.length && streamed.attachments?.length) { next.attachments = streamed.attachments; changed = true }
  if (!entry.effects && streamed.effects) { next.effects = streamed.effects; changed = true }
  if (entry.status === undefined && streamed.unfinished) { next.unfinished = true; changed = true }
  if (frames && !sameRef(entry.stream, frames)) { next.stream = frames; changed = true }
  return changed ? next : entry
}

function sameRef(left: RecordRef | undefined, right: RecordRef | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right))
}

/**
 * The shortest script from `n` items to `m` (Myers' O(ND) diff), where
 * `same` says two agree; null past `MAX_STREAM_DIFFERENCES`. What both
 * start and end with is taken first, so two sides that agree cost one pass.
 */
function* align(n: number, m: number, same: (a: number, b: number) => boolean): Steps<Step[] | null> {
  let head = 0
  while (head < n && head < m && same(head, head)) if (++head % ITEMS_PER_STEP === 0) yield
  let tail = 0
  while (tail < n - head && tail < m - head && same(n - 1 - tail, m - 1 - tail)) if (++tail % ITEMS_PER_STEP === 0) yield
  const steps: Step[] = []
  for (let index = 0; index < head; index++) steps.push({ kind: "same", record: index, stream: index })
  const middle = yield* diff(head, n - tail, head, m - tail, same)
  if (!middle) return null
  steps.push(...middle)
  for (let index = tail; index > 0; index--) steps.push({ kind: "same", record: n - index, stream: m - index })
  return steps
}

function* diff(aFrom: number, aTo: number, bFrom: number, bTo: number, same: (a: number, b: number) => boolean): Steps<Step[] | null> {
  const n = aTo - aFrom
  const m = bTo - bFrom
  const max = Math.min(n + m, MAX_STREAM_DIFFERENCES)
  const offset = max + 1
  const frontier = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  let compared = 0
  for (let d = 0; d <= max && found < 0; d++) {
    // Stops between rounds, never inside one: a round is at most `MAX_STREAM_DIFFERENCES` diagonals and their runs of
    // cheap comparisons, a few milliseconds at most.
    if (compared >= ITEMS_PER_STEP) {
      compared = 0
      yield
    }
    trace.push(frontier.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      compared++
      let x = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!) ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1
      let y = x - k
      const from = x
      while (x < n && y < m && same(aFrom + x, bFrom + y)) {
        x++
        y++
      }
      compared += x - from
      frontier[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null
  const steps: Step[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const before = trace[d]!
    const at = (k: number) => before[k + d + 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) steps.push({ kind: "same", record: aFrom + --x, stream: bFrom + --y })
    if (down) steps.push({ kind: "stream", stream: bFrom + --y })
    else steps.push({ kind: "record", record: aFrom + --x })
  }
  while (x > 0 && y > 0) steps.push({ kind: "same", record: aFrom + --x, stream: bFrom + --y })
  return steps.reverse()
}
