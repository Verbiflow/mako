import type { SnapshotSettlement } from "../contracts/snapshot-budget.js"
import { ProviderFailureEvidenceSchema } from "../contracts/provider-failure-evidence.js"
import { LiveInputQuestionSchema } from "../contracts/live-questions.js"
import { ApprovalOriginSchema, NativeApprovalIdentitySchema } from "../contracts/approval-response.js"
import { PromptDeliverySchema } from "../contracts/prompt-delivery.js"
import { NativePromptReferenceSchema } from "../contracts/native-prompt-identity.js"
import { NativeAgentRosterSchema, providerRoster, sameProviderWork } from "../contracts/native-agents.js"
import { NoticeSchema } from "../contracts/agents.js"
import { ConversationGoalSchema } from "../contracts/live-goals.js"
import { ReviewTargetSchema } from "../contracts/live-reviews.js"
import {
  ModelOptionSchema,
  SessionSettingsSchema,
} from "@mako/sessions/settings"
import {
  ContextManifestSchema,
  ConversationControlSchema,
  readStoredReason,
  StoredReason,
  NativeTotalsSchema,
  PromptAttachmentSchema,
  RequestRetrySchema,
} from "../contracts/conversation-control.js"
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ExecutionContextSchema } from "../contracts/execution-context.js"
import { DecodedEntrySchema, entriesFromMessages, ThreadRefSchema, type DecodedEntry, type ThreadPage } from "@mako/sessions"
import { ToolGrowthSchema, changedEntryStart, continues, growTool, type ToolGrowth } from "@mako/sessions/live-content"
import { RunSnapshotsSchema } from "../contracts/workspace-snapshots.js"
import { RequestChangesSchema } from "../contracts/turn-changes.js"
import { TurnUndoneSchema } from "../contracts/turn-review.js"
import { ACCOUNT_SWITCH_WAITS, MAX_INTERRUPTED_CALLS, savedReason, type LiveRequest, type LiveSnapshot } from "../contracts/live-conversations.js"
import { PROVIDER_FAILURE_KINDS } from "../contracts/provider-failure.js"
import { ActorSchema } from "../contracts/thread-identity.js"
import { laterPrompt, personPromptedAt, type PromptedRequest } from "../contracts/worked-at.js"
import { ACCESS_TIER_NAMES } from "../contracts/access.js"
import type { LiveSessionMode } from "../contracts/providers-acp.js"
import { hostWarn } from "../base/host-log.js"
import { foldMakoLog, MAKO_LOG_SCHEMA, makoFacts, makoLogDifference, type MakoLogEvent, type MakoLogState } from "./mako-log.js"
import { baseKeptBecause, baseKeptOnceHeld, refreshedFacts, sourceOfPage, storedBase } from "./base-source.js"
import { RECLAIM_MIN_BYTES } from "./journal-reclaim.js"
import { cutOffRequests, mergedBaseSteps } from "./stream-merging.js"
import { errorMessage } from "../base/error-message.js"
import { EntrySchema, type Entry } from "@mako/sessions/entries"
import { sharedBase } from "./shared-entries.js"
import { EntryPager, type PagedRows, type PagedTable } from "./paged-entries.js"
import { atOnce, inSlices, StepsStopped, type Steps } from "@mako/sessions/slices"
import { holdDue, holdOf, sooner, transferDue } from "../contracts/request-hold.js"

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

/**
 * A request as its row keeps it: a reason older builds don't know saved as the
 * one they read it as, with the exact one beside it (`OLDER_READING`), so a
 * journal this build writes still opens in a build before it.
 */
function requestRow(request: LiveRequest): string {
  const { interruption, continues } = request
  if (!interruption && !continues) return JSON.stringify(request)
  return JSON.stringify({
    ...request,
    ...interruption && { interruption: { ...interruption, ...savedReason(interruption.reason) } },
    ...continues && { continues: { ...continues, ...savedReason(continues.reason) } },
  })
}

/** The conversation's control as the metadata row keeps it: a transfer's continuation saved as a request's is (`requestRow`). */
function controlRow(control: LiveSnapshot["control"]): LiveSnapshot["control"] {
  if (!control?.transfers.some((transfer) => transfer.continues)) return control
  return {
    ...control,
    transfers: control.transfers.map((transfer) => transfer.continues ? { ...transfer, continues: { ...transfer.continues, ...savedReason(transfer.continues.reason) } } : transfer),
  }
}

export const LiveRequestSchema = z.object({
  actor: ActorSchema.optional(),
  grants: z.array(z.string().max(1024)).max(100).optional(),
  nativeDelivery: PromptDeliverySchema.optional(),
  nativePrompt: NativePromptReferenceSchema.optional(),
  targetBindingId: z.string().optional(),
  snapshots: RunSnapshotsSchema.optional(),
  changes: RequestChangesSchema,
  undone: TurnUndoneSchema,
  tuning: SessionSettingsSchema.optional(),
  mode: z.string().optional(),
  ruleLines: z.array(z.string()).optional(),
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
  admissionOrder: z.number().int().positive().optional(),
  notification: z.literal(true).optional(),
  dispatchedAt: z.number().optional(),
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
  ownerCheck: z.object({ since: z.number() }).optional(),
  editing: z.literal(true).optional(),
  pause: z.literal("stop").optional(),
  signIn: z.object({ harness: z.string(), account: z.string(), credential: z.string(), at: z.number() }).optional(),
  wake: z.object({ at: z.number(), after: z.string() }).optional(),
  retry: RequestRetrySchema.optional(),
  digest: z.object({ notices: z.array(NoticeSchema), lines: z.array(z.string()).optional(), sentAt: z.number().optional(), heard: z.literal(true).optional(), resting: z.literal(true).optional(), nextTry: z.number().optional() }).optional(),
  interruption: z
    .object({
      ...StoredReason,
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
      since: z.number().optional(),
      told: z.number().optional(),
      closed: z.array(z.string()).optional(),
      stopped: z.array(z.string()).optional(),
    })
    .transform(readStoredReason)
    .optional(),
  failure: z.enum(PROVIDER_FAILURE_KINDS).optional(),
  failureEvidence: ProviderFailureEvidenceSchema.optional(),
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
      ...StoredReason,
      auto: z.boolean(),
      brief: z.string().optional(),
      since: z.number().optional(),
    })
    .transform(readStoredReason)
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
    failureEvidence: ProviderFailureEvidenceSchema.optional(),
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

/** How many rows a journal's read (`LiveJournal.reading`) reads and parses between two stops. */
const ROWS_PER_STEP = 128

