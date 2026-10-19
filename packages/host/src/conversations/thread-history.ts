import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { exceeds, opensTurn, PAYLOAD_LIMITS, previewLines, PROSE_LIMITS, steeredMessages, steersShown, type Thread, type ThreadRef } from "@mako/sessions"
import { attachmentDescription, describeToolDetails } from "@mako/sessions/content"
import { readMessage } from "@mako/sessions/context-wire"
import type { Entry } from "@mako/sessions/entries"
import type { LiveSnapshot, LiveSummary } from "../contracts/live-conversations.js"
import { ThreadIdSchema, type ThreadId } from "../contracts/thread-identity.js"
import type { ThreadCatalog, ThreadStore } from "../threads/index.js"
import { resumed } from "./resumed-history.js"

/**
 * `thread_history` on the `mako` server: a running agent reads its Thread's
 * history, and that of each thread its messages referenced, whole. It reads
 * views, never the files a transcript names: a live conversation's history
 * once read (its base whole, then its blocks), and a native session as the
 * catalog decodes it. So it answers alike on the laptop and in the cloud, and
 * when a transcript file is gone.
 *
 * Its notation is the transcript's (`@mako/sessions/transcript-builder`):
 * a Session's turns are numbered from its first prompt, the entries before
 * that are turn 0, and the same thresholds decide what is shown and what is
 * named, so turn 12 of a transcript an agent was handed is turn 12 here. An
 * entry is `<turn>.<k>`, `k` counting from the turn's first entry (0, its
 * prompt), and a field of one is `<turn>.<k>/<field>`. The Thread's other
 * Sessions are addressed with their number first, `2:12.3`. Nothing is
 * cut: a field too long to show is named with its size and first lines and
 * `payload` reads it whole, a page at a time, and an answer too long for
 * one reply says where the next one starts.
 */

/** What one reply carries, at most, before it says where the next starts: under every harness's MCP result limit. */
const PAGE_CHARS = 24_000
/** Turns `turns` lists in one reply when no range is given. */
const INDEX_TURNS = 80
const INDEX_REQUEST = 100
const INDEX_ANSWER = 80
const SEARCH_HITS = 25
const SNIPPET_CHARS = 70
/** Native sessions read whole, kept until there are more than this many or they hold more than this many characters. */
const OPENED_THREADS = 4
const OPENED_CHARS = 256 * 1024 * 1024

const ACTIONS = ["turns", "read", "search", "payload"] as const
/** A call's arguments, as most harnesses record them: one JSON object. */
const CallArgumentsSchema = z.record(z.string(), z.json())
type Action = (typeof ACTIONS)[number]

export interface ThreadHistoryDeps {
  /** Every conversation this host keeps, loaded or not, with the Thread and Session it belongs to. */
  conversations(): readonly LiveSummary[]
  /** A conversation once its history is read (`LiveConversations.historySnapshot`). */
  snapshot(id: string): Promise<LiveSnapshot | null>
  /** The Thread store; null where it didn't open, and then a conversation is its own history. */
  store(): Pick<ThreadStore, "thread" | "sessionContents"> | null
  /** Native sessions as the catalog reads them. */
  catalog: Pick<ThreadCatalog, "list" | "nativePath" | "ref" | "open" | "entry">
}

export interface ThreadHistoryInput {
  action: Action
  thread?: string | undefined
  turns?: string | undefined
  query?: string | undefined
  regex?: boolean | undefined
  ref?: string | undefined
  offset?: number | undefined
}

/** Whose history: a Thread's Sessions, one conversation with no Thread, or one native session; `home` is the Session addressed without a number. */
type Scope =
  | { kind: "thread"; thread: ThreadId; home: { conversation: string } | { session: string } | undefined }
  | { kind: "conversation"; id: string }
  | { kind: "native"; path: string; harness: string }

/** One Session's history. */
interface Part {
  /** 1-based, in the Thread's tab order. */
  session: number
  /** The Thread store's id for it. */
  sessionId?: string
  harness: string
  title?: string
  conversation?: string
  /** Where entries before `baseLength` were decoded from, to read one whole that a page shortened. */
  path?: string
  baseLength: number
  entries: readonly Entry[]
  turns: Turn[]
  /** Its first entries are a parent Session's, which this one forked from: search counts them there. */
  inherited: number
  forkOf?: number
  /** Why its history couldn't be read. */
  missing?: string
  /** Its last turn is still running. */
  running?: true
}

interface Turn {
  /** 0 for what came before the first prompt. */
  number: number
  part: Part
  /** Entries `[start, end)` of `part.entries`. */
  start: number
  end: number
}

interface Reference {
  ref: string
  harness?: string
  title?: string
}

interface View {
  title?: string
  parts: Part[]
  /** The Session a turn or ref without a number means. */
  home: Part
  /** Threads the requests referenced: what else this caller may read. */
  references: Reference[]
  /** The calling conversation, when the view is its own Thread. */
  caller?: string
}

interface Field {
  name: string
  text: string
  /** What the person or the agent wrote, shown up to `PROSE_LIMITS`. */
  prose?: true
}

