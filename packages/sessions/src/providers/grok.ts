import { acpToolDetails } from "../acp-tool-details.js"
import { acpAttachments } from "../acp-attachments.js"
import type { AttachmentContent, ToolDetail } from "../content.js"
/**
 * Grok sessions.
 *
 * Modern sessions keep their authoritative live transcript in `updates.jsonl`:
 * ACP-style `session/update` notifications plus private
 * `_x.ai/session/update` turn boundaries. `summary.json` remains the authority
 * for identity, title, timestamps, current model, and reasoning effort. Older
 * sessions have only `chat_history.jsonl`; discovery falls back to that file,
 * but never returns both logs for one session.
 *
 * A session directory also holds sidecars Grok rewrites constantly
 * (`summary.json`, `chat_history.jsonl` beside updates, `events.jsonl`).
 * Those are not session files. Peeking them as rows makes the catalog
 * oscillate between two titles for one native id.
 *
 * `session/new` writes the directory before any prompt. That placeholder is
 * not a catalog thread; the row appears when a user turn or generated title
 * lands. Subagent children also live in the normal sessions tree — skip them
 * via `session_kind` or the parent's `subagents/<id>/meta.json`, the same
 * way Codex skips `thread_source=subagent` and Cursor skips `subagentInfo`.
 * Forks only carry `parent_session_id` and stay visible.
 */

import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { readdir, readFile, stat, rm } from "node:fs/promises"
import {
  clip,
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type TurnUsage,
} from "../format.js"
import {
  createJsonlFollower,
  readLines,
  snapshotSink,
  type LineTranslator,
} from "../jsonl.js"
import { normalizeToolOutput } from "../tool-output.js"
import type { NativeFile, SessionProvider } from "./types.js"

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/
const UPDATE_METHODS = new Set(["session/update", "_x.ai/session/update"])
const TRANSCRIPT_UPDATES = "updates.jsonl"
const TRANSCRIPT_LEGACY = "chat_history.jsonl"

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue
}

interface GrokSummary {
  id: string
  cwd?: string
  title?: string
  createdAt?: string
  model?: string
  effort?: string
  sessionKind?: string
  parentSessionId?: string
}

interface GrokUpdateBase {
  details?: ToolDetail[]
  attachments?: AttachmentContent[]
  at?: string
}

interface GrokUserChunk extends GrokUpdateBase {
  sessionUpdate: "user_message_chunk"
  text: string
  promptKey?: string
}

interface GrokAgentChunk extends GrokUpdateBase {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk"
  text: string
}

interface GrokToolCall extends GrokUpdateBase {
  sessionUpdate: "tool_call"
  toolCallId?: string
  name: string
  input?: string
  output?: string
}

interface GrokToolUpdate extends GrokUpdateBase {
  sessionUpdate: "tool_call_update"
  toolCallId?: string
  name: string
  input?: string
  output?: string
  status?: string
  failed: boolean
}

interface GrokPlanEntry {
  content: string
  status: string
}

interface GrokPlan extends GrokUpdateBase {
  sessionUpdate: "plan"
  entries: GrokPlanEntry[]
}

interface GrokTurnCompleted extends GrokUpdateBase {
  sessionUpdate: "turn_completed"
  stopReason?: string
  usage?: TurnUsage
}

type GrokUpdate =
  | GrokUserChunk
  | GrokAgentChunk
  | GrokToolCall
  | GrokToolUpdate
  | GrokPlan
  | GrokTurnCompleted

interface LegacyUserLine {
  type: "user"
  text: string
}

interface LegacyReasoningLine {
  type: "reasoning"
  text: string
}

interface LegacyAssistantCall {
  id?: string
  name: string
  input?: string
}

interface LegacyAssistantLine {
  type: "assistant"
  text: string
  calls: LegacyAssistantCall[]
}

interface LegacyToolResultLine {
  type: "tool_result"
  toolCallId?: string
  output: string
}

type LegacyGrokLine =
  | LegacyUserLine
  | LegacyReasoningLine
  | LegacyAssistantLine
  | LegacyToolResultLine

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type UserEntry = Extract<ThreadEntry, { kind: "user" }>
type GrokToolBlock = EntryBlock & { type: "tool" }