/** How long `stageBase` writes rows before it lets other work run. */
const STAGE_SLICE_MS = 4
/** The same while something waits for the rows (`writtenAhead`): a turn about to start. */
const STAGE_SLICE_WAITED_MS = 8
/**
 * Pages of the write-ahead log a commit checkpoints at while rows are written
 * ahead. The commit that crosses the mark copies and syncs what the commits
 * since wrote; at SQLite's 1,000 pages (4MB), writing a history of 150MB
 * ahead crossed it 40 times, and now and then one of those commits held the
 * loop for 75ms. A quarter of that a time stays well inside 50ms.
 */
const STAGE_CHECKPOINT_PAGES = 256

/** Where a run of `writeBaseRows` stopped, and the entry each row it wrote holds. */
interface RowsWritten {
  at: number
  rows: Map<number, Entry>
}

/** What a commit wrote of the base: no copy, or the rows it wrote and how many the copy has. */
type BaseWrite = { kept: false } | { kept: true; rows: Map<number, Entry>; length: number }

/** The base row of a base kept an entry a row (`base_entries`): its page without entries, and how many rows hold them. */
const BaseHeaderRowSchema = BaseFields.extend({ entryRows: z.number().int().nonnegative() })
const BaseEntryRowSchema = z.object({ id: z.number().int().nonnegative(), value: z.string() })

/** A stored base as `readBase` gives it back. `whole` is one an earlier build wrote as one row: written as rows once it changes. */
export interface StoredBase {
  base: ThreadPage
  entryIndex?: (message: number) => number
  whole?: true
}

/**
 * The base journal `db` keeps: none, or its page with its entries read from
 * their rows. One an earlier build kept whole in the base row reads too.
 */
export function readBase(db: DatabaseSync): StoredBase | null {
  return atOnce(readBaseSteps(db))
}

/** `readBase` as `Steps`: its rows are read and parsed `ROWS_PER_STEP` at a time. */
function* readBaseSteps(db: DatabaseSync): Steps<StoredBase | null> {
  return storedBaseOf(yield* baseRowSteps(db))
}

/**
 * The base row and its entries' rows, read and parsed: plain data, so a reader (`JournalReaders`) can read them and
 * hand them over. A base an earlier build kept in the base row is handed over as that row says it.
 */
type BaseRows = { kind: "rows"; page: Omit<z.infer<typeof BaseHeaderRowSchema>, "entryRows">; entries: Entry[] } | { kind: "value"; value: unknown }

function* baseRowSteps(db: DatabaseSync): Steps<BaseRows | null> {
  const row = db.prepare("SELECT value FROM base WHERE id=1").get()
  if (!row) return null
  const value: unknown = JSON.parse(RowSchema.parse(row).value)
  if (value === null) return null
  const header = BaseHeaderRowSchema.safeParse(value)
  if (!header.success) return { kind: "value", value }
  const { entryRows, ...page } = header.data
  const entries: Entry[] = []
  const rows = db.prepare("SELECT id, value FROM base_entries WHERE id >= ? AND id < ? ORDER BY id")
  for (let from = 0; from < entryRows; from += ROWS_PER_STEP) {
    for (const stored of rows.all(from, Math.min(from + ROWS_PER_STEP, entryRows))) {
      const entry = BaseEntryRowSchema.parse(stored)
      if (entry.id !== entries.length) throw new Error(`The journal's history is missing entry ${entries.length}`)
      entries.push(EntrySchema.parse(JSON.parse(entry.value)))
    }
    if (entries.length !== Math.min(from + ROWS_PER_STEP, entryRows)) break
    yield
  }
  if (entries.length !== entryRows) throw new Error(`The journal's history holds ${entries.length} of its ${entryRows} entries`)
  return { kind: "rows", page, entries }
}

/** The base `rows` say, as `readBase` gives it back. */
function storedBaseOf(rows: BaseRows | null): StoredBase | null {
  if (!rows) return null
  if (rows.kind === "rows") return { base: { ...rows.page, entries: rows.entries } }
  const { value } = rows
  const flat = BaseSchema.safeParse(value)
  if (flat.success) return { base: flat.data, whole: true }
  const grouped = MessageBaseSchema.parse(value)
  const starts = [0]
  for (const message of grouped.entries) starts.push(starts.at(-1)! + itemsIn(message))
  const entries = entriesFromMessages(grouped.entries)
  const { start } = grouped
  const entryIndex = (message: number) => start + starts[Math.max(0, Math.min(message - start, grouped.entries.length))]!
  const total = entryIndex(Math.min(grouped.total, start + grouped.entries.length)) + Math.max(0, grouped.total - start - grouped.entries.length)
  return { base: { ...grouped, entries, total }, entryIndex, whole: true }
}

/**
 * Everything a journal's rows hold that its snapshot is made of, read and parsed (`journalRowSteps`): plain data,
 * read here or on a reader (`JournalReaders`) and made into the snapshot by the journal that owns the file.
 */
export interface JournalRows {
  metadata: string
  revision: number
  blocks: Entry[]
  appends: { block: number; value: AppendValue }[]
  base: BaseRows | null
  requests: LiveRequest[]
  order: string[] | undefined
  harnessTurns: z.infer<typeof HarnessTurnSchema>[]
  /** Mako's log, when it was asked for, and whether it holds anything. */
  log: MakoLogEntry[] | undefined
  logBegun: boolean
}

/** How often a read on a reader looks whether its host is stopping. */
const STOP_LOOK_MS = 20

/** Reads a journal file's rows elsewhere than the loop (`JournalReaders.read`); `withLog` reads Mako's log too. */
export type JournalReader = (path: string, withLog: boolean) => Promise<JournalRows | null>

