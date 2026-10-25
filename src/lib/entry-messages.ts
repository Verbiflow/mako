import { eventText, type TranscriptEvent } from "@mako/sessions/events"
import { proposedPlan, type Entry, type EntryOf, type RecordRef, type ReplyEntry } from "@mako/sessions/entries"
import { liveToolFinished, toolTitle } from "@mako/sessions/live-content"
import { AGENT_PLAN_TOOL, identifyTool } from "@mako/sessions/tool-identity"
import type { LiveHistoryAddress } from "@mako/host/contracts/live-history"
import { z } from "zod"
import { formatBytes } from "@/lib/format"
import { entryToolIdentity } from "@/lib/tools"
import type { Block, ChatMessage, MessageAnchor, OriginEntry, ToolContentRest } from "@/lib/types"

export interface PlanStep {
  content: string
  status: string
}

/**
 * Where a run of entries comes from, which decides only how its messages are
 * named and how a trimmed entry is read whole:
 *
 * - `saved`, a page of a saved session: messages are named by their entries'
 *   ids and carry the anchor a fork names; `token` is set when the page is a
 *   live conversation's native base, whose entries its history view reads.
 *   With the session's `path`, each message names the entries it drew
 *   (`origin`), which "Show original" opens.
 * - `live`, a live conversation's blocks: messages are named by where their
 *   entry stands, and the last one streams while the turn runs.
 */
export type EntrySource =
  | { kind: "saved"; start?: number; provider?: string; token?: string; path?: string }
  | {
      kind: "live"
      running: boolean
      provider?: string
      /** The first entry this conversion reads, the turn and plan before it, the history window's offset and token. */
      cursor?: { start: number; turn: number; plan: PlanStep[]; offset?: number; token?: string }
    }

export interface EntryMessages {
  messages: ChatMessage[]
  /** The absolute index of each message's first entry; a message holds every entry up to the next one's. */
  starts: number[]
  /** The newest plan the entries gave. */
  plan: PlanStep[]
}

/**
 * Entries as the transcript's messages: a prompt, a marker or a turn the
 * provider opened is one message each, and the agent's reply is one
 * message per message of its record. An entry that names its model starts
 * one and an entry carrying usage ends it, as the decoders mark them; live
 * entries of a turn are one reply.
 */
/** An entry as the transcript drew it: where its view held it, and what names it there. */
export interface ShownEntry { at: LiveHistoryAddress; type: Entry["type"]; stream?: RecordRef }

/**
 * The absolute index of `entry`, drawn at `index`, among a newer view's
 * `blocks`, which begin at `start`: where it was drawn, or, when a withdrawn
 * block moved it, the block that names the same first stream line.
 */
export function locateShown(blocks: readonly Entry[], start: number, index: number, entry: ShownEntry): number {
  const first = (ref: RecordRef | undefined) => ref?.file && ref.ranges?.length ? `${ref.file}\u0000${ref.ranges[0]![0]}` : undefined
  const named = first(entry.stream)
  const same = (block: Entry | undefined) => block?.type === entry.type && first(block.stream) === named
  if (same(blocks[index - start])) return index
  const found = named === undefined ? -1 : blocks.findIndex(same)
  if (found < 0) throw new Error("This entry is no longer in the conversation.")
  return start + found
}

export function entriesToMessages(entries: readonly Entry[], source: EntrySource): EntryMessages {
  return new EntryDrawing(entries, source).draw()
}

/** The assistant message being drawn: the absolute index of its last entry, and whether an entry's usage ended it. */
interface Reply {
  message: ChatMessage
  last: number
  ended: boolean
}

/**
 * One conversion's state, with its steps as methods. The live projection
 * converts on every update, so a step made as a closure is made again on
 * each, and tsx's `keepNames` names every named closure with a
 * `defineProperty`: six of them cost the projection rows a third more time.
 */
class EntryDrawing {
  private readonly entries: readonly Entry[]
  private readonly source: EntrySource
  private readonly live: boolean
  private readonly offset: number
  private readonly path: string | undefined
  /** Entries of a live conversation's view are read by their address in it, by its host. */
  private readonly viewed: boolean
  private readonly messages: ChatMessage[] = []
  private readonly starts: number[] = []
  private plan: PlanStep[]
  private turn: number
  private turnProvider: string | undefined
  private reply: Reply | null = null

  constructor(entries: readonly Entry[], source: EntrySource) {
    this.entries = entries
    this.source = source
    this.live = source.kind === "live"
    const cursor = source.kind === "live" ? source.cursor : undefined
    this.offset = source.kind === "live" ? (cursor?.offset ?? 0) : (source.start ?? 0)
    this.path = source.kind === "live" ? undefined : source.path
    this.viewed = Boolean(source.kind === "live" ? cursor?.token : source.token)
    this.plan = cursor?.plan ?? []
    this.turn = cursor?.turn ?? 0
    this.turnProvider = source.provider
  }

