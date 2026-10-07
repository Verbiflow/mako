import { readPromptAttachments, legacyTextAttachment, type PromptAttachmentProjection } from "../prompt-attachments.js"
import {
  claudeCommandPrompt,
  claudeInterrupted,
} from "./claude-presentation.js"
import {
  claudeCompactSummary,
  claudeLocalCommand,
} from "./claude-events.js"
import {
  compactionEvent,
  event,
  messageEvent,
  modelChangedEvent,
  turnFailedEvent,
  type Compaction,
  type TranscriptEvent,
} from "../events.js"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { claudeAttachment, ClaudeProjection } from "../claude-projection.js"
import { claudeTokens, ClaudeUsage } from "../harnesses/claude.js"
import type { HarnessTokens } from "../harnesses/tokens.js"
import type { AttachmentContent } from "../content.js"
import { reduceLiveUpdates, type LiveBlock } from "../live-content.js"
import { liveEvent, liveToolEntry } from "../live-entries.js"
/**
 * Claude Code sessions.
 *
 * Native store: `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`. Lines
 * are heterogeneous: `user` / `assistant` carry the conversation as
 * Anthropic-format messages; `summary`, `file-history-snapshot`, mode records
 * and hook records are bookkeeping. Tool use pairs an assistant `tool_use`
 * block with a later user-role `tool_result` block by id. Subagent traffic is
 * marked `isSidechain` and is skipped — a sidechain is the agent's internal
 * conversation, not the user's.
 */

import { homedir } from "node:os"
import { existsSync, realpathSync } from "node:fs"
import { claudeTranscriptRoots } from "./claude-location.js"
import { stat, rm } from "node:fs/promises"
import {
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import {
  createJsonlFollower,
  parseLine,
  readHead,
  readLines,
  walkFiles,
  type LineTranslator,
} from "../jsonl.js"
import { PROVIDER_TURN_FALLBACK } from "../provider-turn.js"
import type { SessionSettings } from "../settings.js"
import type { NativeFile, SessionProvider } from "./types.js"
import { followCurrentCwd } from "./current-cwd.js"

type ClaudeJsonScalar = boolean | number | string | null
type ClaudeJsonValue = ClaudeJsonScalar | ClaudeJsonObject | ClaudeJsonValue[]

interface ClaudeJsonObject {
  [key: string]: ClaudeJsonValue | undefined
}

interface ClaudeTextContent {
  type: "text"
  text?: string
}

interface ClaudeToolResultContent {
  type: "tool_result"
  toolUseId: string
}

interface ClaudeOtherContent {
  type: "other"
}

/** The API answered on another model than the one asked (a refusal's fallback). */
interface ClaudeFallbackContent {
  type: "fallback"
  from?: string
  to?: string
}

type ClaudeContentBlock =
  | ClaudeTextContent
  | ClaudeToolResultContent
  | ClaudeFallbackContent
  | ClaudeOtherContent
  | { type: "attachment"; value: AttachmentContent }
type ClaudeContent = string | ClaudeContentBlock[]

interface SavedUsage extends HarnessTokens {
  speed?: string
}

interface ClaudeMessage {
  /** The API message; Claude Code writes each of its content blocks as its own line, all with this id. */
  id?: string
  role?: string
  model?: string
  content?: ClaudeContent
  usage?: SavedUsage
  /** `tool_use` while the turn waits on a call, `end_turn` once it answered. */
  stopReason?: string
}

interface ClaudeLine {
  effort?: string
  type: string
  /** A title Claude Code wrote for the session, rewritten as it evolves. */
  title?: string
  /** The name `/rename` gave the session. It outranks Claude Code's own. */
  customTitle?: string
  uuid?: string
  timestamp?: string
  sessionId?: string
  /** The session a `--fork-session` copy of this line came from. */
  forkedFrom?: string
  cwd?: string
  isSidechain: boolean
  isMeta: boolean
  isCompactSummary: boolean
  isAbortedMidStream: boolean
  message?: ClaudeMessage
  /** The message as saved, which `savedMessage` screens for the shared decoder. */
  saved?: ClaudeJsonObject
  subtype?: string
  requestId?: string
  /** The `error` of a message Claude Code composed to report an API failure. */
  apiError?: string
  /** A `system` record's own fields. */
  system?: ClaudeJsonObject
  /** An `attachment` record's attachment. */
  attachment?: ClaudeJsonObject
}

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type UserEntry = Extract<ThreadEntry, { kind: "user" }>
type EventEntry = Extract<ThreadEntry, { kind: "event" }>
type ClaudeToolBlock = EntryBlock & { type: "tool" }

interface ClaudeTranslator extends LineTranslator {
  done(): ThreadEntry[]
}

/** Text a user line starts with when the harness, not the user, wrote it. */
const NOT_A_PROMPT =
  /^(?:<(?:command-name|command-message|local-command|system-reminder|task-notification)|Caveat: )/

/**
 * Claude Code writes a `<task-notification>` user line (origin
 * `task-notification`) when a background command or agent settles, and runs a
 * turn on it when nothing else is queued. Its summary is the turn's cause.
 */
function taskNotificationLabel(text: string): string | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("<task-notification>")) return undefined
  const summary = /<summary>([\s\S]*?)<\/summary>/
    .exec(trimmed)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
  return summary ? summary.slice(0, 500) : PROVIDER_TURN_FALLBACK
}