export interface ThreadHistoryTools {
  answer(conversationId: string, input: ThreadHistoryInput): Promise<string>
}

/** The history tool's reader, with the native sessions it last read whole. */
export function threadHistoryTools(deps: ThreadHistoryDeps): ThreadHistoryTools {
  const opened = new Map<string, { stamp: string; chars: number; thread: Promise<Thread | null> }>()

  /** A native session whole, read again only once its catalog row moved. */
  function open(path: string): Promise<Thread | null> {
    const row = deps.catalog.ref(path)
    const stamp = JSON.stringify([row?.bytes, row?.updatedAt, row?.revision])
    const held = opened.get(path)
    opened.delete(path)
    if (held?.stamp === stamp) {
      opened.set(path, held)
      return held.thread
    }
    const kept = { stamp, chars: 0, thread: deps.catalog.open(path) }
    opened.set(path, kept)
    void kept.thread.then((thread) => {
      kept.chars = thread ? thread.entries.reduce((sum, entry) => sum + entryChars(entry), 0) : 0
      let total = 0
      for (const value of opened.values()) total += value.chars
      for (const [key, value] of opened) {
        if (opened.size <= 1 || (opened.size <= OPENED_THREADS && total <= OPENED_CHARS)) break
        total -= value.chars
        opened.delete(key)
      }
    }, () => {
      if (opened.get(path) === kept) opened.delete(path)
    })
    return kept.thread
  }

  async function livePart(summary: LiveSummary, session: number): Promise<{ part: Part; snapshot: LiveSnapshot | null }> {
    const id = summary.session.id
    const snapshot = await deps.snapshot(id)
    const part: Part = { session, harness: summary.session.harness, conversation: id, baseLength: 0, entries: [], turns: [], inherited: 0 }
    if (summary.sessionId) part.sessionId = summary.sessionId
    if (!snapshot) return { part: { ...part, missing: "its journal couldn't be read" }, snapshot }
    const base = await resumed({ openThread: open }, snapshot)
    part.harness = snapshot.session.harness
    part.baseLength = base.length
    part.entries = [...base, ...snapshot.blocks.slice(snapshot.baseCoveredBlocks ?? 0)]
    if (snapshot.session.title) part.title = snapshot.session.title
    if (snapshot.base) part.path = snapshot.base.ref.path
    if (snapshot.historyFailure) part.missing = snapshot.historyFailure
    if (snapshot.session.status === "running") part.running = true
    return { part, snapshot }
  }

  async function nativePart(path: string, harness: string, session: number): Promise<Part> {
    const thread = await open(path)
    const part: Part = { session, harness, path, baseLength: thread?.entries.length ?? 0, entries: thread?.entries ?? [], turns: [], inherited: 0 }
    const row = deps.catalog.ref(path)
    const title = thread?.ref.title ?? row?.title
    if (title) part.title = title
    if (row?.sessionId) part.sessionId = row.sessionId
    if (!thread) part.missing = "its native session couldn't be read on this device"
    return part
  }

  /** The Sessions a scope reads, each whole, with the threads their requests referenced. */
  async function view(scope: Scope, caller?: string): Promise<View> {
    const listing = new Map(deps.conversations().map((summary) => [summary.session.id, summary]))
    const parts: Part[] = []
    const snapshots = new Map<string, LiveSnapshot>()
    let title: string | undefined
    const addLive = async (summary: LiveSummary) => {
      const read = await livePart(summary, parts.length + 1)
      parts.push(read.part)
      if (read.snapshot) snapshots.set(summary.session.id, read.snapshot)
    }
    if (scope.kind === "thread") {
      const store = deps.store()
      const thread = store?.thread(scope.thread)
      title = thread?.title
      for (const session of thread?.sessions ?? []) {
        const contents = store!.sessionContents(session)
        const live = contents.conversations.flatMap((id) => listing.get(id) ?? [])
        for (const summary of live) await addLive(summary)
        if (live.length) continue
        const native = primaryNative(contents.natives, deps.catalog)
        if (native) parts.push({ ...await nativePart(native.path, native.harness, parts.length + 1), sessionId: session })
      }
      // The caller is always its own Thread's, even before the store placed it.
      const own = caller ? listing.get(caller) : undefined
      if (own && !parts.some((part) => part.conversation === caller)) await addLive(own)
    } else if (scope.kind === "conversation") {
      const summary = listing.get(scope.id)
      if (!summary) throw new Error("Mako doesn't keep this conversation on this device.")
      await addLive(summary)
    } else parts.push(await nativePart(scope.path, scope.harness, 1))
    if (!parts.length) throw new Error("Nothing of this thread is on this device.")
    for (const part of parts) {
      part.turns = turnsOf(part)
      // A fork's first turns are its parent's: search counts them in the parent, read shows them in both.
      const ancestry = part.conversation ? snapshots.get(part.conversation)?.control?.ancestry : undefined
      const parent = ancestry?.kind === "fork" ? parts.find((other) => other.conversation === ancestry.parentId) : undefined
      if (parent && parent !== part) {
        part.forkOf = parent.session
        part.inherited = inheritedLength(part, snapshots.get(part.conversation!)!)
      }
    }
    const homeOf = (): Part | undefined => {
      if (scope.kind !== "thread") return parts[0]
      if (caller) return parts.find((part) => part.conversation === caller)
      const home = scope.home
      if (!home) return undefined
      return "conversation" in home ? parts.find((part) => part.conversation === home.conversation) : parts.find((part) => part.sessionId === home.session)
    }
    const read: View = { parts, home: homeOf() ?? parts.at(-1)!, references: references([...snapshots.values()]) }
    title ??= parts.find((part) => part.title)?.title
    if (title) read.title = title
    if (caller) read.caller = caller
    return read
  }

  /** The caller's own Thread, or its conversation alone where the store has no Thread for it. */
  function ownScope(conversationId: string): Scope {
    const summary = deps.conversations().find((candidate) => candidate.session.id === conversationId)
    return placed(summary?.threadId, { conversation: conversationId }) ?? { kind: "conversation", id: conversationId }
  }

  function placed(threadId: string | undefined, home: Extract<Scope, { kind: "thread" }>["home"]): Scope | undefined {
    const thread = threadId ? ThreadIdSchema.safeParse(threadId) : undefined
    return thread?.success && deps.store()?.thread(thread.data) ? { kind: "thread", thread: thread.data, home } : undefined
  }

  /** What a `thread:<harness>:<id>` reference names now: a Mako Thread, a conversation, or a native session. */
  function referenced(ref: string): Scope | undefined {
    const match = /^thread:([^:]+):(.+)$/.exec(ref)
    if (!match) return undefined
    let harness: string
    let id: string
    try {
      harness = decodeURIComponent(match[1]!)
      id = decodeURIComponent(match[2]!)
    } catch {
      return undefined
    }
    const live = deps.conversations().find((summary) => summary.session.harness === harness && summary.session.nativeId === id)
    if (live) return placed(live.threadId, { conversation: live.session.id }) ?? { kind: "conversation", id: live.session.id }
    // The id a token carries is the row's identity where it has one, else its native id (`threadReferenceId`).
    const rows = deps.catalog.list({ harness })
    const row = primaryRow(rows.filter((candidate) => candidate.identity === id)) ?? primaryRow(rows.filter((candidate) => candidate.nativeId === id))
    const path = row?.path ?? deps.catalog.nativePath({ harness, nativeId: id })
    if (!path) return undefined
    const known = row ?? deps.catalog.ref(path)
    return placed(known?.threadId, known?.sessionId ? { session: known.sessionId } : undefined) ?? { kind: "native", path, harness }
  }

  async function scoped(conversationId: string, thread: string | undefined): Promise<View> {
    const own = await view(ownScope(conversationId), conversationId)
    if (!thread) return own
    const ref = thread.trim().replace(/^@/, "")
    const known = own.references.find((reference) => reference.ref === ref)
    if (!known) {
      const readable = own.references.length ? own.references.map((reference) => reference.ref).join(", ") : "none"
      throw new Error(`${ref} isn't one this Thread's messages referenced, so it isn't readable here. Omit thread for this Thread; referenced threads: ${readable}.`)
    }
    const scope = referenced(ref)
    if (!scope) throw new Error(`${ref} (${known.title ?? "untitled"}) isn't on this device any more.`)
    const read = await view(scope)
    read.references = []
    read.title ??= known.title
    return read
  }

  return {
    async answer(conversationId, input) {
      const read = await scoped(conversationId, input.thread)
      switch (input.action) {
        case "turns":
          return index(read, input)
        case "read":
          return readTurns(read, input)
        case "search":
          return search(read, input)
        case "payload":
          return payload(read, input, deps.catalog)
      }
    },
  }
}

