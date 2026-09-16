import type { ForkInput } from "./contracts/conversation-control.js"
import {
  RewindInputSchema,
  type RewindInput,
  type RewindPlan,
  type RewindPreview,
  type RunSnapshots,
} from "./contracts/workspace-snapshots.js"
import type { LiveRequest, LiveSnapshot } from "./shared.js"
import { errorMessage, type LiveAccess, type Resident } from "./live-runtime.js"

/** Captures run boundaries before dispatch/queue drain; rewind creates an idle
 * historical fork so no irreversible provider rollback participates in recovery. */
export class LiveCheckpoints {
  private readonly preparing = new Set<string>()
  private readonly host: LiveAccess
  private readonly fork: (id: string, input: ForkInput) => LiveSnapshot
  constructor(
    host: LiveAccess,
    fork: (id: string, input: ForkInput) => LiveSnapshot
  ) {
    this.host = host
    this.fork = fork
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

  settle(resident: Resident, requestId: string): void {
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
    return snapshots.preview(snapshot.id)
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
