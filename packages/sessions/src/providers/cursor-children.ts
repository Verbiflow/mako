import { readdir, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { boundedChildren, type ChildTranscript } from "../children.js"
import { type DecodedBlock, type ThreadRef } from "../format.js"
import { lineRecord, readHead, unparsedLine, type LinePlace, type RecordTranslator } from "../jsonl.js"
import type { NativeStores } from "../read-only-sqlite.js"
import { READ_BUSY_TIMEOUT_MS, SqliteBusy } from "./sqlite-busy.js"
import { SessionUnreadable } from "./types.js"
import { EntrySink } from "../entry-sink.js"

/**
 * Cursor's Task subagents. Where a child is kept depends on who ran its
 * parent:
 * - `cursor-agent acp` writes each child as a store of its own,
 *   `chats/<workspace>/<child-id>/store.db`, whose meta row carries
 *   `subagentInfo` (`parentAgentId`, `rootParentAgentId`, `toolCallId`,
 *   `typeName`): a whole transcript, read like any store.
 * - The SDK, `cursor-agent -p` and Cursor's editor keep no store for a child.
 *   Cursor writes a plain transcript of it instead,
 *   `~/.cursor/projects/<workspace>/agent-transcripts/<parent-id>/subagents/<child-id>.jsonl`:
 *   one line per message with its text and its calls' names and arguments,
 *   but no call ids and no results. That is all of it this Mac holds.
 *
 * The parent names each child in its Task call's result, "Agent ID: <id>",
 * whichever process ran it.
 */

const SubagentInfo = z.object({ parentAgentId: z.string(), toolCallId: z.string().optional(), typeName: z.string().optional() })
const StoreMeta = z.object({ agentId: z.string().optional(), name: z.string().optional(), subagentInfo: SubagentInfo.optional() })
type StoreMeta = z.infer<typeof StoreMeta>
const AGENT_ID = /Agent ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
/** A result as the text the agent id is searched in: as written, or its JSON. */
const ResultText = z.union([z.string(), z.unknown().transform((value) => JSON.stringify(value ?? ""))])
const ToolResult = z.object({ type: z.literal("tool-result"), toolCallId: z.string(), toolName: z.string().optional(), result: ResultText })
/** Text the store keeps as TEXT or as a BLOB. */
const StoredText = z.union([z.string(), z.instanceof(Uint8Array).transform((bytes) => Buffer.from(bytes).toString("utf8"))])
/** The meta row's value, which `cursor-agent` writes hex-encoded. */
const MetaRow = z.object({
  value: z.union([z.string().transform((value) => (/^[0-9a-f]+$/i.test(value) ? Buffer.from(value, "hex").toString("utf8") : value)), StoredText]),
})
const PayloadRow = z.object({ at: z.number(), payload: StoredText })
const NewestRow = z.object({ at: z.number().nullable() })
const MessageContent = z.object({ content: z.array(z.unknown()) })
const ToolCall = z.object({ type: z.literal("tool-call"), toolCallId: z.string(), toolName: z.string().optional(), args: z.unknown().optional() })
const ResumeArgs = z.object({ agentId: z.string() })

interface StoreRoots {
  chats: string
  acp: string
  sdk: string
  /** `~/.cursor/projects`, where Cursor writes its plain agent transcripts. */
  projects: string
  /** The SDK's index and the agent an SDK store belongs to; null for a `cursor-agent` store. */
  sdkAgent(path: string): { index: string; agentId: string } | null
}

const SdkTask = z.object({
  message: z.object({
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.literal("task"),
    status: z.string(),
    args: z.object({ description: z.string().optional(), agentId: z.string().optional() }).optional(),
    result: z.object({ value: z.object({ agentId: z.string().optional(), isBackground: z.boolean().optional() }).optional() }).optional(),
  }),
})

export class CursorChildren {
  private readonly stores: NativeStores
  private readonly roots: StoreRoots
  /** Each store's meta by path, kept while the store's mtime holds. */
  private readonly metas = new Map<string, { mtimeMs: number; meta: StoreMeta | null }>()
  private indexed: { at: number; index: Promise<ChildIndex> } | null = null
  /** What a parent's Task calls said, kept while its store and WAL hold still. */
  private readonly calls = new Map<string, { stamp: string; identity: string; after: number; calls: ParentCalls }>()

  constructor(stores: NativeStores, roots: StoreRoots) {
    this.stores = stores
    this.roots = roots
  }

  /** The agent a plain transcript belongs to, when `path` is one. */
  transcriptChild(path: string): { parentId: string; agentId: string } | null {
    if (!path.startsWith(`${this.roots.projects}/`)) return null
    const match = /\/agent-transcripts\/([^/]+)\/subagents\/([^/]+)\.jsonl$/.exec(path)
    return match?.[1] && match[2] ? { parentId: match[1], agentId: match[2] } : null
  }

  async list(parentPath: string, parentId: string): Promise<ChildTranscript[]> {
    const [calls, storeChildren, transcripts] = await Promise.all([
      this.parentCalls(parentPath),
      this.storeChildren(parentId),
      this.transcripts(parentId),
    ])
    const children = new Map<string, ChildTranscript>()
    for (const { path, agentId, info } of storeChildren) {
      // A `cursor-agent -p` continuation shares its session's agent id but not its calls: a child belongs to the store holding its call.
      if (info.toolCallId && !calls.seen.has(info.toolCallId)) continue
      const toolId = info.toolCallId ?? calls.byAgent.get(agentId)
      const child: ChildTranscript = {
        nativeId: agentId,
        path,
        state: toolId && calls.answered.has(toolId) ? { kind: "complete" } : { kind: "partial", reason: "Cursor hasn't recorded this agent's end: it is still running, or stopped without reporting." },
      }
      if (toolId) child.toolId = toolId
      if (info.typeName) child.role = info.typeName
      children.set(agentId, await stamped(child, path))
    }
    for (const [agentId, path] of transcripts) {
      if (children.has(agentId)) continue
      const child: ChildTranscript = {
        nativeId: agentId,
        path,
        state: { kind: "partial", reason: "Cursor keeps only a plain transcript of this agent: what it said and which calls it made, without their results." },
      }
      const toolId = calls.byAgent.get(agentId)
      if (toolId) child.toolId = toolId
      children.set(agentId, await stamped(child, path))
    }
    for (const [agentId, toolId] of calls.byAgent) {
      if (children.has(agentId)) continue
      children.set(agentId, { nativeId: agentId, toolId, state: { kind: "missing", reason: "Cursor keeps no record of this agent beyond the report its call returned." } })
    }
    for (const child of children.values()) {
      const title = child.toolId ? calls.titles.get(child.toolId) : undefined
      if (title) child.title = title
    }
    return boundedChildren([...children.values()].sort((left, right) => (left.startedAt ?? "~").localeCompare(right.startedAt ?? "~"))).children
  }

  /** The files of a parent's children, for its records. */
  async recordsOf(parentId: string): Promise<string[]> {
    const files: string[] = []
    for (const { path } of await this.storeChildren(parentId)) {
      const folder = dirname(path)
      for (const name of await readdir(folder).catch(() => new Array<string>()))
        if (!/^store\.db(?:-wal|-shm|-journal)?$/.test(name)) files.push(join(folder, name))
    }
    files.push(...(await this.transcripts(parentId)).values())
    return files
  }

  /** The child stores of a parent: the `store.db` files their database must be captured from. */
  async childStores(parentId: string): Promise<string[]> {
    return (await this.storeChildren(parentId)).map((child) => child.path)
  }

  /** A child store's or plain transcript's ref; null for any other path. */
  async ref(path: string, bytes: number, mtimeMs: number): Promise<ThreadRef | null> {
    const transcript = this.transcriptChild(path)
    if (transcript) {
      const ref: ThreadRef = { harness: "cursor", nativeId: transcript.agentId, path, bytes, updatedAt: new Date(mtimeMs).toISOString(), childOf: { nativeId: transcript.parentId } }
      const prompt = new CursorTranscriptTranslator()
      for (const line of (await readHead(path, 65_536)).split("\n").slice(0, 2)) prompt.push(line)
      const first = prompt.snapshot()[0]
      if (first?.type === "user") ref.title = first.text.split("\n")[0]?.slice(0, 120)
      return ref
    }
    const meta = await this.metaOf(path)
    const info = meta?.subagentInfo
    if (!meta?.agentId || !info) return null
    const ref: ThreadRef = { harness: "cursor", nativeId: meta.agentId, path, bytes, updatedAt: new Date(mtimeMs).toISOString(), childOf: { nativeId: info.parentAgentId } }
    if (info.toolCallId) ref.childOf = { ...ref.childOf!, toolId: info.toolCallId }
    if (meta.name && meta.name !== "New Agent") ref.title = meta.name
    return ref
  }

  /** Stores whose meta names `parentId` as their parent. */
  private async storeChildren(parentId: string): Promise<StoreChild[]> {
    return (await this.index()).stores.get(parentId) ?? []
  }

  /**
   * Every child store by its parent, and every plain transcript folder by
   * its parent, listed at most once in `INDEX_MS`. A store's meta is read
   * once per mtime; listing a hundred parents' children costs one pass.
   */
  private index(): Promise<ChildIndex> {
    if (this.indexed && Date.now() - this.indexed.at < INDEX_MS) return this.indexed.index
    const index = this.build()
    this.indexed = { at: Date.now(), index }
    index.catch(() => {
      if (this.indexed?.index === index) this.indexed = null
    })
    return index
  }

  private async build(): Promise<ChildIndex> {
    const paths: string[] = []
    for (const workspace of await readdir(this.roots.chats).catch(() => new Array<string>()))
      for (const session of await readdir(join(this.roots.chats, workspace)).catch(() => new Array<string>()))
        paths.push(join(this.roots.chats, workspace, session, "store.db"))
    for (const session of await readdir(this.roots.acp).catch(() => new Array<string>())) paths.push(join(this.roots.acp, session, "store.db"))
    const stores = new Map<string, StoreChild[]>()
    for (let at = 0; at < paths.length; at += 16)
      await Promise.all(paths.slice(at, at + 16).map(async (path) => {
        const meta = await this.metaOf(path)
        if (!meta?.agentId || !meta.subagentInfo) return
        const parent = meta.subagentInfo.parentAgentId
        stores.set(parent, [...(stores.get(parent) ?? []), { path, agentId: meta.agentId, info: meta.subagentInfo }])
      }))
    const transcripts = new Map<string, string[]>()
    for (const project of await readdir(this.roots.projects).catch(() => new Array<string>())) {
      const folder = join(this.roots.projects, project, "agent-transcripts")
      for (const parent of await readdir(folder).catch(() => new Array<string>()))
        if (!parent.endsWith(".jsonl")) transcripts.set(parent, [...(transcripts.get(parent) ?? []), join(folder, parent, "subagents")])
    }
    return { stores, transcripts }
  }

  /** A store's meta row, read once per mtime of the store. */
  private async metaOf(path: string): Promise<StoreMeta | null> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const held = this.metas.get(path)
    if (held && held.mtimeMs === info.mtimeMs) return held.meta
    let meta: StoreMeta | null = null
    try {
      const database = this.stores.open(path, { timeout: READ_BUSY_TIMEOUT_MS })
      try {
        const text = MetaRow.safeParse(database.prepare("SELECT value FROM meta WHERE key = '0'").get()).data?.value
        meta = text ? (StoreMeta.safeParse(JSON.parse(text)).data ?? null) : null
      } finally {
        database.close()
      }
    } catch {
      meta = null
    }
    this.metas.set(path, { mtimeMs: info.mtimeMs, meta })
    return meta
  }

  /** The plain transcripts Cursor wrote of a parent's agents, by agent id. */
  private async transcripts(parentId: string): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const folder of (await this.index()).transcripts.get(parentId) ?? [])
      for (const name of await readdir(folder).catch(() => new Array<string>()))
        if (name.endsWith(".jsonl")) found.set(basename(name, ".jsonl"), join(folder, name))
    return found
  }

  /**
   * The parent's Task calls: which agent each named, which were answered,
   * and their descriptions. An SDK agent's calls are read from its run
   * events in the SDK's index; its store holds every checkpoint the agent
   * ever wrote (one measured 10 GB, 22 s to search) and the events name the
   * same calls in a few hundred megabytes. A `cursor-agent` store is
   * searched for the blobs that hold a Task call or its result, as bytes,
   * and only those are decoded.
   */
  private async parentCalls(path: string): Promise<ParentCalls> {
    const sdk = this.roots.sdkAgent(path)
    const source = sdk?.index ?? path
    const [store, wal] = await Promise.all([stat(source).catch(() => null), stat(`${source}-wal`).catch(() => null)])
    if (!store?.isFile()) return { seen: new Set(), byAgent: new Map(), answered: new Set(), titles: new Map() }
    const stamp = `${store.mtimeMs}:${store.size}:${wal?.mtimeMs}:${wal?.size}`
    const identity = `${store.dev}:${store.ino}`
    let held = this.calls.get(path)
    if (held?.stamp === stamp) return held.calls
    // Rows are only ever added (blobs are content-addressed, events appended): read past the last one seen.
    if (!held || held.identity !== identity) held = { stamp, identity, after: 0, calls: { seen: new Set(), byAgent: new Map(), answered: new Set(), titles: new Map() } }
    try {
      const database = this.stores.open(source, { timeout: READ_BUSY_TIMEOUT_MS })
      try {
        const rows = sdk
          ? database.prepare("SELECT rowid AS at, payload_json AS payload FROM run_events WHERE rowid > ? AND run_id IN (SELECT run_id FROM runs WHERE agent_id = ?) AND instr(payload_json, '\"name\":\"task\"') > 0").iterate(held.after, sdk.agentId)
          : database.prepare("SELECT rowid AS at, data AS payload FROM blobs WHERE rowid > ? AND (instr(data, CAST('Agent ID: ' AS BLOB)) > 0 OR (instr(data, CAST('\"tool-call\"' AS BLOB)) > 0 AND instr(data, CAST('\"description\"' AS BLOB)) > 0))").iterate(held.after)
        for (const raw of rows) {
          const row = PayloadRow.safeParse(raw).data
          if (!row) continue
          held.after = Math.max(held.after, row.at)
          if (sdk) foldSdkEvent(held.calls, row.payload)
          else foldBlob(held.calls, row.payload)
        }
        // The newest row, so the next read starts past what this one passed over.
        const last = NewestRow.safeParse(database.prepare(`SELECT max(rowid) AS at FROM ${sdk ? "run_events" : "blobs"}`).get()).data?.at
        held.after = Math.max(held.after, last ?? 0)
      } finally {
        database.close()
      }
    } catch (error) {
      if (SqliteBusy.safeParse(error).success) throw new SessionUnreadable(source, { cause: error })
      // An unreadable store names no calls; its children still list from their own records.
    }
    held.stamp = stamp
    this.calls.delete(path)
    this.calls.set(path, held)
    const oldest = this.calls.keys().next().value
    if (this.calls.size > 64 && oldest !== undefined) this.calls.delete(oldest)
    return held.calls
  }
}

