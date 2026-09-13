import { existsSync } from "node:fs"
import {
  codexPrompt,
  codexPromptImages,
  codexPresentation,
} from "./codex-presentation.js"
import { codexPlanDetails } from "../tool-plan.js"
import { codexServiceTier } from "../model-catalog.js"
import type { SessionSettings } from "../settings.js"
import { attachmentFromUrl, type AttachmentContent } from "../content.js"
/**
 * Codex CLI sessions.
 *
 * Native store: `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`.
 * Each line is `{timestamp, type, payload}` where the interesting types are:
 *
 *   * `session_meta`   — id, cwd, CLI version; always the first line
 *   * `turn_context`   — per-turn model and effort
 *   * `response_item`  — the transcript proper, as OpenAI Responses items:
 *                        message / reasoning / function_call / function_call_output
 *   * `event_msg`      — streaming milestones; `user_message`,
 *                        `token_count` and `thread_settings_applied` (the
 *                        turn's model, effort and service tier — the only
 *                        record that carries the tier) are used here, the
 *                        rest are echoes of response items and are skipped
 *                        to avoid doubling
 *
 * User turns are read from `response_item` messages rather than `user_message`
 * events, because resumed sessions replay history only as response items —
 * but Codex also injects instructions and environment context as user-role
 * messages, so tag-wrapped injections are filtered out.
 */

import { homedir } from "node:os"
import { basename, join } from "node:path"
import { stat, rm } from "node:fs/promises"
import type { SQLOutputValue } from "node:sqlite"
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
  parseLine,
  readLines,
  snapshotSink,
  walkFiles,
  type LineTranslator,
} from "../jsonl.js"
import { normalizeToolOutput } from "../tool-output.js"
import type { NativeFile, SessionProvider } from "./types.js"

const MAX_TRANSLATED_BYTES = 64 * 1024 * 1024

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue | undefined
}

interface CodexRolloutBase {
  at?: string
}

interface CodexSessionMeta extends CodexRolloutBase {
  kind: "session_meta"
  id: string
  cwd?: string
  startedAt?: string
  threadSource?: string
}

interface CodexThreadMetadata {
  rolloutPath?: string
  title?: string
  cwd?: string
  updatedAt?: string
}

interface CodexPeekResult {
  ref: ThreadRef | null
}

interface CodexTurnContext extends CodexRolloutBase {
  kind: "turn_context"
  model?: string
  settings: SessionSettings
}

interface CodexUserMessageEvent extends CodexRolloutBase {
  kind: "user_message_event"
  text: string
}

interface CodexTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CodexTokenCountEvent extends CodexRolloutBase {
  kind: "token_count_event"
  usage?: CodexTokenUsage
}

interface CodexUserResponse extends CodexRolloutBase {
  id?: string
  attachments?: AttachmentContent[]
  kind: "user_response"
  text: string
}

interface CodexAssistantResponse extends CodexRolloutBase {
  id?: string
  attachments?: AttachmentContent[]
  kind: "assistant_response"
  text: string
}

interface CodexPlumbingResponse extends CodexRolloutBase {
  kind: "plumbing_response"
}

interface CodexReasoningResponse extends CodexRolloutBase {
  kind: "reasoning_response"
  text: string
}

interface CodexFunctionCallResponse extends CodexRolloutBase {
  kind: "function_call_response"
  callId?: string
  name: string
  input?: string
  output?: string
  error?: boolean
  canceled?: boolean
}

interface CodexToolCompletion {
  output?: string
  error?: boolean
  canceled?: boolean
}

interface CodexFunctionOutputResponse extends CodexRolloutBase {
  kind: "function_output_response"
  attachments?: AttachmentContent[]
  callId?: string
  output: string
}

interface CodexEventLine extends CodexRolloutBase {
  kind: "event"
  label: string
  detail?: string
}

interface CodexIgnoredRolloutLine extends CodexRolloutBase {
  kind: "ignored"
}

type CodexRolloutEvent =
  | CodexSessionMeta
  | CodexTurnContext
  | CodexUserMessageEvent
  | CodexTokenCountEvent
  | CodexUserResponse
  | CodexAssistantResponse
  | CodexPlumbingResponse
  | CodexReasoningResponse
  | CodexFunctionCallResponse
  | CodexFunctionOutputResponse
  | CodexEventLine
  | CodexIgnoredRolloutLine

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type ToolBlock = EntryBlock & { type: "tool" }

