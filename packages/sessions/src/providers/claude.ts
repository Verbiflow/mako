import { claudeCommandPrompt, claudeInterrupted } from "./claude-presentation.js"
import { todoDetails } from "../tool-plan.js"
import { attachmentFromUrl, type AttachmentContent } from "../content.js"
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
import { join } from "node:path"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { stat, rm } from "node:fs/promises"
import {
  clip,
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
  snapshotSink,
  walkFiles,
  type LineTranslator,
} from "../jsonl.js"
import { normalizeToolOutput } from "../tool-output.js"
import type { SessionSettings } from "../settings.js"
import type { NativeFile, SessionProvider } from "./types.js"

type ClaudeJsonScalar = boolean | number | string | null
type ClaudeJsonValue = ClaudeJsonScalar | ClaudeJsonObject | ClaudeJsonValue[]

interface ClaudeJsonObject {
  [key: string]: ClaudeJsonValue | undefined
}

interface ClaudeTextContent {
  type: "text"
  text?: string
}

interface ClaudeThinkingContent {
  type: "thinking"
  thinking?: string
}

interface ClaudeToolUseContent {
  type: "tool_use"
  id?: string
  name: string
  input?: ClaudeJsonValue
}

interface ClaudeToolResultContent {
  type: "tool_result"
  toolUseId: string
  content?: ClaudeContent
  isError: boolean
}

interface ClaudeOtherContent {
  type: "other"
}

type ClaudeContentBlock =
  | ClaudeTextContent
  | ClaudeThinkingContent
  | ClaudeToolUseContent
  | ClaudeToolResultContent
  | ClaudeOtherContent
  | { type: "attachment"; value: AttachmentContent }
type ClaudeContent = string | ClaudeContentBlock[]

interface ClaudeUsage {
  speed?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface ClaudeMessage {
  role?: string
  model?: string
  content?: ClaudeContent
  usage?: ClaudeUsage
}

interface ClaudeLine {
  effort?: string
  type: string
  /** A title Claude Code wrote for the session, rewritten as it evolves. */
  title?: string
  uuid?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  isSidechain: boolean
  isMeta: boolean
  isCompactSummary: boolean
  isAbortedMidStream: boolean
  message?: ClaudeMessage
}

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type ClaudeToolBlock = EntryBlock & { type: "tool" }

interface ClaudeTranslator extends LineTranslator {
  done(): ThreadEntry[]
}

/** Text a user line starts with when the harness, not the user, wrote it. */
const NOT_A_PROMPT =
  /^(?:<(?:command-name|command-message|local-command|system-reminder|task-notification)|Caveat: )/

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

function parseContentBlock(value: ClaudeJsonValue): ClaudeContentBlock {
  if (!isJsonObject(value)) return { type: "other" }
  switch (stringValue(value["type"])) {
    case "image":
    case "document": {
      const source = isJsonObject(value["source"]) ? value["source"] : {}
      const mimeType =
        stringValue(source["media_type"]) ?? "application/octet-stream"
      const name =
        stringValue(value["title"]) ??
        stringValue(value["type"]) ??
        "Attachment"
      const url = stringValue(source["url"])
      const data = stringValue(source["data"])
      const text = stringValue(source["text"])
      const attachment: AttachmentContent = url
        ? attachmentFromUrl(name, mimeType, url)
        : {
            type: "attachment",
            name,
            mimeType,
            source:
              data !== undefined
                ? {
                    kind: "inline",
                    data:
                      stringValue(source["type"]) === "text"
                        ? Buffer.from(data).toString("base64")
                        : data,
                  }
                : text !== undefined
                  ? {
                      kind: "inline",
                      data: Buffer.from(text).toString("base64"),
                    }
                  : {
                      kind: "unavailable",
                      reason:
                        "The provider did not retain attachment bytes or a readable URL",
                    },
          }
      return { type: "attachment", value: attachment }
    }
    case "text":
      return { type: "text", text: stringValue(value["text"]) }
    case "thinking":
      return { type: "thinking", thinking: stringValue(value["thinking"]) }
    case "tool_use":
      return {
        type: "tool_use",
        id: stringValue(value["id"]),
        name: stringValue(value["name"])?.trim() || "tool",
        input: value["input"],
      }
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: stringValue(value["tool_use_id"]) ?? "",
        content: parseContent(value["content"]),
        isError: value["is_error"] === true,
      }
    default:
      return { type: "other" }
  }
}

function parseContent(
  value: ClaudeJsonValue | undefined
): ClaudeContent | undefined {
  if (isString(value)) return value
  if (!Array.isArray(value)) return undefined
  return value.map(parseContentBlock)
}

function tokenCount(value: ClaudeJsonValue | undefined): number {
  return Number(value ?? 0)
}