/** A journal's rows, `ROWS_PER_STEP` at a time; null for one with nothing kept yet. Run in one read transaction. */
export function* journalRowSteps(db: DatabaseSync, withLog: boolean): Steps<JournalRows | null> {
  const metadata = metadataRow(db)
  if (!metadata) return null
  const revision = ProgressSchema.safeParse(db.prepare("SELECT revision FROM progress WHERE id=1").get()).data?.revision ?? 0
  const blocks: Entry[] = []
  const blockRows = db.prepare("SELECT id, value FROM blocks WHERE id > ? ORDER BY id LIMIT ?")
  for (let last = -1; ;) {
    const rows = blockRows.all(last, ROWS_PER_STEP)
    for (const row of rows) {
      const block = BlockRowSchema.parse(row)
      blocks.push(EntrySchema.parse(JSON.parse(block.value)))
      last = block.id
    }
    if (rows.length < ROWS_PER_STEP) break
    yield
  }
  const appends = db.prepare("SELECT block_id, value FROM block_appends ORDER BY block_id, sequence").all().map((value) => {
    const row = AppendRowSchema.parse(value)
    return { block: row.block_id, value: AppendValueSchema.parse(JSON.parse(row.value)) }
  })
  const base = yield* baseRowSteps(db)
  const requests: LiveRequest[] = []
  const requestRows = db.prepare("SELECT rowid AS at, value FROM requests WHERE rowid > ? ORDER BY rowid LIMIT ?")
  for (let last = -1; ;) {
    const rows = requestRows.all(last, ROWS_PER_STEP)
    for (const row of rows) {
      const request = RowAtSchema.parse(row)
      requests.push(LiveRequestSchema.parse(JSON.parse(request.value)))
      last = request.at
    }
    if (rows.length < ROWS_PER_STEP) break
    yield
  }
  const orderRow = db.prepare("SELECT keys FROM request_order WHERE id=1").get()
  const order = orderRow ? z.array(z.string()).safeParse(JSON.parse(RowKeysSchema.parse(orderRow).keys)).data : undefined
  const harnessTurns = db.prepare("SELECT value FROM harness_turns ORDER BY rowid").all()
    .map((row) => HarnessTurnSchema.parse(JSON.parse(RowSchema.parse(row).value)))
  const logBegun = Boolean(db.prepare("SELECT 1 AS found FROM log LIMIT 1").get())
  const log = withLog ? yield* makoLogRowSteps(db) : undefined
  return { metadata, revision, blocks, appends, base, requests, order, harnessTurns, log, logBegun }
}

function* makoLogRowSteps(db: DatabaseSync): Steps<MakoLogEntry[]> {
  const entries: MakoLogEntry[] = []
  const rows = db.prepare("SELECT seq, at, kind, value, origin, schema FROM log WHERE seq > ? ORDER BY seq LIMIT ?")
  for (let last = 0; ;) {
    const read = rows.all(last, ROWS_PER_STEP * 4)
    for (const row of read) {
      const entry = LogRowSchema.parse(row)
      entries.push({ ...entry, value: LogValueSchema.parse(JSON.parse(entry.value)) })
      last = entry.seq
    }
    if (read.length < ROWS_PER_STEP * 4) return entries
    yield
  }
}

function itemsIn(message: DecodedEntry): number {
  return message.kind === "assistant" ? message.blocks.length : 1
}
const RowSchema = z.object({ value: z.string() })
const BlockRowSchema = z.object({ id: z.number().int(), value: z.string() })
const RowAtSchema = z.object({ at: z.number().int(), value: z.string() })
const RowKeysSchema = z.object({ keys: z.string() })

/**
 * Whether `next` is `previous` with requests added after it and none moved: the rows' insertion order still says the
 * queue's, so no `request_order` row is needed. A removal keeps the order of the rest.
 */
function appendedTo(previous: readonly LiveRequest[] | undefined, next: readonly LiveRequest[]): boolean {
  if (!previous) return true
  const known = new Set(previous.map((request) => request.id))
  let at = 0
  let added = false
  for (const request of next) {
    if (!known.has(request.id)) {
      added = true
      continue
    }
    if (added) return false
    while (at < previous.length && previous[at]!.id !== request.id) at++
    if (at === previous.length) return false
    at++
  }
  return true
}

/** `requests` sorted in place by `order`; any it doesn't name keep their place after those it does. */
function inOrder(requests: LiveRequest[], order: readonly string[]): void {
  const place = new Map(order.map((id, index) => [id, index]))
  const indexed = requests.map((request, index) => ({ request, key: place.get(request.id) ?? order.length + index }))
  indexed.sort((left, right) => left.key - right.key)
  indexed.forEach((item, index) => { requests[index] = item.request })
}
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
/** The `prompted` row: when the person last sent a request here, or null for never, and how many requests it read. */
const PromptedRowSchema = z.object({ at: z.number().nonnegative().nullable(), requests: z.number().int().nonnegative() })
const CountSchema = z.object({ count: z.number().int().nonnegative() })
/** A request's admission and who sent it, as `requestTimes` projects them; an older journal's request has neither. */
const RequestTimeSchema = z.object({ at: z.number().nonnegative().nullable(), kind: z.enum(["person", "agent", "service"]).nullable() })

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
 * read from `requests`, and `promptedAt` from `prompted`, which each commit of the requests keeps. `elsewhere`, `elsewhereKind`, `order`,
 * `waitingOn`, `waitingFor`, `attention`, `threadTitle`, `quietSince`, `cloudContinue`, `movedAt`, `rail` and `copy` are a cloud
 * router's word on a conversation it relays or reads from the account's copy, never a journal's. `parent` is its
 * Thread's edge, read from the Thread store whenever it's listed, and `children` its children's count, read from them.
 */
type UnstoredMetadata = "parent" | "children" | "fins" | "blocks" | "requests" | "harnessTurns" | "spentThrough" | "base" | "revision" | "activityAt" | "nativeActivity" | "side" | "historyFailure" | "elsewhere" | "elsewhereKind" | "waitingOn" | "waitingFor" | "attention" | "threadTitle" | "quietSince" | "cloudContinue" | "movedAt" | "rail" | "copy" | "wakeAt" | "promptedAt" | "order"

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
    nativeAgents: previous.nativeAgents !== next.nativeAgents && !sameProviderWork(previous.nativeAgents, next.nativeAgents),
    goal: previous.goal !== next.goal,
    baseSource: previous.baseSource !== next.baseSource,
    baseCoveredBlocks: previous.baseCoveredBlocks !== next.baseCoveredBlocks,
    baseLiveStart: previous.baseLiveStart !== next.baseLiveStart,
    baseSupplied: previous.baseSupplied !== next.baseSupplied,
    threadPath: previous.threadPath !== next.threadPath,
    nativePaths: previous.nativePaths !== next.nativePaths,
    nativeIds: previous.nativeIds !== next.nativeIds,
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
    nativeIds: control?.bindings.flatMap((binding) =>
      binding.nativeId ? [{ provider: binding.provider, nativeId: binding.nativeId }] : []
    ),
    steeredAt: personPromptedAt(undefined, control?.actions),
    transferWakeAt: transferDue(control),
  }
}

/**
 * A commit the journal couldn't make: the conversation isn't saved (`storageFailed`). Anything else that goes wrong
 * taking in what a provider said is not this, and doesn't stop its turn.
 */
export class JournalWriteError extends Error {
  constructor(cause: unknown) {
    super(errorMessage({ error: cause }), { cause })
    this.name = "JournalWriteError"
  }
}

