import { LiveInputQuestionSchema } from "./contracts/live-questions.js"
import { ApprovalOriginSchema, NativeApprovalIdentitySchema } from "./contracts/approval-response.js"
import { PromptDeliverySchema } from "./contracts/prompt-delivery.js"
import { NativePromptReferenceSchema } from "./contracts/native-prompt-identity.js"
import { NativeAgentRosterSchema } from "./contracts/native-agents.js"
import {
  ModelOptionSchema,
  SessionSettingsSchema,
} from "@mako/sessions/settings"
import {
  ContextManifestSchema,
  ConversationControlSchema,
  NativeTotalsSchema,
  PromptAttachmentSchema,
} from "./contracts/conversation-control.js"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ExecutionContextSchema } from "./contracts/execution-context.js"
import { ThreadEntrySchema, ThreadRefSchema } from "@mako/sessions"
import {
  LiveBlockSchema,
  ToolGrowthSchema,
  changedLiveBlockStart,
  growTool,
  type ToolGrowth,
} from "@mako/sessions/live-content"
import { RunSnapshotsSchema } from "./contracts/workspace-snapshots.js"
import { ACCOUNT_SWITCH_WAITS, INTERRUPTION_REASONS, MAX_INTERRUPTED_CALLS, type LiveSnapshot } from "./contracts/live-conversations.js"
import { PROVIDER_FAILURE_KINDS } from "./contracts/provider-failure.js"
import { ActorSchema } from "./contracts/thread-identity.js"
import { ACCESS_TIER_NAMES } from "./contracts/access.js"
import type { LiveSessionMode } from "./contracts/providers-acp.js"

export const LiveSessionModeSchema: z.ZodType<LiveSessionMode> = z.object({
  id: z.string(),
  name: z.string(),
  access: z.enum(ACCESS_TIER_NAMES).optional(),
  enforcement: z.enum(["provider", "launch"]).optional(),
  description: z.string().optional(),
})

const LegacyHostModeSchema = z.object({ enforcement: z.literal("host") })


const TokenCountsSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
})
const CostSchema = z.object({ amount: z.number(), currency: z.string() })

