import { LiveInputQuestionSchema } from "../contracts/live-questions.js"
import { ApprovalOriginSchema, NativeApprovalIdentitySchema } from "../contracts/approval-response.js"
import { PromptDeliverySchema } from "../contracts/prompt-delivery.js"
import { NativePromptReferenceSchema } from "../contracts/native-prompt-identity.js"
import { NativeAgentRosterSchema } from "../contracts/native-agents.js"
import { ConversationGoalSchema } from "../contracts/live-goals.js"
import { ReviewTargetSchema } from "../contracts/live-reviews.js"
import {
  ModelOptionSchema,
  SessionSettingsSchema,
} from "@mako/sessions/settings"
import {
  ContextManifestSchema,
  ConversationControlSchema,
  NativeTotalsSchema,
  PromptAttachmentSchema,
} from "../contracts/conversation-control.js"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ExecutionContextSchema } from "../contracts/execution-context.js"
import { DecodedEntrySchema, entriesFromMessages, ThreadRefSchema, type DecodedEntry, type ThreadPage } from "@mako/sessions"
import { ToolGrowthSchema, changedEntryStart, growTool, type ToolGrowth } from "@mako/sessions/live-content"
import { RunSnapshotsSchema } from "../contracts/workspace-snapshots.js"
import { ACCOUNT_SWITCH_WAITS, INTERRUPTION_REASONS, MAX_INTERRUPTED_CALLS, type LiveSnapshot } from "../contracts/live-conversations.js"
import { PROVIDER_FAILURE_KINDS } from "../contracts/provider-failure.js"
import { ActorSchema } from "../contracts/thread-identity.js"
import { ACCESS_TIER_NAMES } from "../contracts/access.js"
import type { LiveSessionMode } from "../contracts/providers-acp.js"
import { hostWarn } from "../base/host-log.js"
import { foldMakoLog, MAKO_LOG_SCHEMA, makoFacts, makoLogDifference, type MakoLogEvent, type MakoLogState } from "./mako-log.js"
import { baseKeptBecause, baseKeptOnceHeld, refreshedFacts, sourceOfPage, storedBase } from "./base-source.js"
import { RECLAIM_MIN_BYTES } from "./journal-reclaim.js"
import { cutOffRequests, mergedBase } from "./stream-merging.js"
import { errorMessage } from "../base/error-message.js"
import { EntrySchema } from "@mako/sessions/entries"

export const LiveSessionModeSchema: z.ZodType<LiveSessionMode> = z.object({
  id: z.string(),
  name: z.string(),
  access: z.enum(ACCESS_TIER_NAMES).optional(),
  enforcement: z.enum(["provider", "launch"]).optional(),
  description: z.string().optional(),
})

const LegacyHostModeSchema = z.object({ enforcement: z.literal("host") })
const DelegatedSchema = z.looseObject({ ancestry: z.looseObject({ kind: z.literal("delegation") }) })
/**
 * Delegate, retired, made each child a fork of its parent with a task: its
 * journal reads as a fork. A parent's list of children isn't read, and goes
 * at its next write.
 */
const StoredControlSchema = z.preprocess((value) => {
  const delegated = DelegatedSchema.safeParse(value)
  return delegated.success ? { ...delegated.data, ancestry: { ...delegated.data.ancestry, kind: "fork" } } : value
}, ConversationControlSchema)


