import { describeToolDetails } from "./content.js"
import { describeAttachments } from "./attachment-envelope.js"
import { persistThreadAttachments } from "./attachment-storage.js"
/**
 * Native session emitters — the deepest form of continuation.
 *
 * A handoff prompt tells the next agent about a conversation; an emitted
 * session *is* the conversation, written in the target harness's own store
 * format so its ordinary resume machinery loads it with the full history in
 * context. Resume a session emitted this way and the agent does not read a
 * summary of what happened — it remembers it, because as far as its harness
 * is concerned, it happened to it. Verified: a synthesized Claude Code
 * session file resumes with full recall of facts that exist nowhere else.
 *
 * Tool activity is rendered as formatted text inside assistant messages
 * rather than as structured tool-use records. Deliberate: every harness
 * validates its own tool shapes on replay (paired ids, parseable inputs,
 * known names), and a foreign session cannot satisfy Claude's rules with
 * Codex's tools. Text carries the same information and replays anywhere.
 *
 * Verified through each owning reader, with live resume checks for Claude
 * Code and Codex confirming that emitted history returns in model context.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import { access, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Thread, ThreadEntry } from "./format.js"
import { refuseNativeWrite } from "./read-only-sqlite.js"
import { devinCliDirectory } from "./providers/devin-location.js"

export interface EmitResult {
  sessionId: string
  path: string
}

export interface EmitOptions {
  cwd?: string
  home?: string
  /** The provider's own root when an account moves it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). */
  store?: string
  /** Codex's `model_provider` for the home it writes into; `openai` when unset. */
  codexModelProvider?: string
}

interface Message {
  role: "user" | "assistant"
  text: string
  at?: string
}

interface PersistedClaudeContent {
  type: "text"
  text: string
}

interface PersistedClaudeMessage {
  role: Message["role"]
  model?: "imported"
  content: PersistedClaudeContent[]
}

interface PersistedClaudeEntry {
  type: Message["role"]
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string
  cwd: string
  isSidechain: false
  userType?: "external"
  message: PersistedClaudeMessage
}

/**
 * Flatten canonical entries into alternating user/assistant text messages —
 * the intersection every harness's store can hold and replay.
 */
async function flatten(
  entries: ThreadEntry[],
  home: string
): Promise<Message[]> {
  const messages: Message[] = []
  for (const entry of entries) {
    if (entry.kind === "user") {
      messages.push({
        role: "user",
        text: [entry.text, describeAttachments(entry.attachments ?? [])]
          .filter(Boolean)
          .join("\n\n"),
        at: entry.at,
      })
      continue
    }
    if (entry.kind === "event") {
      const last = messages[messages.length - 1]
      const note = `*[${entry.label}${entry.detail ? `: ${entry.detail}` : ""}]*`
      if (last?.role === "assistant") last.text += `\n\n${note}`
      continue
    }
    const parts: string[] = []
    for (const block of entry.blocks) {
      if (block.type === "attachment") parts.push(describeAttachments([block]))
      if (block.type === "proposed-plan")
        parts.push(
          `[Proposed plan: ${block.status}${block.truncated ? "; truncated" : ""}]\n${block.text}`
        )
      if (block.type === "text" && block.text.trim())
        parts.push(block.text.trim())
      if (block.type === "tool") {
        const status = block.error
          ? " — failed"
          : block.canceled
            ? " — canceled"
            : ""
        const lines = [`[tool: ${block.name}${status}]`]
        if (block.input)
          lines.push(`input: ${await retainPayload(block.input, home, 600)}`)
        if (block.output?.trim())
          lines.push(
            `output:\n${await retainPayload(block.output, home, 2000)}`
          )
        lines.push(describeAttachments(block.attachments ?? []))
        lines.push(describeToolDetails(block.details ?? []))
        parts.push(lines.join("\n"))
      }
      // Thinking is the original model's private state; it does not replay.
    }
    if (parts.length === 0) continue
    const text = parts.join("\n\n")
    const last = messages[messages.length - 1]
    if (last?.role === "assistant") last.text += `\n\n${text}`
    else messages.push({ role: "assistant", text, at: entry.at })
  }
  // Every store expects the conversation to open with a user message.
  while (messages.length > 0 && messages[0]?.role !== "user") messages.shift()
  if (messages.length === 0) {
    throw new Error("This conversation has no replayable turns")
  }
  return messages
}