/**
 * One independent journal per conversation. Only changed blocks and requests
 * are written.
 *
 * WAL with `synchronous=NORMAL`: a commit appends to the WAL without an
 * fsync, and the WAL is synced at each checkpoint. The one exception is the
 * first frame into a WAL with none (a journal its last host closed), whose
 * header SQLite syncs, folder and all: a restart's read-in has `WalPrimer`
 * write it off the host's thread first. A committed transaction
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
  /** Whether the requests' order is kept in `request_order`: once one moved from where it came, the rows' order no longer says it. */
  private ordered = false
  /** The stored base counts messages (`readBase`): the next commit writes it and the metadata again. */
  private messageBase = false
  /**
   * What each `base_entries` row holds, by identity; a hole is a row this
   * journal hasn't written or read. The host keeps an entry's object from
   * one reading of its history to the next while it says the same
   * (`sharedEntries`), so a commit writes only the rows whose entry changed:
   * a history of 150MB gains a turn for the cost of that turn. The rows
   * stay while the base row names none of them (`storedBase` keeps no copy,
   * or an earlier build kept it whole), so a turn that makes the journal
   * keep its copy again writes none of them.
   */
  private baseRows: (Entry | undefined)[] = []
  /** Whether rows past `baseRows` may be on disk: none are once a commit has cut them. */
  private baseRowsCut = false
  /** The base `stageBase` is writing into rows a slice at a time, while the base row names none. */
  private staging?: { base: ThreadPage; at: number; waiting: (() => void)[] }
  /** The base whose entries the rows last held whole, so a flush of the same base looks no further. */
  private stagedBase?: ThreadPage
  /** The pages a commit checkpoints the journal at when it isn't writing rows ahead (`STAGE_CHECKPOINT_PAGES`). */
  private checkpointPages?: number
  /** Whether the base row names the rows; unknown until the journal is read or writes it. */
  private rowsNamed?: boolean
  private closed = false
  /** The entries this journal's rows hold that the host reads back instead of holding (`paged-entries.ts`). */
  private readonly pager: EntryPager
  /** A closed journal waiting for its paged entries to go before it tidies its file (`close`). */
  private closing?: Promise<void>
  /** `keepFile`: the tidying `closing` waits to do is no longer this journal's. */
  private untidy = false
  /** The journal's database file. */
  get file(): string {
    return this.path
  }

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
      CREATE TABLE IF NOT EXISTS base_entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_order (id INTEGER PRIMARY KEY, keys TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompted (id INTEGER PRIMARY KEY, at INTEGER, requests INTEGER NOT NULL);
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
      this.ordered = Boolean(this.db.prepare("SELECT 1 FROM request_order WHERE id=1").get())
      // Every commit writes the metadata and the base row together: a journal without the one has neither.
      if (!this.db.prepare("SELECT 1 FROM metadata WHERE id=1").get()) this.rowsNamed = false
    } catch (error) {
      this.db.close()
      throw error
    }
    this.pager = new EntryPager(journalRows(this.db, () => this.appends))
  }

  /**
   * Pages `blocks[from, to)` in place, as far as `until` (a `performance.now()`
   * deadline) lets it: each block's content is read back from its row from
   * then on. The caller holds that the rows hold these blocks as they are:
   * this journal's last commit wrote them. Returns where it stopped.
   */
  pageBlocks(blocks: Entry[], from: number, to: number, until: number, inlineChars?: number): number {
    let at = from
    for (; at < to && performance.now() < until; at++) blocks[at] = this.pager.page(blocks[at]!, "blocks", at, inlineChars)
    return at
  }

  /**
   * Pages the entries of `entries[from, to)` whose row holds them, in place,
   * as `pageBlocks` does; an entry no row holds yet (written ahead later, or
   * not at all while the base comes from its source unread) stays.
   */
  pageBase(entries: Entry[], from: number, to: number, until: number, inlineChars?: number): number {
    let at = from
    for (; at < to && performance.now() < until; at++) {
      const entry = entries[at]!
      if (this.closed || this.baseRows[at] !== entry) continue
      const paged = this.pager.page(entry, "base", at, inlineChars)
      entries[at] = paged
      this.baseRows[at] = paged
    }
    return at
  }

  /** How many entries this journal paged are still in memory somewhere: what a closed journal waits on before its rows written ahead go. */
  pagedCount(): number {
    return this.pager.pagedCount()
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
    const { steeredAt, transferWakeAt, ...summary } = journalSummary(metadata)
    const wakeAt = sooner(this.wakeAt(), transferWakeAt)
    const promptedAt = laterPrompt(this.requestedAt(), steeredAt)
    const unsettled = this.unsettled()
    return { ...summary, revision: Math.max(summary.revision, this.revision()), ...wakeAt !== undefined && { wakeAt }, ...promptedAt !== undefined && { promptedAt }, ...unsettled && { unsettled } }
  }

  /** Whether a message here was waiting, paused or running as the journal was last written; only rows that name such a status are parsed. */
  private unsettled(): true | undefined {
    const rows = this.db.prepare(`SELECT value FROM requests WHERE value LIKE '%"status":"queued"%' OR value LIKE '%"status":"held"%' OR value LIKE '%"status":"dispatching"%'`).all()
    for (const row of rows) {
      const status = LiveRequestSchema.safeParse(JSON.parse(RowSchema.parse(row).value)).data?.status
      if (status === "queued" || status === "held" || status === "dispatching") return true
    }
    return undefined
  }

  /**
   * When the person last sent a request here (`personPromptedAt`), as each commit that writes the requests keeps it, so
   * a startup that lists every journal reads one row of each. The row names how many requests it was read from: a
   * journal from before it was kept, or one an older build added requests to since, reads its requests once again, and
   * keeps the answer.
   */
  private requestedAt(): number | undefined {
    const kept = PromptedRowSchema.safeParse(this.db.prepare("SELECT at, requests FROM prompted WHERE id=1").get())
    const { count } = CountSchema.parse(this.db.prepare("SELECT count(*) AS count FROM requests").get())
    if (kept.success && kept.data.requests === count) return kept.data.at ?? undefined
    const at = personPromptedAt(this.requestTimes())
    this.db.prepare("INSERT OR REPLACE INTO prompted VALUES (1, ?, ?)").run(at ?? null, count)
    return at
  }

  /** Who sent each request and when it was admitted, read without parsing a request's text. */
  private requestTimes(): PromptedRequest[] {
    return this.db
      .prepare("SELECT json_extract(value, '$.createdAt') AS at, json_extract(value, '$.actor.kind') AS kind FROM requests")
      .all()
      .flatMap((row) => {
        const parsed = RequestTimeSchema.safeParse(row)
        if (!parsed.success || parsed.data.at === null) return []
        const { at, kind } = parsed.data
        return [kind === null ? { createdAt: at } : { createdAt: at, actor: { kind } }]
      })
  }

  /** The soonest a held request here sends itself (`LiveRequest.wake`, `LiveRequest.retry`); only rows that name one are parsed. */
  private wakeAt(): number | undefined {
    let soonest: number | undefined
    for (const row of this.db.prepare("SELECT value FROM requests WHERE value LIKE '%\"wake\"%' OR value LIKE '%\"retry\"%'").all()) {
      const request = LiveRequestSchema.safeParse(JSON.parse(RowSchema.parse(row).value)).data
      const hold = request && holdOf(request)
      const at = hold && holdDue(hold)
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at
    }
    return soonest
  }

  /** The revision of the last commit; the metadata row keeps the one it was last written at. */
  private revision(): number {
    return ProgressSchema.safeParse(this.db.prepare("SELECT revision FROM progress WHERE id=1").get()).data?.revision ?? 0
  }

  read(): LiveSnapshot | null {
    return atOnce(this.reading())
  }

  /**
   * `read` a slice at a time (`inSlices`), for a conversation opened while
   * the host goes on: a journal of 150MB read at once held the loop for a
   * third of a second. Nothing else may use this journal until it resolves.
   */
  readSliced(stopping?: () => boolean, reader?: JournalReader): Promise<LiveSnapshot | null> {
    if (!reader) return inSlices(this.reading(), undefined, stopping)
    // Its rows are read and parsed on a reader, off the loop; the snapshot is made here, a slice at a time. Nothing
    // writes the file meanwhile: nothing else may use this journal until this resolves, and this host is its writer.
    // A stop ends the wait at once, as it ends a read on the loop at its next step; the reader's rows go unused.
    let watching: ReturnType<typeof setInterval> | undefined
    const stopped = new Promise<never>((_, reject) => {
      if (!stopping) return
      watching = setInterval(() => { if (stopping()) reject(new StepsStopped()) }, STOP_LOOK_MS)
      watching.unref?.()
    })
    stopped.catch(() => undefined)
    return Promise.race([reader(this.path, !this.log), stopped]).finally(() => clearInterval(watching)).then(
      (rows) => inSlices(this.fromRows(rows), undefined, stopping),
      (error) => {
        if (error instanceof StepsStopped) throw error
        hostWarn("journal", "a journal's reader failed; it's read here instead", { path: this.path, error: errorMessage({ error }) })
        return inSlices(this.reading(), undefined, stopping)
      })
  }

  /** `read` as `Steps`, its rows read and parsed `ROWS_PER_STEP` at a time, in one read transaction. */
  private *reading(): Steps<LiveSnapshot | null> {
    this.db.exec("BEGIN")
    let rows: JournalRows | null
    try {
      rows = yield* journalRowSteps(this.db, !this.log)
      this.db.exec("COMMIT")
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK")
      throw error
    }
    return yield* this.fromRows(rows)
  }

  /** The snapshot `rows` make, with Mako's log brought up to them. */
  private *fromRows(rows: JournalRows | null): Steps<LiveSnapshot | null> {
    if (!rows) return null
    const snapshot = yield* this.readRows(rows)
    const begun = Boolean(this.log) || rows.logBegun
    this.log ??= foldMakoLog(rows.log ?? (yield* this.makoLogSteps()))
    this.reconcile(snapshot, begun)
    return snapshot
  }

  private *readRows(rows: JournalRows): Steps<LiveSnapshot> {
    const stored = MetadataSchema.parse(JSON.parse(rows.metadata))
    const metadata = { ...stored, revision: Math.max(stored.revision, rows.revision) }
    const { blocks } = rows
    const tails = new Map<number, AppendValue[]>()
    for (const { block, value } of rows.appends) {
      const parts = tails.get(block) ?? []
      parts.push(value)
      tails.set(block, parts)
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
    const read = storedBaseOf(rows.base)
    // Until the next commit writes both, the base row and `baseLiveStart` stay in messages.
    this.messageBase = Boolean(read?.entryIndex)
    this.rowsNamed = Boolean(read && !read.whole)
    // The rows hold what was read; merged again below, an entry that reads the same keeps the object its row holds.
    if (read && !read.whole) this.baseRows = [...read.base.entries]
    const baseLiveStart = read?.entryIndex && metadata.baseLiveStart !== undefined ? read.entryIndex(metadata.baseLiveStart) : metadata.baseLiveStart
    const { requests, harnessTurns } = rows
    const order = this.ordered ? rows.order : undefined
    if (order) inOrder(requests, order)
    // A base an earlier build kept unmerged reads as every other reading of it does.
    const base = read
      ? yield* sharedBase(read.base, (yield* mergedBaseSteps(read.base, blocks, metadata.baseCoveredBlocks ?? 0, baseLiveStart, { cutOff: cutOffRequests(requests) })).base)
      : null
    return {
      ...metadata,
      ...harnessTurns.length && { harnessTurns },
      ...baseLiveStart !== undefined && { baseLiveStart },
      base,
      blocks,
      requests,
    }
  }

  /**
   * Brings Mako's log up to the rows it caches. Every commit writes both, so
   * they differ only for a journal a build before the log wrote, whose facts
   * are taken in as the journal had them, or by a fault, which is logged.
   */
  private reconcile(snapshot: LiveSnapshot, begun: boolean): void {
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
      if (this.db.isTransaction) this.db.exec("ROLLBACK")
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
    try {
      this.db.exec("BEGIN IMMEDIATE")
    } catch (error) {
      throw new JournalWriteError(error)
    }
    let written: BaseWrite | undefined
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
          .run(JSON.stringify({ ...metadata, session, nativeAgents: providerRoster(metadata.nativeAgents), control: controlRow(metadata.control), base: undefined, activityAt: undefined, nativeActivity: undefined, side: undefined, historyFailure: undefined, spentThrough: undefined }))
      this.db.prepare("INSERT OR REPLACE INTO progress VALUES (1, ?)").run(next.revision)
      // An unread base stays unread here: Mako's own blocks can follow it
      // meanwhile, and nothing reaches its harness until it is read.
      const stored = storedBase(next)
      if (!previous || this.messageBase || stored !== storedBase(previous)) written = this.writeBase(stored)
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
        const value = JSON.stringify(blocks[index])
        this.pager.detach("blocks", index, blocks[index])
        upsertBlock.run(index, value)
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
          this.pager.detach("blocks", index)
          append.run(index, count, JSON.stringify(growth))
          counts.set(index, count + 1)
        } else if (
          next.session.status === "running" &&
          count < 128 &&
          (block.type === "text" || block.type === "thinking") &&
          before?.type === block.type &&
          before.id === block.id &&
          block.text.length > before.text.length &&
          continues(block.text, before.text)
        ) {
          this.pager.detach("blocks", index)
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
        this.pager.detachFrom("blocks", blocks.length)
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
            upsertRequest.run(request.id, requestRow(request))
        const kept = new Set(requests.map((request) => request.id))
        if (!previous || previous.requests.some((request) => !kept.has(request.id)))
          this.db.prepare("DELETE FROM requests WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...kept]))
        if (this.ordered || !appendedTo(previous?.requests, requests)) {
          this.db.prepare("INSERT OR REPLACE INTO request_order VALUES (1, ?)").run(JSON.stringify(requests.map((request) => request.id)))
          this.ordered = true
        }
        this.db.prepare("INSERT OR REPLACE INTO prompted VALUES (1, ?, ?)").run(personPromptedAt(requests) ?? null, requests.length)
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
      if (written) this.wroteBase(written)
    } catch (error) {
      // SQLite rolls a full disk, an I/O error or a busy lock back itself, and a ROLLBACK then would throw over why.
      if (this.db.isTransaction) this.db.exec("ROLLBACK")
      this.log = undefined
      // What the rows hold is no longer known: the next write of the base writes each.
      if (written) this.forgetBaseRows()
      throw new JournalWriteError(error)
    }
    if (!this.rowsNamed && next.base) this.stageBase(next.base)
  }

  /**
   * Writes the base row, inside the commit's transaction: none, or the
   * page and the rows of its entries that don't hold them yet.
   */
  private writeBase(stored: ThreadPage | null): BaseWrite {
    if (!stored) {
      this.db.prepare("INSERT OR REPLACE INTO base VALUES (1, 'null')").run()
      return { kept: false }
    }
    const { entries, ...page } = stored
    // Rows written ahead under a base row that named none: a compaction since (`JournalReclaims`) may have dropped them.
    // It drops every row the base row doesn't name, so one row written still there says they all are: counting them
    // read the whole history off disk, 200ms at 150MB, on the commit that starts a turn.
    if (!this.rowsNamed && this.baseRows.length) {
      let last = this.baseRows.length - 1
      while (last >= 0 && !this.baseRows[last]) last--
      if (last >= 0 && !this.db.prepare("SELECT 1 AS found FROM base_entries WHERE id = ?").get(last)) {
        this.baseRows = []
        this.baseRowsCut = false
      }
    }
    const { rows } = this.writeBaseRows(entries, 0, entries.length)
    if (this.baseRowsCut === false || this.baseRows.length > entries.length) {
      this.pager.detachFrom("base", entries.length)
      this.db.prepare("DELETE FROM base_entries WHERE id >= ?").run(entries.length)
    }
    this.db.prepare("INSERT OR REPLACE INTO base VALUES (1, ?)").run(JSON.stringify({ ...page, entryRows: entries.length }))
    return { kept: true, rows, length: entries.length }
  }

  /** Writes `entries[from, to)` whose rows don't hold them, until `until` when given; what each row then holds. */
  private writeBaseRows(entries: readonly Entry[], from: number, to: number, until?: number): RowsWritten {
    const upsert = this.db.prepare("INSERT OR REPLACE INTO base_entries VALUES (?, ?)")
    const rows = new Map<number, Entry>()
    let at = from
    for (; at < to && (until === undefined || performance.now() < until); at++) {
      const entry = entries[at]!
      if (this.baseRows[at] === entry) continue
      const value = JSON.stringify(entry)
      this.pager.detach("base", at, entry)
      upsert.run(at, value)
      rows.set(at, entry)
    }
    return { at, rows }
  }

  /** What a committed `writeBase` left in the rows. */
  private wroteBase(write: BaseWrite): void {
    this.rowsNamed = write.kept
    if (!write.kept) return
    this.stopStaging()
    this.stagedBase = undefined
    for (const [index, entry] of write.rows) this.baseRows[index] = entry
    this.baseRows.length = write.length
    this.baseRowsCut = true
  }

  private forgetBaseRows(): void {
    this.stagedBase = undefined
    this.baseRows = []
    this.baseRowsCut = false
    this.rowsNamed = undefined
    this.stopStaging()
  }

  /**
   * While the base row names no rows, writes the rows of
   * `base`'s entries a slice at a time between other work, so a turn that
   * makes it keep one again (`baseKeptBecause`) commits only the page. The
   * rows mean nothing until the base row names them.
   */
  private stageBase(base: ThreadPage): void {
    if (this.closed || this.staging?.base === base || this.stagedBase === base) return
    const { entries } = base
    if (entries.length === this.baseRows.length && this.baseRowsCut && entries.every((entry, index) => this.baseRows[index] === entry)) {
      this.stagedBase = base
      return
    }
    const scheduled = this.staging
    this.staging = { base, at: 0, waiting: scheduled?.waiting ?? [] }
    if (scheduled) return
    this.checkpointAt(STAGE_CHECKPOINT_PAGES)
    setImmediate(() => this.stageSlice())
  }

  /** Commits checkpoint the journal every `pages` pages of its write-ahead log; at undefined, as they did before. */
  private checkpointAt(pages: number | undefined): void {
    if (this.closed) return
    try {
      if (pages !== undefined) {
        this.checkpointPages ??= z.object({ wal_autocheckpoint: z.number() }).parse(this.db.prepare("PRAGMA wal_autocheckpoint").get()).wal_autocheckpoint
        this.db.exec(`PRAGMA wal_autocheckpoint=${pages}`)
      } else if (this.checkpointPages !== undefined) {
        this.db.exec(`PRAGMA wal_autocheckpoint=${this.checkpointPages}`)
        this.checkpointPages = undefined
      }
    } catch (error) {
      hostWarn("journal", "a journal's checkpoints couldn't be set", { path: this.path, error: errorMessage({ error }) })
    }
  }

  /**
   * Writes the rows of `base`'s entries ahead of the commit that first names
   * them, a slice at a time, so that commit writes only the page: a session
   * of 150MB taken in otherwise held the loop for as long as writing it took.
   */
  writeAhead(base: ThreadPage): Promise<void> {
    if (this.rowsNamed !== false) return Promise.resolve()
    this.stageBase(base)
    const staging = this.staging
    return staging ? new Promise((resolve) => staging.waiting.push(resolve)) : Promise.resolve()
  }

  /**
   * Resolves once the rows being written ahead hold the base (or writing
   * them stopped); undefined when none are being written. Meanwhile they're
   * written in longer slices. A turn waits for them before it starts: the
   * commit that starts it names them, and wrote every one still missing in
   * its one transaction, 0.7s for a history of 150MB.
   */
  writtenAhead(): Promise<void> | undefined {
    const staging = this.staging
    return staging && new Promise((resolve) => staging.waiting.push(resolve))
  }

  /** Writing ahead ended, done or not; whoever waits on it goes on. */
  private stopStaging(): void {
    const waiting = this.staging?.waiting ?? []
    this.staging = undefined
    this.checkpointAt(undefined)
    for (const resolve of waiting) resolve()
  }

  private stageSlice(): void {
    const staging = this.staging
    if (!staging || this.closed || this.rowsNamed !== false) {
      this.stopStaging()
      return
    }
    const { entries } = staging.base
    try {
      this.db.exec("BEGIN IMMEDIATE")
      const written = this.writeBaseRows(entries, staging.at, entries.length, performance.now() + (staging.waiting.length ? STAGE_SLICE_WAITED_MS : STAGE_SLICE_MS))
      const done = written.at >= entries.length
      if (done && (this.baseRowsCut === false || this.baseRows.length > entries.length)) {
        this.pager.detachFrom("base", entries.length)
        this.db.prepare("DELETE FROM base_entries WHERE id >= ?").run(entries.length)
      }
      this.db.exec("COMMIT")
      for (const [index, entry] of written.rows) this.baseRows[index] = entry
      if (!done) {
        staging.at = written.at
        setImmediate(() => this.stageSlice())
        return
      }
      this.baseRows.length = entries.length
      this.baseRowsCut = true
      this.stagedBase = staging.base
      this.stopStaging()
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK")
      this.forgetBaseRows()
      hostWarn("journal", "a journal's history rows couldn't be written ahead; a turn writes them", { path: this.path, error: errorMessage({ error }) })
    }
  }

  /** Mako's log, oldest first. */
  makoLog(): MakoLogEntry[] {
    return atOnce(this.makoLogSteps())
  }

  private makoLogSteps(): Steps<MakoLogEntry[]> {
    return makoLogRowSteps(this.db)
  }

  /**
   * `compact` is handed the closed file when a dropped copy left much of it
   * free (`JournalReclaims`). Entries paged from its rows (`paged-entries.ts`)
   * may outlive it, in a window's view or a read under way: they read
   * through a connection of their own, and the rows written ahead stay, and
   * the file isn't compacted, until the last of them is collected
   * (`released`). `abandon` doesn't wait: the host is stopping.
   */
  close(compact?: (path: string) => void, abandon = false): void {
    if (this.closed) return
    this.closed = true
    this.stopStaging()
    // Rows written ahead that the base row doesn't name go with the journal: dropped by the compaction, off this
    // thread, as 150MB of them take a few hundred milliseconds to free.
    const ahead = this.rowsNamed === false && this.rowsAhead()
    const free = compact !== undefined && (ahead || this.mostlyFree())
    const paged = this.pager.pagedCount() > 0
    if (ahead && !compact && !paged) {
      try {
        this.db.exec("DELETE FROM base_entries")
      } catch (error) {
        hostWarn("journal", "a journal's history rows couldn't be dropped", { path: this.path, error: errorMessage({ error }) })
      }
    }
    this.db.close()
    // Closed, it writes nothing more, so it lets go of what its rows held by identity: kept, they were the paged
    // entries' last holder, so none was ever collected and a journal waiting on them (`LiveRecords.releasing`) stayed
    // for the host's life with its connection and its log (2026-11-12: 68 journals, 80 MB, after 60 opens).
    this.baseRows = []
    this.stagedBase = undefined
    const tidy = () => {
      if (this.untidy) return
      if (ahead && !compact && paged) dropRowsAhead(this.path)
      if (free) compact(this.path)
    }
    const freed = this.pager.release(readOnlyRows(this.path))
    if (!paged || abandon) {
      tidy()
      return
    }
    this.closing = freed.then(tidy)
  }

  /**
   * Closes a journal read in that another one opened at the same time got
   * ahead of (`LiveRecords.loadSliced`): the file is that one's, so nothing of
   * it is tidied here.
   */
  discard(): void {
    if (this.closed) return
    this.closed = true
    this.untidy = true
    this.stopStaging()
    this.db.close()
  }

  /** Once the journal closed and what it waited on before tidying its file (`close`) is done. */
  released(): Promise<void> {
    return this.closing ?? Promise.resolve()
  }

  /**
   * The conversation was read in again before this closed journal tidied its
   * file: the journal open now owns it, rows written ahead included, and
   * tidies it when it closes.
   */
  keepFile(): void {
    this.untidy = true
  }

  private rowsAhead(): boolean {
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM base_entries LIMIT 1").get())
    } catch {
      return false
    }
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

/** Rows as the journal at `db` holds them; a block's appends (`appends`, by block) are folded in. */
function journalRows(db: DatabaseSync, appends: () => ReadonlyMap<number, number>): PagedRows {
  let base: ReturnType<DatabaseSync["prepare"]> | undefined
  let block: ReturnType<DatabaseSync["prepare"]> | undefined
  let tail: ReturnType<DatabaseSync["prepare"]> | undefined
  return {
    read(table: PagedTable, row: number): string | undefined {
      if (table === "base") {
        base ??= db.prepare("SELECT value FROM base_entries WHERE id=?")
        return RowSchema.safeParse(base.get(row)).data?.value
      }
      block ??= db.prepare("SELECT value FROM blocks WHERE id=?")
      const value = RowSchema.safeParse(block.get(row)).data?.value
      if (value === undefined || !appends().get(row)) return value
      tail ??= db.prepare("SELECT value FROM block_appends WHERE block_id=? ORDER BY sequence")
      let entry = EntrySchema.parse(JSON.parse(value))
      for (const part of tail.all(row).map((stored) => AppendValueSchema.parse(JSON.parse(RowSchema.parse(stored).value)))) {
        if (part.kind === "text" && (entry.type === "text" || entry.type === "thinking")) entry = { ...entry, text: entry.text + part.text }
        else if (part.kind === "tool" && entry.type === "tool") entry = growTool(entry, part.growth)
      }
      return JSON.stringify(entry)
    },
  }
}

/** A closed journal's rows, for the entries paged from them, through a read-only connection opened on the first read. */
function readOnlyRows(path: string): PagedRows {
  let open: { db: DatabaseSync; rows: PagedRows } | undefined
  return {
    read(table, row) {
      if (!open) {
        const db = new DatabaseSync(path, { readOnly: true })
        const counts = new Map<number, number>()
        for (const value of db.prepare("SELECT block_id, count(*) AS count FROM block_appends GROUP BY block_id").all()) {
          const counted = AppendCountSchema.parse(value)
          counts.set(counted.block_id, counted.count)
        }
        open = { db, rows: journalRows(db, () => counts) }
      }
      return open.rows.read(table, row)
    },
    close() {
      open?.db.close()
      open = undefined
    },
  }
}

/** Drops the rows a closed journal wrote ahead (`stageBase`), when its base row names none. */
function dropRowsAhead(path: string): void {
  try {
    const db = new DatabaseSync(path)
    try {
      db.exec("PRAGMA busy_timeout=5000")
      db.exec("DELETE FROM base_entries WHERE NOT EXISTS (SELECT 1 FROM base WHERE id=1 AND json_extract(value, '$.entryRows') IS NOT NULL)")
    } finally {
      db.close()
    }
  } catch (error) {
    hostWarn("journal", "a journal's history rows couldn't be dropped", { path, error: errorMessage({ error }) })
  }
}

/**
 * One request as journal `id` keeps it, read without loading the
 * conversation: a turn's review reads a conversation nobody has open.
 * Undefined when the journal or the request isn't there.
 */
export function storedRequest(root: string, id: string, requestId: string): LiveRequest | undefined {
  const path = join(root, `${id}.sqlite`)
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM requests WHERE id=?").get(requestId)
    return row ? LiveRequestSchema.parse(JSON.parse(RowSchema.parse(row).value)) : undefined
  } finally {
    db.close()
  }
}

