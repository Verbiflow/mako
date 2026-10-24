import { join } from "node:path"
import { z } from "zod"
import { ForkInputSchema, type ConversationControl, type ForkInput } from "../contracts/conversation-control.js"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import { resolveAnchor } from "../contracts/message-anchor.js"
import type { ThreadPage } from "@mako/sessions"
import { isTurnStart } from "@mako/sessions/live-content"
import { isReplyEntry, type Entry } from "@mako/sessions/entries"
import { liveEntries, prepareLiveContext } from "./live-context.js"
import { LiveJournal } from "./live-journal.js"
import { conversationControl, residentOf, type LiveAccess } from "./live-runtime.js"
import { baseUnread } from "./base-source.js"
import { SessionIdSchema } from "../contracts/thread-identity.js"

type ForkAccess = Pick<LiveAccess, "dependencies" | "bundles" | "require" | "load" | "flush" | "stamp" | "add" | "register" | "actor" | "announceGroup">

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
      bundles: this.access.bundles,
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
      if (existing.snapshot.control.ancestry.session !== command.session)
        throw new Error("This fork ID was used for a fork into another Session")
      return this.access.stamp(existing.snapshot)
    }
    // A Session the caller named is minted under that ID; one this store has already is refused before anything is made.
    const named = command.session === undefined ? undefined : SessionIdSchema.parse(command.session)
    if (named) {
      const threads = this.access.dependencies.threads
      if (!threads?.writable) throw new Error("This host's Thread store isn't open, so the fork can't go into the Session it was given.")
      if (threads.sessionPlacement(named)) throw new Error(`The Session ${named} the fork was given is one this host has already.`)
    }
    if (baseUnread(source)) throw new Error("This conversation's history is still being read. Try the fork again in a moment.")
    let nativeFork: NonNullable<ConversationControl["ancestry"]>["nativeFork"]
    const entries = forkHistory(source, command.point)
    if (command.point.kind === "run") {
      const requestId = command.point.requestId
      const request = source.requests.find((candidate) => candidate.id === requestId)!
      const binding = source.control?.bindings.find((candidate) => candidate.id === request.nativeRun?.bindingId)
      const fork = dependencies.driver(command.provider)?.fork
      const nativePoint =
        fork?.kind !== "native" ? undefined
          : fork.point === "checkpoint" ? request.nativeRun?.forkId
            : request.nativeRun?.runId
      // A native session is stored against the folder it ran in, so a fork elsewhere starts fresh with the transcript.
      if (cwd === undefined && binding?.nativeId && request.nativeRun && binding.provider === command.provider && nativePoint) {
        const { start, next } = turnOf(source, requestId)
        const steers = source.blocks
          .slice(start + 1, next < 0 ? undefined : next)
          .filter((block) => block.type === "user" && block.steeringFor === requestId).length
        nativeFork = {
          provider: binding.provider,
          nativeId: binding.nativeId,
          runId: nativePoint,
          ...binding.path && { path: binding.path },
          ...steers && { steers },
        }
      }
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
          ...named && { session: named },
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
    if (named && stamped.sessionId !== named)
      throw new Error(`The fork was made, but this host's Thread store didn't file it into the Session it was given (${named}).`)
    if (placement && stamped.threadId) this.access.announceGroup(stamped.threadId)
    return stamped
  }
}

/**
 * The history a fork at `point` goes on from: `source`'s, as it shows it,
 * up to and including that answer (`before-run`: up to the prompt). The
 * fork's journal starts from it, and a native fork's view merges its own
 * record of those turns with it again whenever it reads that record, so
 * what its parent's stream supplied (setup notices, Mako's words for each
 * prompt) stays in the turns it inherited. Throws, with the words the
 * person is shown, when the point isn't in `source`.
 */
export function forkHistory(source: LiveSnapshot, point: ForkInput["point"]): Entry[] {
  if (point.kind === "run" || point.kind === "before-run") {
    const request = source.requests.find((candidate) => candidate.id === point.requestId)
    if (!request || (point.kind === "run" && request.status !== "completed"))
      throw new Error("Fork from a completed answer")
    const { start, next } = turnOf(source, point.requestId)
    const covered = source.baseCoveredBlocks ?? 0
    const end = point.kind === "before-run" ? start : next < 0 ? source.blocks.length : next
    // The native history read after a checkpoint replaced the blocks it
    // covers. It ends where they end, so it still ends at this answer when
    // no later turn began before that point. An earlier turn starts from
    // the native history before the live blocks and goes on with them.
    if (start < covered && (point.kind === "before-run" || (next >= 0 && next < covered))) {
      const prefix = source.base && source.baseLiveStart !== undefined ? source.baseLiveStart - source.base.start : -1
      if (!source.base || prefix < 0 || prefix > source.base.entries.length)
        throw new Error("The transcript was refreshed. Choose the answer again from its current history.")
      return [...source.base.entries.slice(0, prefix), ...liveEntries(source.blocks.slice(0, end))]
    }
    return [...source.base?.entries ?? [], ...liveEntries(source.blocks.slice(covered, end))]
  }
  const base = source.base
  if (!base) throw new Error("The source history changed. Reload it before choosing a fork point.")
  let index = point.index - base.start
  if (nativeRevision(base) !== point.revision) {
    // The store moved since the transcript was read. The answer is still
    // the same message; find it by its own identity rather than refusing.
    const found = point.anchor ? resolveAnchor(base.entries, base.start, point.anchor, isReplyEntry) : undefined
    if (found === undefined)
      throw new Error(point.anchor
        ? "The source history changed and the chosen answer is no longer in it. Reload the thread and choose again."
        : "The source history changed. Reload it before choosing a fork point.")
    index = found - base.start
  }
  if (index < 0 || index >= base.entries.length || !base.entries[index] || !isReplyEntry(base.entries[index]))
    throw new Error("Choose an answer present in the captured native history")
  return base.entries.slice(0, index + 1)
}

/** The live blocks of request `requestId`'s turn: where its prompt is, and where the next turn begins (-1 at the end). */
function turnOf(source: LiveSnapshot, requestId: string) {
  const start = source.blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
  if (start < 0) throw new Error("The source turn is not present in this capture")
  return { start, next: source.blocks.findIndex((block, index) => index > start && isTurnStart(block)) }
}

function nativeRevision(page: ThreadPage): string {
  return JSON.stringify([page.ref.revision, page.ref.bytes, page.ref.updatedAt])
}