interface GrokTranslator extends LineTranslator {
  done(): ThreadEntry[]
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed: JsonValue = JSON.parse(raw)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function contentText(content: JsonValue | undefined): string {
  if (isString(content)) return content
  if (Array.isArray(content)) return content.map(contentText).join("")
  if (!isJsonObject(content)) return ""
  const direct = stringValue(content["text"])
  if (direct !== undefined) return direct
  for (const key of [
    "content",
    "output_for_prompt",
    "output",
    "result",
    "message",
    "error",
  ]) {
    const nested = contentText(content[key])
    if (nested) return nested
  }
  return ""
}

function encodedJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isString(value)) return clip(value)
  return clip(JSON.stringify(value))
}

function isoTimestamp(
  root: JsonObject,
  params: JsonObject
): string | undefined {
  const metadata = objectValue(params["_meta"])
  const agentTimestamp = numberValue(metadata?.["agentTimestampMs"])
  if (agentTimestamp !== undefined) return dateFromMillis(agentTimestamp)

  const timestamp = root["timestamp"]
  if (isString(timestamp)) {
    const millis = Date.parse(timestamp)
    return Number.isNaN(millis) ? undefined : new Date(millis).toISOString()
  }
  const numeric = numberValue(timestamp)
  if (numeric === undefined) return undefined
  return dateFromMillis(numeric > 10_000_000_000 ? numeric : numeric * 1000)
}

function dateFromMillis(millis: number): string | undefined {
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function parseSummary(raw: string): GrokSummary | null {
  const root = parseJsonObject(raw)
  if (!root) return null
  const info = objectValue(root["info"])
  const id = stringValue(info?.["id"])
  if (!id) return null
  return {
    id,
    cwd: stringValue(info?.["cwd"]),
    title:
      stringValue(root["generated_title"]) ||
      stringValue(root["session_summary"]),
    createdAt: stringValue(root["created_at"]),
    model: stringValue(root["current_model_id"]),
    effort: stringValue(root["reasoning_effort"]),
    sessionKind:
      stringValue(root["session_kind"]) || stringValue(root["sessionKind"]),
    parentSessionId:
      stringValue(root["parent_session_id"]) ||
      stringValue(root["parentSessionId"]),
  }
}

/** Grok's ACP reserved namespace and the summary.json field share this name. */
function isSubagentKind(kind: string | undefined): boolean {
  if (!kind) return false
  const value = kind.trim().toLowerCase()
  if (value === "subagent") return true
  const last = value.split(/[/:]/).at(-1)
  return last === "subagent"
}

/**
 * Child agents are stored as ordinary session directories. The parent keeps
 * `subagents/<child-id>/meta.json`; forks only have `parent_session_id`.
 */
function isSubagentSession(
  summary: GrokSummary,
  transcriptPath: string
): boolean {
  if (isSubagentKind(summary.sessionKind)) return true
  const parentId = summary.parentSessionId
  if (!parentId || parentId === summary.id) return false
  const parentDir = join(dirname(dirname(transcriptPath)), parentId)
  return (
    existsSync(join(parentDir, "subagents", summary.id, "meta.json")) ||
    existsSync(join(parentDir, "subagents", `${summary.id}.json`))
  )
}

function parseUsage(value: JsonValue | undefined): TurnUsage | undefined {
  const usage = objectValue(value)
  if (!usage) return undefined
  const input = numberValue(usage["inputTokens"])
  const output = numberValue(usage["outputTokens"])
  const cacheRead = numberValue(usage["cachedReadTokens"])
  const cacheWrite = numberValue(usage["cacheCreationTokens"])
  const costTicks = numberValue(usage["costUsdTicks"])
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    costTicks === undefined
  ) {
    return undefined
  }
  const parsed: TurnUsage = {}
  if (input !== undefined) parsed.input = input
  if (output !== undefined) parsed.output = output
  if (cacheRead !== undefined) parsed.cacheRead = cacheRead
  if (cacheWrite !== undefined) parsed.cacheWrite = cacheWrite
  if (costTicks !== undefined) parsed.costUsd = costTicks / 1_000_000_000
  return parsed
}

function parsePlanEntries(value: JsonValue | undefined): GrokPlanEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const entry = objectValue(item)
    if (!entry) return []
    const content = stringValue(entry["content"])
    if (!content) return []
    return [{ content, status: stringValue(entry["status"]) ?? "pending" }]
  })
}

