import type { ForkInput } from "../contracts/conversation-control.js"
import {
  RewindInputSchema,
  type RewindInput,
  type RewindPlan,
  type RewindPreview,
  type RunSnapshots,
} from "../contracts/workspace-snapshots.js"
import type { CheckpointComparison } from "../workspaces/index.js"
import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import type { LiveAccess, Resident } from "./live-runtime.js"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { join } from "node:path"
import type { LiveTurnChanges } from "./live-turn-changes.js"

/**
 * How long an untracked/non-Git turn waits for its optional checkpoint before it goes without one. Behind a slow save of the
 * last turn's checkpoint, in a checkout under constant builds, a send once waited 127 s. The capture still runs (its run
 * is what the turn's end checkpoints against), but what it holds after the turn went is never the turn's `before`.
 */
export const BEFORE_CHECKPOINT_WAIT_MS = 10_000

/** Turns kept open for reading their files; each holds one object reader. */
const OPEN_TURNS = 4

/** Captures run boundaries before dispatch/queue drain; rewind creates an idle
 * historical fork so no irreversible provider rollback participates in recovery. */
export class LiveCheckpoints {
  private readonly preparing = new Set<string>()
  /** Checkpoints of each conversation under way, a turn's start and its end alike: `checkpointing` while any is. */
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

  prompt(
    resident: Resident,
    request: LiveRequest,
    run: () => Promise<void>
  ): Promise<void> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots && !this.host.dependencies.prepareTurn) return run()
    const generation = resident.generation
    return this.prepare(resident, request).then(() => {
      if (
        generation !== resident.generation ||
        resident.snapshot.requests.find((item) => item.id === request.id)
          ?.status !== "dispatching"
      ) {
        snapshots?.abandonRun(request.id)
        this.host.drain(resident)
        this.host.residencyChanged(resident)
        return
      }
      return run()
    }).catch((error) => {
      this.host.residencyChanged(resident)
      throw error
    })
  }

  /** A checkpoint of the conversation's workspace begins; what it returns ends it. */
  private hold(resident: Resident): () => void {
    this.capturing.set(resident, (this.capturing.get(resident) ?? 0) + 1)
    resident.checkpointing = true
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.capturing.get(resident) ?? 1) - 1
      this.capturing.set(resident, left)
      resident.checkpointing = left > 0
      this.host.noteWork(resident)
    }
  }

  /**
   * Confirm tracking before capturing a Git turn's baseline. Those turns wait until content is saved; outside Git,
   * the optional checkpoint can still release once frozen or after its deadline.
   */
  private async prepare(
    resident: Resident,
    request: LiveRequest
  ): Promise<void> {
    const release = this.hold(resident)
    const generation = resident.generation
    this.preparing.add(request.id)
    try {
      const tracking = await this.host.dependencies.prepareTurn?.(resident.snapshot.session.cwd)
      if (tracking !== undefined && (generation !== resident.generation || resident.snapshot.requests.find(item => item.id === request.id)?.status !== "dispatching")) return
      await this.capture(resident, request, tracking === "tracked")
    } finally {
      this.preparing.delete(request.id)
      release()
    }
  }

  private async capture(
    resident: Resident,
    request: LiveRequest,
    required: boolean
  ): Promise<void> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) {
      if (required) throw new Error("The turn's content baseline service is unavailable")
      return
    }
    const release = this.hold(resident)
    const generation = resident.generation
    const conversation = resident.snapshot.session.id
    const began = Date.now()
    let heldAt: number | undefined
    let wentAt: number | undefined
    let frozen = () => {}
    const held = new Promise<void>((resolve) => (frozen = () => {
      heldAt ??= Date.now()
      resolve()
    }))
    const saved = (async () => {
      try {
        await snapshots.assertAvailable(resident.snapshot.session.cwd)
        let before: RunSnapshots["before"]
        try {
          const snapshot = await snapshots.beginRun(request.id, resident.snapshot.session.cwd, frozen)
          const late = wentAt === undefined ? 0 : (heldAt ?? Date.now()) - wentAt
          // Held after the turn went, it may already hold the turn's own edits: a rewind to it would keep them and the
          // turn's diff would leave them out, so it's never the turn's `before`. The capture still ran for `endRun`.
          before = late > 0
            ? { kind: "unavailable", reason: `The checkpoint held the workspace ${Math.round(late / 1000)} s after the turn went, so it may hold the turn's own edits` }
            : { kind: "ready", snapshot }
        } catch (error) {
          before = { kind: "unavailable", reason: errorMessage({ error }) }
        }
        // Each turn's checkpoint says how long it took to hold the workspace and to be saved, so a slow one is seen.
        hostLog("checkpoints", "a turn's checkpoint was saved", {
          conversation, request: request.id, kind: before.kind, heldMs: heldAt === undefined ? null : heldAt - began,
          savedMs: Date.now() - began, ...wentAt !== undefined && { wentWithoutMs: wentAt - began },
        })
        if (generation !== resident.generation) return
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((item) =>
            item.id === request.id ? { ...item, snapshots: { ...item.snapshots, before } } : item
          ),
        }
        this.host.flush(resident)
      } finally {
        release()
      }
    })()
    // A failure after the turn went is the request's `before`, said above; one before it fails the start as ever.
    void saved.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.host.dependencies.checkpointWaitMs ?? BEFORE_CHECKPOINT_WAIT_MS)
    })
    try {
      // A tracked turn needs durable content from before its first tool. A frozen callback or a deadline cannot prove it.
      const outcome = required ? await saved : await Promise.race([held, saved, waited])
      if (required && generation === resident.generation) {
        const before = resident.snapshot.requests.find(item => item.id === request.id)?.snapshots?.before
        if (before?.kind !== "ready") throw new Error(before?.reason ?? "The turn's content baseline was not saved")
      }
      if (outcome === "late" && heldAt === undefined) {
        // Never a send waiting minutes on its checkpoint: the turn goes, said so, and the capture lands on it if it ends.
        wentAt = Date.now()
        hostWarn("checkpoints", "a turn went before its checkpoint held the workspace", { conversation, request: request.id, waitedMs: wentAt - began })
        if (generation === resident.generation) {
          const reason = "The checkpoint was still waiting when the turn went"
          resident.snapshot = {
            ...resident.snapshot,
            requests: resident.snapshot.requests.map((item) =>
              item.id === request.id && !item.snapshots?.before ? { ...item, snapshots: { ...item.snapshots, before: { kind: "unavailable", reason } } } : item
            ),
          }
          this.host.flush(resident)
        }
      }
    } finally {
      clearTimeout(timer)
      // The turn goes on, steered and stopped as any: what the checkpoint still saves holds only the workspace's own
      // lock, which the turn's end and the next turn's checkpoint wait behind.
      release()
    }
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
        release()
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
        // Whatever moved the generation meanwhile (a wake, a relaunch) drained while this held the queue: what waits goes now.
        // On 2026-11-11 a steer's message sat 15 minutes after Claude's stop woke its session during a slow snapshot.
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
