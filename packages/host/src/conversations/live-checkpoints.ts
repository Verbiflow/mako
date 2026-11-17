import type { ForkInput } from "../contracts/conversation-control.js"
import { isActiveNativeAgent } from "../contracts/native-agents.js"
import {
  RewindInputSchema,
  type RewindInput,
  type RewindPlan,
  type RewindPreview,
  type RunSnapshots,
} from "../contracts/workspace-snapshots.js"
import type { CheckpointComparison } from "../workspaces/index.js"
import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import { activeBinding, type LiveAccess, type Resident } from "./live-runtime.js"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { join } from "node:path"
import type { LiveTurnChanges } from "./live-turn-changes.js"

/**
 * How long a turn waits for its checkpoint to hold the workspace before it goes without one. Behind a slow save of the
 * last turn's checkpoint, in a checkout under constant builds, a send once waited 127 s. The capture still runs (its run
 * is what the turn's end checkpoints against), but what it holds after the turn went is never the turn's `before`.
 */
export const BEFORE_CHECKPOINT_WAIT_MS = 10_000

/** Turns kept open for reading their files; each holds one object reader. */
const OPEN_TURNS = 4
type ClosingCapture = { state: "reading" | "fixed" | "overlapped" }
/**
 * How a turn's agent may go once its checkpoint is under way: `waited`, the checkpoint held the workspace (or its wait
 * ran out) before the message went; `held`, the message goes at once and `binding`'s writes wait on `gate`.
 */
type Prepared = { kind: "waited" } | { kind: "held"; binding: string; gate: Promise<void> }
/** What went before a turn's checkpoint held the workspace, when it's known (`wentAt`): where writes are held, its first write. */
interface WentFirst { by?: "write" }

/** Captures run boundaries before dispatch/queue drain; rewind creates an idle
 * historical fork so no irreversible provider rollback participates in recovery. */
