import { join } from "node:path"
import { z } from "zod"
import { ForkInputSchema, type ConversationControl, type ForkInput } from "../contracts/conversation-control.js"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import { resolveAnchor } from "../contracts/message-anchor.js"
import type { ThreadPage } from "@mako/sessions"
import { isTurnStart } from "@mako/sessions/live-content"
import { liveEntries, prepareLiveContext } from "./live-context.js"
import { LiveJournal } from "./live-journal.js"
import { conversationControl, residentOf, type LiveAccess } from "./live-runtime.js"

type ForkAccess = Pick<LiveAccess, "dependencies" | "require" | "load" | "flush" | "stamp" | "add" | "register" | "actor" | "announceGroup">

/** Conversations forked from another at an answer, and the findings a fork sends back to its parent. */
export class LiveForks {
  private readonly access: ForkAccess

  constructor(access: ForkAccess) {
    this.access = access
  }

  async merge(id: string, mergeId: string): Promise<LiveSnapshot> {
    z.string().uuid().parse(mergeId)
    const source = this.access.require(id)
    this.access.flush(source)
    const ancestry = conversationControl(source).ancestry
    if (ancestry?.kind !== "fork")
      throw new Error("Only a fork can send findings back to its parent")
    const parent = this.access.require(ancestry.parentId)
    const existing = conversationControl(parent).merges.find(
      (merge) => merge.id === mergeId
    )
    if (existing) {
      if (existing.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    if (
      source.snapshot.session.status === "running" ||
      source.snapshot.requests.some(
        (request) =>
          request.status === "queued" || request.status === "dispatching"
      )
    )
      throw new Error(
        "Wait for the fork's current turn to finish before transferring findings"
      )
    if (
      !source.snapshot.requests.some(
        (request) => request.status === "completed"
      )
    )
      throw new Error("The fork has no completed findings yet")
    const captured = source.snapshot
    const manifest = await prepareLiveContext({
      snapshot: captured,
      root: join(this.access.dependencies.root, "context"),
      fromBlock: 0,
      includesBase: false,
    })
    const control = conversationControl(parent)
    const concurrent = control.merges.find((merge) => merge.id === mergeId)
    if (concurrent) {
      if (concurrent.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    const previous = parent.snapshot
    parent.snapshot = {
      ...previous,
      control: {
        ...control,
        merges: [
          ...control.merges,
          {
            id: mergeId,
            sourceId: id,
            sourceRevision: captured.revision,
            manifest,
            status: "pending",
          },
        ],
      },
    }
    try {
      this.access.flush(parent)
    } catch (error) {
      parent.snapshot = previous
      throw error
    }
    return parent.snapshot
  }

  /** `cwd` places the fork's Session in another folder: a worktree the host made for it. */
  fork(id: string, input: ForkInput, cwd?: string): LiveSnapshot {
    const { dependencies } = this.access
    const command = ForkInputSchema.parse(input)
    const parent = this.access.require(id)
    this.access.flush(parent)
    const source = parent.snapshot
    const point = JSON.stringify(command.point)
    const placement = command.thread === "new" ? undefined : "parent-thread"
    const existing = this.access.load(command.id)
    if (existing) {
      if (
        existing.snapshot.control?.ancestry?.parentId !== id ||
        existing.snapshot.control.ancestry.point !== point ||
        (existing.snapshot.control.ancestry.provider ??
          existing.snapshot.session.harness) !== command.provider
      )
        throw new Error("This fork ID belongs to another source point")
      if (existing.snapshot.control.ancestry.placement !== placement)
        throw new Error("This fork ID was used for a fork into another Thread")
      return this.access.stamp(existing.snapshot)
    }
    let nativeFork: NonNullable<ConversationControl["ancestry"]>["nativeFork"]
    let entries = source.base?.entries ?? []
    if (command.point.kind === "run" || command.point.kind === "before-run") {
      const requestId = command.point.requestId
      const request = source.requests.find(
        (candidate) => candidate.id === requestId
      )
      if (
        !request ||
        (command.point.kind === "run" && request.status !== "completed")
      )
        throw new Error("Fork from a completed answer")
      const binding = source.control?.bindings.find(
        (candidate) => candidate.id === request.nativeRun?.bindingId
      )
      const fork = dependencies.driver(command.provider)?.fork
      const nativePoint =
        fork?.kind !== "native" ? undefined
          : fork.point === "checkpoint" ? request.nativeRun?.forkId
            : request.nativeRun?.runId
      // A native session is stored against the folder it ran in, so a fork elsewhere starts fresh with the transcript.
      if (
        cwd === undefined &&
        command.point.kind === "run" &&
        binding?.nativeId &&
        request.nativeRun &&
        binding.provider === command.provider &&
        nativePoint
      )
        nativeFork = {
          provider: binding.provider,
          nativeId: binding.nativeId,
          runId: nativePoint,
          ...binding.path && { path: binding.path },
        }
      const start = source.blocks.findIndex(
        (block) => block.type === "user" && block.requestId === requestId
      )
      if (start < 0)
        throw new Error("The source turn is not present in this capture")
      const next = source.blocks.findIndex(
        (block, index) => index > start && isTurnStart(block)
      )
      const steers = source.blocks
        .slice(start + 1, next < 0 ? undefined : next)
        .filter((block) => block.type === "user" && block.steeringFor === requestId).length
      if (nativeFork && steers) nativeFork = { ...nativeFork, steers }
      const covered = source.baseCoveredBlocks ?? 0
      // The native history read after a checkpoint replaced the blocks it
      // covers. It ends where they end, so it still ends at this answer when
      // no later turn began before that point; an earlier answer is named by
      // its native message instead.
      if (start < covered && (command.point.kind === "before-run" || (next >= 0 && next < covered)))
        throw new Error("The transcript was refreshed. Choose the answer again from its current history.")
      entries = [
        ...entries,
        ...liveEntries(
          source.blocks.slice(
            covered,
            command.point.kind === "before-run"
              ? start
              : next < 0
                ? source.blocks.length
                : next
          )
        ),
      ]
    } else {
      const base = source.base
      if (!base)
        throw new Error(
          "The source history changed. Reload it before choosing a fork point."
        )
      let index = command.point.index - base.start
      if (nativeRevision(base) !== command.point.revision) {
        // The store moved since the transcript was read. The answer is still
        // the same message; find it by its own identity rather than refusing.
        const found = command.point.anchor
          ? resolveAnchor(base.entries, base.start, command.point.anchor, "assistant")
          : undefined
        if (found === undefined)
          throw new Error(
            command.point.anchor
              ? "The source history changed and the chosen answer is no longer in it. Reload the thread and choose again."
              : "The source history changed. Reload it before choosing a fork point."
          )
        index = found - base.start
      }
      if (
        index < 0 ||
        index >= base.entries.length ||
        base.entries[index]?.kind !== "assistant"
      )
        throw new Error(
          "Choose an answer present in the captured native history"
        )
      entries = base.entries.slice(0, index + 1)
    }
    const snapshot: LiveSnapshot = {
      session: {
        ...source.session,
        id: command.id,
        cwd: cwd ?? source.session.cwd,
        harness: command.provider,
        nativeId: undefined,
        nativePath: undefined,
        nativeRunId: undefined,
        nativeForkId: undefined,
        title: command.move ? source.session.title : source.session.title ? `${source.session.title} — fork` : "Fork",
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: command.provider === source.session.harness ? source.session.currentMode : null,
        configOptions: [],
        lastStop: undefined,
        error: undefined,
      },
      revision: 0,
      createdAt: Date.now(),
      blocks: [],
      requests: [],
      permissions: [],
      base: {
        ref: source.base?.ref ?? {
          path: id,
          nativeId: id,
          harness: source.session.harness,
          cwd: source.session.cwd,
        },
        entries,
        start: source.base?.start ?? 0,
        total: entries.length,
        hasEarlier: source.base?.hasEarlier ?? false,
      },
      control: {
        merges: [],
        ancestry: {
          kind: "fork",
          nativeFork,
          provider: command.provider,
          parentId: id,
          sourceRevision: source.revision,
          point,
          placement,
        },
        activeBindingId: command.id,
        bindings: [],
        transfers: [],
      },
    }
    const journal = new LiveJournal(dependencies.root, command.id)
    try {
      journal.commit(snapshot)
      dependencies.memory?.rememberJournal(command.id)
    } catch (error) {
      journal.close()
      throw error
    }
    this.access.add(residentOf(snapshot, journal))
    this.access.register(snapshot, this.access.actor())
    const stamped = this.access.stamp(snapshot)
    if (placement && stamped.threadId) this.access.announceGroup(stamped.threadId)
    return stamped
  }
}

function nativeRevision(page: ThreadPage): string {
  return JSON.stringify([page.ref.revision, page.ref.bytes, page.ref.updatedAt])
}
