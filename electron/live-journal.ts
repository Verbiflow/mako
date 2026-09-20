import { NativeAgentRosterSchema } from "./contracts/native-agents.js"
import {
  ModelOptionSchema,
  SessionSettingsSchema,
} from "@mako/sessions/settings"
import {
  ContextManifestSchema,
  ConversationControlSchema,
  PromptAttachmentSchema,
} from "./contracts/conversation-control.js"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ThreadEntrySchema, ThreadRefSchema } from "@mako/sessions"
import {
  LiveBlockSchema,
  changedLiveBlockStart,
} from "./contracts/live-content.js"
import { RunSnapshotsSchema } from "./contracts/workspace-snapshots.js"
import { INTERRUPTION_REASONS, type LiveSnapshot } from "./contracts/live-conversations.js"
import { PROVIDER_FAILURE_KINDS } from "./contracts/provider-failure.js"
import { ACCESS_TIER_NAMES } from "./contracts/access.js"
import type { LiveSessionMode } from "./contracts/providers-acp.js"

export const LiveSessionModeSchema: z.ZodType<LiveSessionMode> = z.object({
  id: z.string(),
  name: z.string(),
  access: z.enum(ACCESS_TIER_NAMES).optional(),
  enforcement: z.enum(["provider", "host", "launch"]).optional(),
  description: z.string().optional(),
})

const question = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isSecret: z.boolean(),
  allowOther: z.boolean(),
  required: z.boolean().optional(),
  valueType: z
    .enum(["string", "number", "integer", "boolean", "string-array"])
    .optional(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      value: z.string().optional(),
    })
  ),
  defaultValues: z.array(z.string()).optional(),
})
export const LiveRequestSchema = z.object({
  snapshots: RunSnapshotsSchema.optional(),
  tuning: SessionSettingsSchema.optional(),
  inputDigest: z.string().optional(),
  nativeRun: z
    .object({
      bindingId: z.string(),
      runId: z.string(),
      forkId: z.string().optional(),
    })
    .optional(),
  id: z.string().uuid(),
  text: z.string().max(1_000_000),
  attachments: z.array(PromptAttachmentSchema),
  displayText: z.string().optional(),
  context: z.array(ContextManifestSchema).optional(),
  status: z.enum([
    "queued",
    "held",
    "canceled",
    "dispatching",
    "completed",
    "failed",
    "uncertain",
    "interrupted",
  ]),
  error: z.string().optional(),
  interruption: z
    .object({
      reason: z.enum(INTERRUPTION_REASONS),
      at: z.number(),
      autoContinue: z.object({ at: z.number() }).optional(),
    })
    .optional(),
  failure: z.enum(PROVIDER_FAILURE_KINDS).optional(),
  continues: z
    .object({
      requestId: z.string(),
      reason: z.enum(INTERRUPTION_REASONS),
      auto: z.boolean(),
    })
    .optional(),
})
const MetadataSchema = z.object({
  baseCoveredBlocks: z.number().int().nonnegative().optional(),
  nativeAgents: NativeAgentRosterSchema.optional(),
  control: ConversationControlSchema.optional(),
  session: z.object({
    connection: z.enum([
      "starting",
      "connected",
      "hibernated",
      "disconnected",
    ]),
    id: z.string(),
    nativeId: z.string().optional(),
    harness: z.string(),
    cwd: z.string(),
    title: z.string().optional(),
    status: z.enum(["starting", "ready", "running", "failed", "closed"]),
    // The full mode shape: a schema that kept only id and name once stripped
    // every recovered session's tiers, so after Restart Mako the picker
    // showed raw provider names with no order and no "Mako approves" detail.
    modes: z.array(LiveSessionModeSchema),
    currentMode: z.string().nullable(),
    configOptions: z.array(ModelOptionSchema),
    settings: SessionSettingsSchema.optional(),
    lastStop: z.string().optional(),
    error: z.string().optional(),
  }),
  revision: z.number().int().nonnegative(),
  threadPath: z.string().optional(),
  createdAt: z.number(),
  permissions: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      title: z.string(),
      kind: z.string().optional(),
      options: z.array(
        z.object({
          optionId: z.string(),
          name: z.string(),
          kind: z.string().optional(),
        })
      ),
      questions: z.array(question).optional(),
    })
  ),
})
const BaseSchema = z
  .object({
    ref: ThreadRefSchema,
    entries: z.array(ThreadEntrySchema),
    checkpoint: z.number().optional(),
    start: z.number(),
    total: z.number(),
    hasEarlier: z.boolean(),
  })
  .nullable()
const RowSchema = z.object({ value: z.string() })
const AppendRowSchema = z.object({
  block_id: z.number().int().nonnegative(),
  value: z.string(),
})
const AppendCountSchema = z.object({
  block_id: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
})

/**
 * One independent journal per conversation. Only changed blocks and requests
 * are written.
 *
 * WAL with `synchronous=NORMAL`: a commit appends to the WAL without an
 * fsync, and the WAL is synced at each checkpoint. A committed transaction
 * survives a host crash or kill either way — SQLite's durability against the
 * application dying does not depend on this pragma — and only a power loss
 * or kernel panic in the same instant can lose the last few commits, and the
 * provider's own store still holds those turns. Under `FULL`
 * every streamed flush fsynced the WAL on the host's main thread, several
 * times a second per running conversation.
 */