export class LiveCheckpoints {
  private readonly preparing = new Set<string>()
  /** Before publication may finish after its closing capture, without holding the next send. */
  private readonly saving = new Map<string, Promise<void>>()
  /** Checkpoints of each conversation under way, a turn's start and its end alike: `checkpointing` while any is. */
  private readonly capturing = new WeakMap<Resident, number>()
  /** Captures of each conversation still reading its live files, before their read is fixed: `checkpointReading` while any is. */
  private readonly reads = new WeakMap<Resident, number>()
  /** A closing payload may finish later; only its live-file read must precede the next agent's writes. */
  private readonly endings = new WeakMap<Resident, Set<ClosingCapture>>()
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
    return this.prepare(resident, request).then(async (prepared) => {
      // Held for a binding no longer the one that runs (a switch between): its writes wouldn't wait, so the turn does.
      if (prepared.kind === "held" && activeBinding(resident)?.id !== prepared.binding) await prepared.gate
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
      // A closing capture still reading as the next agent may write could hold its edits. Where writes are held, that
      // moment is when the hold lets go, not now.
      if (prepared.kind === "waited" || activeBinding(resident)?.id !== prepared.binding) this.overlapEndings(resident)
      return run()
    }).catch((error) => {
      this.host.residencyChanged(resident)
      throw error
    })
  }

  private overlapEndings(resident: Resident): void {
    for (const ending of this.endings.get(resident) ?? [])
      if (ending.state === "reading") ending.state = "overlapped"
  }

  /** The binding whose writes this turn's checkpoint can hold, when its harness waits for Mako before each tool. */
  private writeHolding(resident: Resident): { holds: NonNullable<LiveAccess["dependencies"]["writeHolds"]>; binding: string } | undefined {
    const holds = this.host.dependencies.writeHolds
    const binding = activeBinding(resident)
    const firstWrite = binding && this.host.dependencies.driver(binding.provider)?.firstWrite
    if (!holds || !binding || !firstWrite || !holds.attends(binding.id)) return undefined
    // A command still running takes the agent's input with no hook between: nothing could hold that write.
    if (firstWrite.openCommands && resident.snapshot.nativeAgents?.agents.some((agent) => agent.work === "command" && isActiveNativeAgent(agent))) return undefined
    return { holds, binding: binding.id }
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
   * A capture's read of the workspace's live files begins: until what it returns is called (its read is fixed, or the
   * capture ended), what the person sends into a running turn waits (`LiveActions.submit`). Its publication after
   * that holds only moves, rewinds and residency (`hold`).
   */
  private reading(resident: Resident): () => void {
    this.reads.set(resident, (this.reads.get(resident) ?? 0) + 1)
    resident.checkpointReading = true
    let open = true
    return () => {
      if (!open) return
      open = false
      const left = (this.reads.get(resident) ?? 1) - 1
      this.reads.set(resident, left)
      resident.checkpointReading = left > 0
    }
  }

  /**
   * The turn's checkpoint. Where the harness holds its agent's writes (`writeHolding`), resolves at once and the
   * writes wait instead; otherwise once it holds the workspace as the turn starts, when its agent may be told, which
   * for a turn from the last checkpoint is before it's saved (`WorkspaceSnapshots.beginRun`'s `frozen`). Either way it
   * waits at most `BEFORE_CHECKPOINT_WAIT_MS`. The request says it once it's saved; the agent never waits on that.
   */
  private async prepare(
    resident: Resident,
    request: LiveRequest
  ): Promise<Prepared> {
    const snapshots = this.host.dependencies.workspaceSnapshots
    if (!snapshots) return { kind: "waited" }
    const release = this.hold(resident)
    const read = this.reading(resident)
    this.preparing.add(request.id)
    const generation = resident.generation
    const conversation = resident.snapshot.session.id
    const began = Date.now()
    let heldAt: number | undefined
    let wentAt: number | undefined
    /** What went before the checkpoint held the workspace: the turn's message, or (writes held) its first write. */
    const went: WentFirst = {}
    let frozen = () => {}
    const held = new Promise<void>((resolve) => (frozen = () => {
      heldAt ??= Date.now()
      read()
      resolve()
    }))
    // A workspace that can't be checkpointed fails the start, before the agent is told anything.
    try {
      await snapshots.assertAvailable(resident.snapshot.session.cwd)
    } catch (error) {
      this.preparing.delete(request.id)
      read()
      release()
      throw error
    }
    const saved = (async () => {
      try {
        let before: RunSnapshots["before"]
        try {
          const snapshot = await snapshots.beginRun(request.id, resident.snapshot.session.cwd, frozen)
          const late = wentAt === undefined ? 0 : (heldAt ?? Date.now()) - wentAt
          // Held after the turn went, it may already hold the turn's own edits: a rewind to it would keep them and the
          // turn's diff would leave them out, so it's never the turn's `before`. The capture still ran for `endRun`.
          before = late > 0
            ? { kind: "unavailable", timedOut: true, reason: `The checkpoint held the workspace ${Math.round(late / 1000)} s after ${went.by === "write" ? "the agent first wrote" : "the turn went"}, so it may hold the turn's own edits` }
            : { kind: "ready", snapshot }
        } catch (error) {
          before = { kind: "unavailable", reason: errorMessage({ error }) }
        }
        // Each turn's checkpoint says how long it took to hold the workspace and to be saved, so a slow one is seen.
        hostLog("checkpoints", "a turn's checkpoint was saved", {
          conversation, request: request.id, kind: before.kind, heldMs: heldAt === undefined ? null : heldAt - began,
          savedMs: Date.now() - began, ...wentAt !== undefined && { wentWithoutMs: wentAt - began },
        })
        // The immutable boundary belongs to this request even if Stop/wake advanced its session generation while
        // packing. Dispatch still checks generation in prompt(); a request removed by rewind keeps no late boundary.
        if (generation !== resident.generation && !resident.snapshot.requests.some((item) => item.id === request.id)) return
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((item) =>
            item.id === request.id ? { ...item, snapshots: { ...item.snapshots, before } } : item
          ),
        }
        this.host.flush(resident)
      } finally {
        read()
        release()
      }
    })()
    // A failure after the turn went is the request's `before`, said above; one before it fails the start as ever.
    this.saving.set(request.id, saved)
    void saved.finally(() => {
      if (this.saving.get(request.id) === saved) this.saving.delete(request.id)
    }).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.host.dependencies.checkpointWaitMs ?? BEFORE_CHECKPOINT_WAIT_MS)
    })
    const gate = Promise.race([held, saved, waited])
    // `late`: the turn's message went before the checkpoint held the workspace; `wrote`, where writes are held, its
    // first write did.
    const wentWithout = (outcome: "late" | "wrote" | void) => {
      if (!outcome || heldAt !== undefined || wentAt !== undefined) return
      // Never a send, nor a write, waiting minutes on its checkpoint: the turn goes, said so, and the capture lands
      // on it if it ends.
      wentAt = Date.now()
      if (outcome === "wrote") went.by = "write"
      hostWarn("checkpoints", outcome === "wrote" ? "a turn's first write went before its checkpoint held the workspace" : "a turn went before its checkpoint held the workspace", { conversation, request: request.id, waitedMs: wentAt - began })
      try {
        this.host.dependencies.checkpointTimedOut?.(wentAt - began)
      } catch {
        // Diagnostics must never prevent or delay provider dispatch.
      }
      if (generation === resident.generation) {
        const reason = outcome === "wrote" ? "The checkpoint was still waiting when the agent first wrote" : "The checkpoint was still waiting when the turn went"
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((item) =>
            item.id === request.id && !item.snapshots?.before ? { ...item, snapshots: { ...item.snapshots, before: { kind: "unavailable", reason, timedOut: true } } } : item
          ),
        }
        this.host.flush(resident)
      }
    }
    const settle = () => {
      clearTimeout(timer)
      this.preparing.delete(request.id)
      // The turn goes on, steered and stopped as any: what the checkpoint still saves holds only the workspace's own
      // lock, which the turn's end and the next turn's checkpoint wait behind.
      release()
    }
    const holding = this.writeHolding(resident)
    if (holding) {
      // The agent is told now; what it may write waits on the same race the message would have. A checkpoint is late
      // (`wentAt`) only if a write was let go before it held the workspace: a turn that writes nothing keeps it, however
      // long the capture takes.
      this.preparing.delete(request.id)
      // The agent can't write before the hold lets go, so what the person sends into its turn needn't wait for the read.
      read()
      let open = () => {}
      const writes = new Promise<void>((resolve) => (open = resolve))
      const unhold = holding.holds.hold(holding.binding, {
        until: writes,
        frozen: () => heldAt !== undefined,
        wrote: () => {
          // A closing capture still reading as the agent writes could hold its edits, as a send's could.
          this.overlapEndings(resident)
          wentWithout("wrote")
        },
      })
      void gate.catch(() => undefined).finally(() => {
        settle()
        open()
      })
      // Held until its capture ends: once the checkpoint holds the workspace, a write goes at once (`TurnHold.frozen`).
      void saved.catch(() => undefined).finally(unhold)
      return { kind: "held", binding: holding.binding, gate: writes }
    }
    try {
      // A failure after the turn went is the request's `before`, said above; one before it fails the start as ever.
      wentWithout(await gate)
    } finally {
      settle()
    }
    return { kind: "waited" }
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
    const read = this.reading(resident)
    const endings = this.endings.get(resident) ?? new Set<ClosingCapture>()
    this.endings.set(resident, endings)
    const ending: ClosingCapture = { state: "reading" }
    endings.add(ending)
    void snapshots
      .endRun(requestId, () => {
        read()
        if (ending.state === "reading") ending.state = "fixed"
      })
      .then(
        (snapshot): NonNullable<RunSnapshots["after"]> => ending.state === "overlapped" ? {
          kind: "unavailable",
          reason: "The next turn started before this closing checkpoint held the workspace, so it may hold the next turn's edits",
        } : ({
          kind: "ready",
          snapshot,
        }),
        (error): NonNullable<RunSnapshots["after"]> => ({
          kind: "unavailable",
          reason: errorMessage({ error }),
        })
      )
      .then(async (after) => {
        // Still its turn's end after a wake or a relaunch moved the generation on; a request rewound away takes it with it.
        // Over before the batch that says it goes: what reads the conversation's work as its batch comes (the
        // account's list) reads it at rest, and no later batch would say so.
        release()
        this.host.drain(resident)
        // The closing files are saved, so another turn can start. Only the record waits: RunSnapshots requires
        // before before it can attach after, and an independent closing pack can finish first.
        await this.saving.get(requestId)?.catch(() => undefined)
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
        endings.delete(ending)
        if (!endings.size) this.endings.delete(resident)
        read()
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