function isString(value: ClaudeJsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonObject(
  value: ClaudeJsonValue | undefined
): value is ClaudeJsonObject {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function stringValue(value: ClaudeJsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: ClaudeJsonValue | undefined): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined
}

/** Claude's own words on a refusal, then the API's explanation when it gave one. */
function refusalText(record: ClaudeJsonObject): string | undefined {
  return (
    [
      stringValue(record["content"]),
      stringValue(record["apiRefusalExplanation"]),
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
  )
}

const SourceSchema = z.object({ type: z.string(), media_type: z.string().optional(), data: z.string().optional(), url: z.string().optional(), text: z.string().optional() })
const AttachmentBlockSchema = z.object({ type: z.enum(["image", "document"]), title: z.string().nullish(), source: SourceSchema })
const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() })
const Dropped = z.unknown().transform(() => null)
/** The reply blocks `ClaudeProjection` decodes, with every field it reads of each; others are left out. */
const ReplyContentSchema = z.array(z.union([
  TextBlockSchema,
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string().transform((name) => name.trim() || "tool"), input: z.unknown() }),
  Dropped,
])).transform((blocks) => blocks.filter((block) => block !== null))
/** A user line's tool results, which `ClaudeProjection` decodes into their calls. */
const ResultContentSchema = z.array(z.union([
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    is_error: z.boolean().optional(),
    content: z.union([
      z.string(),
      z.array(z.union([TextBlockSchema, AttachmentBlockSchema, Dropped])).transform((parts) => parts.filter((part) => part !== null)),
    ]).optional(),
  }),
  Dropped,
])).transform((blocks) => blocks.filter((block) => block !== null))

/**
 * A transcript line as the SDK message it saved, for the decoder the live
 * session runs: Claude Code writes the SDK's assistant and user messages
 * to its transcript, one content block a line.
 */
function savedMessage(line: ClaudeLine): SDKMessage | undefined {
  const saved = line.saved
  if (!saved || !line.uuid) return undefined
  const base = { uuid: line.uuid, session_id: line.sessionId ?? "", parent_tool_use_id: null }
  if (line.type === "assistant") {
    const content = ReplyContentSchema.safeParse(saved["content"])
    if (!content.success) return undefined
    const message = { ...base, type: "assistant", message: { id: stringValue(saved["id"]) ?? line.uuid, model: stringValue(saved["model"]) ?? "", content: content.data }, ...line.apiError !== undefined && { error: line.apiError } }
    // SAFETY: the screen kept every field `ClaudeProjection` reads of an assistant message, and only blocks it decodes.
    return message as SDKMessage
  }
  const content = ResultContentSchema.safeParse(saved["content"])
  if (!content.success) return undefined
  const message = { ...base, type: "user", message: { role: "user", content: content.data } }
  // SAFETY: the screen kept every field `ClaudeProjection` reads of a user message, and only its tool results.
  return message as SDKMessage
}