const TokenCountsSchema = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
})
const CostSchema = z.object({ amount: z.number(), currency: z.string() })
const UnrecordedSchema = z.object({ tokens: z.number().int().nonnegative(), cost: z.number().int().nonnegative() })
/** What a turn spent, as Mako measured it; see `TurnSpend`. */
const TurnSpendSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  at: z.number(),
  tokens: TokenCountsSchema.optional(),
  cost: z.number().nonnegative().optional(),
  estimate: z.object({ amount: z.number().nonnegative(), currency: z.literal("USD"), table: z.string() }).optional(),
  unrecorded: z.enum(["tokens", "cost"]).optional(),
})
/** A turn Mako didn't send, or what was spent after the last; see `HarnessTurn`. */
export const HarnessTurnSchema = z.object({ id: z.string(), kind: z.enum(["turn", "after"]), spend: TurnSpendSchema })

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
  /** When the host admitted it (epoch milliseconds); unset in journals written before it was kept. */
  createdAt: z.number().nonnegative().optional(),
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
  carried: z.object({ at: z.number(), to: z.literal("cloud") }).optional(),
  // What it waits for is read again whenever the wait is checked; one this build doesn't know is its current step.
  accountSwitch: z.object({ reason: z.enum(["selection", "credentials"]), waitingFor: z.enum(ACCOUNT_SWITCH_WAITS).catch("operation") }).optional(),
  signIn: z.object({ harness: z.string(), account: z.string(), credential: z.string(), at: z.number() }).optional(),
  wake: z.object({ at: z.number(), after: z.string() }).optional(),
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
      closed: z.array(z.string()).optional(),
      stopped: z.array(z.string()).optional(),
    })
    .optional(),
  failure: z.enum(PROVIDER_FAILURE_KINDS).optional(),
  /** The session's usage reading when this request was dispatched; `spend` is measured from it. */
  usageFrom: z.object({
    tokens: TokenCountsSchema.optional(),
    cost: CostSchema.optional(),
    unrecorded: UnrecordedSchema.optional(),
  }).optional(),
  /** What answering this request spent, as Mako measured it; see `TurnSpend`. */
  spend: TurnSpendSchema.optional(),
  continues: z
    .object({
      requestId: z.string(),
      reason: z.enum(INTERRUPTION_REASONS),
      auto: z.boolean(),
    })
    .optional(),
  goal: z.object({ step: z.enum(["set", "pause", "resume", "clear", "continue"]), turn: z.number().int().positive().optional() }).optional(),
  review: ReviewTargetSchema.optional(),
  verbatim: z.literal(true).optional(),
})
const MetadataSchema = z.object({
  baseSource: z.object({
    harness: z.string(), nativeId: z.string(), path: z.string(),
    span: z.object({ entries: z.number().int().nonnegative(), ids: z.string(), heldAt: z.number() }).optional(),
  }).optional(),
  baseCoveredBlocks: z.number().int().nonnegative().optional(),
  baseLiveStart: z.number().int().nonnegative().optional(),
  baseSupplied: z.number().int().nonnegative().optional(),
  nativeAgents: NativeAgentRosterSchema.optional(),
  goal: ConversationGoalSchema.optional(),
  control: StoredControlSchema.optional(),
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
      compactedFrom: z.number().optional(),
      // Journals before October 12 kept the old reading beside a flag; it reopens as what the context held before.
      compacted: z.boolean().optional(),
      native: NativeTotalsSchema.optional(),
    }).transform(({ compacted, used, ...usage }) =>
      compacted && used !== undefined ? { ...usage, compactedFrom: used } : used === undefined ? usage : { ...usage, used }
    ).optional(),
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
      detail: z.string().optional(),
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
      feedbackOption: z.string().optional(),
      gone: z.literal(true).optional(),
    })
  ),
})
const BaseFields = z.object({
  ref: ThreadRefSchema,
  checkpoint: z.number().optional(),
  start: z.number(),
  total: z.number(),
  hasEarlier: z.boolean(),
  translator: z.string().optional(),
})
const BaseSchema = BaseFields.extend({ entries: z.array(EntrySchema) })
/** A base stored before 2026-10-15, its entries grouped into messages and its indices counting them. */
const MessageBaseSchema = BaseFields.extend({ entries: z.array(DecodedEntrySchema) })

/**
 * The stored base, and for one that counted messages, the index each
 * message index of it is in entries: a message is as many entries as it
 * has items, and its page keeps its start.
 */