/**
 * Write a thread into Claude Code's own store, resumable by session id with
 * `claude --resume` or loaded live over ACP.
 */
export async function emitClaudeSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  refuseNativeWrite("Claude's sessions")
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, "-")
  const dir = join(options.store ?? join(home, ".claude"), "projects", slug)
  await mkdir(dir, { recursive: true })

  const lines: string[] = []
  let parentUuid: string | null = null
  for (const message of await flatten(
    (await persistThreadAttachments(thread, join(home, ".mako", "attachments")))
      .entries,
    home
  )) {
    const uuid = randomUUID()
    const entry: PersistedClaudeEntry = {
      type: message.role,
      uuid,
      parentUuid,
      sessionId,
      timestamp: message.at ?? new Date().toISOString(),
      cwd,
      isSidechain: false,
      userType: message.role === "user" ? "external" : undefined,
      message: {
        role: message.role,
        model: message.role === "assistant" ? "imported" : undefined,
        content: [{ type: "text", text: message.text }],
      },
    }
    lines.push(JSON.stringify(entry))
    parentUuid = uuid
  }

  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, `${lines.join("\n")}\n`, "utf8")
  return { sessionId, path }
}

/**
 * Write a thread into Codex's rollout store, resumable with
 * `codex exec resume <id>` — which replays the message items into context.
 */
export async function emitCodexSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  refuseNativeWrite("Codex's sessions")
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const now = new Date()
  const iso = now.toISOString()
  const dir = join(
    options.store ?? join(home, ".codex"),
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  )
  await mkdir(dir, { recursive: true })

  const lines: string[] = [
    JSON.stringify({
      timestamp: iso,
      type: "session_meta",
      // cli_version is required by Codex's session-meta schema; without it
      // the resume machinery refuses the file outright. Since 0.159 a resume
      // also loads its provider from model_provider and fails on an empty one.
      payload: {
        id: sessionId,
        timestamp: iso,
        cwd,
        originator: "mako",
        cli_version: "0.147.0",
        source: "exec",
        model_provider: options.codexModelProvider ?? "openai",
      },
    }),
  ]
  for (const message of await flatten(
    (await persistThreadAttachments(thread, join(home, ".mako", "attachments")))
      .entries,
    home
  )) {
    lines.push(
      JSON.stringify({
        timestamp: message.at ?? iso,
        type: "response_item",
        payload: {
          type: "message",
          role: message.role,
          content: [
            {
              type: message.role === "user" ? "input_text" : "output_text",
              text: message.text,
            },
          ],
        },
      })
    )
  }

  const stamp = iso.slice(0, 19).replace(/:/g, "-")
  const path = join(dir, `rollout-${stamp}-${sessionId}.jsonl`)
  await writeFile(path, lines.join("\n") + "\n", "utf8")
  return { sessionId, path }
}

async function retainPayload(
  text: string,
  home: string,
  inlineLimit: number
): Promise<string> {
  if (text.length <= inlineLimit) return text
  const digest = createHash("sha256").update(text).digest("hex")
  const root = join(home, ".mako", "native-import-artifacts")
  await mkdir(root, { recursive: true })
  const path = join(root, `${digest}.txt`)
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 })
  return `Complete payload (${text.length} characters, sha256 ${digest}): ${path}. Read this file for the full content.`
}

/**
 * Write a thread into Grok's own store — a session directory holding the
 * model's history, the update stream Grok restores and lists it from, and
 * the summary its CLI lists sessions by. In the model's history the user's
 * words go inside a `<user_query>` tag because that is where Grok's own
 * scaffolding puts them, and its resume path expects to find them there.
 */