function parseContentBlock(value: ClaudeJsonValue): ClaudeContentBlock {
  if (!isJsonObject(value)) return { type: "other" }
  switch (stringValue(value["type"])) {
    case "image":
    case "document": {
      const block = AttachmentBlockSchema.safeParse(value)
      return block.success ? { type: "attachment", value: claudeAttachment(block.data) } : { type: "other" }
    }
    case "text":
      return { type: "text", text: stringValue(value["text"]) }
    case "tool_result":
      return { type: "tool_result", toolUseId: stringValue(value["tool_use_id"]) ?? "" }
    case "fallback":
      return {
        type: "fallback",
        from: modelName(value["from"]),
        to: modelName(value["to"]),
      }
    default:
      return { type: "other" }
  }
}

function modelName(value: ClaudeJsonValue | undefined): string | undefined {
  return isJsonObject(value) ? stringValue(value["model"]) : undefined
}

function parseContent(
  value: ClaudeJsonValue | undefined
): ClaudeContent | undefined {
  if (isString(value)) return value
  if (!Array.isArray(value)) return undefined
  return value.map(parseContentBlock)
}

function parseUsage(
  value: ClaudeJsonValue | undefined
): SavedUsage | undefined {
  if (!isJsonObject(value)) return undefined
  const usage = ClaudeUsage.parse(value)
  return usage.speed ? { speed: usage.speed, ...claudeTokens(usage) } : claudeTokens(usage)
}

function parseMessage(
  value: ClaudeJsonValue | undefined
): ClaudeMessage | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    id: stringValue(value["id"]),
    role: stringValue(value["role"]),
    model: stringValue(value["model"]),
    content: parseContent(value["content"]),
    usage: parseUsage(value["usage"]),
    stopReason: stringValue(value["stop_reason"]),
  }
}

function parseClaudeLine(raw: string): ClaudeLine | null {
  const root = parseLine(raw)
  if (!root) return null
  const type = stringValue(root["type"])
  if (!type) return null
  return {
    type,
    title: stringValue(root["aiTitle"]) ?? stringValue(root["summary"]),
    customTitle:
      type === "custom-title" ? stringValue(root["customTitle"]) : undefined,
    effort: stringValue(root["effort"]),
    uuid: stringValue(root["uuid"]),
    timestamp: stringValue(root["timestamp"]),
    sessionId: stringValue(root["sessionId"]),
    forkedFrom: forkedFromSession(root["forkedFrom"]),
    cwd: stringValue(root["cwd"]),
    isSidechain: root["isSidechain"] === true,
    isMeta: root["isMeta"] === true,
    isCompactSummary: root["isCompactSummary"] === true,
    isAbortedMidStream: root["isAbortedMidStream"] === true,
    message: parseMessage(root["message"]),
    saved: isJsonObject(root["message"]) ? root["message"] : undefined,
    subtype: stringValue(root["subtype"]),
    requestId: stringValue(root["requestId"]),
    apiError:
      root["isApiErrorMessage"] === true
        ? (stringValue(root["error"]) ?? "unknown")
        : undefined,
    system: type === "system" ? root : undefined,
    attachment:
      type === "attachment" && isJsonObject(root["attachment"])
        ? root["attachment"]
        : undefined,
  }
}

function forkedFromSession(
  value: ClaudeJsonValue | undefined
): string | undefined {
  return isJsonObject(value) ? stringValue(value["sessionId"]) : undefined
}

function plainText(content: ClaudeContent | undefined): string {
  if (!Array.isArray(content)) return content ?? ""
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("")
}

/** Native user parts keep staged files separate from authored text and tool results. */
function userContent(content: ClaudeContent | undefined): PromptAttachmentProjection {
  if (!Array.isArray(content)) return readPromptAttachments(content ?? "")
  const texts: string[] = []
  const attachments = attachmentParts(content)
  let seenText = false
  for (const part of content) {
    if (part.type !== "text") continue
    const text = part.text ?? ""
    const legacy = seenText ? legacyTextAttachment(text) : undefined
    seenText = true
    if (legacy) { attachments.push(legacy); continue }
    const projected = readPromptAttachments(text)
    texts.push(projected.text)
    attachments.push(...projected.attachments)
  }
  return { text: texts.join(""), attachments }
}