/** Retirement reads only metadata and pending request rows, never transcript blocks or a writable journal. */
export function storedRetirementState(root: string, id: string): { finished: boolean; at: number } | undefined {
  const path = join(root, `${id}.sqlite`)
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const metadata = metadataRow(db)
    if (!metadata) return undefined
    const summary = journalSummary(metadata)
    let pending = false
    for (const row of db.prepare(`SELECT value FROM requests WHERE value LIKE '%"status":"queued"%' OR value LIKE '%"status":"held"%' OR value LIKE '%"status":"dispatching"%'`).all()) {
      const request = LiveRequestSchema.parse(JSON.parse(RowSchema.parse(row).value))
      if (request.status === "queued" || request.status === "held" || request.status === "dispatching") pending = true
    }
    return {
      finished: !pending && !summary.hasSessionQuestions && summary.transferWakeAt === undefined &&
        (summary.session.status === "ready" || summary.session.status === "failed" || summary.session.status === "closed"),
      at: Math.max(summary.createdAt, statSync(path).mtimeMs, existsSync(`${path}-wal`) ? statSync(`${path}-wal`).mtimeMs : 0),
    }
  } finally { db.close() }
}

/** The bytes of the copy of its history journal `id` keeps; 0 when it keeps none. */
export function copiedBaseBytes(root: string, id: string): number {
  return atOnce(copiedBaseBytesSteps(root, id))
}

