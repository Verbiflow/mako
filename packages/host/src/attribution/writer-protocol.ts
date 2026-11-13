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
export const WriterRepositorySchema = z.object({ watchHead: z.boolean(), ignoredEntries: z.boolean() }).nullable()
export const WriterInventorySchema = z.object({ tracked: z.array(z.string()), untracked: z.array(z.string()), changed: z.array(z.string()) })
export const WriterStringSchema = z.string().nullable()
export const WriterSetSchema = z.set(z.string())
export const WriterBytesSchema = z.instanceof(Uint8Array).nullable()
export const WriterBooleanSchema = z.boolean()
export const WriterVoidSchema = z.undefined()
export const WriterHistoryMarkSchema = z.object({ id: z.string(), at: z.string() })
export const WriterHistorySchema = z.object({ paths: z.array(z.string()), lost: z.array(z.string()), ignored: z.array(z.number()) })
export const WriterChildrenSchema = ChildTranscriptsSchema.nullable()
export const WriterThreadSchema = ThreadSchema.nullable()
export type WriterHostResult = WriterContext | z.infer<typeof WriterRepositorySchema> | z.infer<typeof WriterInventorySchema> | string | null | Set<string> | readonly string[] | Uint8Array | boolean | undefined | z.infer<typeof WriterHistoryMarkSchema> | z.infer<typeof WriterHistorySchema> | Awaited<ReturnType<ChildSource["children"]>> | Awaited<ReturnType<ChildSource["open"]>>

export interface WriterPorts {
  context(): Promise<WriterContext>
  repository(root: string): Promise<TrackerRepository | null>
  watch: TreeWatcher
  history?: SystemHistory
  children?: ChildSource
  deliveryLagMs(): number
}

export interface WriterSnapshot {
  path: string
  address: string
  role: JournalRole
  sharing: SharingStatus
  followers: ReturnType<SharedJournal["followers"]>
  recent: readonly { lagMs: number; hashMs: number; diffMs: number; writeMs: number }[]
  rescans: ReturnType<LaptopTracker["rescanReading"]> | null
}

const HostSchema = z.object({ pid: z.number().int().positive(), dataRoot: z.string(), label: z.string() })
const RoleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }), z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("follower"), owner: HostSchema }), z.object({ kind: z.literal("private"), why: z.string() }),
])
export const WriterSnapshotSchema = z.object({
  path: z.string(), address: z.string(), role: RoleSchema,
  sharing: z.object({ role: z.enum(["starting", "owner", "follower", "private"]), folder: z.string(), owner: HostSchema.optional(), followers: z.array(HostSchema), unsent: z.number().int().nonnegative() }),
  followers: z.array(z.object({ host: HostSchema, placed: z.map(z.string(), z.object({ thread: z.string(), session: z.string() })), live: z.map(z.string(), z.number()) })),
  recent: z.array(z.object({ lagMs: z.number(), hashMs: z.number(), diffMs: z.number(), writeMs: z.number() }).loose()),
  // Diagnostic rescan details are produced by the same build's tracker, never used to authorize a write.
  rescans: z.object({ roots: z.number(), lastHour: z.number(), filesLastHour: z.number(), msLastHour: z.number(), lossesLastHour: z.number(), backedOff: z.array(z.object({ root: z.string(), everyMs: z.number() })) }).nullable(),
})
export const WriterPathsSchema = z.array(z.string())
export const WriterCollectionSchema = z.object({ dropped: z.number(), bytes: z.number() }).optional()
const BackfillSchema = z.object({ sessions: z.number(), calls: z.number(), entries: z.number(), lines: z.number(), ms: z.number(), partial: z.boolean() }).optional()
export type WriterCommandResult = WriterSnapshot | BackfillResult | Collected | string[] | undefined
export const WriterCommandResults = {
  snapshot: WriterSnapshotSchema,
  wake: WriterVoidSchema,
  "read-back": BackfillSchema,
  collect: WriterCollectionSchema,
  sleep: WriterPathsSchema,
  "let-go": WriterPathsSchema,
  sweep: WriterPathsSchema,
  close: WriterVoidSchema,
}

const Root = z.object({ root: z.string() })
export const WriterHostRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("context") }),
  Root.extend({ kind: z.literal("repository") }),
  Root.extend({ kind: z.literal("head") }),
  Root.extend({ kind: z.literal("inventory") }),
  Root.extend({ kind: z.literal("ignored"), paths: z.array(z.string()) }),
  Root.extend({ kind: z.literal("ignored-entries") }),
  Root.extend({ kind: z.literal("read"), commit: z.string(), path: z.string() }),
  Root.extend({ kind: z.literal("changed"), from: z.string().nullable(), to: z.string() }),
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
  z.object({ kind: z.literal("wake"), checkout: z.string() }),
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
])
export type FromWriter = z.infer<typeof FromWriterSchema>
export type WriterReply = Extract<FromWriter, { type: "reply" }>
export type WriterHostReply = Extract<ToWriter, { type: "host-reply" }>
export type WriterStateMessage = Extract<FromWriter, { type: "ready" | "snapshot" }>