function failedToolUpdate(
  status: string | undefined,
  rawOutput: JsonValue | undefined
): boolean {
  if (status === "failed" || status === "error") return true
  const output = objectValue(rawOutput)
  const exitCode = numberValue(output?.["exit_code"])
  return exitCode !== undefined && exitCode !== 0
}

function toolName(update: JsonObject): string {
  return stringValue(update["title"]) || stringValue(update["kind"]) || "tool"
}

function parseUpdateLine(raw: string): GrokUpdate | null {
  const root = parseJsonObject(raw)
  if (!root) return null
  const method = stringValue(root["method"])
  if (!method || !UPDATE_METHODS.has(method)) return null
  const params = objectValue(root["params"])
  const update = objectValue(params?.["update"])
  if (!params || !update) return null
  const sessionUpdate = stringValue(update["sessionUpdate"])
  const at = isoTimestamp(root, params)
  const metadata = objectValue(params["_meta"])

  switch (sessionUpdate) {
    case "user_message_chunk": {
      const text = contentText(update["content"])
      const attachments = acpAttachments(update["content"])
      if (!text && !attachments.length) return null
      const promptIndex = numberValue(metadata?.["promptIndex"])
      return {
        sessionUpdate,
        at,
        text,
        attachments,
        promptKey:
          stringValue(metadata?.["promptId"]) ??
          stringValue(metadata?.["clientMessageId"]) ??
          (promptIndex === undefined ? undefined : String(promptIndex)),
      }
    }
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const text = contentText(update["content"])
      const attachments = acpAttachments(update["content"])
      return text || attachments.length
        ? { sessionUpdate, at, text, attachments }
        : null
    }
    case "tool_call": {
      return {
        sessionUpdate,
        at,
        attachments: acpAttachments(update["content"]),
        details: acpToolDetails(update["content"]),
        toolCallId: stringValue(update["toolCallId"]),
        name: toolName(update),
        input: encodedJson(update["rawInput"]),
        output:
          clip(normalizeToolOutput(contentText(update["content"]))) ||
          undefined,
      }
    }
    case "tool_call_update": {
      const status = stringValue(update["status"])
      const content =
        contentText(update["content"]) || contentText(update["rawOutput"])
      return {
        sessionUpdate,
        at,
        attachments: acpAttachments(update["content"]),
        details: acpToolDetails(update["content"]),
        toolCallId: stringValue(update["toolCallId"]),
        name: toolName(update),
        input: encodedJson(update["rawInput"]),
        output: clip(normalizeToolOutput(content)) || undefined,
        status,
        failed: failedToolUpdate(status, update["rawOutput"]),
      }
    }
    case "plan":
      return { sessionUpdate, at, entries: parsePlanEntries(update["entries"]) }
    case "turn_completed":
      return {
        sessionUpdate,
        at,
        stopReason: stringValue(update["stop_reason"]),
        usage: parseUsage(update["usage"]),
      }
    default:
      return null
  }
}

function parseLegacyCalls(value: JsonValue | undefined): LegacyAssistantCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const call = objectValue(item)
    if (!call) return []
    return [
      {
        id: stringValue(call["id"]),
        name: stringValue(call["name"]) ?? "tool",
        input: encodedJson(call["arguments"]),
      },
    ]
  })
}

function parseLegacyLine(raw: string): LegacyGrokLine | null {
  const root = parseJsonObject(raw)
  if (!root) return null
  switch (stringValue(root["type"])) {
    case "user":
      return { type: "user", text: contentText(root["content"]) }
    case "reasoning":
      return { type: "reasoning", text: contentText(root["summary"]) }
    case "assistant":
      return {
        type: "assistant",
        text: contentText(root["content"]),
        calls: parseLegacyCalls(root["tool_calls"]),
      }
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: stringValue(root["tool_call_id"]),
        output: normalizeToolOutput(contentText(root["content"])),
      }
    default:
      return null
  }
}

export class GrokProvider implements SessionProvider {
  harness = "grok" as const
  displayName = "Grok"
  private root: string