  draw(): EntryMessages {
    const { entries, source, live, offset } = this
    for (let index = source.kind === "live" ? (source.cursor?.start ?? 0) : 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      const at = index + offset
      switch (entry.type) {
        case "user": {
          this.close()
          this.turnProvider = entry.provider ?? source.provider
          if (!entry.steeringFor) this.turn += 1
          const message: ChatMessage = {
            id: live && entry.requestId ? `acp-request-${entry.requestId}` : this.named("user", entry, at),
            role: "user",
            blocks: [{ type: "text", text: entry.text }, ...(entry.attachments ?? [])],
          }
          if (entry.requestId) message.requestId = entry.requestId
          if (entry.steeringFor) message.steeringFor = live ? `acp-request-${entry.steeringFor}` : `native-user-${entry.steeringFor}`
          if (entry.at !== undefined) message.timestamp = entry.at
          const anchored = this.anchor(entry, at)
          if (anchored) message.anchor = anchored
          this.drew(message, entry, at)
          this.messages.push(message)
          this.starts.push(at)
          break
        }
        case "provider-turn":
          this.turnProvider = source.provider
          this.turn += 1
          this.marker(entry, at, { label: entry.reason, ...entry.detail !== undefined && { detail: entry.detail }, ...entry.cause && { cause: entry.cause }, ...entry.body && { body: entry.body }, ...entry.tone && { tone: entry.tone }, ...entry.source && { source: entry.source } }, true)
          break
        case "event":
          this.marker(entry, at, { label: entry.label, detail: entry.detail, body: entry.body, tone: entry.tone, setup: entry.setup, source: entry.source, cause: entry.cause, limit: entry.limit }, false)
          break
        case "unread":
          this.marker(entry, at, unreadNote(entry), false)
          break
        case "plan":
          this.plan = entry.entries
          this.append(entry, at, [{ type: "toolResult", id: `plan-${at}`, name: AGENT_PLAN_TOOL, text: "", details: [{ type: "plan", entries: entry.entries }] }])
          break
        case "proposed-plan":
          this.append(entry, at, [proposedPlan(entry)])
          break
        case "text":
          this.append(entry, at, [{ type: "text", text: entry.text }])
          break
        case "thinking":
          this.append(entry, at, [{ type: "thinking", thinking: entry.text }])
          break
        case "attachment":
          this.append(entry, at, [entry.attachment])
          break
        case "tool":
          // A call's blocks are named by the reply that holds them, so it opens first.
          this.append(entry, at, toolBlocks(entry, this.turn, this.turnProvider, source, this.open(entry, at).message.id))
          break
      }
    }
    this.close()
    const last = this.messages.at(-1)
    if (source.kind === "live" && source.running && last?.role === "assistant") last.streaming = true
    return { messages: this.messages, starts: this.starts, plan: this.plan }
  }

  private drew(message: ChatMessage, entry: Entry, at: number): void {
    const address: LiveHistoryAddress | undefined = !this.viewed ? undefined : this.live ? { kind: "live", index: at } : entry.id ? { kind: "base", id: entry.id } : undefined
    const path = this.path
    if (!(path && entry.id) && !(address && entry.stream)) return
    const origin: OriginEntry = { type: entry.type }
    if (entry.id) origin.id = entry.id
    const label = entry.type === "tool" ? entry.name ?? entry.title : entry.type === "unread" ? entry.kind : undefined
    if (label) origin.label = label
    if (entry.record) origin.record = entry.record
    if (entry.stream) origin.stream = entry.stream
    if (address) origin.at = address
    if (message.origin) message.origin.entries.push(origin)
    else message.origin = path ? { path, entries: [origin] } : { entries: [origin] }
  }

  private named(kind: string, entry: Entry, at: number): string {
    return this.live ? `acp-${kind}-${at}` : entry.id ? `native-${kind}-${entry.id}` : `foreign-entry-${at}`
  }

  private anchor(entry: Entry, at: number): MessageAnchor | undefined {
    if (this.live) return undefined
    const anchor: MessageAnchor = { index: at }
    if (entry.id) anchor.id = entry.id
    if (entry.at !== undefined) anchor.at = entry.at
    return anchor
  }

  private close(): void {
    const reply = this.reply
    if (reply && !this.live) reply.message.anchor = this.anchor(this.entries[reply.last - this.offset]!, reply.last)
    this.reply = null
  }

  /** The reply `entry` belongs to: the open one, or a new one when that one ended or `entry` names a model after it began. */
  private open(entry: ReplyEntry | EntryOf<"plan">, at: number): Reply {
    const current = this.reply
    if (current && !current.ended && (entry.type === "plan" || entry.model === undefined || current.message.blocks.length === 0)) return current
    this.close()
    const message: ChatMessage = { id: this.named("assistant", entry, at), role: "assistant", blocks: [] }
    if (this.turnProvider) message.provider = this.turnProvider
    if (entry.type !== "plan" && entry.model) message.model = entry.model
    if (entry.at !== undefined) message.timestamp = entry.at
    this.messages.push(message)
    this.starts.push(at)
    this.reply = { message, last: at, ended: false }
    return this.reply
  }

  private append(entry: ReplyEntry | EntryOf<"plan">, at: number, blocks: Block[]): void {
    const reply = this.open(entry, at)
    reply.message.blocks.push(...blocks)
    this.drew(reply.message, entry, at)
    reply.last = at
    if (entry.type !== "plan" && entry.usage) reply.ended = true
  }