export class ClaudeProvider implements SessionProvider {
  harness = "claude" as const
  displayName = "Claude Code"
  /**
   * Claude Code touches a session file for reasons that are not a
   * conversation: a `last-prompt` bookkeeping line when the CLI exits, a
   * `cost-state` line, an `ai-title` rewrite. The file's mtime is therefore
   * not when the thread was last used; its newest message is.
   */
  activityFromContent = true
  /** 2: rows carry `currentCwd` (EnterWorktree, or the shell changing folder), one folder's two spellings counted as one. */
  peekVersion = 2
  private home: string
  private extraRoots: { at: number; root: string; value: string[] } | null = null

  constructor(home = homedir()) {
    this.home = home
  }

  /**
   * `claudeTranscriptRoots`, each folder once. Cached briefly: roots() is
   * called on every watch and scan setup, and the declared ones are read
   * from a file.
   */
  roots(): string[] {
    if (this.extraRoots && Date.now() - this.extraRoots.at < 60_000) {
      return [this.extraRoots.root, ...this.extraRoots.value]
    }
    const [root, ...declared] = claudeTranscriptRoots(this.home)
    const extras: string[] = []
    // Identity is the *real* path: account homes symlink their projects dir
    // straight back at ~/.claude/projects, and scanning the same store
    // through several names lists every session several times.
    const seen = new Set<string>()
    const realOf = (dir: string): string => {
      try {
        return realpathSync(dir)
      } catch {
        return dir
      }
    }
    if (existsSync(root)) seen.add(realOf(root))
    for (const dir of declared) {
      if (!existsSync(dir)) continue
      const real = realOf(dir)
      if (seen.has(real)) continue
      seen.add(real)
      extras.push(real)
    }
    this.extraRoots = { at: Date.now(), root, value: extras }
    return [root, ...extras]
  }

