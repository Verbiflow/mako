import { z } from "zod"
import { ACCESS_TIER_NAMES, type AccessTier } from "./access.js"
import { CHILDREN_BINDING, type NativeAgent } from "./native-agents.js"
import { ActorSchema, SessionIdSchema, ThreadIdSchema, type SessionId, type ThreadId } from "./thread-identity.js"

export { CHILDREN_BINDING }

/**
 * The word every person-facing string and every agent's instructions use for
 * a Thread that leads others, until the person names the role. Identifiers
 * keep `lead` whatever it reads as.
 */
export const ROLE_WORD = "lead"

/**
 * How a child came to be one: `started` through a door (`agents_start`),
 * `discovered` as a harness CLI run from a Mako Session's shell (found by
 * `MAKO_SESSION_ID`), `linked` named afterwards (`agents_link`), or
 * `attached` by the person.
 */
export const ChildOriginSchema = z.enum(["started", "discovered", "linked", "attached"])
export type ChildOrigin = z.infer<typeof ChildOriginSchema>

/** What a child is to its parent; `lead` makes it a sub-lead, which digests its own children. */
export const ChildRoleSchema = z.enum(["worker", "reviewer", "verifier", "researcher", "lead"])
export type ChildRole = z.infer<typeof ChildRoleSchema>

/**
 * Where a child runs: this Mac (`here`), another of the person's devices by
 * its name (`device:<name>`), or a cloud machine. Absent: where its parent runs.
 */
export const PlaceSchema = z.union([z.literal("here"), z.literal("cloud"), z.templateLiteral(["device:", z.string().min(1).max(120)])])
export type Place = z.infer<typeof PlaceSchema>

/** What a child is asked to do, readable two levels down: the parent's intent, and how it knows it's done. */
export const BriefSchema = z.object({
  objective: z.string().min(1).max(200_000),
  doneWhen: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  boundaries: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  /** What its report must carry. */
  output: z.string().max(2_000).optional(),
})
export type Brief = z.infer<typeof BriefSchema>

/**
 * What a spawn asked for, kept as asked. What the child runs as now (its
 * harness, model, access, folder and branch) is its Thread's and Session's,
 * read there: a child continued on another harness is that Thread's fact.
 */
export const ChildSpecSchema = z.object({
  brief: BriefSchema,
  harness: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(256).optional(),
  reasoning: z.string().min(1).max(64).optional(),
  /** At most the parent's tier (`childAccess`); absent means the parent's. */
  access: z.enum(ACCESS_TIER_NAMES).optional(),
  place: PlaceSchema.optional(),
  workspace: z.object({ branch: z.string().min(1).max(256).optional(), base: z.string().min(1).max(256).optional() }).optional(),
})
export type ChildSpec = z.infer<typeof ChildSpecSchema>

/**
 * A run Mako didn't start (`discovered`, `linked`): its harness's own process,
 * followed through its Session and its pid. A pid alone is reused, so its
 * start time says it's the same process. `runDir` names where a run #286's
 * builds started keeps its exit status. Its end is written once and never
 * reopened.
 */
export const FollowedRunSchema = z.object({
  harness: z.string().min(1).max(64),
  /** Its harness's ID for its Session, once known. */
  nativeId: z.string().min(1).max(512).optional(),
  /** The device it runs on: only that device's hosts can see its process. */
  device: z.string().uuid(),
  process: z.object({ pid: z.number().int().positive(), startedAt: z.number().optional() }).optional(),
  runDir: z.string().max(4096).optional(),
  startedAt: z.number(),
  ended: z.object({
    at: z.number(),
    kind: z.enum(["done", "failed", "stopped", "unknown"]),
    detail: z.string().max(2000).optional(),
    toolUses: z.number().int().nonnegative().optional(),
  }).optional(),
})
export type FollowedRun = z.infer<typeof FollowedRunSchema>

/**
 * The edge: one row of `thread_parents`, keyed by the child Thread, written
 * by the child's owner. It holds only what nothing else does; the child's
 * state is computed (`childState`), never stored beside it.
 */
export const ThreadParentSchema = z.object({
  /** The key: one parent per child. */
  child: ThreadIdSchema,
  parent: ThreadIdSchema,
  /** The Session notices go to; if it's gone, the parent's current Session. */
  parentSession: SessionIdSchema,
  /** Unique among the parent's children; addressable as `child:<name>`. */
  name: z.string().min(1).max(80),
  role: ChildRoleSchema,
  origin: ChildOriginSchema,
  /** What the spawn asked for, immutable. A discovered or linked child was asked nothing; its brief is what its Session first said. */
  asked: ChildSpecSchema,
  /** The spawn's operation (`start:{caller}:{clientKey}`); a repeated spawn answers this edge. */
  op: z.string().min(1).max(512),
  startedBy: ActorSchema,
  createdAt: z.number(),
  /** The delegation is over; the child keeps existing as a Thread. */
  closedAt: z.number().optional(),
  /** Present while a process Mako didn't start runs the child's turns (`FollowedRun`). */
  run: FollowedRunSchema.optional(),
})
export type ThreadParent = z.infer<typeof ThreadParentSchema>