/** Every `thread:` reference the requests' `<mako_context>` blocks carry, once each. */
function references(snapshots: readonly LiveSnapshot[]): Reference[] {
  const found = new Map<string, Reference>()
  for (const snapshot of snapshots)
    for (const request of snapshot.requests)
      for (const item of readMessage(request.text).items) {
        const ref = item.kind === "conversation" ? item.attrs.ref : undefined
        if (!ref?.startsWith("thread:") || found.has(ref)) continue
        const reference: Reference = { ref }
        if (item.attrs.harness) reference.harness = item.attrs.harness
        if (item.attrs.title) reference.title = item.attrs.title
        found.set(ref, reference)
      }
  return [...found.values()]
}

/**
 * A Session's turns, as the transcript groups them (`groupTurns`): one opens
 * at each prompt the person sent (a steer, and a chunk continuing the same
 * message, stay in theirs) and at each turn the harness started; what comes
 * before the first is turn 0.
 */
function turnsOf(part: Part): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  let previous: Entry | undefined
  let opened = 0
  for (const [index, entry] of part.entries.entries()) {
    const opens = opensTurn(entry, previous)
    if (opens || !current) {
      current = { number: opens ? ++opened : 0, part, start: index, end: index + 1 }
      turns.push(current)
    } else current.end = index + 1
    previous = entry
  }
  return turns
}

