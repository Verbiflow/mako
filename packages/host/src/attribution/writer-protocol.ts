import { z } from "zod"
import type { ChildSource } from "@mako/sessions"
import type { AttributionDeps, CataloguedSession } from "./index.js"
import type { TrackerRepository } from "./tracker.js"
import type { TreeWatcher, SystemHistory } from "./ports.js"
import type { SharedJournal, JournalRole, SharingStatus } from "./shared-journal.js"
import type { LaptopTracker } from "./tracker.js"
import { ThreadSchema } from "@mako/sessions/thread-schema"
import { ChildTranscriptsSchema } from "@mako/sessions/children"
import type { BackfillResult } from "./backfill.js"
import type { Collected } from "./journal-store.js"

export const WriterSettingsSchema = z.object({
  dataRoot: z.string(), userRoot: z.string(), defaultDataRoot: z.string().optional(), label: z.string(), hostPid: z.number().int().positive(),
  home: z.string(), temporary: z.array(z.string()), own: z.array(z.string()),
  history: z.boolean(), children: z.boolean(), catalogued: z.boolean(), running: z.boolean(), privateReason: z.string().optional(),
})
export type WriterSettings = z.infer<typeof WriterSettingsSchema>

export interface WriterContext {
  sessions: readonly CataloguedSession[]
  running: ReturnType<NonNullable<AttributionDeps["running"]>>
  stores: readonly string[]
}

const SessionSchema = z.object({ harness: z.string(), nativeId: z.string(), path: z.string(), cwd: z.string().optional(), currentCwd: z.string().optional(), worktrees: z.array(z.object({ path: z.string() })).optional(), updatedAt: z.string().optional(), threadId: z.string().optional(), sessionId: z.string().optional() })
export const WriterContextSchema = z.object({ sessions: z.array(SessionSchema), running: z.record(z.string(), z.object({ status: z.string() })), stores: z.array(z.string()) })
/**
 * What the host answers when the writer asks for its context: nothing new since the version the writer holds, or the
 * sessions that came or changed since and the paths of those that went (every session, `whole`, for a writer whose
 * version isn't the one the host last sent). Only the fields the writer reads cross
 * (`CataloguedSession`), each session once a change: the whole catalog used to, as the host keeps it, at every ask.
 */
export const WriterContextChangeSchema = z.union([
  z.object({ same: z.literal(true) }),
  z.object({ version: z.number().int().positive(), whole: z.boolean(), sessions: z.array(SessionSchema), removed: z.array(z.string()), running: z.record(z.string(), z.object({ status: z.string() })), stores: z.array(z.string()) }),
])
export type WriterContextChange = z.infer<typeof WriterContextChangeSchema>

/** The host's context as the writer holds it: by session, with the version the host knows it by. */
export interface HeldContext {
  version: number
  sessions: Map<string, WriterContext["sessions"][number]>
  context: WriterContext
}

/** `held` with what the host said moved (`WriterContextChange`) put in place; a whole context in place of all of it. */
export function applyContextChange(held: HeldContext, change: WriterContextChange): HeldContext {
  if ("same" in change) return held
  const sessions = change.whole ? new Map<string, WriterContext["sessions"][number]>() : new Map(held.sessions)
  for (const path of change.removed) sessions.delete(path)
  for (const session of change.sessions) sessions.set(session.path, session)
  return { version: change.version, sessions, context: { sessions: [...sessions.values()], running: change.running, stores: change.stores } }
}
/** Whether a root is a repository, and its Git folder watched by the host: Git itself runs in the writer. */
export const WriterRepositorySchema = z.object({ watchHead: z.boolean() }).nullable()
export const WriterBooleanSchema = z.boolean()
export const WriterVoidSchema = z.undefined()
export const WriterHistoryMarkSchema = z.object({ id: z.string(), at: z.string() })
export const WriterHistorySchema = z.object({ paths: z.array(z.string()), lost: z.array(z.string()), ignored: z.array(z.number()) })
export const WriterChildrenSchema = ChildTranscriptsSchema.nullable()
export const WriterThreadSchema = ThreadSchema.nullable()
export type WriterHostResult = WriterContextChange | z.infer<typeof WriterRepositorySchema> | null | boolean | undefined | z.infer<typeof WriterHistoryMarkSchema> | z.infer<typeof WriterHistorySchema> | Awaited<ReturnType<ChildSource["children"]>> | Awaited<ReturnType<ChildSource["open"]>>

export interface WriterPorts {
  context(): Promise<WriterContext>
  repository(root: string): Promise<TrackerRepository | null>
  watch: TreeWatcher
  history?: SystemHistory
  children?: ChildSource
  deliveryLagMs(): number
  /** A read-back pass the host asked for ended (`read-back`); undefined when it couldn't run. */
  readBack?(result: BackfillResult | undefined): void
  /** Every change made by `through` has its author for good (`TrackerOptions.settledThrough`). */
  settledThrough?(through: number): void
}

/** What the writer's worker holds: its JavaScript heap, its typed arrays (an awake root's stat cache is columns of them), and the roots behind them. */
export interface WriterMemory {
  heapBytes: number
  arrayBytes: number
  awake: number
  asleep: number
}

export interface WriterSnapshot {
  path: string
  address: string
  role: JournalRole
  sharing: SharingStatus
  followers: ReturnType<SharedJournal["followers"]>
  recent: readonly { lagMs: number; hashMs: number; diffMs: number; writeMs: number }[]
  rescans: ReturnType<LaptopTracker["rescanReading"]> | null
  memory: WriterMemory
}