  constructor(home = homedir()) {
    this.root = join(home, ".grok", "sessions")
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const files: NativeFile[] = []
    let workspaces: string[]
    try {
      workspaces = await readdir(this.root)
    } catch {
      return []
    }
    await Promise.all(
      workspaces.map(async (workspace) => {
        let sessions: string[]
        const workspacePath = join(this.root, workspace)
        try {
          sessions = await readdir(workspacePath)
        } catch {
          return
        }
        await Promise.all(
          sessions.map(async (session) => {
            const sessionPath = join(workspacePath, session)
            const updatesPath = join(sessionPath, TRANSCRIPT_UPDATES)
            const updatesInfo = await stat(updatesPath).catch(() => null)
            const summaryInfo = await stat(
              join(sessionPath, "summary.json")
            ).catch(() => null)
            const revision = summaryInfo
              ? String(summaryInfo.mtimeMs)
              : undefined
            if (updatesInfo) {
              files.push({
                path: updatesPath,
                bytes: updatesInfo.size,
                mtimeMs: updatesInfo.mtimeMs,
                revision,
              })
              return
            }
            const legacyPath = join(sessionPath, TRANSCRIPT_LEGACY)
            const legacyInfo = await stat(legacyPath).catch(() => null)
            if (legacyInfo) {
              files.push({
                path: legacyPath,
                bytes: legacyInfo.size,
                mtimeMs: legacyInfo.mtimeMs,
                revision,
              })
            }
          })
        )
      })
    )
    return files
  }

  /** Remove a session directory (`<root>/<workspace>/<session>/`). */
  async remove(path: string): Promise<boolean> {
    const directory = dirname(path)
    if (dirname(dirname(directory)) !== this.root) return false
    await rm(directory, { recursive: true, force: true })
    return true
  }

  /**
   * Sidecar writes belong to the native transcript, never to a second row.
   * `summary.json` next to `updates.jsonl` is a title store, not a session.
   */
  watchTarget(path: string): string | null {
    const name = basename(path)
    if (name === TRANSCRIPT_UPDATES) return path
    if (name === TRANSCRIPT_LEGACY) {
      const updates = join(dirname(path), TRANSCRIPT_UPDATES)
      return existsSync(updates) ? updates : path
    }
    const sessionDir = this.sessionDirectory(path)
    if (!sessionDir) return null
    return this.transcriptPath(sessionDir)
  }

  observationPaths(path: string): string[] {
    return [path, join(dirname(path), "summary.json")]
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const name = basename(file.path)
    if (name !== TRANSCRIPT_UPDATES && name !== TRANSCRIPT_LEGACY) return null
    if (name === TRANSCRIPT_LEGACY) {
      const updates = await stat(
        join(dirname(file.path), TRANSCRIPT_UPDATES)
      ).catch(() => null)
      if (updates) return null
    }
    const raw = await readFile(
      join(dirname(file.path), "summary.json"),
      "utf8"
    ).catch(() => null)
    if (!raw) return null
    const summary = parseSummary(raw)
    if (!summary) return null
    if (isSubagentSession(summary, file.path)) return null
    let title = titleFrom(summary.title)
    let sawUser = false
    if (!title) {
      const into = createTranslator(file.path)()
      let spent = 0
      await readLines(file.path, 0, (line) => {
        spent += line.length + 1
        into.push(line)
        return spent < 8 * 1024 * 1024
      })
      for (const entry of into.done()) {
        if (entry.kind !== "user") continue
        sawUser = true
        title = titleFrom(entry.text)
        if (title) break
      }
    }
    // A directory written at session/new, with only hooks or a skills
    // reminder, is not a conversation yet. The row appears when the first
    // user turn or generated title lands.
    if (!title && !sawUser) return null
    return {
      harness: this.harness,
      nativeId: summary.id,
      path: file.path,
      cwd: summary.cwd,
      title,
      model: summary.model,
      settings: {
        model: summary.model,
        options: summary.effort ? { effort: summary.effort } : {},
      },
      startedAt: summary.createdAt,
      // The transcript moves only when the conversation does. summary.json's
      // `updated_at` is rewritten every minute by an open TUI and by title
      // generation, which once kept a day-old thread at the top of the rail.
      updatedAt: new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
    }
  }