/** How many of a fork's first entries it inherited: those before its own first prompt. */
function inheritedLength(part: Part, snapshot: LiveSnapshot): number {
  const own = new Set(snapshot.requests.map((request) => request.id))
  const first = part.entries.findIndex((entry) => entry.type === "user" && entry.requestId !== undefined && own.has(entry.requestId))
  return first >= 0 ? first : own.size === 0 ? part.entries.length : 0
}

/** One native session out of the copies a Session may have (Cursor's `chats/` store beside its original). */
function primaryNative(natives: ReturnType<ThreadStore["sessionContents"]>["natives"], catalog: Pick<ThreadCatalog, "ref">) {
  return natives.find((native) => catalog.ref(native.path)?.identity === undefined) ?? natives[0]
}

function primaryRow(rows: ThreadRef[]): ThreadRef | undefined {
  return rows.find((row) => row.identity === undefined) ?? rows[0]
}

function entryChars(entry: Entry): number {
  return fields(entry).reduce((sum, field) => sum + field.text.length, 0)
}

/** An entry's text, by field: what `read` shows, `search` matches and `payload` pages. */
function fields(entry: Entry): Field[] {
  const all: Field[] = []
  const add = (name: string, text: string | undefined, prose?: true) => {
    if (text) all.push(prose ? { name, text, prose } : { name, text })
  }
  switch (entry.type) {
    case "user":
    case "text":
    case "proposed-plan":
      add("text", entry.text, true)
      break
    case "thinking":
      add("text", entry.text)
      break
    case "tool":
      add("input", entry.input)
      add("output", entry.output)
      add("details", entry.details?.length ? describeToolDetails(entry.details) : undefined)
      break
    case "plan":
      add("text", entry.entries.map((step) => `${step.status}: ${step.content}`).join("\n"))
      break
    case "event":
    case "provider-turn":
      add("detail", entry.detail)
      add("body", entry.body)
      break
    case "unread":
      add("raw", entry.raw === undefined ? undefined : JSON.stringify(entry.raw))
      break
    case "attachment":
      break
  }
  return all
}

/** What an entry is, in a few words: the head of its line in `read` and `search`. */
function kindOf(entry: Entry): string {
  switch (entry.type) {
    case "user":
      return entry.steeringFor ? "prompt (steering)" : "prompt"
    case "text":
      return "reply"
    case "thinking":
      return "thinking"
    case "proposed-plan":
      return `proposed plan (${entry.status})`
    case "tool": {
      const state = [entry.status, entry.unfinished ? "unfinished" : undefined].filter(Boolean).join(", ")
      return `tool ${toolName(entry)}${state ? ` (${state})` : ""}`
    }
    case "plan":
      return "plan"
    case "event":
      return `event: ${entry.label}${entry.tone ? ` (${entry.tone})` : ""}`
    case "provider-turn":
      return `turn the harness started: ${entry.reason}`
    case "unread":
      return `unread ${entry.kind} record (${entry.reason})`
    case "attachment":
      return `attachment ${attachmentDescription(entry.attachment)} (${entry.attachment.mimeType})`
  }
}

function toolName(entry: Extract<Entry, { type: "tool" }>): string {
  return entry.name ?? entry.title ?? "call"
}

/** A page shortened this entry; the catalog reads it whole by its id. */
function shortened(entry: Entry): boolean {
  if (entry.type === "unread") return Boolean(entry.rawOmitted)
  return entry.type === "tool" && (Boolean(entry.contentOmitted) || (entry.outputLength ?? 0) > (entry.output?.length ?? 0))
}

const count = (value: number) => value.toLocaleString("en-US")
const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`

function firstLine(text: string, max: number): string {
  const line = text.split("\n").find((candidate) => candidate.trim())?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function stamp(at: number | undefined, previous?: number): string {
  if (at === undefined) return ""
  const moment = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${pad(moment.getHours())}:${pad(moment.getMinutes())}`
  const sameDay = previous !== undefined && new Date(previous).toDateString() === moment.toDateString()
  return sameDay ? time : `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${time}`
}

/** How another Session's turns are addressed: `2:`; the home Session's need nothing. */
function prefix(view: View, part: Part): string {
  return part === view.home ? "" : `${part.session}:`
}

/** The Session a `2:` prefix names, or the home one. */
function partOf(view: View, session: string | undefined): Part {
  if (session === undefined) return view.home
  const part = view.parts.find((candidate) => candidate.session === Number(session))
  if (!part) throw new Error(`This Thread has sessions 1–${view.parts.length}; ${session} isn't one.`)
  return part
}

function turnOf(part: Part, number: number, view: View): Turn {
  const turn = part.turns.find((candidate) => candidate.number === number)
  if (!turn) {
    const first = part.turns[0]?.number ?? 1
    const last = part.turns.at(-1)?.number ?? 0
    throw new Error(last ? `${part === view.home ? "This session" : `Session ${part.session}`} has turns ${first}–${last}; ${number} isn't one.` : "It has no turns yet.")
  }
  return turn
}

interface Range {
  part: Part
  from: number
  fromEntry: number
  to: number
  toEntry?: number
}

