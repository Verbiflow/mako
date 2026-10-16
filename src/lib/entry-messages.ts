import { eventText, type TranscriptEvent } from "@mako/sessions/events"
import { proposedPlan, type Entry, type EntryOf, type ReplyEntry } from "@mako/sessions/entries"
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
export function entriesToMessages(entries: readonly Entry[], source: EntrySource): EntryMessages {
  const live = source.kind === "live"
  const cursor = live ? source.cursor : undefined
  const offset = live ? (cursor?.offset ?? 0) : (source.start ?? 0)
  const messages: ChatMessage[] = []
  const starts: number[] = []
  let plan = cursor?.plan ?? []
  let turn = cursor?.turn ?? 0
  let turnProvider = source.provider
  let reply: { message: ChatMessage; last: number; ended: boolean } | null = null

  const path = live ? undefined : source.path
  const drew = (message: ChatMessage, entry: Entry) => {
    if (!path || !entry.id) return
    const origin: OriginEntry = { id: entry.id, type: entry.type }
    const label = entry.type === "tool" ? entry.name ?? entry.title : entry.type === "unread" ? entry.kind : undefined
    if (label) origin.label = label
    if (entry.record) origin.record = entry.record
    if (message.origin) message.origin.entries.push(origin)
    else message.origin = { path, entries: [origin] }
  }
  const named = (kind: string, entry: Entry, at: number) =>
    live ? `acp-${kind}-${at}` : entry.id ? `native-${kind}-${entry.id}` : `foreign-entry-${at}`
  const anchor = (entry: Entry, at: number): MessageAnchor | undefined => {
    if (live) return undefined
    const anchor: MessageAnchor = { index: at }
    if (entry.id) anchor.id = entry.id
    if (entry.at !== undefined) anchor.at = entry.at
    return anchor
  }
  const close = () => {
    if (reply && !live) reply.message.anchor = anchor(entries[reply.last - offset]!, reply.last)
    reply = null
  }
  const append = (entry: ReplyEntry | EntryOf<"plan">, at: number, blocks: (message: ChatMessage) => Block[]) => {
    if (reply && (reply.ended || (entry.type !== "plan" && entry.model !== undefined && reply.message.blocks.length > 0))) close()
    if (!reply) {
      const message: ChatMessage = { id: named("assistant", entry, at), role: "assistant", blocks: [] }
      if (turnProvider) message.provider = turnProvider
      if (entry.type !== "plan" && entry.model) message.model = entry.model
      if (entry.at !== undefined) message.timestamp = entry.at
      messages.push(message)
      starts.push(at)
      reply = { message, last: at, ended: false }
    }
    reply.message.blocks.push(...blocks(reply.message))
    drew(reply.message, entry)
    reply.last = at
    if (entry.type !== "plan" && entry.usage) reply.ended = true
  }
  const marker = (entry: Entry, at: number, note: TranscriptEvent, opensTurn: boolean) => {
    close()
    const message: ChatMessage = {
      // Saved provider turns keep the `native-event-` ids earlier builds gave their exchanges.
      id: named(opensTurn && live ? "turn" : "event", entry, at),
      role: "system",
      blocks: [{ type: "text", text: opensTurn ? note.label : eventText(note) }],
      note,
    }
    if (opensTurn) message.opensTurn = true
    if (opensTurn && entry.at !== undefined) message.timestamp = entry.at
    drew(message, entry)
    messages.push(message)
    starts.push(at)
  }

  for (let index = cursor?.start ?? 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const at = index + offset
    switch (entry.type) {
      case "user": {
        close()
        turnProvider = entry.provider ?? source.provider
        if (!entry.steeringFor) turn += 1
        const message: ChatMessage = {
          id: live && entry.requestId ? `acp-request-${entry.requestId}` : named("user", entry, at),
          role: "user",
          blocks: [{ type: "text", text: entry.text }, ...(entry.attachments ?? [])],
        }
        if (entry.requestId) message.requestId = entry.requestId
        if (entry.steeringFor) message.steeringFor = live ? `acp-request-${entry.steeringFor}` : `native-user-${entry.steeringFor}`
        if (entry.at !== undefined) message.timestamp = entry.at
        const anchored = anchor(entry, at)
        if (anchored) message.anchor = anchored
        drew(message, entry)
        messages.push(message)
        starts.push(at)
        break
      }
      case "provider-turn":
        turnProvider = source.provider
        turn += 1
        marker(entry, at, { label: entry.reason, ...entry.detail !== undefined && { detail: entry.detail }, ...entry.cause && { cause: entry.cause }, ...entry.body && { body: entry.body }, ...entry.tone && { tone: entry.tone }, ...entry.source && { source: entry.source } }, true)
        break
      case "event":
        marker(entry, at, { label: entry.label, detail: entry.detail, body: entry.body, tone: entry.tone, setup: entry.setup, source: entry.source, cause: entry.cause, limit: entry.limit }, false)
        break
      case "unread":
        marker(entry, at, unreadNote(entry), false)
        break
      case "plan":
        plan = entry.entries
        append(entry, at, () => [{ type: "toolResult", id: `plan-${at}`, name: AGENT_PLAN_TOOL, text: "", details: [{ type: "plan", entries: entry.entries }] }])
        break
      case "proposed-plan":
        append(entry, at, () => [proposedPlan(entry)])
        break
      case "text":
        append(entry, at, () => [{ type: "text", text: entry.text }])
        break
      case "thinking":
        append(entry, at, () => [{ type: "thinking", thinking: entry.text }])
        break
      case "attachment":
        append(entry, at, () => [entry.attachment])
        break
      case "tool":
        append(entry, at, (message) => toolBlocks(entry, turn, turnProvider, source, message.id))
        break
    }
  }
  close()
  const last = messages.at(-1)
  if (live && source.running && last?.role === "assistant") last.streaming = true
  return { messages, starts, plan }
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
 * record. Indented JSON has no line that could close its fence.
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