  /**
   * Grok names the thread in `summary.json` while the transcript keeps
   * growing. Re-read that sidecar without walking the jsonl again.
   */
  async refine(ref: ThreadRef, _fromByte: number): Promise<ThreadRef> {
    const raw = await readFile(
      join(dirname(ref.path), "summary.json"),
      "utf8"
    ).catch(() => null)
    if (!raw) return ref
    const summary = parseSummary(raw)
    if (!summary) return ref
    return {
      ...ref,
      cwd: summary.cwd ?? ref.cwd,
      title: titleFrom(summary.title) ?? ref.title,
      model: summary.model ?? ref.model,
      settings: {
        model: summary.model ?? ref.settings?.model,
        options: summary.effort
          ? { effort: summary.effort }
          : (ref.settings?.options ?? {}),
      },
    }
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref = await this.peek({
      path,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
    })
    if (!ref) return null
    const into = createTranslator(path)()
    const checkpoint = await readLines(path, 0, into.push)
    return { ref, checkpoint, entries: into.done() }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, createTranslator(path))
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = createTranslator(path)()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }

  private sessionDirectory(path: string): string | null {
    const prefix = `${this.root}/`
    if (path === this.root || !path.startsWith(prefix)) return null
    const parts = path.slice(prefix.length).split("/")
    if (
      parts.length < 3 ||
      parts.some((part) => part === "" || part === "." || part === "..")
    )
      return null
    return join(this.root, parts[0]!, parts[1]!)
  }

  private transcriptPath(sessionDir: string): string | null {
    const updates = join(sessionDir, TRANSCRIPT_UPDATES)
    if (existsSync(updates)) return updates
    const history = join(sessionDir, TRANSCRIPT_LEGACY)
    return existsSync(history) ? history : null
  }
}

function createTranslator(path: string): () => GrokTranslator {
  return basename(path) === TRANSCRIPT_UPDATES
    ? updatesTranslator
    : legacyTranslator
}

function updatesTranslator(): GrokTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  let latestAssistant: AssistantEntry | null = null
  let user: UserEntry | null = null
  let userKey: string | undefined
  let plan: AssistantEntry | null = null
  const toolsById = new Map<string, GrokToolBlock>()
  let started = false
  let needsReset = false

  const flushAssistant = (): void => {
    if (assistant) sink.push(assistant)
    assistant = null
  }

  const ensureAssistant = (at?: string): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at, blocks: [] }
      latestAssistant = assistant
    }
    return assistant
  }

  const appendBlockText = (
    type: "text" | "thinking",
    text: string,
    at?: string
  ): void => {
    const entry = ensureAssistant(at)
    const last = entry.blocks.at(-1)
    if (last?.type === type) last.text += text
    else entry.blocks.push({ type, text })
  }

  const createTool = (
    id: string | undefined,
    name: string,
    input: string | undefined,
    at?: string
  ): GrokToolBlock => {
    const block: GrokToolBlock = { type: "tool", name, input }
    ensureAssistant(at).blocks.push(block)
    if (id) toolsById.set(id, block)
    return block
  }

  const push = (raw: string): void => {
    const event = parseUpdateLine(raw)
    if (!event) return

    if (event.sessionUpdate !== "user_message_chunk") user = null

    switch (event.sessionUpdate) {
      case "user_message_chunk": {
        if (user && userKey === event.promptKey) {
          user.text += event.text
          if (event.attachments?.length)
            user.attachments = [
              ...(user.attachments ?? []),
              ...event.attachments,
            ]
          return
        }
        flushAssistant()
        toolsById.clear()
        latestAssistant = null
        plan = null
        user = { kind: "user", at: event.at, text: event.text }
        if (event.attachments?.length) user.attachments = event.attachments
        userKey = event.promptKey
        started = true
        sink.push(user)
        return
      }
      case "agent_message_chunk":
        if (!started) needsReset = true
        started = true
        appendBlockText("text", event.text, event.at)
        if (event.attachments?.length)
          ensureAssistant(event.at).blocks.push(...event.attachments)
        return
      case "agent_thought_chunk":
        if (!started) needsReset = true
        started = true
        appendBlockText("thinking", event.text, event.at)
        return
      case "tool_call": {
        if (!started) needsReset = true
        started = true
        const block = createTool(
          event.toolCallId,
          event.name,
          event.input,
          event.at
        )
        if (event.details?.length) block.details = event.details
        if (event.attachments?.length) block.attachments = event.attachments
        if (event.output) block.output = event.output
        return
      }
      case "tool_call_update": {
        const block = event.toolCallId
          ? toolsById.get(event.toolCallId)
          : undefined
        if (!block) needsReset = true
        const target =
          block ??
          createTool(event.toolCallId, event.name, event.input, event.at)
        if (event.details?.length) target.details = event.details
        if (event.attachments?.length) target.attachments = event.attachments
        if (!target.input && event.input) target.input = event.input
        if (event.output) {
          const complete = event.status === "completed" || event.failed
          target.output = clip(
            complete ? event.output : `${target.output ?? ""}${event.output}`
          )
        }
        if (event.failed) target.error = true
        if (/cancel/i.test(event.status ?? "")) target.canceled = true
        return
      }
      case "plan": {
        const block: GrokToolBlock = {
          type: "tool",
          name: "Plan",
          output: "",
          details: [{ type: "plan", entries: event.entries }],
        }
        if (plan) {
          plan.at = event.at ?? plan.at
          plan.blocks = [block]
          return
        }
        flushAssistant()
        plan = { kind: "assistant", at: event.at, blocks: [block] }
        sink.push(plan)
        return
      }
      case "turn_completed": {
        const completedAssistant = assistant ?? latestAssistant
        if (completedAssistant && event.usage)
          completedAssistant.usage = event.usage
        flushAssistant()
        if (
          event.stopReason &&
          /cancel|interrupt|abort/i.test(event.stopReason)
        ) {
          sink.push({ kind: "event", at: event.at, label: "Interrupted" })
        }
        toolsById.clear()
        latestAssistant = null
        plan = null
        userKey = undefined
        return
      }
    }
  }

  const snapshot = (): ThreadEntry[] => {
    const entries = snapshotSink(sink)
    return assistant ? [...entries, assistant] : entries
  }

  const done = (): ThreadEntry[] => {
    flushAssistant()
    return snapshotSink(sink)
  }

  return {
    push,
    snapshot,
    done,
    commitBatch: flushAssistant,
    get needsReset() {
      return needsReset
    },
  }
}