  private marker(entry: Entry, at: number, note: TranscriptEvent, opensTurn: boolean): void {
    this.close()
    const message: ChatMessage = {
      // Saved provider turns keep the `native-event-` ids earlier builds gave their exchanges.
      id: this.named(opensTurn && this.live ? "turn" : "event", entry, at),
      role: "system",
      blocks: [{ type: "text", text: opensTurn ? note.label : eventText(note) }],
      note,
    }
    if (opensTurn) message.opensTurn = true
    if (opensTurn && entry.at !== undefined) message.timestamp = entry.at
    this.drew(message, entry, at)
    this.messages.push(message)
    this.starts.push(at)
  }
}

/**
 * The harness's own id for the call a transcript row draws: what `toolBlocks`
 * made the row's id from (a live turn's number or a saved message's id, then
 * the entry's). A roster entry names its call by this id (`toolId`).
 */
export function callEntryId(callId: string): string {
  const live = /^\d+:/.exec(callId)
  if (live) return callId.slice(live[0].length)
  const saved = callId.indexOf("-tool-")
  return saved >= 0 ? callId.slice(saved + "-tool-".length) : callId
}

/** A call and, once it returned or is shown cut short, its result. */
function toolBlocks(entry: EntryOf<"tool">, turn: number, provider: string | undefined, source: EntrySource, message: string): Block[] {
  const live = source.kind === "live"
  const tool = entryToolIdentity(entry, provider)
  const id = live ? `${turn}:${entry.id}` : `${message}-tool-${entry.id}`
  const call: Block = { type: "toolCall", id, name: tool.name, tool, arguments: tool.input ?? entry.input }
  if (entry.toolKind) call.kind = entry.toolKind
  const failed = entry.status === "failed" && !entry.unfinished
  const canceled = /cancel/i.test(entry.status ?? "")
  const finished = liveToolFinished(entry.status)
  const rest = restOf(entry, source)
  const answered = finished || failed || canceled || entry.output !== undefined || Boolean(entry.attachments?.length) || Boolean(entry.details?.length) || rest !== undefined
  if (!answered) return [call]
  const result: Block = {
    type: "toolResult",
    id,
    name: tool.name,
    text: entry.output ?? (failed ? toolTitle(entry) : ""),
    attachments: entry.attachments,
    details: entry.details,
  }
  if (failed) result.isError = true
  if (canceled) result.isCanceled = true
  if (entry.unfinished) result.isCutOff = true
  if (live && !finished) result.streaming = true
  if (rest) result.rest = rest
  return [call, result]
}

/** Where the whole of a call a page or a history window trimmed is read. */
function restOf(entry: EntryOf<"tool">, source: EntrySource): ToolContentRest | undefined {
  if (source.kind === "live") {
    const token = source.cursor?.token
    return entry.historyRest && token ? { length: entry.historyRest.length, live: { token, at: { kind: "live", index: entry.historyRest.index } } } : undefined
  }
  const trimmed = (entry.outputLength ?? 0) > (entry.output?.length ?? 0)
  if (!trimmed && !entry.contentOmitted && !entry.attachmentsOmitted) return undefined
  const length = entry.outputLength ?? entry.output?.length ?? 0
  if (source.token) {
    const address: LiveHistoryAddress = { kind: "base", id: entry.id }
    return { length, live: { token: source.token, at: address } }
  }
  return { length, entry: entry.id }
}

/**
 * A record the decoder didn't read, as a quiet marker whose body is the
 * record, fenced past any backticks in it (`fenced`).
 */
function unreadNote(entry: EntryOf<"unread">): TranscriptEvent {
  const why = entry.reason === "unknown" ? "not a kind Mako reads" : entry.reason === "unreadable" ? "Mako couldn't read it" : "not drawn"
  const note: TranscriptEvent = { label: `Unread record: ${entry.kind}`, detail: why }
  const raw = entry.raw
  const line = z.string().safeParse(raw)
  const cut = CutLineSchema.safeParse(raw)
  if (line.success) note.body = fenced(line.data, "text")
  else if (cut.success) {
    note.detail = `${why}: a ${formatBytes(cut.data.bytes)} line, longer than one string can hold`
    note.body = fenced(cut.data.head, "text")
  } else if (raw !== undefined) note.body = fenced(JSON.stringify(raw, null, 2), "json")
  else if (entry.rawOmitted) note.body = "The record is large. Original reads it whole."
  return note
}

/** A line too long to be a string, as its decoder keeps it (`unparsedLine`). */
const CutLineSchema = z.strictObject({ head: z.string(), bytes: z.number() })

/** `text` as a fenced code block, its fence longer than any run of backticks inside. */
function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

/** The question a saved session is waiting on: its newest question call, while unanswered. */
export function pendingThreadInput(entries: readonly Entry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type !== "tool" || !entry.name || identifyTool({ name: entry.name }).kind !== "question") continue
    return entry.output === undefined ? entry.name : null
  }
  return null
}