export const LiveRequestSchema = z.object({
  actor: ActorSchema.optional(),
  nativeDelivery: PromptDeliverySchema.optional(),
  nativePrompt: NativePromptReferenceSchema.optional(),
  targetBindingId: z.string().optional(),
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
  accountSwitch: z.object({ reason: z.enum(["selection", "credentials"]), waitingFor: z.enum(ACCOUNT_SWITCH_WAITS) }).optional(),
  signIn: z.object({ harness: z.string(), account: z.string(), credential: z.string(), at: z.number() }).optional(),
  interruption: z
    .object({
      reason: z.enum(INTERRUPTION_REASONS),
      at: z.number(),
      autoContinue: z.object({ at: z.number() }).optional(),
      calls: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            result: z.enum(["none", "unseen"]),
            file: z.string().optional(),
          })
        )
        .max(MAX_INTERRUPTED_CALLS)
        .optional(),
      moreCalls: z.number().int().positive().optional(),
      told: z.number().optional(),
    })
    .optional(),
  failure: z.enum(PROVIDER_FAILURE_KINDS).optional(),
  /** The session's usage reading when this request was dispatched; `spend` is measured from it. */
  usageFrom: z.object({
    tokens: TokenCountsSchema.optional(),
    cost: CostSchema.optional(),
  }).optional(),
  /** What answering this request spent, for harnesses whose own store keeps no usage. */
  spend: z.object({
    provider: z.string(),
    model: z.string().optional(),
    at: z.number(),
    tokens: TokenCountsSchema.optional(),
    cost: z.number().nonnegative().optional(),
  }).optional(),
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
    executionContext: ExecutionContextSchema.optional(),
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
    // Retain old journals without restoring retired host-enforced choices.
    modes: z.preprocess(
      value => Array.isArray(value) ? value.filter(mode =>
        !LegacyHostModeSchema.safeParse(mode).success
      ) : value,
      z.array(LiveSessionModeSchema)
    ),
    currentMode: z.string().nullable(),
    launchMode: z.string().optional(),
    configOptions: z.array(ModelOptionSchema),
    settings: SessionSettingsSchema.optional(),
    lastStop: z.string().optional(),
    error: z.string().optional(),
    // How full the context is and the harness's own session totals belong to
    // the conversation and reopen with it; what was spent belonged to the
    // process that ended.
    usage: z.object({
      used: z.number().optional(),
      size: z.number().optional(),
      compacted: z.boolean().optional(),
      native: NativeTotalsSchema.optional(),
    }).optional(),
  }),
  revision: z.number().int().nonnegative(),
  threadPath: z.string().optional(),
  createdAt: z.number(),
  permissions: z.array(
    z.object({
      origin: ApprovalOriginSchema.optional(),
      native: NativeApprovalIdentitySchema.optional(),
      observationId: z.string().optional(),
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
      questions: z.array(LiveInputQuestionSchema).optional(),
      implementsPlan: z.object({ plan: z.string(), approve: z.string() }).optional(),
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
    translator: z.string().optional(),
  })
  .nullable()
const RowSchema = z.object({ value: z.string() })
const AppendRowSchema = z.object({
  block_id: z.number().int().nonnegative(),
  value: z.string(),
})
/** A text block's new end, stored as a JSON string, or what a tool block's input and output gained. */
const AppendValueSchema = z.union([
  z.string().transform((text) => ({ kind: "text" as const, text })),
  ToolGrowthSchema.transform((growth) => ({ kind: "tool" as const, growth })),
])
type AppendValue = z.infer<typeof AppendValueSchema>
const ProgressSchema = z.object({ revision: z.number().int().nonnegative() })

/** Kept in their own tables, or by this host only; `revision` is in `progress`, which every flush moves. */
type UnstoredMetadata = "blocks" | "requests" | "base" | "revision" | "activityAt" | "nativeActivity"

/**
 * Whether `next` holds metadata `previous` did not. Fields are compared by
 * identity, which the host keeps for what did not change, so a streamed
 * flush does not serialise a harness's commands and models again.
 */
function metadataChanged(previous: LiveSnapshot, next: LiveSnapshot): boolean {
  const changed = {
    session: previous.session !== next.session,
    control: previous.control !== next.control,
    permissions: previous.permissions !== next.permissions,
    nativeAgents: previous.nativeAgents !== next.nativeAgents,
    baseCoveredBlocks: previous.baseCoveredBlocks !== next.baseCoveredBlocks,
    threadPath: previous.threadPath !== next.threadPath,
    nativePaths: previous.nativePaths !== next.nativePaths,
    hasSessionQuestions: previous.hasSessionQuestions !== next.hasSessionQuestions,
    epoch: previous.epoch !== next.epoch,
    createdAt: previous.createdAt !== next.createdAt,
    threadId: previous.threadId !== next.threadId,
    sessionId: previous.sessionId !== next.sessionId,
    history: previous.history !== next.history,
  } satisfies Record<Exclude<keyof LiveSnapshot, UnstoredMetadata>, boolean>
  return Object.values(changed).some(Boolean)
}

const AppendCountSchema = z.object({
  block_id: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
})

/** What a journal's metadata row says about the conversation, without its content. */
export function journalSummary(metadata: string) {
  const { session, revision, threadPath, createdAt, control } =
    MetadataSchema.parse(JSON.parse(metadata))
  return {
    session,
    revision,
    threadPath,
    createdAt,
    ancestry: control?.ancestry
      ? { kind: control.ancestry.kind, parentId: control.ancestry.parentId, placement: control.ancestry.placement }
      : undefined,
    threadSession: control?.session,
    hasSessionQuestions: Boolean(control?.questions?.length),
    nativeBindings: control?.bindings ?? [{ provider: session.harness, nativeId: session.nativeId }],
    nativePaths: control?.bindings.flatMap((binding) =>
      binding.path ? [binding.path] : []
    ),
  }
}

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
  /** Journals written before `options` had its own row keep it in metadata until their next commit. */
  private optionsStored = false
  constructor(root: string, id: string) {
    z.string().uuid().parse(id)
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, `${id}.sqlite`))
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
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
      this.optionsStored = Boolean(this.db.prepare("SELECT 1 FROM options WHERE id=1").get())
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * The metadata row with the session's model options put back. They change
   * far less often than the session (Devin offers 721 model choices, 113KB),
   * so they have their own row instead of riding along with every status.
   */
  private metadata(): string | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE id=1").get()
    if (!row) return null
    const value = RowSchema.parse(row).value
    const options = this.db.prepare("SELECT value FROM options WHERE id=1").get()
    if (!options) return value
    const parsed = JSON.parse(value)
    parsed.session.configOptions = JSON.parse(RowSchema.parse(options).value)
    return JSON.stringify(parsed)
  }

  summary() {
    const metadata = this.metadata()
    if (!metadata) return null
    const summary = journalSummary(metadata)
    return { ...summary, revision: Math.max(summary.revision, this.revision()) }
  }

  /** The revision of the last commit; the metadata row keeps the one it was last written at. */
  private revision(): number {
    return ProgressSchema.safeParse(this.db.prepare("SELECT revision FROM progress WHERE id=1").get()).data?.revision ?? 0
  }

  read(): LiveSnapshot | null {
    const metadataValue = this.metadata()
    if (!metadataValue) return null
    const stored = MetadataSchema.parse(JSON.parse(metadataValue))
    const metadata = { ...stored, revision: Math.max(stored.revision, this.revision()) }
    const base = this.db.prepare("SELECT value FROM base WHERE id=1").get()
    const blocks = this.db
      .prepare("SELECT value FROM blocks ORDER BY id")
      .all()
      .map((row) =>
        LiveBlockSchema.parse(JSON.parse(RowSchema.parse(row).value))
      )
    const tails = new Map<number, AppendValue[]>()
    for (const value of this.db
      .prepare(
        "SELECT block_id, value FROM block_appends ORDER BY block_id, sequence"
      )
      .all()) {
      const row = AppendRowSchema.parse(value)
      const parts = tails.get(row.block_id) ?? []
      parts.push(AppendValueSchema.parse(JSON.parse(row.value)))
      tails.set(row.block_id, parts)
    }
    for (const [index, parts] of tails) {
      let block = blocks[index]
      for (const part of parts) {
        if (part.kind === "text" && (block?.type === "text" || block?.type === "thinking"))
          block = { ...block, text: block.text + part.text }
        else if (part.kind === "tool" && block?.type === "tool") block = growTool(block, part.growth)
        else throw new Error("Journal append has no matching block")
      }
      if (block) blocks[index] = block
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

  /** `grown`: tool blocks of `next` that differ from `previous` only by these appends (`deliverLiveUpdates`). */
  commit(next: LiveSnapshot, previous?: LiveSnapshot, grown?: ReadonlyMap<number, ToolGrowth>): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const { blocks, requests, base, ...metadata } = next
      const { configOptions, ...session } = metadata.session
      // Comes from the live harness each time and is not read back.
      delete session.commands
      const writeOptions = !this.optionsStored || configOptions !== previous?.session.configOptions
      if (writeOptions)
        this.db.prepare("INSERT OR REPLACE INTO options VALUES (1, ?)").run(JSON.stringify(configOptions))
      if (!previous || writeOptions || metadataChanged(previous, next))
        this.db
          .prepare("INSERT OR REPLACE INTO metadata VALUES (1, ?)")
          .run(JSON.stringify({ ...metadata, session, activityAt: undefined, nativeActivity: undefined }))
      this.db.prepare("INSERT OR REPLACE INTO progress VALUES (1, ?)").run(next.revision)
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
        const growth = grown?.get(index)
        if (next.session.status === "running" && count < 128 && growth && block.type === "tool" && before?.type === "tool") {
          append.run(index, count, JSON.stringify(growth))
          counts.set(index, count + 1)
        } else if (
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
      if (writeOptions) this.optionsStored = true
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
