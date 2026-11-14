import type { ForkInput } from "../contracts/conversation-control.js"
import {
  RewindInputSchema,
  type RewindInput,
  type RewindPlan,
  type RewindPreview,
  type RunSnapshots,
  type WorkspaceTracking,
} from "../contracts/workspace-snapshots.js"
import type { CheckpointComparison } from "../workspaces/index.js"
import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import type { LiveAccess, Resident } from "./live-runtime.js"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { join } from "node:path"
import type { LiveTurnChanges } from "./live-turn-changes.js"

/** Turns kept open for reading their files; each holds one object reader. */
const OPEN_TURNS = 4
/** Only an unprepared checkpoint uses the existing send budget. Tracking never holds it. */
export const BEFORE_CHECKPOINT_WAIT_MS = 10_000

/** Captures run boundaries before dispatch/queue drain; rewind creates an idle
 * historical fork so no irreversible provider rollback participates in recovery. */
export class LiveCheckpoints {
  private readonly preparing = new Map<string, () => void>()
  /** Protect relocation and residency while closing snapshots; dispatch deliberately does not wait on this flag. */
  private readonly capturing = new WeakMap<Resident, number>()
  /** The turns last read, newest last, by their two checkpoints. */
  private readonly turns = new Map<string, CheckpointComparison>()
  private readonly host: LiveAccess
  private readonly fork: (id: string, input: ForkInput) => LiveSnapshot
  private readonly changes: LiveTurnChanges
  constructor(
    host: LiveAccess,
    fork: (id: string, input: ForkInput) => LiveSnapshot,
    changes: LiveTurnChanges
  ) {
    this.host = host
    this.fork = fork
    this.changes = changes
  }

  private hold(resident: Resident): () => void {
    this.capturing.set(resident, (this.capturing.get(resident) ?? 0) + 1)
    resident.checkpointing = true
    let held = true
    return () => {
      if (!held) return
      held = false
      const remaining = (this.capturing.get(resident) ?? 1) - 1
      this.capturing.set(resident, remaining)
      resident.checkpointing = remaining > 0
      this.host.noteWork(resident)
    }
  }