const HostSchema = z.object({ pid: z.number().int().positive(), dataRoot: z.string(), label: z.string() })
const RoleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }), z.object({ kind: z.literal("failed"), why: z.string() }), z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("follower"), owner: HostSchema }), z.object({ kind: z.literal("private"), why: z.string() }),
])
export const WriterSnapshotSchema = z.object({
  path: z.string(), address: z.string(), role: RoleSchema,
  sharing: z.object({ role: z.enum(["starting", "failed", "owner", "follower", "private"]), folder: z.string(), owner: HostSchema.optional(), followers: z.array(HostSchema), unsent: z.number().int().nonnegative(), failure: z.string().optional() }),
  followers: z.array(z.object({ host: HostSchema, placed: z.map(z.string(), z.object({ thread: z.string(), session: z.string() })), live: z.map(z.string(), z.number()) })),
  recent: z.array(z.object({ lagMs: z.number(), hashMs: z.number(), diffMs: z.number(), writeMs: z.number() }).loose()),
  // Diagnostic rescan details are produced by the same build's tracker, never used to authorize a write.
  rescans: z.object({ roots: z.number(), lastHour: z.number(), filesLastHour: z.number(), msLastHour: z.number(), lossesLastHour: z.number(), backedOff: z.array(z.object({ root: z.string(), everyMs: z.number() })) }).nullable(),
  memory: z.object({ heapBytes: z.number(), arrayBytes: z.number(), awake: z.number(), asleep: z.number() }),
})
export const WriterPathsSchema = z.array(z.string())
export const WriterCollectionSchema = z.object({ dropped: z.number(), bytes: z.number() }).optional()
const BackfillSchema = z.object({ sessions: z.number(), calls: z.number(), entries: z.number(), lines: z.number(), ms: z.number(), partial: z.boolean() }).optional()
export type WriterCommandResult = WriterSnapshot | Collected | string[] | undefined
export const WriterCommandResults = {
  snapshot: WriterSnapshotSchema,
  heard: WriterVoidSchema,
  wake: WriterVoidSchema,
  "read-back": WriterVoidSchema,
  collect: WriterCollectionSchema,
  sleep: WriterPathsSchema,
  "let-go": WriterPathsSchema,
  sweep: WriterPathsSchema,
  close: WriterVoidSchema,
}

const Root = z.object({ root: z.string() })
export const WriterHostRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("context"), have: z.number().int().nonnegative() }),
  Root.extend({ kind: z.literal("repository") }),
  Root.extend({ kind: z.literal("watch"), subscription: z.number().int() }),
  Root.extend({ kind: z.literal("watch-head"), subscription: z.number().int() }),
  z.object({ kind: z.literal("unwatch"), subscription: z.number().int() }),
  z.object({ kind: z.literal("history-mark") }),
  z.object({ kind: z.literal("history-since"), mark: z.object({ id: z.string(), at: z.string() }), roots: z.array(z.string()), options: z.object({ ignore: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() }).optional() }),
  z.object({ kind: z.literal("children"), path: z.string() }),
  z.object({ kind: z.literal("open"), path: z.string() }),
])
export type WriterHostRequest = z.infer<typeof WriterHostRequestSchema>

export const WriterCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot") }),
  /**
   * Answered once every message the host sent before it has been taken: the file events of its watches come on this
   * port, so after it they are the tracker's to journal (`settled` asks the journal on another channel).
   */
  z.object({ kind: z.literal("heard") }),
  z.object({ kind: z.literal("wake"), checkout: z.string() }),
  /** Answered as the pass starts, never when it ends: a pass can outlast any wait for an answer. `read-back` says how it went. */
  z.object({ kind: z.literal("read-back") }),
  z.object({ kind: z.literal("collect") }),
  z.object({ kind: z.literal("sleep") }),
  z.object({ kind: z.literal("let-go") }),
  z.object({ kind: z.literal("sweep") }),
  z.object({ kind: z.literal("close") }),
])
export type WriterCommand = z.infer<typeof WriterCommandSchema>
const Id = z.number().int().positive()
export const ToWriterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), settings: WriterSettingsSchema }),
  z.object({ type: z.literal("command"), id: Id, command: WriterCommandSchema }),
  z.object({ type: z.literal("host-reply"), id: Id, ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional(), lagMs: z.number().nonnegative() }),
  z.object({ type: z.literal("event"), subscription: z.number().int(), event: z.enum(["changed", "gone", "dropped", "head"]), paths: z.array(z.string()).optional(), why: z.enum(["dropped", "polling", "listening"]).optional(), lagMs: z.number().nonnegative() }),
])
export type ToWriter = z.infer<typeof ToWriterSchema>
const LogLineSchema = z.object({ level: z.enum(["info", "warn", "error"]), scope: z.string(), message: z.string(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])).optional() })
export const FromWriterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), line: LogLineSchema }),
  z.object({ type: z.literal("ready"), snapshot: z.unknown() }),
  z.object({ type: z.literal("snapshot"), snapshot: z.unknown() }),
  z.object({ type: z.literal("failed"), error: z.string() }),
  z.object({ type: z.literal("reply"), id: Id, ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal("host-request"), id: Id, request: WriterHostRequestSchema }),
  z.object({ type: z.literal("read-back"), result: BackfillSchema }),
  z.object({ type: z.literal("settled"), through: z.number() }),
])
export type FromWriter = z.infer<typeof FromWriterSchema>
export type WriterReply = Extract<FromWriter, { type: "reply" }>
export type WriterHostReply = Extract<ToWriter, { type: "host-reply" }>
export type WriterStateMessage = Extract<FromWriter, { type: "ready" | "snapshot" }>