export function readBase(text: string): { base: ThreadPage; entryIndex?: (message: number) => number } | null {
  const value = JSON.parse(text)
  if (value === null) return null
  const flat = BaseSchema.safeParse(value)
  if (flat.success) return { base: flat.data }
  const grouped = MessageBaseSchema.parse(value)
  const starts = [0]
  for (const message of grouped.entries) starts.push(starts.at(-1)! + itemsIn(message))
  const entries = entriesFromMessages(grouped.entries)
  const { start } = grouped
  const entryIndex = (message: number) => start + starts[Math.max(0, Math.min(message - start, grouped.entries.length))]!
  const total = entryIndex(Math.min(grouped.total, start + grouped.entries.length)) + Math.max(0, grouped.total - start - grouped.entries.length)
  return { base: { ...grouped, entries, total }, entryIndex }
}

function itemsIn(message: DecodedEntry): number {
  return message.kind === "assistant" ? message.blocks.length : 1
}
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

/**
 * Mako's log (`mako-log.ts`), in the conversation's own file so each event
 * commits with the rows it changes. `origin` is `host` for what this build
 * did and `journal` for facts taken in from rows an earlier build wrote.
 */
const MAKO_LOG_TABLE = `CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
  origin TEXT NOT NULL, schema INTEGER NOT NULL);`
const LogRowSchema = z.object({
  seq: z.number().int().positive(),
  at: z.number(),
  kind: z.string(),
  value: z.string(),
  origin: z.enum(["host", "journal"]),
  schema: z.number().int().positive(),
})
const LogValueSchema = z.record(z.string(), z.json())
export type MakoLogEntry = Omit<z.infer<typeof LogRowSchema>, "value"> & MakoLogEvent

/**
 * Kept in their own tables, or by this host only; `revision` is in `progress`, which every flush moves; `wakeAt` is
 * read from `requests`. `elsewhere` and
 * `copy` are a cloud router's word on a conversation it relays or reads from the account's copy, never a journal's.
 */
type UnstoredMetadata = "blocks" | "requests" | "harnessTurns" | "spentThrough" | "base" | "revision" | "activityAt" | "nativeActivity" | "side" | "historyFailure" | "elsewhere" | "waitingOn" | "copy" | "wakeAt"

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
    goal: previous.goal !== next.goal,
    baseSource: previous.baseSource !== next.baseSource,
    baseCoveredBlocks: previous.baseCoveredBlocks !== next.baseCoveredBlocks,
    baseLiveStart: previous.baseLiveStart !== next.baseLiveStart,
    baseSupplied: previous.baseSupplied !== next.baseSupplied,
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