export async function emitGrokSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  refuseNativeWrite("Grok's sessions")
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const dir = join(
    home,
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    sessionId
  )
  await mkdir(dir, { recursive: true })

  const messages = await flatten(
    (await persistThreadAttachments(thread, join(home, ".mako", "attachments")))
      .entries,
    home
  )
  const lines = messages.map((message) =>
    JSON.stringify(
      message.role === "user"
        ? {
            type: "user",
            content: [
              {
                type: "text",
                text: `<user_query>\n${message.text}\n</user_query>`,
              },
            ],
          }
        : { type: "assistant", content: message.text }
    )
  )
  await writeFile(
    join(dir, "chat_history.jsonl"),
    `${lines.join("\n")}\n`,
    "utf8"
  )
  const updates = grokUpdates(sessionId, messages, Date.parse(now))
  await writeFile(join(dir, "updates.jsonl"), `${updates.join("\n")}\n`, "utf8")
  await writeFile(
    join(dir, "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd },
      session_summary: thread.ref.title ?? "Imported conversation",
      created_at: thread.ref.startedAt ?? now,
      updated_at: now,
      num_messages: messages.length,
      num_chat_messages: messages.length,
      current_model_id: "grok-4.6",
      chat_format_version: 1,
      next_trace_turn: 1,
    }),
    "utf8"
  )
  return { sessionId, path: join(dir, "updates.jsonl") }
}

/**
 * The same messages as Grok's update stream, each exchange ending in the
 * `turn_completed` its own sessions carry. Grok restores a session from
 * `updates.jsonl` and gives its model `chat_history.jsonl`, so a session
 * without the stream answers from the imported turns but never shows them.
 */
interface GrokUpdate {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "turn_completed"
  content?: { type: "text"; text: string }
  _meta?: { promptIndex: number }
  prompt_id?: string
  stop_reason?: "end_turn"
}