function parseUsage(
  value: ClaudeJsonValue | undefined
): ClaudeUsage | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    speed: stringValue(value["speed"]),
    input: tokenCount(value["input_tokens"]),
    output: tokenCount(value["output_tokens"]),
    cacheRead: tokenCount(value["cache_read_input_tokens"]),
    cacheWrite: tokenCount(value["cache_creation_input_tokens"]),
  }
}

function parseMessage(
  value: ClaudeJsonValue | undefined
): ClaudeMessage | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    role: stringValue(value["role"]),
    model: stringValue(value["model"]),
    content: parseContent(value["content"]),
    usage: parseUsage(value["usage"]),
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
    effort: stringValue(root["effort"]),
    uuid: stringValue(root["uuid"]),
    timestamp: stringValue(root["timestamp"]),
    sessionId: stringValue(root["sessionId"]),
    cwd: stringValue(root["cwd"]),
    isSidechain: root["isSidechain"] === true,
    isMeta: root["isMeta"] === true,
    isCompactSummary: root["isCompactSummary"] === true,
    isAbortedMidStream: root["isAbortedMidStream"] === true,
    message: parseMessage(root["message"]),
  }
}

function parseDeclaredRoots(raw: string): string[] {
  try {
    const parsed: ClaudeJsonValue = JSON.parse(raw)
    if (!isJsonObject(parsed)) return []
    const roots = parsed["claude"]
    if (!Array.isArray(roots)) return []
    return roots.flatMap((root) => {
      const path = stringValue(root)
      return path === undefined ? [] : [path]
    })
  } catch {
    return []
  }
}

