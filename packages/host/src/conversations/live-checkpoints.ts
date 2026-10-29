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
import { hostWarn } from "../base/host-log.js"
import { join } from "node:path"
import type { LiveTurnChanges } from "./live-turn-changes.js"

/** Turns kept open for reading their files; each holds one object reader. */
const OPEN_TURNS = 4

/** Captures run boundaries before dispatch/queue drain; rewind creates an idle
 * historical fork so no irreversible provider rollback participates in recovery. */
export class LiveCheckpoints {
  private readonly preparing = new Set<string>()
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
    if (!snapshots) return run()
    const generation = resident.generation
    return this.prepare(resident, request).then(() => {
      if (
        generation !== resident.generation ||
        resident.snapshot.requests.find((item) => item.id === request.id)
          ?.status !== "dispatching"
      ) {
        snapshots.abandonRun(request.id)
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

  private async prepare(
    resident: Resident,
    request: LiveRequest
  ): Promise<void> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) return
    resident.checkpointing = true
    this.preparing.add(request.id)
    const generation = resident.generation
    try {
      await snapshots.assertAvailable(resident.snapshot.session.cwd)
      let before: RunSnapshots["before"]
      try {
        before = {
          kind: "ready",
          snapshot: await snapshots.beginRun(
            request.id,
            resident.snapshot.session.cwd
          ),
        }
      } catch (error) {
        before = { kind: "unavailable", reason: errorMessage({ error }) }
      }
      if (generation !== resident.generation) return
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((item) =>
          item.id === request.id ? { ...item, snapshots: { before } } : item
        ),
      }
      this.host.flush(resident)
    } finally {
      this.preparing.delete(request.id)
      resident.checkpointing = false
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
    const generation = resident.generation
    resident.checkpointing = true
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
        if (generation !== resident.generation) return
        // Over before the batch that says it goes: what reads the conversation's work as its batch comes (the
        // account's list) reads it at rest, and no later batch would say so.
        resident.checkpointing = false
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
        resident.checkpointing = false
        if (generation === resident.generation) {
          this.host.drain(resident)
          this.host.residencyChanged(resident)
        }
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
      throw new Error("This turn has no workspace checkpoint at that point")
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
      }
    }
    return restored
  }
}