  /** A prepared checkpoint is a flag read; a missing one keeps its independent bounded capture opportunity. */
  async prompt(resident: Resident, request: LiveRequest, run: () => Promise<void>): Promise<void> {
    const began = Date.now(), generation = resident.generation
    const cwd = resident.snapshot.session.cwd
    const snapshots = this.host.dependencies.workspaceSnapshots
    let tracking = this.host.dependencies.workspaceTracking?.(cwd)
    const prepared = snapshots?.beginPreparedRun(request.id, cwd)
    let canceled = false, wentAt: number | undefined
    let before: RunSnapshots["before"] = prepared?.kind === "ready" ? { kind: "ready", snapshot: prepared.snapshot } : { kind: "unavailable", reason: prepared?.reason ?? "The turn's content baseline service is unavailable" }
    const stopped = new Promise<void>(resolve => this.preparing.set(request.id, () => { canceled = true; resolve() }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (prepared?.kind !== "ready" && snapshots) {
        let frozen = () => {}
        const held = new Promise<void>(resolve => { frozen = resolve })
        const saved = snapshots.captureRun(request.id, frozen).then(snapshot => {
          if (canceled || generation !== resident.generation) return
          if (wentAt !== undefined) return // Content read after the send cannot replace its true before.
          before = { kind: "ready", snapshot }
          this.record(resident, request.id, before, tracking)
        }, error => {
          if (canceled || generation !== resident.generation || wentAt !== undefined) return
          before = { kind: "unavailable", reason: errorMessage({ error }) }
          this.record(resident, request.id, before, tracking)
        })
        void saved.catch(() => {})
        const deadline = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), this.host.dependencies.checkpointWaitMs ?? BEFORE_CHECKPOINT_WAIT_MS) })
        const outcome = await Promise.race([held, saved, deadline, stopped])
        if (outcome === "late") {
          wentAt = Date.now()
          before = { kind: "unavailable", reason: "The checkpoint was still waiting when the turn went" }
        }
        // A frozen callback can release while saving continues. Its captured content is still before tools.
        if (outcome !== "late") clearTimeout(timer)
      } else await Promise.resolve()
      if (canceled || generation !== resident.generation || resident.snapshot.requests.find(item => item.id === request.id)?.status !== "dispatching") {
        snapshots?.abandonRun(request.id)
        this.host.drain(resident)
        this.host.residencyChanged(resident)
        return
      }
      tracking = this.host.dependencies.workspaceTracking?.(cwd)
      this.record(resident, request.id, before, tracking)
      hostLog("checkpoints", "dispatch used checkpoint state", {
        conversation: resident.snapshot.session.id, request: request.id, cwd, dispatchAt: Date.now(), foregroundMs: Date.now() - began,
        tracking: tracking?.kind ?? "unknown", baseline: before.kind, prepared: prepared?.kind === "ready",
        ...(tracking?.kind === "tracked" && tracking.preparation && { discoveryMs: tracking.preparation.discoveryMs, trackingQueueMs: tracking.preparation.queueMs ?? 0, trackAckMs: tracking.preparation.trackAckMs, trackedAt: tracking.preparation.acknowledgedAt }),
        ...(prepared?.kind === "ready" && { snapshot: prepared.snapshot.id, preparedAt: prepared.preparedAt, captureMs: prepared.captureMs, preparedForMs: Date.now() - prepared.preparedAt }),
      })
      this.preparing.delete(request.id)
      await run()
    } finally {
      clearTimeout(timer)
      this.preparing.delete(request.id)
    }
  }

  private record(resident: Resident, requestId: string, before: RunSnapshots["before"], tracking: WorkspaceTracking | undefined): void {
    const coverage: RunSnapshots["coverage"] = tracking?.kind === "unavailable" || tracking?.kind === "pending" ? { kind: "unavailable", reason: tracking.reason }
      : tracking?.kind === "incomplete" ? { kind: "incomplete", reason: tracking.reason }
      : tracking?.kind === "outside" ? undefined
      : before.kind === "unavailable" ? { kind: "incomplete", reason: before.reason }
      : tracking?.kind === "tracked" ? { kind: "complete" } : undefined
    resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(item => item.id === requestId ? {
      ...item, snapshots: { ...item.snapshots, before, coverage },
    } : item) }
    this.host.flush(resident)
  }

  cancelBeforeDispatch(resident: Resident, requestId?: string): boolean {
    const request = resident.snapshot.requests.find(
      (item) =>
        (!requestId || requestId === item.id) && this.preparing.has(item.id)
    )
    if (!request) return false
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((item) =>
        item.id === request.id
          ? {
              ...item,
              status: "interrupted",
              error: "Canceled before provider dispatch",
            }
          : item
      ),
    }
    this.preparing.get(request.id)?.()
    this.host.flush(resident)
    return true
  }

  /** A request's turn ended: its "after" checkpoint is captured, and the journal counts what it changed. */
  settle(resident: Resident, requestId: string): void {
    this.changes.ended(resident, requestId)
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) return
    const release = this.hold(resident)
    void snapshots
      .endRun(requestId)
      .then(
        (snapshot): NonNullable<RunSnapshots["after"]> => ({
          kind: "ready",
          snapshot,
        }),
        (error): NonNullable<RunSnapshots["after"]> => ({
          kind: "unavailable",
          reason: errorMessage({ error }),
        })
      )
      .then((after) => {
        // Still its turn's end after a wake or a relaunch moved the generation on; a request rewound away takes it with it.
        // Over before the batch that says it goes: what reads the conversation's work as its batch comes (the
        // account's list) reads it at rest, and no later batch would say so.
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((item) =>
            item.id === requestId && item.snapshots
              ? { ...item, snapshots: { ...item.snapshots, after } }
              : item
          ),
        }
        this.host.flush(resident)
      })
      .catch((error) => this.host.storageFailed(resident, { error }))
      .finally(() => {
        release()
        // Finishing a checkpoint only refreshes background state; it never holds the next send.
        this.host.drain(resident)
        this.host.residencyChanged(resident)
      })
  }

  private target(id: string, requestId: string, position: "before" | "after") {
    const resident = this.host.require(id)
    if (
      resident.checkpointing ||
      resident.rewinding ||
      resident.opening ||
      resident.transferring ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.requests.some(
        (request) =>
          request.status === "queued" || request.status === "dispatching"
      )
    )
      throw new Error(
        "Wait for this conversation's pending work to finish before rewinding"
      )
    const request = resident.snapshot.requests.find(
      (item) => item.id === requestId
    )
    const boundary = request?.snapshots?.[position]
    if (
      (position === "after" && request?.status !== "completed") ||
      boundary?.kind !== "ready"
    )
      throw new Error(`This turn has no workspace checkpoint at that point${boundary?.kind === "unavailable" ? `: ${boundary.reason}` : ""}`)
    return { resident, snapshot: boundary.snapshot }
  }

  async preview(
    id: string,
    requestId: string,
    position: "before" | "after"
  ): Promise<RewindPreview> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) throw new Error("Workspace checkpoints are unavailable")
    const { snapshot } = this.target(id, requestId, position)
    const preview = await snapshots.preview(snapshot.id)
    // Whose each file is: a rewind takes back everyone's changes since the checkpoint, the person's and other Threads' too.
    try {
      const scope = preview.target.scope
      const writers = this.host.dependencies.rewindWriters?.(preview.changedFiles.map((path) => join(scope, path)), snapshot.createdAt)
      if (writers) preview.writers = Object.fromEntries(preview.changedFiles.flatMap((path) => {
        const found = writers[join(scope, path)]
        return found ? [[path, found]] : []
      }))
    } catch (error) {
      hostWarn("rewind", "whose files a rewind takes back could not be read", { error: errorMessage({ error }) })
    }
    return preview
  }

  /**
   * One finished turn's two checkpoints, compared, with the folder they
   * saved; undefined unless both were saved. Read from the request as its
   * conversation keeps it, so a conversation nobody has open is read
   * without loading it.
   */
  turn(id: string, requestId: string): { scope: string; comparison: CheckpointComparison } | undefined {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) return undefined
    const request = this.host.request(id, requestId)
    const before = request?.snapshots?.before
    const after = request?.snapshots?.after
    if (before?.kind !== "ready" || after?.kind !== "ready") return undefined
    const comparison = this.compare(snapshots, before.snapshot.id, after.snapshot.id)
    return { scope: comparison.root, comparison }
  }

  private compare(snapshots: NonNullable<LiveAccess["dependencies"]["workspaceSnapshots"]>, before: string, after: string): CheckpointComparison {
    const key = `${before}:${after}`
    // Each read keeps both checkpoints past the next prune, so reading never finds a store gone.
    const trees = snapshots.trees(before, after)
    const open = this.turns.get(key)
    if (open) {
      this.turns.delete(key)
      this.turns.set(key, open)
      return open
    }
    const turn = snapshots.compare(trees)
    this.turns.set(key, turn)
    for (const [oldest, kept] of this.turns) {
      if (this.turns.size <= OPEN_TURNS) break
      kept.close()
      this.turns.delete(oldest)
    }
    return turn
  }

  async rewind(id: string, input: RewindInput): Promise<LiveSnapshot> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) throw new Error("Workspace checkpoints are unavailable")
    const command = RewindInputSchema.parse(input)
    const position = command.position ?? "after"
    const { resident, snapshot } = this.target(id, command.requestId, position)
    const plan: RewindPlan = {
      sourceId: id,
      fork: {
        id: command.id,
        provider: resident.snapshot.session.harness,
        point: {
          kind: position === "before" ? "before-run" : "run",
          requestId: command.requestId,
        },
      },
      targetId: snapshot.id,
      expectedId: command.expectedId,
    }
    resident.rewinding = true
    try {
      await snapshots.restore(plan, () => {
        this.fork(id, plan.fork)
      })
      return this.host.require(command.id).snapshot
    } finally {
      resident.rewinding = false
      this.host.noteWork(resident)
    }
  }

  async recover(): Promise<LiveSnapshot[]> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) return []
    const restored: LiveSnapshot[] = []
    for (const plan of snapshots.pending()) {
      if (plan.fork.point.kind === "native")
        throw new Error("Unsupported saved rewind point")
      const { resident, snapshot } = this.target(
        plan.sourceId,
        plan.fork.point.requestId,
        plan.fork.point.kind === "before-run" ? "before" : "after"
      )
      if (snapshot.id !== plan.targetId)
        throw new Error("The saved rewind does not match the source answer")
      resident.rewinding = true
      try {
        await snapshots.restore(plan, () => {
          this.fork(plan.sourceId, plan.fork)
        })
        restored.push(this.host.require(plan.fork.id).snapshot)
      } finally {
        resident.rewinding = false
        this.host.noteWork(resident)
      }
    }
    return restored
  }
}