/** `copiedBaseBytes` as `Steps`: the host's sweep measures a copy of 150MB a slice at a time (`inSlices`), not in 150ms at once. */
export function* copiedBaseBytesSteps(root: string, id: string): Steps<number> {
  const db = new DatabaseSync(join(root, `${id}.sqlite`), { readOnly: true })
  try {
    return (yield* baseHeader(db))?.copiedBytes ?? 0
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
  /** A copy an entry a row: how many rows; null for one kept whole, or none. */
  entryRows: z.number().nullable(),
  /** A copy kept whole: how many entries it holds. */
  entries: z.number().nullable(),
})
const RowBytesSchema = z.object({ bytes: z.number().nullable() })
const OptionalBaseHeaderSchema = BaseHeaderSchema.optional()

/** How many rows of a copy one step of `baseHeader` sums: a couple of milliseconds' reading. */
const ROWS_SUMMED = 512

/** The base row's page, read without decoding its entries, and the bytes of the copy it names: 0 when it names none. */
function* baseHeader(db: DatabaseSync) {
  const header = OptionalBaseHeaderSchema.parse(db.prepare(`SELECT length(value) AS bytes,
    json_extract(value, '$.start') AS start, json_extract(value, '$.hasEarlier') AS hasEarlier, json_extract(value, '$.preview') AS preview,
    json_extract(value, '$.ref.harness') AS harness, json_extract(value, '$.ref.nativeId') AS nativeId, json_extract(value, '$.ref.path') AS path,
    json_extract(value, '$.entryRows') AS entryRows, json_array_length(value, '$.entries') AS entries FROM base WHERE id=1`).get())
  if (!header) return undefined
  const kept = header.bytes !== null && header.bytes > "null".length
  // Rows past the copy's count, or under a base row that names none, are rows written ahead (`stageBase`), not a copy.
  let rows = 0
  if (kept && header.entryRows !== null) {
    const sum = db.prepare("SELECT sum(length(value)) AS bytes FROM base_entries WHERE id >= ? AND id < ?")
    for (let from = 0; from < header.entryRows; from += ROWS_SUMMED) {
      rows += RowBytesSchema.parse(sum.get(from, Math.min(from + ROWS_SUMMED, header.entryRows))).bytes ?? 0
      yield
    }
  }
  return { ...header, entries: header.entryRows ?? header.entries, copiedBytes: kept ? (header.bytes ?? 0) + rows : 0 }
}
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
    const header = atOnce(baseHeader(db))
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
      copiedBaseBytes: header?.copiedBytes ?? 0,
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