/** How long one listing of the stores and transcript folders answers for. */
const INDEX_MS = 5_000

interface StoreChild {
  path: string
  agentId: string
  info: z.infer<typeof SubagentInfo>
}

interface ChildIndex {
  stores: Map<string, StoreChild[]>
  transcripts: Map<string, string[]>
}

interface ParentCalls {
  /** Every Task call the store holds, by id. */
  seen: Set<string>
  byAgent: Map<string, string>
  answered: Set<string>
  titles: Map<string, string>
}

function foldBlob(calls: ParentCalls, text: string): void {
  if (!text.startsWith("{")) return
  let content: unknown[]
  try {
    const message = MessageContent.safeParse(JSON.parse(text))
    if (!message.success) return
    content = message.data.content
  } catch {
    return
  }
  for (const part of content) {
    const call = ToolCall.safeParse(part)
    if (call.success && /^(task|calldynamictool)$/i.test(call.data.toolName ?? "")) {
      calls.seen.add(call.data.toolCallId)
      const args = z.object({ description: z.string() }).safeParse(call.data.args).data ?? z.object({ args: z.object({ description: z.string() }) }).safeParse(call.data.args).data?.args
      if (args) calls.titles.set(call.data.toolCallId, args.description)
      const resumed = ResumeArgs.safeParse(call.data.args).data?.agentId
      if (resumed && !calls.byAgent.has(resumed)) calls.byAgent.set(resumed, call.data.toolCallId)
      continue
    }
    const result = ToolResult.safeParse(part)
    if (!result.success) continue
    const agent = AGENT_ID.exec(result.data.result)?.[1]
    if (!agent) continue
    calls.seen.add(result.data.toolCallId)
    calls.answered.add(result.data.toolCallId)
    if (!calls.byAgent.has(agent)) calls.byAgent.set(agent, result.data.toolCallId)
  }
}