export class LiveJournal {
  private readonly db: DatabaseSync
  private readonly appends = new Map<number, number>()
  constructor(root: string, id: string) {
    z.string().uuid().parse(id)
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, `${id}.sqlite`))
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS base (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS block_appends (block_id INTEGER NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (block_id, sequence));`)
      for (const value of this.db
        .prepare(
          "SELECT block_id, count(*) AS count FROM block_appends GROUP BY block_id"
        )
        .all()) {
        const row = AppendCountSchema.parse(value)
        this.appends.set(row.block_id, row.count)
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  summary() {
    const row = this.db.prepare("SELECT value FROM metadata WHERE id=1").get()
    if (!row) return null
    const { session, revision, threadPath, createdAt, control } =
      MetadataSchema.parse(JSON.parse(RowSchema.parse(row).value))
    return {
      session,
      revision,
      threadPath,
      createdAt,
      nativePaths: control?.bindings.flatMap((binding) =>
        binding.path ? [binding.path] : []
      ),
    }
  }

  read(): LiveSnapshot | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE id=1").get()
    if (!row) return null
    const metadata = MetadataSchema.parse(
      JSON.parse(RowSchema.parse(row).value)
    )
    const base = this.db.prepare("SELECT value FROM base WHERE id=1").get()
    const blocks = this.db
      .prepare("SELECT value FROM blocks ORDER BY id")
      .all()
      .map((row) =>
        LiveBlockSchema.parse(JSON.parse(RowSchema.parse(row).value))
      )
    const tails = new Map<number, string[]>()
    for (const value of this.db
      .prepare(
        "SELECT block_id, value FROM block_appends ORDER BY block_id, sequence"
      )
      .all()) {
      const row = AppendRowSchema.parse(value)
      const parts = tails.get(row.block_id) ?? []
      parts.push(z.string().parse(JSON.parse(row.value)))
      tails.set(row.block_id, parts)
    }
    for (const [index, parts] of tails) {
      const block = blocks[index]
      if (block?.type !== "text" && block?.type !== "thinking")
        throw new Error("Journal text append has no matching block")
      blocks[index] = { ...block, text: block.text + parts.join("") }
    }
    return {
      ...metadata,
      base: base
        ? BaseSchema.parse(JSON.parse(RowSchema.parse(base).value))
        : null,
      blocks,
      requests: this.db
        .prepare("SELECT value FROM requests ORDER BY rowid")
        .all()
        .map((row) =>
          LiveRequestSchema.parse(JSON.parse(RowSchema.parse(row).value))
        ),
    }
  }

  commit(next: LiveSnapshot, previous?: LiveSnapshot): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const { blocks, requests, base, ...metadata } = next
      this.db
        .prepare("INSERT OR REPLACE INTO metadata VALUES (1, ?)")
        .run(JSON.stringify(metadata))
      if (!previous || base !== previous.base)
        this.db
          .prepare("INSERT OR REPLACE INTO base VALUES (1, ?)")
          .run(JSON.stringify(base))
      const upsertBlock = this.db.prepare(
        "INSERT OR REPLACE INTO blocks VALUES (?, ?)"
      )
      const counts = new Map<number, number>()
      const append = this.db.prepare(
        "INSERT INTO block_appends VALUES (?, ?, ?)"
      )
      const clear = this.db.prepare(
        "DELETE FROM block_appends WHERE block_id=?"
      )
      const writeBlock = (index: number) => {
        upsertBlock.run(index, JSON.stringify(blocks[index]))
        clear.run(index)
        counts.set(index, 0)
      }
      const from = previous ? changedLiveBlockStart(previous.blocks, blocks) : 0
      for (let index = from; index < blocks.length; index++) {
        const block = blocks[index]!
        const before = previous?.blocks[index]
        if (block === before) continue
        const count = this.appends.get(index) ?? 0
        if (
          next.session.status === "running" &&
          count < 128 &&
          (block.type === "text" || block.type === "thinking") &&
          before?.type === block.type &&
          before.id === block.id &&
          block.text.length > before.text.length &&
          block.text.startsWith(before.text)
        ) {
          append.run(
            index,
            count,
            JSON.stringify(block.text.slice(before.text.length))
          )
          counts.set(index, count + 1)
        } else writeBlock(index)
      }
      if (next.session.status !== "running")
        for (const index of this.appends.keys()) {
          if (index < blocks.length && !counts.has(index)) writeBlock(index)
        }
      if (!previous || blocks.length < previous.blocks.length) {
        this.db.prepare("DELETE FROM blocks WHERE id>=?").run(blocks.length)
        this.db
          .prepare("DELETE FROM block_appends WHERE block_id>=?")
          .run(blocks.length)
        for (const index of this.appends.keys())
          if (index >= blocks.length) counts.set(index, 0)
      }
      if (requests !== previous?.requests) {
        const oldRequests = new Map(
          previous?.requests.map((request) => [request.id, request])
        )
        const upsertRequest = this.db.prepare(
          "INSERT INTO requests VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value"
        )
        for (const request of requests)
          if (request !== oldRequests.get(request.id))
            upsertRequest.run(request.id, JSON.stringify(request))
      }
      this.db.exec("COMMIT")
      for (const [index, count] of counts) {
        if (count) this.appends.set(index, count)
        else this.appends.delete(index)
      }
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

export function journalIds(root: string): string[] {
  mkdirSync(root, { recursive: true })
  return readdirSync(root).flatMap((name) => {
    if (!name.endsWith(".sqlite")) return []
    const id = z.string().uuid().safeParse(name.slice(0, -7))
    return id.success ? [id.data] : []
  })
}