interface CodexTranslator extends LineTranslator {
  done(): ThreadEntry[]
  commitBatch(): void
  readonly needsReset: boolean
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
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

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function textOf(content: JsonValue | undefined): string {
  if (isString(content)) return content
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const value of content) {
    const part = objectValue(value)
    text += stringValue(part?.["text"]) ?? ""
  }
  return text
}

function encodedInput(input: JsonValue | undefined): string | undefined {
  if (input === undefined) return undefined
  return isString(input) ? input : JSON.stringify(input)
}

function completedTool(status: string | undefined): CodexToolCompletion {
  const normalized = status?.toLowerCase()
  if (
    ["completed", "complete", "done", "success", "succeeded"].includes(
      normalized ?? ""
    )
  )
    return { output: "" }
  if (["failed", "failure", "error", "errored"].includes(normalized ?? ""))
    return { output: "", error: true }
  if (
    ["canceled", "cancelled", "interrupted", "aborted"].includes(
      normalized ?? ""
    )
  )
    return { output: "", canceled: true }
  return {}
}

function outputText(output: JsonValue | undefined): string {
  const text = isString(output)
    ? output
    : (stringValue(objectValue(output)?.["content"]) ??
      JSON.stringify(output ?? "") ??
      "")
  return normalizeToolOutput(text)
}

function parseTokenUsage(payload: JsonObject): CodexTokenUsage | undefined {
  const info = objectValue(payload["info"])
  const usage = objectValue(info?.["last_token_usage"])
  if (!usage) return undefined
  return {
    input: Number(usage["input_tokens"] ?? 0),
    output: Number(usage["output_tokens"] ?? 0),
    cacheRead: Number(usage["cached_input_tokens"] ?? 0),
    cacheWrite: Number(usage["cache_write_input_tokens"] ?? 0),
  }
}

function parseResponseItem(
  payload: JsonObject,
  at: string | undefined
): CodexRolloutEvent {
  switch (stringValue(payload["type"])) {
    case "message": {
      const text = textOf(payload["content"])
      switch (stringValue(payload["role"])) {
        case "user":
          return {
            kind: "user_response",
            id: stringValue(payload["id"]),
            at,
            text,
            attachments: responseAttachments(payload["content"]),
          }
        case "assistant":
          return {
            kind: "assistant_response",
            id: stringValue(payload["id"]),
            at,
            text,
            attachments: responseAttachments(payload["content"]),
          }
        default:
          return { kind: "plumbing_response", at }
      }
    }
    case "reasoning":
      return {
        kind: "reasoning_response",
        at,
        text: textOf(payload["summary"]) || textOf(payload["content"]),
      }
    case "tool_search_call":
      return {
        kind: "function_call_response",
        at,
        callId: stringValue(payload["call_id"]) ?? stringValue(payload["id"]),
        name: "ToolSearch",
        input: encodedInput(payload["arguments"]),
        ...completedTool(stringValue(payload["status"])),
      }
    case "web_search_call":
      return {
        kind: "function_call_response",
        at,
        callId: stringValue(payload["call_id"]) ?? stringValue(payload["id"]),
        name: "web_search",
        input: encodedInput(payload["action"]),
        ...completedTool(stringValue(payload["status"])),
      }
    case "local_shell_call": {
      const action = objectValue(payload["action"])
      const command = action?.["command"]
      const text = Array.isArray(command)
        ? command.flatMap((part) => (isString(part) ? [part] : [])).join(" ")
        : stringValue(command)
      return {
        kind: "function_call_response",
        at,
        callId: stringValue(payload["call_id"]),
        name: "exec_command",
        input: text ? JSON.stringify({ command: text }) : undefined,
      }
    }
    case "function_call":
    case "custom_tool_call":
      return {
        kind: "function_call_response",
        at,
        callId: stringValue(payload["call_id"]),
        name: stringValue(payload["name"])?.trim() || "tool",
        input:
          stringValue(payload["arguments"]) ?? stringValue(payload["input"]),
      }
    case "function_call_output":
    case "custom_tool_call_output":
    case "tool_search_output":
    case "web_search_output":
      return {
        kind: "function_output_response",
        at,
        callId: stringValue(payload["call_id"]),
        output: outputText(payload["output"]),
        attachments: responseAttachments(payload["output"]),
      }
    default:
      return { kind: "ignored", at }
  }
}