function plainText(content: ClaudeContent | undefined): string {
  if (!Array.isArray(content)) return content ?? ""
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("")
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
  private root: string
  private home: string
  private extraRoots: { at: number; value: string[] } | null = null

  constructor(home = homedir()) {
    this.home = home
    this.root = join(home, ".claude", "projects")
  }

  /**
   * Claude does not always live in ~/.claude. A CLAUDE_CONFIG_DIR moves the
   * whole store; router setups (subrouter and friends) fan Claude out into
   * per-profile homes like ~/.subrouter/<x>/claude/<id>/projects — sessions
   * as real as any, invisible to a provider that only knows the default
   * path. Roots therefore are: the default, the env override, anything
   * declared in ~/.mako/roots.json ({"claude": ["/abs/projects", …]}), and
   * auto-discovered subrouter profiles. Discovery is a couple of readdirs,
   * cached briefly — roots() is called on every watch/scan setup.
   */
  roots(): string[] {
    if (this.extraRoots && Date.now() - this.extraRoots.at < 60_000) {
      return [this.root, ...this.extraRoots.value]
    }
    const extras: string[] = []
    // Identity is the *real* path: router setups symlink their per-profile
    // projects dirs straight back at ~/.claude/projects, and scanning the
    // same store through five names lists every session five times.
    const seen = new Set<string>()
    const realOf = (dir: string): string => {
      try {
        return realpathSync(dir)
      } catch {
        return dir
      }
    }
    if (existsSync(this.root)) seen.add(realOf(this.root))
    const push = (dir: string) => {
      if (!dir || !existsSync(dir)) return
      const real = realOf(dir)
      if (seen.has(real)) return
      seen.add(real)
      extras.push(real)
    }
    const env = process.env["CLAUDE_CONFIG_DIR"]
    if (env) push(join(env, "projects"))
    try {
      const declared = parseDeclaredRoots(
        readFileSync(join(this.home, ".mako", "roots.json"), "utf8")
      )
      for (const dir of declared) push(dir)
    } catch {
      // No declaration file: nothing declared.
    }
    try {
      const subrouter = join(this.home, ".subrouter")
      for (const group of readdirSync(subrouter)) {
        const claudeDir = join(subrouter, group, "claude")
        if (!existsSync(claudeDir)) continue
        for (const profile of readdirSync(claudeDir)) {
          push(join(claudeDir, profile, "projects"))
        }
      }
    } catch {
      // No subrouter: the common case.
    }
    this.extraRoots = { at: Date.now(), value: extras }
    return [this.root, ...extras]
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
    for (const raw of head.split("\n")) {
      const line = parseClaudeLine(raw)
      if (!line) continue
      fillClaudeRef(ref, line)
      if (ref.nativeId && ref.model) break
    }
    ref.settings = {}
    let lastMessageAt: string | undefined
    await readLines(file.path, Math.max(0, file.bytes - 2 * 1024 * 1024), (raw) => {
      const line = parseClaudeLine(raw)
      if (line) fillClaudeRef(ref, line)
      lastMessageAt = newerMessageTimestamp(lastMessageAt, line)
      if (line?.type === "assistant" && !line.isSidechain && line.message?.model) {
        ref.model = line.message.model
        const options: NonNullable<SessionSettings["options"]> = {}
        if (line.effort) options.effort = line.effort
        if (line.message.usage?.speed === "standard") options.fast = false
        if (line.message.usage?.speed === "fast") options.fast = true
        ref.settings = { model: line.message.model, options }
      }
    })
    // The tail is where the newest messages are; a file whose tail holds no
    // message at all keeps the file's own time rather than claiming none.
    if (lastMessageAt !== undefined) ref.updatedAt = lastMessageAt
    // A session file with no session id yet is a placeholder, not a session.
    return ref.nativeId ? ref : null
  }

  /** Remove a session file; Claude Code keeps no index that names it. */
  async remove(path: string): Promise<boolean> {
    if (!this.roots().some((root) => path.startsWith(`${root}/`)) || !path.endsWith(".jsonl"))
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
    await readLines(ref.path, fromByte, (raw) => {
      const line = parseClaudeLine(raw)
      if (!line || line.isSidechain) return
      lastMessageAt = newerMessageTimestamp(lastMessageAt, line)
      if (line.title?.trim() && (line.type === "ai-title" || line.type === "summary")) {
        next.title = titleFrom(line.title) ?? next.title
      }
      if (line.type === "assistant" && line.message?.model !== undefined)
        next.model = line.message.model
    })
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
  const toolsById = new Map<string, ClaudeToolBlock>()
  let started = false
  let needsReset = false

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

    if (line.type === "user") {
      const content = line.message?.content
      // Tool results ride user-role messages; attach them to their calls
      // rather than showing them as turns the user took.
      if (Array.isArray(content)) {
        let onlyResults = true
        for (const part of content) {
          if (part.type !== "tool_result") {
            onlyResults = false
            continue
          }
          const block = toolsById.get(part.toolUseId)
          if (block) {
            block.output = clip(normalizeToolOutput(plainText(part.content)))
            block.attachments = attachmentParts(part.content)
            if (part.isError) block.error = true
            toolsById.delete(part.toolUseId)
          } else if (part.toolUseId) {
            needsReset = true
          }
        }
        if (onlyResults) return
      }
      if (line.isMeta) return
      if (line.isCompactSummary) {
        sink.push({
          kind: "event",
          at: line.timestamp,
          label: "Compacted",
          detail: undefined,
        })
        assistant = null
        return
      }
      const text = claudeCommandPrompt(plainText(content))
      if (claudeInterrupted(text)) {
        sink.push({kind: "event", at: line.timestamp, label: "Interrupted"})
        assistant = null
        return
      }
      const attachments = attachmentParts(content)
      if (
        (!text.trim() && !attachments.length) ||
        NOT_A_PROMPT.test(text.trimStart())
      )
        return
      assistant = null
      started = true
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
    if (!message || !Array.isArray(message.content)) {
      if (line.isAbortedMidStream) {
        sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
      }
      return
    }
    if (!assistant || (line.uuid && assistant.id !== line.uuid)) {
      assistant = {
        id: line.uuid,
        kind: "assistant",
        at: line.timestamp,
        model: message.model,
        blocks: [],
      }
      sink.push(assistant)
    }
    const turn: AssistantEntry = assistant
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (part.text) turn.blocks.push({ type: "text", text: part.text })
          break
        case "thinking":
          if (part.thinking)
            turn.blocks.push({ type: "thinking", text: part.thinking })
          break
        case "attachment":
          turn.blocks.push(part.value)
          break
        case "tool_use": {
          const block: ClaudeToolBlock = {
            type: "tool",
            id: part.id,
            name: part.name,
            input: clip(
              part.input === undefined ? undefined : JSON.stringify(part.input)
            ),
          }
          if (part.name === "TodoWrite") block.details = todoDetails(block.input)
          if (part.id !== undefined) toolsById.set(part.id, block)
          turn.blocks.push(block)
          break
        }
      }
    }
    if (message.usage) turn.usage = message.usage
    if (line.isAbortedMidStream) {
      sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
      assistant = null
      toolsById.clear()
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

function fillClaudeRef(ref: ThreadRef, line: ClaudeLine): void {
  if (line.isSidechain) return
  if (!ref.nativeId && line.sessionId !== undefined)
    ref.nativeId = line.sessionId
  if (!ref.cwd && line.cwd !== undefined) ref.cwd = line.cwd
  if (!ref.startedAt && line.timestamp !== undefined)
    ref.startedAt = line.timestamp
  if (
    !ref.model &&
    line.type === "assistant" &&
    !line.isSidechain &&
    line.message?.model !== undefined
  ) {
    ref.model = line.message.model
  }
  // Claude Code names the session itself (`ai-title`, once `summary`) and
  // rewrites that name as the conversation moves on, so the latest one wins.
  // The first prompt only stands in until a written title exists.
  if (line.title?.trim() && (line.type === "ai-title" || line.type === "summary")) {
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
    const text = claudeCommandPrompt(plainText(line.message?.content))
    if (text.trim() && !NOT_A_PROMPT.test(text.trimStart()))
      ref.title = titleFrom(text)
  }
}