/** A turn range: `12`, `40-60`, `12.7-14`, `12.7-12.30`, any of them after a session's `2:`. */
function range(text: string | undefined, view: View): Range | undefined {
  if (text === undefined) return undefined
  const found = /^\s*(?:(\d+):)?(\d+)(?:\.(\d+))?\s*(?:-\s*(\d+)(?:\.(\d+))?\s*)?$/.exec(text)
  if (!found) throw new Error(`turns takes a turn or a range such as 12, 40-60, 12.7-14 or 2:5-9 (session 2); got ${JSON.stringify(text)}.`)
  const part = partOf(view, found[1])
  const from = Number(found[2])
  const last = part.turns.at(-1)?.number ?? 0
  const to = Math.min(found[4] === undefined ? from : Number(found[4]), last)
  turnOf(part, from, view)
  if (to < from) throw new Error(`${text} runs backwards.`)
  const parsed: Range = { part, from, fromEntry: Number(found[3] ?? 0), to }
  if (found[5] !== undefined) parsed.toEntry = Number(found[5])
  return parsed
}

function header(view: View): string[] {
  const name = `${view.caller ? "This Thread" : "Thread"}${view.title ? ` "${view.title}"` : ""}`
  const span = (part: Part) => {
    const last = part.turns.at(-1)?.number ?? 0
    return last ? `turns 1–${last}` : "no turns"
  }
  const notes = (part: Part) => [
    part.forkOf ? `a fork of session ${part.forkOf}: it holds that session's first ${plural(part.inherited, "entry", "entries")}` : undefined,
    part.missing,
  ].filter(Boolean)
  const lines: string[] = []
  const [only] = view.parts
  if (only && view.parts.length === 1) {
    const part = only
    lines.push(`${name} · ${part.harness}: ${span(part)}${notes(part).map((note) => `; ${note}`).join("")}.`)
  } else {
    lines.push(`${name}: ${plural(view.parts.length, "session")}.`)
    for (const part of view.parts) {
      const own = part.conversation !== undefined && part.conversation === view.caller ? ["this session"] : []
      const address = part === view.home ? " (turns and refs without a session number)" : ` (address as ${part.session}:<turn>)`
      lines.push(`Session ${part.session} · ${part.harness}${part.title && part.title !== view.title ? ` "${part.title}"` : ""}: ${span(part)}${[...own, ...notes(part)].map((note) => `; ${note}`).join("")}${address}`)
    }
  }
  if (view.references.length) {
    lines.push("Referenced threads, readable by passing thread:")
    for (const reference of view.references) lines.push(`  ${reference.ref}${reference.title ? ` "${reference.title}"` : ""}${reference.harness ? ` (${reference.harness})` : ""}`)
  }
  return lines
}

/** The turn's harness, where a switch changed it: its prompt names the harness it went to. */
function harnessOf(turn: Turn): string {
  const first = turn.part.entries[turn.start]
  return (first?.type === "user" ? first.provider : undefined) ?? turn.part.harness
}

/**
 * One line per turn: when, the request, and what was done; under it, as the
 * transcript's index has them, the messages sent into it while the agent
 * worked, the latest `STEER_LINES`. Asked for one turn (`turns="12"`, or
 * `"12.40"` from its entry 40 on), it lists every one.
 */
function index(view: View, input: ThreadHistoryInput): string {
  const asked = range(input.turns, view)
  const part = asked?.part ?? view.home
  const turns = part.turns
  if (!turns.length) return [...header(view), "No turns yet."].join("\n")
  const last = turns.at(-1)!.number
  const to = asked?.to ?? last
  const from = asked?.from ?? Math.max(turns[0]!.number, to - INDEX_TURNS + 1)
  const lines: string[] = []
  let chars = 0
  let previousAt: number | undefined
  let previousHarness: string | undefined
  let shownTo = from - 1
  const at = prefix(view, part)
  const one = asked !== undefined && asked.from === asked.to
  let more = ""
  for (const turn of turns) {
    if (turn.number < from || turn.number > to) continue
    const line = turnLine(view, turn, previousAt, previousHarness)
    const steers = turn.number === 0 ? [] : steeredMessages(turn.part.entries.slice(turn.start, turn.end))
    const sub = (steer: { k: number; words: string }) => `  - ${at}${turn.number}.${steer.k}: "${steer.words}"`
    if (one) {
      // The one turn asked for, every message sent into it, a page at a time.
      lines.push(line.text)
      chars += line.text.length + 1
      for (const steer of steers) {
        if (steer.k < (asked?.fromEntry ?? 0)) continue
        const text = sub(steer)
        if (chars + text.length > PAGE_CHARS) {
          more = ` More: turns="${at}${turn.number}.${steer.k}".`
          break
        }
        lines.push(text)
        chars += text.length + 1
      }
      shownTo = turn.number
      break
    }
    const { earlier, shown } = steersShown(steers)
    const block = [
      line.text,
      ...(earlier ? [`  - ${plural(earlier, "earlier message")} not listed: turns="${at}${turn.number}" lists every one`] : []),
      ...shown.map(sub),
    ].join("\n")
    if (lines.length && chars + block.length > PAGE_CHARS) break
    lines.push(block)
    chars += block.length + 1
    previousAt = line.at ?? previousAt
    previousHarness = line.harness
    shownTo = turn.number
  }
  const earlier = from > turns[0]!.number ? ` Earlier: turns="${at}${Math.max(turns[0]!.number, from - INDEX_TURNS)}-${from - 1}".` : ""
  const later = shownTo < last ? ` Later: turns="${at}${shownTo + 1}-${Math.min(last, shownTo + INDEX_TURNS)}".` : ""
  const which = view.parts.length > 1 ? `Session ${part.session}, turns` : "Turns"
  return [...header(view), `${which} ${from}–${shownTo} of ${last}.${earlier}${later}${more}`, ...lines].join("\n")
}