/**
 * Each turn writes its settings twice: `thread_settings_applied` carries the
 * service tier, `turn_context` the effort. Both describe one turn, so they
 * fold together; a record naming another model starts over.
 */
function latestSettings(
  previous: SessionSettings | undefined,
  next: SessionSettings
): SessionSettings {
  if (!previous || (previous.model && next.model && previous.model !== next.model))
    return next
  const options = { ...previous.options, ...next.options }
  const settings: SessionSettings = {}
  const model = next.model ?? previous.model
  if (model) settings.model = model
  if (Object.keys(options).length) settings.options = options
  return settings
}

function parseCodexRolloutLine(raw: string): CodexRolloutEvent | null {
  const root = parseLine(raw)
  if (!root) return null
  const at = stringValue(root["timestamp"])
  const payload = objectValue(root["payload"])
  switch (stringValue(root["type"])) {
    case "session_meta":
      return {
        kind: "session_meta",
        at,
        id: String(payload?.["id"] ?? payload?.["session_id"] ?? ""),
        cwd: stringValue(payload?.["cwd"]),
        startedAt: stringValue(payload?.["timestamp"]),
        threadSource: stringValue(payload?.["thread_source"]),
      }
    case "turn_context": {
      const options: NonNullable<SessionSettings["options"]> = {}
      const effort = stringValue(payload?.["effort"])
      const serviceTier = stringValue(payload?.["service_tier"])
      if (effort) options.effort = effort
      if (serviceTier) options.serviceTier = codexServiceTier(serviceTier)
      return {
        kind: "turn_context",
        at,
        model: stringValue(payload?.["model"]),
        settings: { model: stringValue(payload?.["model"]), options },
      }
    }
    case "event_msg":
      if (!payload) return { kind: "ignored", at }
      switch (stringValue(payload["type"])) {
        case "thread_settings_applied": {
          // The thread's effective settings, written before each turn's
          // `turn_context`. Codex 0.147+ records the service tier only here.
          const applied = objectValue(payload["thread_settings"])
          const options: NonNullable<SessionSettings["options"]> = {}
          const effort = stringValue(applied?.["reasoning_effort"])
          const serviceTier = stringValue(applied?.["service_tier"])
          if (effort) options.effort = effort
          if (serviceTier) options.serviceTier = codexServiceTier(serviceTier)
          const model = stringValue(applied?.["model"])
          return {
            kind: "turn_context",
            at,
            model,
            settings: { model, options },
          }
        }
        case "user_message":
          return {
            kind: "user_message_event",
            at,
            text: String(payload["message"] ?? ""),
          }
        case "token_count":
          return {
            kind: "token_count_event",
            at,
            usage: parseTokenUsage(payload),
          }
        case "turn_aborted":
          return {
            kind: "event",
            at,
            label: "Interrupted",
            detail: stringValue(payload["reason"]),
          }
        case "context_compacted":
          return { kind: "event", at, label: "Context compacted" }
        default:
          return { kind: "ignored", at }
      }
    case "response_item":
      return payload ? parseResponseItem(payload, at) : { kind: "ignored", at }
    case undefined:
      return null
    default:
      return { kind: "ignored", at }
  }
}