function foldSdkEvent(calls: ParentCalls, payload: string): void {
  let event
  try {
    event = SdkTask.safeParse(JSON.parse(payload))
  } catch {
    return
  }
  if (!event.success) return
  const { call_id: call, status, args, result } = event.data.message
  calls.seen.add(call)
  if (args?.description) calls.titles.set(call, args.description)
  const agent = result?.value?.agentId ?? args?.agentId
  if (!agent) return
  if (!calls.byAgent.has(agent)) calls.byAgent.set(agent, call)
  if (status === "completed" && !result?.value?.isBackground) calls.answered.add(call)
}

async function stamped(child: ChildTranscript, path: string): Promise<ChildTranscript> {
  const info = await stat(path).catch(() => null)
  if (!info) return child
  return { ...child, startedAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString(), updatedAt: new Date(info.mtimeMs).toISOString() }
}

const TranscriptLine = z.object({
  role: z.string(),
  message: z.object({
    content: z.array(z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown().optional() }),
      z.object({ type: z.string() }),
    ])),
  }),
})

const TurnEnded = z.object({ type: z.literal("turn_ended"), status: z.string(), error: z.string().optional() })

/**
 * Cursor's plain agent transcript, one message a line. A call keeps its name
 * and arguments; Cursor writes no id and no result for it.
 */