function grokUpdates(sessionId: string, messages: Message[], fallbackMs: number): string[] {
  const lines: string[] = []
  let promptIndex = 0
  let promptId: string | undefined
  let lastMs = fallbackMs
  const line = (method: string, update: GrokUpdate, at: number): void => {
    lines.push(JSON.stringify({
      timestamp: Math.floor(at / 1000),
      method,
      params: { sessionId, update, _meta: { eventId: `${sessionId}-${lines.length + 1}`, agentTimestampMs: at } },
    }))
  }
  const endTurn = (): void => {
    if (!promptId) return
    line("_x.ai/session/update", { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" }, lastMs)
    promptId = undefined
  }
  for (const message of messages) {
    const parsed = message.at ? Date.parse(message.at) : Number.NaN
    lastMs = Number.isNaN(parsed) ? lastMs : parsed
    const content: GrokUpdate["content"] = { type: "text", text: message.text }
    if (message.role === "user") {
      endTurn()
      promptId = randomUUID()
      line("session/update", { sessionUpdate: "user_message_chunk", content, _meta: { promptIndex: promptIndex++ } }, lastMs)
    } else {
      line("session/update", { sessionUpdate: "agent_message_chunk", content }, lastMs)
    }
  }
  endTurn()
  return lines
}

/** The `refinery_schema_history` version of Devin's store this writer matches. */
export const DEVIN_STORE_VERSION = 17

/** The model of the latest Devin session, which an imported one continues on. */
const DevinModel = z.string().catch("swe-2-high")

/**
 * Write a thread into the Devin CLI's store: a `sessions` row and a chain of
 * `message_nodes` its `main_chain_id` ends at, in the one SQLite database
 * every Devin session shares. Devin adds its own system prompt as new roots
 * when it loads the session, so the chain holds only the conversation. The
 * write is one transaction, and a store at another schema version is left
 * untouched. `devin -r <id>` or ACP `session/load` resumes it.
 */
export async function emitDevinSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  refuseNativeWrite("Devin's session store")
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error(
      "Writing Devin sessions needs Node's built-in SQLite (Node 22.5+)"
    )
  })
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const path = join(devinCliDirectory(options.home ? {} : process.env, home), "sessions.db")
  const messages = await flatten(
    (await persistThreadAttachments(thread, join(home, ".mako", "attachments")))
      .entries,
    home
  )
  // Opening creates a missing database, and an empty store is not Devin's.
  await access(path).catch(() => {
    throw new Error("Devin has no session store yet; run Devin once first")
  })
  const database = new sqlite.DatabaseSync(path)
  database.exec("PRAGMA busy_timeout = 5000")
  const sessionId = `mako-${randomUUID().slice(0, 13)}`
  try {
    database.exec("BEGIN IMMEDIATE")
    try {
      const version = database
        .prepare("SELECT MAX(version) AS version FROM refinery_schema_history")
        .get()?.version
      if (version !== DEVIN_STORE_VERSION)
        throw new Error(
          `Devin's session store is at version ${String(version)}; Mako writes version ${DEVIN_STORE_VERSION}`
        )
      const nowSeconds = Math.floor(Date.now() / 1000)
      const seconds = (at: string | undefined) => {
        const parsed = at ? Date.parse(at) : Number.NaN
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : nowSeconds
      }
      const latest = DevinModel.parse(database
        .prepare("SELECT model FROM sessions WHERE model != '' ORDER BY last_activity_at DESC LIMIT 1")
        .get()?.model)
      database
        .prepare(
          `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at,
             last_activity_at, title, main_chain_id, workspace_dirs, hidden, metadata)
           VALUES (?, ?, 'windsurf', ?, 'normal', ?, ?, ?, ?, '[]', 0, ?)`
        )
        .run(
          sessionId,
          cwd,
          latest,
          seconds(thread.ref.startedAt),
          nowSeconds,
          thread.ref.title ?? "Imported conversation",
          messages.length - 1,
          JSON.stringify({ total_credit_cost: 0, total_acu_cost: 0 })
        )
      const node = database.prepare(
        `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      messages.forEach((message, index) => {
        const user = message.role === "user"
        const said = {
          message_id: randomUUID(),
          role: message.role,
          content: message.text,
          metadata: {
            num_tokens: null,
            is_user_input: user ? true : null,
            request_id: null,
            metrics: null,
            finish_reason: user ? null : "stop",
            created_at: new Date(seconds(message.at) * 1000).toISOString(),
            telemetry: user
              ? { source: "user", operation: "unknown" }
              : { source: "assistant", operation: "inference" },
          },
        }
        const chat = user ? said : { ...said, tool_calls: [] }
        node.run(sessionId, index, index ? index - 1 : null, JSON.stringify(chat), seconds(message.at))
      })
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  } finally {
    database.close()
  }
  return { sessionId, path: `${path}#${sessionId}` }
}

export interface OpenCodeImport {
  sessionId: string
  /** The working directory the session belongs to. */
  directory: string
  /** The body `opencode session import` takes. */
  document: unknown
}

/**
 * The model imported assistant turns name. OpenCode refuses an assistant turn
 * without one, has no such model, and resumes the session on the user's
 * default; Mako's reader shows no model for these turns.
 */
export const OPENCODE_IMPORTED_MODEL = { id: "imported", providerID: "imported" } as const

const OPENCODE_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** OpenCode's identifier shape: message ids ascend with time; session ids descend. */
function openCodeIds(): (prefix: "ses" | "msg", at: number) => string {
  let counter = 0
  return (prefix, at) => {
    let time = BigInt(at) * 4096n + BigInt(++counter)
    if (prefix === "ses") time = ~time
    const random = Array.from(
      randomBytes(14),
      (byte) => OPENCODE_ID_ALPHABET[byte % OPENCODE_ID_ALPHABET.length]
    ).join("")
    return `${prefix}_${(time & 0xffffffffffffn).toString(16).padStart(12, "0")}${random}`
  }
}

/**
 * A thread as the session `opencode session import` takes. OpenCode's own
 * import is the supported way into its store, so this writes no file.
 */
export async function openCodeImport(
  thread: Thread,
  options: EmitOptions = {}
): Promise<OpenCodeImport> {
  refuseNativeWrite("OpenCode's sessions")
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const messages = await flatten(
    (await persistThreadAttachments(thread, join(home, ".mako", "attachments")))
      .entries,
    home
  )
  const id = openCodeIds()
  const now = Date.now()
  const started = Date.parse(thread.ref.startedAt ?? "")
  const created = Number.isFinite(started) ? started : now
  const sessionId = id("ses", created)
  // Ascending times keep OpenCode's ordering when timestamps are missing or tie.
  let last = created
  const at = (iso: string | undefined) => {
    const parsed = iso ? Date.parse(iso) : Number.NaN
    last = Math.max(last + 1, Number.isFinite(parsed) ? parsed : last + 1)
    return last
  }
  const document = {
    info: {
      id: sessionId,
      projectID: "global",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, updated: now },
      title: thread.ref.title ?? "Imported conversation",
      location: { directory: cwd },
    },
    messages: messages.map((message) => {
      const time = at(message.at)
      return message.role === "user"
        ? { id: id("msg", time), type: "user", text: message.text, time: { created: time } }
        : {
            id: id("msg", time),
            type: "assistant",
            agent: "build",
            model: OPENCODE_IMPORTED_MODEL,
            content: [{ type: "text", text: message.text }],
            time: { created: time, completed: time },
            finish: "stop",
          }
    }),
  }
  return { sessionId, directory: cwd, document }
}

/**
 * Write a thread into Cursor's store: content-addressed JSON blobs in
 * SQLite, ordered by a protobuf root. The root must carry the conversation's
 * time zone beside its timestamp — Cursor's resume rejects the file
 * otherwise, in so many words. Verified against `cursor-agent --resume`.
 */
export async function emitCursorSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  refuseNativeWrite("Cursor's chats")
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error(
      "Writing Cursor sessions needs Node's built-in SQLite (Node 22.5+)"
    )
  })
  const { createHash } = await import("node:crypto")

  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const chatId = randomUUID()
  const workspaceHash = createHash("md5").update(cwd).digest("hex")
  const dir = join(home, ".cursor", "chats", workspaceHash, chatId)
  await mkdir(dir, { recursive: true })

  const database = new sqlite.DatabaseSync(join(dir, "store.db"))
  try {
    database.exec(
      "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    const put = database.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)")
    const hashes: Buffer[] = []
    for (const message of await flatten(
      (
        await persistThreadAttachments(
          thread,
          join(home, ".mako", "attachments")
        )
      ).entries,
      home
    )) {
      const data = Buffer.from(
        JSON.stringify(
          message.role === "user"
            ? {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<user_query>\n${message.text}\n</user_query>`,
                  },
                ],
              }
            : {
                role: "assistant",
                content: [{ type: "text", text: message.text }],
              }
        )
      )
      const id = createHash("sha256").update(data).digest("hex")
      put.run(id, data)
      hashes.push(Buffer.from(id, "hex"))
    }

    const varint = (value: number | bigint): Buffer => {
      const bytes: number[] = []
      let current = BigInt(value)
      while (current > 127n) {
        bytes.push(Number(current & 0x7fn) | 0x80)
        current >>= 7n
      }
      bytes.push(Number(current))
      return Buffer.from(bytes)
    }
    const tag = (field: number, wire: number): Buffer =>
      varint((field << 3) | wire)
    const bytesField = (field: number, buffer: Buffer): Buffer =>
      Buffer.concat([tag(field, 2), varint(buffer.length), buffer])

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const root = Buffer.concat([
      ...hashes.map((hash) => bytesField(1, hash)),
      bytesField(9, Buffer.from(`file://${cwd}`)),
      bytesField(22, Buffer.from("cli")),
      Buffer.concat([tag(26, 0), varint(Date.now())]),
      bytesField(27, Buffer.from(timeZone)),
    ])
    const rootId = createHash("sha256").update(root).digest("hex")
    put.run(rootId, root)

    const meta = {
      agentId: chatId,
      latestRootBlobId: rootId,
      name: thread.ref.title ?? "Imported conversation",
      mode: "agent",
      isRunEverything: false,
      createdAt: Date.now(),
    }
    database
      .prepare("INSERT INTO meta (key, value) VALUES ('0', ?)")
      .run(Buffer.from(JSON.stringify(meta)).toString("hex"))
  } finally {
    database.close()
  }

  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      createdAtMs: Date.now(),
      hasConversation: true,
      updatedAtMs: Date.now(),
      cwd,
    }),
    "utf8"
  )
  return { sessionId: chatId, path: join(dir, "store.db") }
}