function sqliteText(value: SQLOutputValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

function sqliteNumber(value: SQLOutputValue | undefined): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Number]")
    return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export class CodexProvider implements SessionProvider {
  harness = "codex" as const
  /** 1: the service tier is read from `thread_settings_applied`. */
  peekVersion = 1
  displayName = "Codex"
  private root: string
  private metadataPath: string
  private metadataMtime = -1
  private metadata = new Map<string, CodexThreadMetadata>()
  private metadataKnown = new Set<string>()
  private metadataLoads = new Map<
    string,
    Promise<CodexThreadMetadata | undefined>
  >()

  constructor(home = homedir()) {
    this.root = join(home, ".codex", "sessions")
    this.metadataPath = join(home, ".codex", "state_5.sqlite")
  }

  private async threadMetadata(
    id: string
  ): Promise<CodexThreadMetadata | undefined> {
    const [info, wal] = await Promise.all([
      stat(this.metadataPath).catch(() => null),
      stat(`${this.metadataPath}-wal`).catch(() => null),
    ])
    if (!info) return undefined
    const mtime = Math.max(info.mtimeMs, wal?.mtimeMs ?? 0)
    if (mtime !== this.metadataMtime) {
      this.metadata.clear()
      this.metadataKnown.clear()
      this.metadataLoads.clear()
      this.metadataMtime = mtime
    }
    if (this.metadataKnown.has(id)) return this.metadata.get(id)
    const existing = this.metadataLoads.get(id)
    if (existing) return existing
    const load = (async () => {
      const sqlite = await import("node:sqlite").catch(() => null)
      if (!sqlite) return undefined
      const database = new sqlite.DatabaseSync(this.metadataPath, {
        readOnly: true,
      })
      try {
        const row = database
          .prepare(
            "SELECT id, name, title, cwd, updated_at_ms, rollout_path FROM threads WHERE id = ? AND (thread_source IS NULL OR thread_source != 'subagent')"
          )
          .get(id)
        if (this.metadataMtime !== mtime) return this.metadata.get(id)
        this.metadataKnown.add(id)
        if (!row) return undefined
        const updatedAtMs = sqliteNumber(row.updated_at_ms)
        const storedTitle = sqliteText(row.title)
        const conciseTitle =
          storedTitle && !storedTitle.includes("\n") && storedTitle.length <= 80
            ? titleFrom(storedTitle)
            : undefined
        const metadata = {
          rolloutPath: sqliteText(row.rollout_path),
          title: titleFrom(sqliteText(row.name)) ?? conciseTitle,
          cwd: sqliteText(row.cwd),
          updatedAt: updatedAtMs
            ? new Date(updatedAtMs).toISOString()
            : undefined,
        }
        this.metadata.set(id, metadata)
        return metadata
      } catch {
        return undefined
      } finally {
        database.close()
      }
    })().finally(() => {
      if (this.metadataLoads.get(id) === load) this.metadataLoads.delete(id)
    })
    this.metadataLoads.set(id, load)
    return load
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const paths = await walkFiles(this.root, (name) => name.endsWith(".jsonl"))
    const byIdentity = new Map<string, NativeFile[]>()
    for (let index = 0; index < paths.length; index += 8) {
      const batch = await Promise.all(
        paths.slice(index, index + 8).map(async (path) => {
          const info = await stat(path).catch(() => null)
          return info ? { path, bytes: info.size, mtimeMs: info.mtimeMs } : null
        })
      )
      for (const file of batch) {
        if (!file) continue
        // A resumed thread continues in `<id>_<suffix>.jsonl` with the same
        // session id; the first id names the thread and the group below picks
        // Codex's current file for it.
        const id =
          basename(file.path).match(
            /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i
          )?.[0] ?? file.path
        const group = byIdentity.get(id) ?? []
        group.push(file)
        byIdentity.set(id, group)
      }
    }
    const groups = [...byIdentity]
    const files: NativeFile[] = []
    for (let index = 0; index < groups.length; index += 8) {
      const batch = await Promise.all(
        groups.slice(index, index + 8).map(async ([id, candidates]) => {
          // Codex changes rollout paths when resuming. Its current path is authoritative;
          // display timestamps are shared across aliases and cannot choose a transcript.
          const current =
            candidates.length > 1
              ? (await this.threadMetadata(id))?.rolloutPath
              : undefined
          return (
            candidates.find((file) => file.path === current) ??
            candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
          )
        })
      )
      for (const file of batch) if (file) files.push(file)
    }
    return files
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const budget = 8 * 1024 * 1024
    let spent = 0
    let sawMeta = false
    const found: CodexPeekResult = { ref: null }
    await readLines(file.path, 0, (raw) => {
      spent += raw.length + 1
      const event = parseCodexRolloutLine(raw)
      if (!event) return spent < budget
      if (event.kind === "session_meta") {
        if (sawMeta) return spent < budget
        sawMeta = true
        if (!event.id || event.threadSource === "subagent") return false
        found.ref = {
          harness: this.harness,
          nativeId: event.id,
          path: file.path,
          cwd: event.cwd,
          startedAt: event.startedAt ?? event.at,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          bytes: file.bytes,
        }
        return spent < budget
      }
      if (!sawMeta) return false // Not a rollout file at all.
      const ref = found.ref
      if (!ref) return spent < budget
      if (event.kind === "turn_context" && !ref.model && event.model) {
        ref.model = event.model
      }
      if (
        !ref.title &&
        (event.kind === "user_message_event" || event.kind === "user_response")
      ) {
        ref.title = titleFrom(codexPrompt(event.text))
      }
      return spent < budget && !(ref.title && ref.model)
    })
    const ref = found.ref
    if (!ref) return null
    // Head metadata identifies the thread. Only the bounded tail describes its latest settings.
    ref.settings = {}
    await readLines(
      file.path,
      Math.max(0, file.bytes - 2 * 1024 * 1024),
      (raw) => {
        const event = parseCodexRolloutLine(raw)
        if (event?.kind === "turn_context") {
          ref.settings = latestSettings(ref.settings, event.settings)
          if (event.model) ref.model = event.model
        }
      }
    )
    const details = await this.threadMetadata(ref.nativeId)
    return details
      ? {
          ...ref,
          cwd: details.cwd ?? ref.cwd,
          title: details.title ?? ref.title,
          updatedAt:
            details.updatedAt && details.updatedAt > (ref.updatedAt ?? "")
              ? details.updatedAt
              : ref.updatedAt,
        }
      : ref
  }

  /**
   * Remove a thread: its rollout file, any resumed rollout for the same id,
   * and its row in the state database. Subagent rollouts named after it go
   * too; they have no life without their parent.
   */
  async remove(path: string): Promise<boolean> {
    if (!path.startsWith(`${this.root}/`)) return false
    const id = basename(path).match(
      /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i
    )?.[0]
    if (!id) return false
    const files = (await walkFiles(this.root, (name) => name.endsWith(".jsonl"))).filter(
      (candidate) => basename(candidate).includes(id)
    )
    for (const file of files) await rm(file, { force: true })
    const sqlite = await import("node:sqlite").catch(() => null)
    if (sqlite && existsSync(this.metadataPath)) {
      const database = new sqlite.DatabaseSync(this.metadataPath)
      try {
        database.prepare("DELETE FROM threads WHERE id = ?").run(id)
      } finally {
        database.close()
      }
    }
    this.metadata.delete(id)
    this.metadataKnown.delete(id)
    return true
  }

  /** Codex names a thread in its state database after the first turn; pick that up without rereading the rollout. */
  async refine(ref: ThreadRef, _fromByte: number): Promise<ThreadRef> {
    const details = await this.threadMetadata(ref.nativeId)
    if (!details) return ref
    return {
      ...ref,
      cwd: details.cwd ?? ref.cwd,
      title: details.title ?? ref.title,
      updatedAt:
        details.updatedAt && details.updatedAt > (ref.updatedAt ?? "")
          ? details.updatedAt
          : ref.updatedAt,
    }
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const native: NativeFile = { path, bytes: file.size, mtimeMs: file.mtimeMs }
    const ref = await this.peek(native)
    if (!ref) return null
    const into = translator()
    const fromByte = Math.max(0, file.size - MAX_TRANSLATED_BYTES)
    const checkpoint = await readLines(path, fromByte, into.push)
    const entries = into.done()
    if (fromByte > 0) {
      entries.unshift({
        kind: "event",
        label: "Earlier history not shown",
        detail: `The most recent ${MAX_TRANSLATED_BYTES / 1024 / 1024} MB is shown; earlier history remains in the native session file`,
      })
    }
    return { ref, checkpoint, entries }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, translator)
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }
}