/** A typed report from a child: explicit (`agents_report`), or implicit when its turn or run ended without one. */
export const ReportStatusSchema = z.enum(["progress", "done", "blocked", "needs-input", "failed"])
export type ReportStatus = z.infer<typeof ReportStatusSchema>
export const ArtifactSchema = z.object({
  kind: z.enum(["branch", "commit", "pull-request", "file", "screenshot", "test-run", "link"]),
  ref: z.string().min(1).max(4096),
  label: z.string().max(200).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>
export const ReportSchema = z.object({
  /** Explicit: `report:{child}:{clientKey}`. Implicit: `report:{child}:{turn}`, the request or run whose end it is. */
  id: z.string().min(1).max(600),
  child: ThreadIdSchema,
  status: ReportStatusSchema,
  /** Its first sentence is the digest's line. */
  summary: z.string().max(16_000),
  artifacts: z.array(ArtifactSchema).max(64).optional(),
  /** What it waits on, for `blocked` and `needs-input`. */
  question: z.string().max(4_000).optional(),
  /** Recorded by the owner because the turn ended without one. */
  implicit: z.literal(true).optional(),
  /** The child owner's generation when it was written: a report from a stale owner is refused. */
  ownerGeneration: z.number().int().positive(),
  at: z.number(),
})
export type Report = z.infer<typeof ReportSchema>

/** Why a spawn waits: the tree's running budget, or (from 8.4) its place. */
export type QueueReason = "tree-running" | "place-full" | "device-offline"

/**
 * A child's state, computed by `childState` and never stored. `agents_list`,
 * the roster entry and the window's `rollup` all read it.
 */
export type ChildState =
  | { kind: "queued"; reason: QueueReason; ahead: number }
  | { kind: "starting"; step: "placing" | "preparing" | "booting" | "launching" }
  | { kind: "working"; step?: string; phase?: string }
  | { kind: "idle" }
  | { kind: "blocked"; question: string; on: "lead" | "person" | "approval" }
  | { kind: "ended"; outcome: "done" | "failed" | "stopped"; reason?: string }

/**
 * What the child's Thread shows now, from whatever runs its current turn: the
 * live snapshot for a turn Mako drives, or the follower for a run Mako didn't
 * start (`childReading` in the engine). One source at a time.
 */
export interface ChildThread {
  source: "live" | "followed"
  /** Its Session, and where this device's catalog reads its transcript. */
  session?: SessionId
  path?: string
  title?: string
  harness?: string
  model?: string
  /** The admission queue holds it. */
  queued?: { reason: QueueReason; ahead: number }
  starting?: "placing" | "preparing" | "booting" | "launching"
  /** A turn or its process is at work. */
  working?: boolean
  /** The last thing its transcript shows it doing (`lastStep`). */
  step?: string
  /** An approval or question in it waits, and on whom. */
  waiting?: { question: string; on: "lead" | "person" | "approval" }
  /** How its last turn or run ended; absent while one runs or before any ended. */
  ended?: { outcome: "done" | "failed" | "stopped" | "unknown"; reason?: string; at: number }
  toolUses?: number
  startedAt?: number
  updatedAt?: number
}

/** The child's reports, as its owner keeps them: the newest decides what its parent last heard. */
export interface ChildJournal {
  latest?: Report
}

/** Its last report's first sentence: what a strip and the digest show it at. */
export function reportPhase(report: Report | undefined): string | undefined {
  const text = report?.summary.trim()
  if (!text) return undefined
  const sentence = /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text.split("\n", 1)[0]!
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence
}

/**
 * The one way anything learns a child's state. A closed delegation, or a turn
 * that ended with nothing after it, reads as ended with how it went; a child
 * whose last word is a question reads as blocked on it.
 */
export function childState(edge: ThreadParent, thread: ChildThread, journal: ChildJournal): ChildState {
  if (thread.queued) return { kind: "queued", reason: thread.queued.reason, ahead: thread.queued.ahead }
  if (thread.starting) return { kind: "starting", step: thread.starting }
  if (thread.waiting) return { kind: "blocked", question: thread.waiting.question, on: thread.waiting.on }
  const latest = journal.latest
  const phase = latest?.status === "progress" ? reportPhase(latest) : undefined
  if (thread.working) return { kind: "working", ...(thread.step && { step: thread.step }), ...(phase && { phase }) }
  if (latest && (latest.status === "blocked" || latest.status === "needs-input") && !edge.closedAt)
    return { kind: "blocked", question: latest.question ?? reportPhase(latest) ?? "It asks for a decision.", on: "lead" }
  const ended = thread.ended
  if (ended?.outcome === "stopped") return { kind: "ended", outcome: "stopped", ...(ended.reason && { reason: ended.reason }) }
  if (latest?.status === "done") return { kind: "ended", outcome: "done" }
  if (latest?.status === "failed") return { kind: "ended", outcome: "failed", reason: reportPhase(latest) ?? "It failed." }
  if (ended) return ended.outcome === "done"
    ? { kind: "ended", outcome: "done" }
    : { kind: "ended", outcome: ended.outcome === "unknown" ? "failed" : ended.outcome, ...(ended.reason && { reason: ended.reason }) }
  if (edge.closedAt) return { kind: "ended", outcome: "stopped" }
  return { kind: "idle" }
}

/** A roster entry's id for a child: stable for its whole life, whatever runs its turns. */
export function childEntryId(child: ThreadId): string {
  return `mako-child:${child}`
}

/**
 * The roster entry a child is (`CHILDREN_BINDING`), from its edge and what its
 * Thread shows. Every surface draws this one entry (the Agents panel, the
 * transcript's line, the composer's toggle, the phone), and it's never saved in
 * the parent's journal.
 */
export function childEntry(edge: ThreadParent, thread: ChildThread, journal: ChildJournal): NativeAgent {
  const state = childState(edge, thread, journal)
  const entry: NativeAgent = {
    nativeId: childEntryId(edge.child),
    title: thread.title ?? edge.name,
    work: "agent",
    background: true,
    stoppable: state.kind === "working" || state.kind === "starting" || state.kind === "queued" || state.kind === "blocked",
    state: entryState(state),
    bindingId: CHILDREN_BINDING,
    provider: thread.harness ?? edge.asked.harness ?? edge.run?.harness ?? "unknown",
    observedAt: thread.updatedAt ?? edge.createdAt,
    startedAt: thread.startedAt ?? edge.createdAt,
    child: { thread: edge.child, origin: edge.origin, ...(thread.session && { session: thread.session }), ...(thread.path && { path: thread.path }) },
  }
  entry.detail = edge.asked.brief.objective.slice(0, 8192)
  const model = thread.model ?? edge.asked.model
  if (model) entry.model = model
  if (edge.role !== "worker") entry.role = edge.role
  if (thread.toolUses) entry.usage = { toolUses: thread.toolUses }
  if (state.kind === "ended") entry.settledAt = thread.ended?.at ?? journal.latest?.at ?? edge.closedAt ?? edge.createdAt
  return entry
}

function entryState(state: ChildState): NativeAgent["state"] {
  switch (state.kind) {
    case "queued":
      return { kind: "waiting", reason: state.reason === "tree-running" ? `Queued: ${state.ahead} ahead, the tree's running budget is in use` : `Queued: ${state.ahead} ahead` }
    case "starting":
      return { kind: "working", activity: "Starting" }
    case "working":
      return { kind: "working", ...((state.phase ?? state.step) && { activity: state.phase ?? state.step }) }
    case "idle":
      return { kind: "waiting", reason: "Idle: a message gives it its next turn" }
    case "blocked":
      return { kind: "waiting", reason: state.question }
    case "ended":
      if (state.outcome === "done") return { kind: "completed" }
      if (state.outcome === "stopped") return { kind: "canceled" }
      return { kind: "failed", error: state.reason ?? "It failed." }
  }
}

/** Mako's access ladder, least to most permissive; `deny` is beside it (`childAccess`). */
export const ACCESS_LADDER: readonly AccessTier[] = ["plan", "chat", "ask", "edits", "auto", "full"]

/**
 * The tier a child may run on under a parent on `parent`, given what it asked:
 * at most the parent's. A parent on `deny` starts children on `deny`, `plan`
 * or `chat`. Undefined: refused.
 */
export function childAccess(parent: AccessTier, asked: AccessTier | undefined): AccessTier | undefined {
  const wanted = asked ?? parent
  if (parent === "deny") return wanted === "deny" || wanted === "plan" || wanted === "chat" ? wanted : undefined
  if (wanted === "deny") return wanted
  return ACCESS_LADDER.indexOf(wanted) <= ACCESS_LADDER.indexOf(parent) ? wanted : undefined
}

/** The tree's budgets, held by its authority: the lead's host in 8.1. No depth: cycles are refused instead. */
export interface TreeBudget {
  /** Threads running at once across the tree. */
  running: number
  /** Threads started in total. */
  started: number
}
export const TREE_BUDGET: TreeBudget = { running: 20, started: 100 }

/** Who calls an orchestration operation: the door stamps it, and through the socket it's a label, not a grant. */
export type AgentCaller = { kind: "agent"; session: string } | { kind: "person" }

/** A refusal is an answer, not an error, so every door says it the same way. */
export type AgentRefusalReason =
  | "place-unavailable"
  | "access"
  | "budget"
  | "cycle"
  | "unknown-child"
  | "unknown-harness"
  | "no-parent"
  | "conflict"
  | "stale-owner"
  | "unavailable"
export interface AgentRefused {
  refused: AgentRefusalReason
  why: string
}