  async discover(): Promise<NativeFile[]> {
    const paths = (
      await Promise.all(
        this.roots().map((root) =>
          walkFiles(root, (name) => name.endsWith(".jsonl"), 2)
        )
      )
    ).flat()
    const files = await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await stat(path)
          return { path, bytes: info.size, mtimeMs: info.mtimeMs }
        } catch {
          return null
        }
      })
    )
    return files.filter((file): file is NativeFile => file !== null)
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const head = await readHead(file.path, 262_144)
    const ref: ThreadRef = {
      harness: this.harness,
      nativeId: "",
      path: file.path,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
    }
    let spoke = false
    for (const raw of head.split("\n")) {
      const line = parseClaudeLine(raw)
      if (!line) continue
      fillClaudeRef(ref, line)
      spoke ||= line.type === "user" || line.type === "assistant"
      if (ref.nativeId && ref.model) break
    }
    ref.settings = {}
    let lastMessageAt: string | undefined
    await readLines(
      file.path,
      Math.max(0, file.bytes - 2 * 1024 * 1024),
      (raw) => {
        const line = parseClaudeLine(raw)
        if (line) fillClaudeRef(ref, line)
        spoke ||= line?.type === "user" || line?.type === "assistant"
        lastMessageAt = newerMessageTimestamp(lastMessageAt, line)
        const model = line ? sessionModel(line) : undefined
        if (line && model) {
          ref.model = model
          const options: NonNullable<SessionSettings["options"]> = {}
          if (line.effort) options.effort = line.effort
          if (line.message?.usage?.speed === "standard") options.fast = false
          if (line.message?.usage?.speed === "fast") options.fast = true
          ref.settings = { model, options }
        }
      }
    )
    // The tail is where the newest messages are; a file whose tail holds no
    // message at all keeps the file's own time rather than claiming none.
    if (lastMessageAt !== undefined) ref.updatedAt = lastMessageAt
    // A session file with no session id yet is a placeholder, not a session.
    // So is one holding only the records Claude Code writes before the first
    // message (queued prompts, worktree state): it hasn't said where it runs,
    // and listed now it would file under no project until its next write.
    return ref.nativeId && (ref.cwd || spoke) ? ref : null
  }

  /** Remove a session file; Claude Code keeps no index that names it. */
  async remove(path: string): Promise<boolean> {
    if (
      !this.roots().some((root) => path.startsWith(`${root}/`)) ||
      !path.endsWith(".jsonl")
    )
      return false
    await rm(path, { force: true })
    return true
  }

  /**
   * Claude Code appends its own `ai-title` (once `summary`) line after the
   * conversation has moved on. Only the appended bytes can carry a new one,
   * and a later settings line there moves the row's model with it. The row's
   * time moves only when those bytes hold a message; an exit-time
   * `last-prompt` or `cost-state` record leaves it where it was.
   */
  async refine(ref: ThreadRef, fromByte: number): Promise<ThreadRef> {
    const next: ThreadRef = { ...ref }
    let lastMessageAt: string | undefined
    let named = false
    let written: string | undefined
    await readLines(ref.path, fromByte, (raw) => {
      const line = parseClaudeLine(raw)
      if (!line || line.isSidechain) return
      lastMessageAt = newerMessageTimestamp(lastMessageAt, line)
      if (line.customTitle?.trim()) {
        next.title = titleFrom(line.customTitle) ?? next.title
        named = true
      } else if (
        line.title?.trim() &&
        (line.type === "ai-title" || line.type === "summary")
      ) {
        written = line.title
      }
      const model = sessionModel(line)
      if (model) next.model = model
      followCurrentCwd(next, line.cwd)
    })
    // Claude Code writes the `/rename` name again just before each title of
    // its own, so a renamed session's is in the bytes right before this one.
    if (written && !named && !(await renamedBefore(ref.path, fromByte)))
      next.title = titleFrom(written) ?? next.title
    if (lastMessageAt !== undefined && lastMessageAt > (next.updatedAt ?? ""))
      next.updatedAt = lastMessageAt
    return next
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
    const into = translator()
    const checkpoint = await readLines(path, 0, into.push)
    return { ref, checkpoint, entries: into.done() }
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

function translator(): ClaudeTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const projection = new ClaudeProjection()
  /** Calls waiting on their result: the decoded call, and the saved block and entry its result completes. */
  const tools = new Map<string, { live: Extract<LiveBlock, { type: "tool" }>; block: ClaudeToolBlock; entry: AssistantEntry }>()
  let started = false
  let needsReset = false
  /** The prompt that opened the running turn; a prompt Claude folds into the turn steers it. */
  let opener: string | undefined
  /**
   * Claude's last reply asked for a tool, so its turn runs on: Claude Code
   * 2.1.283 saves a message steered in then as a plain prompt after the
   * call's result, where a prompt after an answered turn opens the next.
   */
  let running = false
  /** The latest boundary's marker, which the summary written after it completes. */
  let compaction: { entry: EventEntry; kept: Compaction } | null = null
  /** The latest terminal slash command's marker, which the output written after it completes. */
  let command: { entry: EventEntry; name: string } | null = null
  /** Fallback markers by API request: the reply's `fallback` block and Claude's notice after it are one change. */
  const fallbacks = new Map<string, EventEntry>()
  /**
   * The entry carrying each API call's usage. Every line of a reply repeats
   * it, the later ones with more output streamed, so one entry holds the
   * latest reading and the call counts once.
   */
  const spent = new Map<string, AssistantEntry>()

  const mark = (
    marker: TranscriptEvent,
    at: string | undefined,
    id?: string
  ): EventEntry => {
    const entry: EventEntry = { kind: "event", at, ...marker }
    if (id) {
      entry.id = id
      entry.source = { harness: "claude", record: id }
    }
    sink.push(entry)
    assistant = null
    return entry
  }
  const conversing = (): void => {
    compaction = null
    command = null
  }

  const system = (line: ClaudeLine, record: ClaudeJsonObject): void => {
    switch (line.subtype) {
      case "compact_boundary": {
        const metadata = isJsonObject(record["compactMetadata"])
          ? record["compactMetadata"]
          : {}
        const trigger = metadata["trigger"]
        const kept: Compaction = {
          trigger:
            trigger === "auto"
              ? "automatic"
              : trigger === "manual"
                ? "manual"
                : undefined,
          tokensBefore: numberValue(metadata["preTokens"]),
          tokensAfter: numberValue(metadata["postTokens"]),
          durationMs: numberValue(metadata["durationMs"]),
        }
        compaction = {
          entry: mark(compactionEvent(kept), line.timestamp, line.uuid),
          kept,
        }
        return
      }
      case "model_refusal_fallback": {
        const from = stringValue(record["originalModel"])
        const to = stringValue(record["fallbackModel"])
        if (!from || !to) return
        const marker = modelChangedEvent(
          from,
          to,
          record["scope"] === "local"
            ? "for one reply after a refusal"
            : "after a refusal",
          refusalText(record)
        )
        const earlier = line.requestId
          ? fallbacks.get(line.requestId)
          : undefined
        if (earlier) {
          Object.assign(earlier, marker)
          sink.edited(earlier)
        } else mark(marker, line.timestamp, line.uuid)
        return
      }
      case "model_refusal_no_fallback":
        mark(
          turnFailedEvent(
            `${stringValue(record["originalModel"]) ?? "The model"} declined the request`,
            refusalText(record)
          ),
          line.timestamp,
          line.uuid
        )
        return
      case "local_command": {
        const local = claudeLocalCommand(stringValue(record["content"]) ?? "")
        if (local.kind === "command") {
          command = {
            entry: mark(
              event("Notice", local.command),
              line.timestamp,
              line.uuid
            ),
            name: local.command,
          }
          return
        }
        if (!local.output) return
        const printed = messageEvent(
          "Notice",
          command ? `${command.name} · ${local.output}` : local.output
        )
        const marker: TranscriptEvent = local.failed
          ? { ...printed, tone: "warning" }
          : printed
        if (command) {
          Object.assign(command.entry, marker)
          sink.edited(command.entry)
        } else mark(marker, line.timestamp, line.uuid)
        command = null
        return
      }
    }
  }

  /** A prompt or background result Claude took in while a turn ran, recorded only as a queued command. */
  const queued = (line: ClaudeLine, attachment: ClaudeJsonObject): void => {
    if (attachment["type"] !== "queued_command") return
    const prompt = parseContent(attachment["prompt"])
    const projected = userContent(prompt)
    const text = claudeCommandPrompt(projected.text)
    const notification = taskNotificationLabel(text)
    if (notification) {
      mark(event(notification), line.timestamp, line.uuid)
      return
    }
    if (attachment["commandMode"] !== "prompt") return
    const attachments = projected.attachments
    if (
      (!text.trim() && !attachments.length) ||
      NOT_A_PROMPT.test(text.trimStart())
    )
      return
    const entry: UserEntry = {
      kind: "user",
      id: line.uuid,
      at: line.timestamp,
      text,
      attachments,
    }
    if (opener) entry.steeringFor = opener
    conversing()
    assistant = null
    sink.push(entry)
  }

  const push = (raw: string): void => {
    const line = parseClaudeLine(raw)
    if (!line || line.isSidechain) return

    // Session-level records: a title Claude Code wrote, and its bookkeeping.
    if (
      line.type === "summary" ||
      line.type === "ai-title" ||
      line.type === "last-prompt"
    )
      return

    if (line.system) return system(line, line.system)
    if (line.attachment) return queued(line, line.attachment)

    if (line.type === "user") {
      const content = line.message?.content
      // Tool results ride user-role messages; attach them to their calls
      // rather than showing them as turns the user took.
      if (Array.isArray(content)) {
        let results = 0
        for (const part of content) {
          if (part.type !== "tool_result") continue
          results++
          if (part.toolUseId && !tools.has(part.toolUseId)) needsReset = true
        }
        const saved = results ? savedMessage(line) : undefined
        for (const update of saved ? projection.project(saved) : []) {
          const call = update.kind === "tool-update" ? tools.get(update.id) : undefined
          if (!call) continue
          const [live] = reduceLiveUpdates([call.live], [update])
          if (live?.type === "tool") Object.assign(call.block, liveToolEntry(live))
          tools.delete(call.live.id)
          sink.edited(call.entry)
        }
        if (results === content.length) return
      }
      if (line.isCompactSummary) {
        const summary = claudeCompactSummary(plainText(content))
        if (compaction) {
          Object.assign(
            compaction.entry,
            compactionEvent({ ...compaction.kept, summary })
          )
          sink.edited(compaction.entry)
        } else mark(compactionEvent({ summary }), line.timestamp, line.uuid)
        compaction = null
        return
      }
      if (line.isMeta) return
      const projected = userContent(content)
      const text = claudeCommandPrompt(projected.text)
      if (claudeInterrupted(text)) {
        sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
        assistant = null
        running = false
        return
      }
      const notification = taskNotificationLabel(text)
      if (notification) {
        assistant = null
        started = true
        opener = undefined
        sink.push({
          kind: "event",
          id: line.uuid,
          at: line.timestamp,
          label: notification,
          opensTurn: true,
        })
        return
      }
      const attachments = projected.attachments
      if (
        (!text.trim() && !attachments.length) ||
        NOT_A_PROMPT.test(text.trimStart())
      )
        return
      assistant = null
      started = true
      conversing()
      if (running && opener) {
        sink.push({ kind: "user", id: line.uuid, at: line.timestamp, steeringFor: opener, text, attachments })
        return
      }
      opener = line.uuid
      fallbacks.clear()
      sink.push({
        kind: "user",
        id: line.uuid,
        at: line.timestamp,
        text,
        attachments,
      })
      return
    }

    if (line.type !== "assistant") return
    if (!started) needsReset = true
    started = true
    const message = line.message
    if (line.isAbortedMidStream || line.apiError !== undefined) running = false
    else if (message?.stopReason) running = message.stopReason === "tool_use"
    const saved = savedMessage(line)
    if (!message || !Array.isArray(message.content) || !saved) {
      if (line.isAbortedMidStream) {
        sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
      }
      return
    }
    const blocks = reduceLiveUpdates([], projection.project(saved))
    const failure = blocks.find((block) => block.type === "event")
    if (failure) {
      mark(liveEvent(failure), line.timestamp, line.uuid)
      return
    }
    for (const part of message.content) {
      if (part.type !== "fallback" || !part.from || !part.to) continue
      const entry = mark(modelChangedEvent(part.from, part.to), line.timestamp)
      if (line.requestId) fallbacks.set(line.requestId, entry)
    }
    // Claude Code's filler for a turn with nothing to answer decodes to nothing, as do fallback-only lines.
    if (!blocks.length) return
    if (!assistant || (line.uuid && assistant.id !== line.uuid)) {
      conversing()
      assistant = {
        id: line.uuid,
        kind: "assistant",
        at: line.timestamp,
        model: message.model,
        blocks: [],
      }
      sink.push(assistant)
    } else sink.edited(assistant)
    const turn: AssistantEntry = assistant
    for (const block of blocks) {
      switch (block.type) {
        case "text":
        case "thinking":
          if (block.text) turn.blocks.push({ type: block.type, text: block.text })
          break
        case "attachment":
          turn.blocks.push(block.attachment)
          break
        case "proposed-plan":
          turn.blocks.push({ type: block.type, id: block.id, text: block.text, status: block.status, ...block.truncated && { truncated: true } })
          break
        case "tool": {
          const saved = liveToolEntry(block)
          tools.set(block.id, { live: block, block: saved, entry: turn })
          turn.blocks.push(saved)
          break
        }
      }
    }
    if (message.usage) {
      const call = message.id && `${message.id}:${line.requestId ?? ""}`
      const owner = call ? spent.get(call) : undefined
      if (owner) {
        owner.usage = message.usage
        if (owner !== turn) sink.edited(owner)
      } else {
        turn.usage = message.usage
        if (call) spent.set(call, turn)
      }
    }
    if (line.isAbortedMidStream) {
      sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
      assistant = null
      tools.clear()
    }
  }

  return {
    push,
    snapshot: () => sink.snapshot(),
    done: () => sink.snapshot(),
    get needsReset() {
      return needsReset
    },
    get unchanged() {
      return sink.unchanged
    },
  }
}