/**
 * Turn raw rollout lines into canonical entries, one line at a time.
 *
 * Function calls and their outputs are paired by `call_id` and merged into a
 * single tool block on the current assistant turn. A `token_count` event
 * closes over the most recent assistant entry, which is the turn it priced.
 * Push-based so a gigabyte session streams through without ever being held.
 */
function translator(): CodexTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const callsById = new Map<string, ToolBlock>()
  let started = false
  let needsReset = false
  let model: string | undefined

  const openAssistant = (at?: string): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at, model, blocks: [] }
      sink.push(assistant)
    }
    return assistant
  }

  const push = (raw: string): void => {
    const event = parseCodexRolloutLine(raw)
    if (!event) return

    switch (event.kind) {
      case "turn_context":
        if (event.model) model = event.model
        return
      case "token_count_event":
        if (event.usage && assistant) {
          const usage: TurnUsage = {
            input: event.usage.input,
            output: event.usage.output,
            cacheRead: event.usage.cacheRead,
            cacheWrite: event.usage.cacheWrite,
          }
          assistant.usage = usage
        }
        return
      case "user_response": {
        const text = codexPrompt(event.text)
        const attachments = event.attachments?.length
          ? event.attachments
          : codexPromptImages(event.text)
        if (!text && !attachments.length) return
        assistant = null
        started = true
        sink.push({
          kind: "user",
          id: event.id,
          at: event.at,
          text: text ?? "",
          attachments,
        })
        return
      }
      case "assistant_response":
        if (!event.text && !event.attachments?.length) return
        if (!started) needsReset = true
        started = true
        if (event.id && assistant?.id !== event.id) assistant = null
        openAssistant(event.at).id = event.id
        if (event.text)
          openAssistant(event.at).blocks.push({
            type: "text",
            text: codexPresentation(event.text),
          })
        openAssistant(event.at).blocks.push(...(event.attachments ?? []))
        return
      case "reasoning_response":
        if (!event.text.trim()) return
        if (!started) needsReset = true
        started = true
        openAssistant(event.at).blocks.push({
          type: "thinking",
          text: codexPresentation(event.text),
        })
        return
      case "function_call_response": {
        if (!started) needsReset = true
        started = true
        const block: ToolBlock = {
          type: "tool",
          id: event.callId,
          name: event.name,
          input: clip(event.input),
        }
        if (
          event.name === "update_plan" ||
          event.name === "functions.update_plan"
        )
          block.details = codexPlanDetails(block.input)
        if (event.output !== undefined) block.output = event.output
        if (event.error) block.error = true
        if (event.canceled) block.canceled = true
        if (event.callId) callsById.set(event.callId, block)
        openAssistant(event.at).blocks.push(block)
        return
      }
      case "function_output_response": {
        const id = event.callId ?? ""
        const block = callsById.get(id)
        if (block) {
          block.output = clip(event.output)
          if (block && event.attachments?.length)
            block.attachments = event.attachments
          callsById.delete(id)
        } else if (id) {
          needsReset = true
        }
        return
      }
      case "event":
        assistant = null
        callsById.clear()
        const item: Extract<ThreadEntry, { kind: "event" }> = {
          kind: "event",
          label: event.label,
        }
        if (event.at) item.at = event.at
        if (event.detail) item.detail = event.detail
        sink.push(item)
        return
      case "session_meta":
      case "user_message_event":
      case "plumbing_response":
      case "ignored":
        return
    }
  }

  return {
    push,
    snapshot: () => snapshotSink(sink),
    done: () => snapshotSink(sink),
    commitBatch: () => {
      assistant = null
    },
    get needsReset() {
      return needsReset
    },
  }
}

function responseAttachments(
  content: JsonValue | undefined
): AttachmentContent[] {
  if (!Array.isArray(content)) return []
  const attachments: AttachmentContent[] = []
  for (const value of content) {
    const part = objectValue(value)
    if (!part) continue
    const type = stringValue(part["type"]) ?? ""
    if (!/image|audio|file/.test(type)) continue
    const name = stringValue(part["filename"]) ?? type.replaceAll("_", " ")
    const mimeType =
      stringValue(part["mime_type"]) ??
      (type.includes("image")
        ? "image/png"
        : type.includes("audio")
          ? "audio/wav"
          : "application/octet-stream")
    const url =
      stringValue(part["audio_url"]) ??
      stringValue(part["image_url"]) ??
      stringValue(part["url"]) ??
      stringValue(part["file_url"])
    const path = stringValue(part["path"])
    attachments.push(
      url
        ? attachmentFromUrl(name, mimeType, url)
        : {
            type: "attachment",
            name,
            mimeType,
            source: path
              ? { kind: "file", path }
              : {
                  kind: "unavailable",
                  reason:
                    "The provider did not retain attachment bytes or a readable URL",
                },
          }
    )
  }
  return attachments
}