export class CursorTranscriptTranslator implements RecordTranslator {
  private readonly sink: EntrySink

  /** `after`: the id of the entry before the first this one decodes, for one begun at a `ResumePoint`. */
  constructor(after?: string) {
    this.sink = new EntrySink(after)
  }

  get resume() {
    return this.sink.resume
  }

  get unchanged(): number {
    return this.sink.unchanged
  }

  push(raw: string, place?: LinePlace): void {
    this.sink.reading(lineRecord(place))
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      const sample = unparsedLine(raw, place)
      if (sample !== undefined) this.sink.unread("line", "unreadable", sample)
      return
    }
    // Where each turn ended: said only when the agent was stopped.
    const ended = TurnEnded.safeParse(value)
    if (ended.success) {
      if (ended.data.status !== "success") this.sink.push({ kind: "event", label: "Stopped", detail: ended.data.error ?? ended.data.status, tone: "warning" })
      return
    }
    const parsed = TranscriptLine.safeParse(value)
    if (!parsed.success) {
      this.sink.unread("transcript line", "unreadable", raw)
      return
    }
    const { role, message } = parsed.data
    if (role === "user") {
      const text = message.content.map((part) => ("text" in part ? part.text : "")).join("")
      const query = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(text)?.[1] ?? text
      this.sink.turn()
      this.sink.push({ kind: "user", text: query.trim() })
      return
    }
    if (role !== "assistant") {
      this.sink.unread(`role ${role}`, "unknown")
      return
    }
    const blocks: DecodedBlock[] = []
    for (const part of message.content) {
      if ("text" in part && part.type === "text") blocks.push({ type: "text", text: part.text })
      else if ("name" in part && part.type === "tool_use") blocks.push({ type: "tool", name: part.name, input: JSON.stringify(part.input ?? {}) })
    }
    if (blocks.length) this.sink.push({ kind: "assistant", blocks })
  }

  snapshot() {
    return this.sink.snapshot()
  }

  done() {
    return this.sink.done()
  }

  unread() {
    return this.sink.unreadRecords
  }
}