/** The metadata row with the session's model options, which have a row of their own, put back. */
function metadataRow(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM metadata WHERE id=1").get()
  if (!row) return null
  const value = RowSchema.parse(row).value
  const options = db.prepare("SELECT value FROM options WHERE id=1").get()
  if (!options) return value
  const parsed = JSON.parse(value)
  parsed.session.configOptions = JSON.parse(RowSchema.parse(options).value)
  return JSON.stringify(parsed)
}

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
      ? { parentId: control.ancestry.parentId, placement: control.ancestry.placement }
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
  private readonly path: string
  private readonly appends = new Map<number, number>()
  /** Mako's log folded, once read; a failed commit drops it so the next reads it again. */
  private log?: MakoLogState
  /** Journals written before `options` had its own row keep it in metadata until their next commit. */
  private optionsStored = false
  /** The stored base counts messages (`readBase`): the next commit writes it and the metadata again. */
  private messageBase = false
  constructor(root: string, id: string) {
    z.string().uuid().parse(id)
    mkdirSync(root, { recursive: true })
    this.path = join(root, `${id}.sqlite`)
    this.db = new DatabaseSync(this.path)
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS base (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_turns (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS block_appends (block_id INTEGER NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (block_id, sequence));
      ${MAKO_LOG_TABLE}`)
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
    return metadataRow(this.db)
  }

  summary() {
    const metadata = this.metadata()
    if (!metadata) return null
    const summary = journalSummary(metadata)
    const wakeAt = this.wakeAt()
    return { ...summary, revision: Math.max(summary.revision, this.revision()), ...wakeAt !== undefined && { wakeAt } }
  }

  /** The soonest a held request here sends itself (`LiveRequest.wake`); only rows that name a wake are parsed. */
  private wakeAt(): number | undefined {
    let soonest: number | undefined
    for (const row of this.db.prepare("SELECT value FROM requests WHERE value LIKE '%\"wake\"%'").all()) {
      const request = LiveRequestSchema.safeParse(JSON.parse(RowSchema.parse(row).value)).data
      if (request?.status === "held" && request.wake && (soonest === undefined || request.wake.at < soonest)) soonest = request.wake.at
    }
    return soonest
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
        EntrySchema.parse(JSON.parse(RowSchema.parse(row).value))
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
    const read = base ? readBase(RowSchema.parse(base).value) : null
    // Until the next commit writes both, the base row and `baseLiveStart` stay in messages.
    this.messageBase = Boolean(read?.entryIndex)
    const baseLiveStart = read?.entryIndex && metadata.baseLiveStart !== undefined ? read.entryIndex(metadata.baseLiveStart) : metadata.baseLiveStart
    const requests = this.db
      .prepare("SELECT value FROM requests ORDER BY rowid")
      .all()
      .map((row) =>
        LiveRequestSchema.parse(JSON.parse(RowSchema.parse(row).value))
      )
    const harnessTurns = this.db
      .prepare("SELECT value FROM harness_turns ORDER BY rowid")
      .all()
      .map((row) => HarnessTurnSchema.parse(JSON.parse(RowSchema.parse(row).value)))
    const snapshot: LiveSnapshot = {
      ...metadata,
      ...harnessTurns.length && { harnessTurns },
      ...baseLiveStart !== undefined && { baseLiveStart },
      // A base an earlier build kept unmerged reads as every other reading of it does.
      base: read ? mergedBase(read.base, blocks, metadata.baseCoveredBlocks ?? 0, baseLiveStart, { cutOff: cutOffRequests(requests) }).base : null,
      blocks,
      requests,
    }
    this.reconcile(snapshot)
    return snapshot
  }

  /**
   * Brings Mako's log up to the rows it caches. Every commit writes both, so
   * they differ only for a journal a build before the log wrote, whose facts
   * are taken in as the journal had them, or by a fault, which is logged.
   */
  private reconcile(snapshot: LiveSnapshot): void {
    const begun = Boolean(this.log) || Boolean(this.db.prepare("SELECT 1 AS found FROM log LIMIT 1").get())
    const events = this.logState().advance(makoFacts(snapshot))
    if (!events.length) return
    if (begun) hostWarn("journal", "Mako's log differed from its rows; took the rows' facts in", {
      conversation: snapshot.session.id, events: events.length, kinds: [...new Set(events.map((event) => event.kind))].join(","),
    })
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.appendLog(events, "journal")
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.log = undefined
      throw error
    }
  }

  private logState(): MakoLogState {
    this.log ??= foldMakoLog(this.makoLog())
    return this.log
  }

  private appendLog(events: readonly MakoLogEvent[], origin: "host" | "journal"): void {
    const insert = this.db.prepare("INSERT INTO log (at, kind, value, origin, schema) VALUES (?, ?, ?, ?, ?)")
    const at = Date.now()
    for (const event of events) insert.run(at, event.kind, JSON.stringify(event.value), origin, MAKO_LOG_SCHEMA)
  }

  /** `grown`: tool blocks of `next` that differ from `previous` only by these appends (`deliverLiveUpdates`). */
  commit(next: LiveSnapshot, previous?: LiveSnapshot, grown?: ReadonlyMap<number, ToolGrowth>): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const { blocks, requests, harnessTurns, ...metadata } = next
      const { configOptions, ...session } = metadata.session
      // Comes from the live harness each time and is not read back.
      delete session.commands
      const writeOptions = !this.optionsStored || configOptions !== previous?.session.configOptions
      if (writeOptions)
        this.db.prepare("INSERT OR REPLACE INTO options VALUES (1, ?)").run(JSON.stringify(configOptions))
      if (!previous || writeOptions || this.messageBase || metadataChanged(previous, next))
        this.db
          .prepare("INSERT OR REPLACE INTO metadata VALUES (1, ?)")
          .run(JSON.stringify({ ...metadata, session, base: undefined, activityAt: undefined, nativeActivity: undefined, side: undefined, historyFailure: undefined, spentThrough: undefined }))
      this.db.prepare("INSERT OR REPLACE INTO progress VALUES (1, ?)").run(next.revision)
      // An unread base stays unread here: Mako's own blocks can follow it
      // meanwhile, and nothing reaches its harness until it is read.
      const stored = storedBase(next)
      if (!previous || this.messageBase || stored !== storedBase(previous))
        this.db
          .prepare("INSERT OR REPLACE INTO base VALUES (1, ?)")
          .run(JSON.stringify(stored))
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
      const from = previous ? changedEntryStart(previous.blocks, blocks) : 0
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
        const kept = new Set(requests.map((request) => request.id))
        if (!previous || previous.requests.some((request) => !kept.has(request.id)))
          this.db.prepare("DELETE FROM requests WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...kept]))
      }
      // Each is kept as it ends and never changes.
      if (harnessTurns !== previous?.harnessTurns && harnessTurns?.length) {
        const kept = new Set(previous?.harnessTurns?.map((turn) => turn.id))
        const insert = this.db.prepare("INSERT OR IGNORE INTO harness_turns VALUES (?, ?)")
        for (const turn of harnessTurns) if (!kept.has(turn.id)) insert.run(turn.id, JSON.stringify(turn))
      }
      const events = this.logState().advance(makoFacts(next))
      if (events.length) this.appendLog(events, "host")
      if (events.length && process.env.MAKO_LOG_CHECK === "1") {
        const difference = makoLogDifference(this.makoLog(), makoFacts(next))
        if (difference) throw new Error(`Mako's log lost a change to ${next.session.id}'s facts. ${difference}`)
      }
      this.db.exec("COMMIT")
      if (writeOptions) this.optionsStored = true
      this.messageBase = false
      for (const [index, count] of counts) {
        if (count) this.appends.set(index, count)
        else this.appends.delete(index)
      }
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.log = undefined
      throw error
    }
  }

  /** Mako's log, oldest first. */
  makoLog(): MakoLogEntry[] {
    return this.db.prepare("SELECT seq, at, kind, value, origin, schema FROM log ORDER BY seq").all().map((row) => {
      const entry = LogRowSchema.parse(row)
      return { ...entry, value: LogValueSchema.parse(JSON.parse(entry.value)) }
    })
  }

  /** `compact` is handed the closed file when a dropped copy left much of it free (`JournalReclaims`). */
  close(compact?: (path: string) => void): void {
    const free = compact !== undefined && this.mostlyFree()
    this.db.close()
    if (free) compact(this.path)
  }

  private mostlyFree(): boolean {
    try {
      const { page_size: size } = z.object({ page_size: z.number() }).parse(this.db.prepare("PRAGMA page_size").get())
      const { page_count: pages } = z.object({ page_count: z.number() }).parse(this.db.prepare("PRAGMA page_count").get())
      const { freelist_count: free } = z.object({ freelist_count: z.number() }).parse(this.db.prepare("PRAGMA freelist_count").get())
      return free * size >= RECLAIM_MIN_BYTES && free * 4 >= pages
    } catch (error) {
      hostWarn("journal", "a journal's free space could not be read", { path: this.path, error: errorMessage({ error }) })
      return false
    }
  }
}

/** The bytes of the copy of its history journal `id` keeps; 0 when it keeps none. */
export function copiedBaseBytes(root: string, id: string): number {
  const db = new DatabaseSync(join(root, `${id}.sqlite`), { readOnly: true })
  try {
    const row = z.object({ bytes: z.number().nullable() }).optional().parse(db.prepare("SELECT length(value) AS bytes FROM base WHERE id = 1").get())
    return row?.bytes && row.bytes > "null".length ? row.bytes : 0
  } finally {
    db.close()
  }
}

const BaseHeaderSchema = z.object({
  bytes: z.number().nullable(),
  start: z.number().nullable(),
  hasEarlier: z.number().nullable(),
  preview: z.number().nullable(),
  harness: z.string().nullable(),
  nativeId: z.string().nullable(),
  path: z.string().nullable(),
  entries: z.number().nullable(),
})
const PragmaSchema = z.object({ size: z.number(), pages: z.number(), free: z.number() })

export type JournalInspection = ReturnType<typeof inspectJournal>

/**
 * What journal `id` keeps, read without writing or decoding its content:
 * its size and free space, and where its base comes from and why.
 */
export function inspectJournal(root: string, id: string) {
  const path = join(root, `${id}.sqlite`)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = metadataRow(db)
    if (!row) throw new Error("The journal has no metadata row")
    const metadata = MetadataSchema.parse(JSON.parse(row))
    const header = BaseHeaderSchema.optional().parse(db.prepare(`SELECT length(value) AS bytes,
      json_extract(value, '$.start') AS start, json_extract(value, '$.hasEarlier') AS hasEarlier, json_extract(value, '$.preview') AS preview,
      json_extract(value, '$.ref.harness') AS harness, json_extract(value, '$.ref.nativeId') AS nativeId, json_extract(value, '$.ref.path') AS path,
      json_array_length(value, '$.entries') AS entries FROM base WHERE id=1`).get())
    const base = header?.harness && header.nativeId && header.path && header.start !== null
      ? { start: header.start, hasEarlier: Boolean(header.hasEarlier), preview: Boolean(header.preview), ref: { harness: header.harness, nativeId: header.nativeId, path: header.path } }
      : null
    const { count: blocks } = z.object({ count: z.number() }).parse(db.prepare("SELECT count(*) AS count FROM blocks").get())
    const pages = PragmaSchema.parse(db.prepare("SELECT (SELECT page_size FROM pragma_page_size) AS size, (SELECT page_count FROM pragma_page_count) AS pages, (SELECT freelist_count FROM pragma_freelist_count) AS free").get())
    const facts = { base, baseSource: metadata.baseSource, baseCoveredBlocks: metadata.baseCoveredBlocks, blocks: { length: blocks }, control: metadata.control }
    // What the sweep holds: the base as its refresh reads it again.
    const refreshed = refreshedFacts(facts)
    const candidate = refreshed.base && !metadata.baseSource ? sourceOfPage(refreshed.base) : undefined
    return {
      id,
      path,
      session: { harness: metadata.session.harness, nativeId: metadata.session.nativeId, title: metadata.session.title },
      createdAt: metadata.createdAt,
      fork: metadata.control?.ancestry?.kind === "fork",
      blocks,
      bytes: pages.size * pages.pages,
      freeBytes: pages.size * pages.free,
      copiedBaseBytes: header?.bytes && header.bytes > "null".length ? header.bytes : 0,
      baseEntries: header?.entries ?? 0,
      baseSource: metadata.baseSource,
      /** Null when the base is read from `baseSource` on open, or there is none. */
      keptBecause: base || metadata.baseSource ? baseKeptBecause(facts) : null,
      /** The session a stored base could be read from instead, once the sweep has read it again and the record store holds it. */
      candidate,
      /** Why the copy would stay even then; null when the sweep drops it. */
      keptOnceHeldBecause: candidate ? baseKeptOnceHeld(refreshed) : null,
    }
  } finally {
    db.close()
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