function turnLine(view: View, turn: Turn, previousAt: number | undefined, previousHarness: string | undefined): { text: string; at?: number; harness: string } {
  const entries = turn.part.entries
  const first = entries[turn.start]!
  const tools = new Map<string, number>()
  const edited = new Set<string>()
  let replies = 0
  let lastReply: string | undefined
  let at: number | undefined
  let steered = 0
  for (let index = turn.start; index < turn.end; index++) {
    const entry = entries[index]!
    at ??= entry.at
    if (turn.number !== 0 && entry.type === "user" && entry.steeringFor !== undefined) steered++
    if (entry.type === "text" && entry.text.trim()) {
      replies++
      lastReply = entry.text
    } else if (entry.type === "tool") {
      tools.set(toolName(entry), (tools.get(toolName(entry)) ?? 0) + 1)
      for (const detail of entry.details ?? []) if (detail.type === "diff") edited.add(detail.path)
    }
  }
  const harness = harnessOf(turn)
  const asked = turn.number === 0
    ? `(before the first prompt: ${kindOf(first)})`
    : first.type === "user"
      ? firstLine(readMessage(first.text).body, INDEX_REQUEST) || "(empty prompt)"
      : kindOf(first)
  const done: string[] = []
  const calls = [...tools.values()].reduce((sum, value) => sum + value, 0)
  if (calls) done.push(`${plural(calls, "tool")} (${[...tools].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, value]) => `${name} ${value}`).join(", ")}${tools.size > 4 ? ", …" : ""})`)
  if (edited.size) done.push(`edited ${[...edited].slice(0, 4).map((path) => path.split("/").at(-1)).join(", ")}${edited.size > 4 ? ` +${edited.size - 4}` : ""}`)
  if (lastReply) done.push(`${replies > 1 ? `${replies} replies, last: ` : ""}"${firstLine(lastReply, INDEX_ANSWER)}"`)
  if (turn.part.running && turn === turn.part.turns.at(-1)) done.push("running now")
  else if (!done.length) done.push(plural(turn.end - turn.start, "entry", "entries"))
  const when = stamp(at, previousAt)
  const switched = previousHarness !== undefined && harness !== previousHarness ? ` [${harness}]` : ""
  const sent = steered ? ` (+${plural(steered, "message")} sent while it worked, below)` : ""
  const line = `${prefix(view, turn.part)}${turn.number}${when ? ` ${when}` : ""}${switched} ${asked}${sent} → ${done.join(" · ")}`
  return at === undefined ? { text: line, harness } : { text: line, at, harness }
}

function indented(text: string, by = "    "): string {
  return text.split("\n").map((line) => `${by}${line}`).join("\n")
}

function lineCount(text: string): number {
  let lines = 1
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++
  return lines
}

/** A field as `read` shows it: whole, or named with its size and first lines. */
function renderField(field: Field, ref: string, entry: Entry): string {
  // A last newline shows as nothing; the payload keeps it.
  const shown = (field.name === "input" && entry.type === "tool" ? compactInput(field.text) : field.text).replace(/\n$/, "")
  const bare = field.prose && field.name === "text"
  if (!exceeds(shown, field.prose ? PROSE_LIMITS : PAYLOAD_LIMITS)) {
    if (bare) return shown
    return shown.includes("\n") ? `  ${field.name}:\n${indented(shown)}` : `  ${field.name}: ${shown}`
  }
  const lines = previewLines(field.text)
  return `  ${field.name}: ${count(field.text.length)} chars, ${plural(lineCount(field.text), "line")} → payload ref="${ref}/${field.name}"; it begins:\n${indented(lines.join("\n"))}`
}

/** A call's JSON arguments as `key: value` lines, the same content without quotes and braces. */
function compactInput(text: string): string {
  const parsed = callArguments(text)
  if (!parsed) return text
  return Object.entries(parsed).map(([key, value]) => {
    const string = z.string().safeParse(value)
    if (!string.success) return `${key}: ${JSON.stringify(value)}`
    return string.data.includes("\n") ? `${key}: |\n${indented(string.data, "  ")}` : `${key}: ${string.data}`
  }).join("\n")
}

