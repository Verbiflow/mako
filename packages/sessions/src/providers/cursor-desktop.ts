import { cursorTaskNotification, cursorPrompt } from "./cursor-presentation.js"
import { stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { z } from "zod"
import {
  EntrySink,
  clip,
  titleFrom,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import { type AttachmentContent, attachmentFromUrl } from "../content.js"
import { normalizeToolOutput } from "../tool-output.js"
import { todoDetails } from "../tool-plan.js"
import type { NativeFile, SessionFollower, SessionUpdate } from "./types.js"

const MAX_RECORD = 16 * 1024 * 1024
const MAX_BUBBLE = 2 * 1024 * 1024
const MAX_HISTORY = 64 * 1024 * 1024
const Header = z.object({
  composerId: z.string(),
  name: z.string().optional(),
  createdAt: z.number().optional(),
  lastUpdatedAt: z.number().optional(),
  workspaceIdentifier: z
    .object({ uri: z.object({ fsPath: z.string().optional() }).optional() })
    .optional(),
})
const Stored = z.object({
  fullConversationHeadersOnly: z
    .array(z.object({ bubbleId: z.string() }))
    .max(12_000)
    .optional(),
  modelConfig: z.object({ modelName: z.string().optional() }).optional(),
  activeCanvas: z.object({ path: z.string() }).optional(),
})
const Image = z.object({
  filePath: z.string().optional(),
  path: z.string().optional(),
  imageUrl: z.string().optional(),
  mimeType: z.string().optional(),
})
const Bubble = z.object({
  bubbleId: z.string(),
  type: z.number(),
  text: z.string().optional(),
  createdAt: z.string().optional(),
  thinking: z.object({ text: z.string() }).optional(),
  images: z.array(Image).optional(),
  toolFormerData: z
    .object({
      toolCallId: z.string().optional(),
      name: z.string(),
      params: z.string().optional(),
      rawArgs: z.string().optional(),
      result: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
})

function parseJson<T>(
  schema: z.ZodType<T>,
  raw: SQLOutputValue | undefined
): T | undefined {
  const text = z.string().safeParse(raw)
  if (!text.success) return undefined
  try {
    const result = schema.safeParse(JSON.parse(text.data))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

async function openDatabase(path: string): Promise<DatabaseSync | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

/**
 * One aggregate over the header table stands in for the whole listing:
 * a header added, removed, updated or checkpointed changes it.
 */
function discoverFingerprint(db: DatabaseSync): string | null {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count, MAX(lastUpdatedAt) AS updated, MAX(checkpointAt) AS checkpoint FROM composerHeaders WHERE COALESCE(isSubagent,0) = 0"
      )
      .get()
    const parsed = z
      .object({
        count: z.number(),
        updated: z.number().nullable(),
        checkpoint: z.number().nullable(),
      })
      .safeParse(row)
    return parsed.success
      ? `${parsed.data.count}:${parsed.data.updated ?? 0}:${parsed.data.checkpoint ?? 0}`
      : null
  } catch {
    return null
  }
}

function timestamp(value: number | undefined): string | undefined {
  return value && Number.isFinite(value) && value > 0 && value < 8.64e15
    ? new Date(value).toISOString()
    : undefined
}

/** Desktop composer IDs share one DB; the fragment is a provider-owned catalog identity. */
export class CursorDesktopStore {
  readonly root: string
  private readonly databasePath: string
  private readonly readRevisions = new Map<string, string>()
  private lastDiscover: { fingerprint: string; files: NativeFile[] } | null =
    null
  private lastRead: {
    path: string
    revision: string | undefined
    signatures: string[]
  } | null = null
  constructor(home: string) {
    this.root = join(
      home,
      process.platform === "darwin"
        ? "Library/Application Support/Cursor/User/globalStorage"
        : process.platform === "win32"
          ? "AppData/Roaming/Cursor/User/globalStorage"
          : ".config/Cursor/User/globalStorage"
    )
    this.databasePath = join(this.root, "state.vscdb")
  }

  owns(path: string): boolean {
    return path.startsWith(`${this.databasePath}#composer:`)
  }
  private id(path: string): string | undefined {
    if (!this.owns(path)) return undefined
    const id = path.slice(`${this.databasePath}#composer:`.length)
    return /^[\da-f-]{36}$/i.test(id) ? id : undefined
  }

  async discover(): Promise<NativeFile[]> {
    const db = await openDatabase(this.databasePath)
    if (!db) return []
    try {
      // A write anywhere in the database re-runs discovery; when no header
      // moved, the previous list is the answer and the aggregate is the
      // whole cost.
      const fingerprint = discoverFingerprint(db)
      if (
        fingerprint &&
        this.lastDiscover &&
        this.lastDiscover.fingerprint === fingerprint
      )
        return this.lastDiscover.files
      // Headers are small, separately indexed records. Never hydrate composerData in a catalog scan.
      const files = db
        .prepare(
          "SELECT composerId, lastUpdatedAt, checkpointAt FROM composerHeaders WHERE COALESCE(isSubagent,0) = 0 ORDER BY lastUpdatedAt DESC LIMIT 20000"
        )
        .all()
        .flatMap((row) => {
          const parsed = z
            .object({
              composerId: z.string().regex(/^[\da-f-]{36}$/i),
              lastUpdatedAt: z.number().nullable(),
              checkpointAt: z.number().nullable(),
            })
            .safeParse(row)
          if (!parsed.success) return []
          const updated = parsed.data.lastUpdatedAt ?? 0
          return [
            {
              path: `${this.databasePath}#composer:${parsed.data.composerId}`,
              bytes: 0,
              mtimeMs: updated,
              revision: `${updated}:${parsed.data.checkpointAt ?? 0}`,
            },
          ]
        })
      if (fingerprint) this.lastDiscover = { fingerprint, files }
      return files
    } catch {
      return []
    } finally {
      db.close()
    }
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const id = this.id(file.path)
    if (!id) return null
    const db = await openDatabase(this.databasePath)
    if (!db) return null
    try {
      const row = db
        .prepare(
          "SELECT value, lastUpdatedAt, checkpointAt FROM composerHeaders WHERE composerId = ? AND COALESCE(isSubagent,0) = 0 AND length(value) <= 65536"
        )
        .get(id)
      const header = parseJson(Header, row?.value)
      return header
        ? {
            harness: "cursor",
            nativeId: id,
            path: file.path,
            title: titleFrom(header.name),
            cwd: header.workspaceIdentifier?.uri?.fsPath,
            startedAt: timestamp(header.createdAt),
            updatedAt: timestamp(header.lastUpdatedAt),
            bytes: file.bytes,
            revision: `${row?.lastUpdatedAt ?? 0}:${row?.checkpointAt ?? 0}`,
            // Cursor CLI cannot resume a desktop composer. It remains portable read-only history.
            resumeUnavailable:
              "Cursor desktop history continues here by copying the conversation into a new agent session.",
          }
        : null
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  createFollower(path: string): SessionFollower {
    let revision = this.readRevisions.get(path)
    let previous =
      this.lastRead?.path === path && this.lastRead.revision === revision
        ? this.lastRead.signatures
        : null
    return {
      offset: 0,
      next: async () => {
        const ref = await this.peek({ path, bytes: 0, mtimeMs: 0 })
        if (ref?.revision === revision)
          return { entries: [], nextByte: 0, replace: false }
        const thread = await this.read(path)
        if (!thread) return { entries: [], nextByte: 0, replace: false }
        revision = thread.ref.revision
        const signatures =
          this.lastRead?.path === path && this.lastRead.revision === revision
            ? this.lastRead.signatures
            : thread.entries.map(entrySignature)
        let shared = 0
        while (
          previous &&
          shared < previous.length &&
          shared < signatures.length &&
          previous[shared] === signatures[shared]
        )
          shared++
        const appended = previous !== null && shared === previous.length
        previous = signatures
        const update: SessionUpdate = {
          entries: thread.entries.slice(shared),
          nextByte: 0,
          replace: !appended,
        }
        if (!appended) update.replaceFrom = shared
        return update
      },
    }
  }

  async read(path: string): Promise<Thread | null> {
    const id = this.id(path)
    if (!id) return null
    const info = await stat(this.databasePath).catch(() => null)
    if (!info) return null
    const ref = await this.peek({ path, bytes: 0, mtimeMs: info.mtimeMs })
    if (!ref) return null
    const db = await openDatabase(this.databasePath)
    if (!db) return null
    try {
      const raw = db
        .prepare(
          "SELECT value FROM cursorDiskKV WHERE key = ? AND length(value) <= ?"
        )
        .get(`composerData:${id}`, MAX_RECORD)?.value
      const data = parseJson(Stored, raw)
      if (!data)
        return {
          ref,
          entries: [
            {
              kind: "event",
              label: "History unavailable",
              detail:
                "The desktop conversation record is unavailable, unsupported, or exceeds the read limit.",
            },
          ],
        }
      ref.model = data.modelConfig?.modelName
      const sink = new EntrySink()
      let spent = z.string().safeParse(raw).data?.length ?? 0
      const query = db.prepare(
        "SELECT value FROM cursorDiskKV WHERE key = ? AND length(value) <= ?"
      )
      for (const header of data.fullConversationHeadersOnly ?? []) {
        const value = query.get(
          `bubbleId:${id}:${header.bubbleId}`,
          MAX_BUBBLE
        )?.value
        spent += z.string().safeParse(value).data?.length ?? 0
        if (spent > MAX_HISTORY) {
          sink.push({ kind: "event", label: "History read limit reached" })
          break
        }
        const bubble = parseJson(Bubble, value)
        if (!bubble) {
          sink.push({
            kind: "event",
            label: "Message unavailable",
            detail:
              "The native message is missing, unsupported, or exceeds the read limit.",
          })
          continue
        }
        const entry = bubbleEntry(bubble, ref.model)
        if (entry) sink.push(entry)
      }
      if (data.activeCanvas)
        sink.push({
          kind: "assistant",
          blocks: [
            {
              type: "attachment",
              name: basename(data.activeCanvas.path),
              mimeType: "text/x-cursor-canvas",
              source: { kind: "file", path: data.activeCanvas.path },
            },
          ],
        })
      this.readRevisions.set(path, ref.revision ?? "")
      if (this.readRevisions.size > 32)
        this.readRevisions.delete(this.readRevisions.keys().next().value!)
      const entries = sink.done()
      this.lastRead = {
        path,
        revision: ref.revision,
        signatures: entries.map(entrySignature),
      }
      return { ref, entries }
    } finally {
      db.close()
    }
  }
}

function entrySignature(entry: ThreadEntry): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("base64url")
}

function bubbleImages(images: z.infer<typeof Image>[]): AttachmentContent[] {
  return images.map((image) => {
    const path = image.filePath ?? image.path
    const name = path ? basename(path) : "Image"
    const mimeType = image.mimeType ?? "image/png"
    if (image.imageUrl) return attachmentFromUrl(name, mimeType, image.imageUrl)
    return {
      type: "attachment",
      name,
      mimeType,
      source: path
        ? { kind: "file", path }
        : {
            kind: "unavailable",
            reason: "The desktop record does not retain a readable image",
          },
    }
  })
}

function bubbleEntry(
  bubble: z.infer<typeof Bubble>,
  model: string | undefined
): ThreadEntry | null {
  const attachments = bubbleImages(bubble.images ?? [])
  if (bubble.type === 1)
    return (
      cursorTaskNotification(
        bubble.text ?? "",
        bubble.bubbleId,
        bubble.createdAt
      ) ?? {
        kind: "user",
        id: bubble.bubbleId,
        at: bubble.createdAt,
        text: cursorPrompt(bubble.text ?? ""),
        attachments,
      }
    )
  if (bubble.type !== 2) return null
  const entry: Extract<ThreadEntry, { kind: "assistant" }> = {
    kind: "assistant",
    id: bubble.bubbleId,
    at: bubble.createdAt,
    model,
    blocks: [],
  }
  if (bubble.thinking?.text)
    entry.blocks.push({ type: "thinking", text: bubble.thinking.text })
  if (bubble.text) entry.blocks.push({ type: "text", text: bubble.text })
  const tool = bubble.toolFormerData
  if (tool) {
    const input = clip(tool.params ?? tool.rawArgs)
    entry.blocks.push({
      type: "tool",
      id: tool.toolCallId ?? bubble.bubbleId,
      name: tool.name,
      input,
      output:
        tool.result !== undefined
          ? clip(normalizeToolOutput(tool.result))
          : /complete|error|fail|cancel/i.test(tool.status ?? "")
            ? ""
            : undefined,
      error: /error|fail/i.test(tool.status ?? ""),
      canceled: /cancel/i.test(tool.status ?? ""),
      details: /^(?:todo_write|TodoWrite)$/.test(tool.name)
        ? todoDetails(input)
        : undefined,
    })
  }
  entry.blocks.push(...attachments)
  return entry.blocks.length ? entry : null
}