function attachmentParts(
  content: ClaudeContent | undefined
): AttachmentContent[] {
  return Array.isArray(content)
    ? content.flatMap((part) =>
        part.type === "attachment" ? [part.value] : []
      )
    : []
}

/** Refs whose title Claude Code wrote; a prompt never replaces one of these. */
const storedTitles = new WeakSet<ThreadRef>()
/** Refs `/rename` named; neither a prompt nor Claude Code's title replaces these. */
const customTitles = new WeakSet<ThreadRef>()

/** Whether a `/rename` name was written from 64 KB before `byte` on. */
async function renamedBefore(path: string, byte: number): Promise<boolean> {
  let found = false
  await readLines(path, Math.max(0, byte - 65_536), (raw) => {
    if (!raw.includes('"custom-title"')) return
    found = Boolean(parseClaudeLine(raw)?.customTitle?.trim())
    return !found
  })
  return found
}

/**
 * The timestamp of a conversation message, or the one already held if this
 * line is not one. Only `user` and `assistant` lines on the main chain count:
 * bookkeeping records (`last-prompt`, `cost-state`, `ai-title`, snapshots)
 * carry no timestamp and say nothing about when the thread was used.
 */
function newerMessageTimestamp(
  held: string | undefined,
  line: ClaudeLine | null
): string | undefined {
  if (
    !line ||
    line.isSidechain ||
    (line.type !== "user" && line.type !== "assistant") ||
    line.timestamp === undefined
  )
    return held
  return held === undefined || line.timestamp > held ? line.timestamp : held
}