/** Only request status/checkpoint metadata, never transcript content or request text. */
export function storedSnapshotSettlement(root: string, elsewhere: (id: string) => boolean = () => false): SnapshotSettlement {
  return atOnce(snapshotSettlementSteps(root, elsewhere))
}
export function readSnapshotSettlement(root: string, elsewhere: (id: string) => boolean = () => false): Promise<SnapshotSettlement> {
  return inSlices(snapshotSettlementSteps(root, elsewhere))
}
function* snapshotSettlementSteps(root: string, elsewhere: (id: string) => boolean): Steps<SnapshotSettlement> {
  const result: SnapshotSettlement = { valid: true, settledIds: [], blockedScopes: [] }
  try {
    if (!existsSync(root)) return result
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".sqlite")) continue
      const id = name.slice(0, -7)
      const db = new DatabaseSync(join(root, name), { readOnly: true })
      try {
        const metadata = metadataRow(db)
        if (!metadata) throw new Error("Conversation metadata is unavailable.")
        const summary = journalSummary(metadata)
        let busy = elsewhere(id) || !["ready", "failed", "closed"].includes(summary.session.status)
        const ids: string[] = []
        for (const row of db.prepare("SELECT json_extract(value, '$.status') AS status, json_extract(value, '$.snapshots') AS snapshots FROM requests").iterate()) {
          yield
          const projected = z.object({ status: z.string(), snapshots: z.string().nullable() }).parse(row)
          const settled = ["completed", "failed", "interrupted", "canceled"].includes(projected.status)
          if (!settled) busy = true
          if (!projected.snapshots || !settled) continue
          const snapshots = RunSnapshotsSchema.parse(JSON.parse(projected.snapshots))
          if (snapshots.before.kind === "ready") ids.push(snapshots.before.snapshot.id)
          if (snapshots.after?.kind === "ready") ids.push(snapshots.after.snapshot.id)
        }
        if (busy) result.blockedScopes.push(realpathSync(summary.session.cwd))
        else result.settledIds.push(...ids)
      } finally { db.close() }
      yield
    }
  } catch { result.valid = false }
  return result
}