function callArguments(text: string): z.infer<typeof CallArgumentsSchema> | undefined {
  if (!text.startsWith("{")) return undefined
  try {
    const parsed = CallArgumentsSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function renderEntry(entry: Entry, ref: string): string {
  const lines = [`[${ref}] ${kindOf(entry)}`]
  if (entry.type === "user") {
    // The words; each item the person attached is one line, its body in the prompt's payload.
    const message = readMessage(entry.text)
    if (message.body) lines.push(renderField({ name: "text", text: message.body, prose: true }, ref, entry))
    for (const item of message.items)
      lines.push(`  context [${item.n}] ${item.kind}${Object.entries(item.attrs).map(([name, value]) => ` ${name}="${value}"`).join("")}${item.body ? ` (${count(item.body.length)} chars in payload ref="${ref}/text")` : ""}`)
  } else for (const field of fields(entry)) lines.push(renderField(field, ref, entry))
  if (entry.type === "user" || entry.type === "tool")
    for (const attachment of entry.attachments ?? []) lines.push(`  attachment ${attachmentDescription(attachment)} (${attachment.mimeType})`)
  if (entry.type === "tool" && shortened(entry))
    lines.push(`  output whole: ${count(entry.outputLength ?? 0)} chars → payload ref="${ref}/output"`)
  return lines.join("\n")
}

function turnHeading(view: View, turn: Turn): string {
  const at = turn.part.entries[turn.start]?.at
  const where = view.parts.length > 1 ? ` · session ${turn.part.session}` : ""
  const name = turn.number === 0 ? "Before turn 1" : `Turn ${turn.number}`
  return `## ${name}${where} · ${harnessOf(turn)}${at === undefined ? "" : ` · ${stamp(at)}`}`
}

/** Turns whole, a page at a time; the newest when none is named. */
function readTurns(view: View, input: ThreadHistoryInput): string {
  const newest = view.home.turns.at(-1)
  if (!newest && input.turns === undefined) return "No turns yet."
  const asked = range(input.turns, view) ?? { part: view.home, from: newest!.number, fromEntry: 0, to: newest!.number }
  const at = prefix(view, asked.part)
  const out: string[] = []
  let chars = 0
  for (const turn of asked.part.turns) {
    if (turn.number < asked.from || turn.number > asked.to) continue
    const size = turn.end - turn.start
    const first = turn.number === asked.from ? asked.fromEntry : 0
    const last = turn.number === asked.to && asked.toEntry !== undefined ? Math.min(asked.toEntry, size - 1) : size - 1
    if (first >= size) throw new Error(`Turn ${at}${turn.number} has entries ${turn.number}.0–${turn.number}.${size - 1}.`)
    out.push(turnHeading(view, turn) + (first ? ` (from entry ${turn.number}.${first})` : ""))
    for (let k = first; k <= last; k++) {
      const text = renderEntry(turn.part.entries[turn.start + k]!, `${at}${turn.number}.${k}`)
      if (chars > 0 && chars + text.length > PAGE_CHARS) {
        const until = asked.toEntry !== undefined ? `-${asked.to}.${asked.toEntry}` : asked.to !== turn.number ? `-${asked.to}` : ""
        out.push(`\nMore: read turns="${at}${turn.number}.${k}${until}".`)
        return out.join("\n")
      }
      out.push(text)
      chars += text.length + 1
    }
  }
  const last = asked.part.turns.at(-1)?.number ?? 0
  if (asked.to < last) out.push(`\n(${asked.to + 1 === last ? `Turn ${at}${last} follows` : `Turns ${at}${asked.to + 1}–${last} follow`}: read turns="${at}${asked.to + 1}${asked.to + 1 === last ? "" : `-${last}`}".)`)
  return out.join("\n")
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CHARS)
  const end = Math.min(text.length, at + length + SNIPPET_CHARS)
  const flat = (part: string) => part.replace(/\s+/g, " ")
  return `${start > 0 ? "…" : ""}${flat(text.slice(start, at))}«${flat(text.slice(at, at + length))}»${flat(text.slice(at + length, end))}${end < text.length ? "…" : ""}`
}

/**
 * Hits newest first, this Session's before the others': each field that
 * matches, with a snippet around its first match. A fork's inherited turns
 * are counted in the Session they came from.
 */
function search(view: View, input: ThreadHistoryInput): string {
  const query = input.query
  if (!query) throw new Error("search needs a query.")
  let pattern: RegExp
  try {
    pattern = new RegExp(input.regex ? query : escapeRegex(query), "i")
  } catch (error) {
    throw new Error(`The regex doesn't parse: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const asked = range(input.turns, view)
  const parts = asked ? [asked.part] : [view.home, ...view.parts.filter((part) => part !== view.home)]
  const skip = input.offset ?? 0
  const hits: string[] = []
  let total = 0
  let searched = 0
  for (const part of parts) {
    const at = prefix(view, part)
    const floor = asked || !part.forkOf ? 0 : part.inherited
    for (let t = part.turns.length - 1; t >= 0; t--) {
      const turn = part.turns[t]!
      if (asked && (turn.number < asked.from || turn.number > asked.to)) continue
      if (turn.end <= floor) break
      searched++
      for (let index = Math.max(turn.start, floor); index < turn.end; index++) {
        const entry = part.entries[index]!
        const ref = `${at}${turn.number}.${index - turn.start}`
        const named = entry.type === "tool" ? toolName(entry) : entry.type === "event" ? entry.label : undefined
        for (const field of named ? [{ name: "", text: named }, ...fields(entry)] : fields(entry)) {
          const found = pattern.exec(field.text)
          if (!found) continue
          total++
          if (total <= skip || hits.length >= SEARCH_HITS) continue
          hits.push(`[${field.name ? `${ref}/${field.name}` : ref}] ${kindOf(entry)}: ${snippet(field.text, found.index, found[0].length)}`)
        }
      }
    }
  }
  const scope = asked ? ` in turns ${input.turns}` : ""
  if (!total) return `No match for ${JSON.stringify(query)}${scope} across ${plural(searched, "turn")}.`
  const more = skip + hits.length < total ? ` More: offset=${skip + hits.length}.` : ""
  return [`${plural(total, "hit")} for ${JSON.stringify(query)}${scope}, newest first; ${skip + 1}–${skip + hits.length} shown.${more}`, ...hits].join("\n")
}

/** One field whole, a page of characters at a time. */
async function payload(view: View, input: ThreadHistoryInput, catalog: Pick<ThreadCatalog, "entry">): Promise<string> {
  const found = /^\s*(?:(\d+):)?(\d+)\.(\d+)(?:\/([a-z]+))?\s*$/.exec(input.ref ?? "")
  if (!found) throw new Error(`payload takes a ref from read or search, such as 12.7, 12.7/output or 2:12.7/output; got ${JSON.stringify(input.ref ?? "")}.`)
  const part = partOf(view, found[1])
  const turn = turnOf(part, Number(found[2]), view)
  const k = Number(found[3])
  const at = prefix(view, part)
  if (k >= turn.end - turn.start) throw new Error(`Turn ${at}${turn.number} has entries ${turn.number}.0–${turn.number}.${turn.end - turn.start - 1}.`)
  const index = turn.start + k
  let entry = part.entries[index]!
  if (shortened(entry) && entry.id && part.path && index < part.baseLength) entry = (await catalog.entry(part.path, entry.id)) ?? entry
  const all = fields(entry)
  const name = found[4] ?? (all.find((field) => field.name === "output") ?? all[0])?.name
  const field = all.find((candidate) => candidate.name === name)
  if (!field) throw new Error(`${at}${turn.number}.${k} (${kindOf(entry)}) has ${all.length ? all.map((candidate) => candidate.name).join(", ") : "no text"}${name ? `, not ${name}` : ""}.`)
  const text = field.text
  const start = Math.min(input.offset ?? 0, text.length)
  let end = Math.min(text.length, start + PAGE_CHARS)
  if (end < text.length) {
    // A page ends at a line where one is near, and never between the halves of a surrogate pair.
    const newline = text.lastIndexOf("\n", end - 1)
    if (newline >= start + PAGE_CHARS * 0.8) end = newline + 1
    else if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
  }
  const ref = `${at}${turn.number}.${k}/${field.name}`
  const span = start === 0 && end === text.length ? `${count(text.length)} chars, whole` : `chars ${count(start)}–${count(end)} of ${count(text.length)}`
  const more = end < text.length ? `\n\nMore: payload ref="${ref}" offset=${end}.` : ""
  return `[${ref}] ${kindOf(entry)} · ${span}\n${text.slice(start, end)}${more}`
}

async function reply(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] }
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
  }
}

/** What an agent reads before calling it, in every session: kept short. */
const DESCRIPTION = [
  "Read this Thread's history whole, every session and harness of it, and that of each thread its messages referenced (a <mako_context> conversation item). Turns are numbered as in a transcript Mako gave you. Changes nothing.",
  "turns: one line per turn: number, time, request, what was done. Newest first page by default.",
  "read: turns whole: turns=\"12\", \"40-45\", \"12.7-14\" (from entry 7 of turn 12); another session's as \"2:12\". The newest turn by default. Entries are refs like 12.7; a field too long to show gives its size, first lines and a ref like 12.7/output.",
  "search: query as text, or a regex with regex: true; case-insensitive over prompts, replies, thinking and tool names, inputs and outputs. Hits newest first with refs and snippets; turns narrows it.",
  "payload: a ref's whole content, a page at a time from offset.",
  "A reply too long for one answer says how to get the rest.",
].join("\n")

/** `thread_history` on a conversation's `mako` server, for the Thread the calling conversation belongs to. */
export function registerThreadHistoryTools(server: McpServer, tools: ThreadHistoryTools, conversationId: () => string): void {
  server.registerTool(
    "thread_history",
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        action: z.enum(ACTIONS),
        thread: z.string().max(1024).optional().describe("A referenced thread, as its item's ref names it (thread:<harness>:<id>). Omit for this Thread."),
        turns: z.string().max(64).optional().describe("A turn or range: 12, 40-60, 12.7-14, 2:5-9."),
        query: z.string().min(1).max(1024).optional().describe("search: text, or a JavaScript regex with regex: true."),
        regex: z.boolean().optional(),
        ref: z.string().max(64).optional().describe("payload: a ref from read or search, such as 12.7/output."),
        offset: z.number().int().nonnegative().optional().describe("payload: the character to start at. search: hits to skip."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => reply(() => tools.answer(conversationId(), input))
  )
}