/**
 * The model a main-chain assistant message ran on. Claude Code writes
 * `<synthetic>` on messages it composed itself (an API error notice, "no
 * response requested"); that is not a model the session can continue with
 * and must never become the row's reading.
 */
function sessionModel(line: ClaudeLine): string | undefined {
  if (line.type !== "assistant" || line.isSidechain) return undefined
  const model = line.message?.model
  return model && !model.startsWith("<") ? model : undefined
}

function fillClaudeRef(ref: ThreadRef, line: ClaudeLine): void {
  if (line.isSidechain) return
  if (!ref.nativeId && line.sessionId !== undefined)
    ref.nativeId = line.sessionId
  if (
    !ref.parentNativeId &&
    line.forkedFrom &&
    line.forkedFrom !== ref.nativeId
  )
    ref.parentNativeId = line.forkedFrom
  if (!ref.cwd && line.cwd !== undefined) ref.cwd = line.cwd
  followCurrentCwd(ref, line.cwd)
  if (!ref.startedAt && line.timestamp !== undefined)
    ref.startedAt = line.timestamp
  if (!ref.model) {
    const model = sessionModel(line)
    if (model) ref.model = model
  }
  // A `/rename` name is the user's; the latest one wins over everything.
  if (line.customTitle?.trim()) {
    ref.title = titleFrom(line.customTitle)
    customTitles.add(ref)
    storedTitles.add(ref)
    return
  }
  // Claude Code names the session itself (`ai-title`, once `summary`) and
  // rewrites that name as the conversation moves on, so the latest one wins.
  // The first prompt only stands in until a written title exists.
  if (
    line.title?.trim() &&
    (line.type === "ai-title" || line.type === "summary")
  ) {
    if (customTitles.has(ref)) return
    ref.title = titleFrom(line.title)
    storedTitles.add(ref)
    return
  }
  if (
    !ref.title &&
    !storedTitles.has(ref) &&
    line.type === "user" &&
    !line.isSidechain &&
    !line.isMeta
  ) {
    const text = claudeCommandPrompt(userContent(line.message?.content).text)
    if (text.trim() && !NOT_A_PROMPT.test(text.trimStart()))
      ref.title = titleFrom(text)
  }
}