function legacyTranslator(): GrokTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const toolsById = new Map<string, GrokToolBlock>()
  let started = false
  let needsReset = false

  const flushAssistant = (preserveTools = false): void => {
    if (assistant) sink.push(assistant)
    assistant = null
    if (!preserveTools) toolsById.clear()
  }

  const ensureAssistant = (): AssistantEntry => {
    if (!assistant) assistant = { kind: "assistant", blocks: [] }
    return assistant
  }

  const appendBlockText = (type: "text" | "thinking", text: string): void => {
    const entry = ensureAssistant()
    const last = entry.blocks.at(-1)
    if (last?.type === type) last.text += text
    else entry.blocks.push({ type, text })
  }

  const push = (raw: string): void => {
    const line = parseLegacyLine(raw)
    if (!line) return

    switch (line.type) {
      case "user": {
        const query = USER_QUERY.exec(line.text)
        const spoken = (query?.[1] ?? "").trim()
        if (!spoken) return
        flushAssistant()
        started = true
        sink.push({ kind: "user", text: spoken })
        return
      }
      case "reasoning":
        if (!started) needsReset = true
        started = true
        if (line.text.trim()) appendBlockText("thinking", line.text)
        return
      case "assistant": {
        if (!started) needsReset = true
        started = true
        if (line.text.trim()) appendBlockText("text", line.text)
        for (const call of line.calls) {
          const block: GrokToolBlock = {
            type: "tool",
            name: call.name,
            input: call.input,
          }
          ensureAssistant().blocks.push(block)
          if (call.id) toolsById.set(call.id, block)
        }
        return
      }
      case "tool_result": {
        const block = line.toolCallId
          ? toolsById.get(line.toolCallId)
          : undefined
        if (block) {
          block.output = clip(line.output)
          toolsById.delete(line.toolCallId ?? "")
        } else if (line.toolCallId) {
          needsReset = true
        }
        return
      }
    }
  }

  const snapshot = (): ThreadEntry[] => {
    const entries = snapshotSink(sink)
    return assistant ? [...entries, assistant] : entries
  }

  const done = (): ThreadEntry[] => {
    flushAssistant()
    return snapshotSink(sink)
  }

  return {
    push,
    snapshot,
    done,
    commitBatch: () => flushAssistant(true),
    get needsReset() {
      return needsReset
    },
  }
}
