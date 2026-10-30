import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema, ReturnDepartureSchema, type MoveCheckpoint, type MoveCarryRepository, type ReturnState } from "@mako/protocol/moves"
import type { ArchivedThread } from "@mako/protocol/thread-listing"
import { describeGatewayFailure } from "@mako/protocol/gateway-http"
import { describeSync, withFreshLink, type ReceivedRecords, type ReceivingSession, type RecordsLink, type StagedRecords } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { ReturnProjectMissingSchema, type ReturnLanded, type ReturnWaitsOn, type ThreadReturnOptions, type ThreadReturnOutcome, type ThreadReturnStep } from "../contracts/cloud-threads.js"
import { OutdatedRestoreSchema, type OutdatedRestore, type RuntimeUpdateOffer } from "../contracts/restore-plan.js"
import { decodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import { HandoffSchema, MoveIdSchema, RuntimeIdSchema, type ClaimReceipt, type ExecutionOwner, type Handoff, type MoveId, type SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type SessionId, type ThreadId } from "../contracts/thread-identity.js"
import type { CloudAccount } from "../usage/index.js"
import type { ThreadFileHistory } from "@mako/protocol"
import { applyMoveCheckpoint, captureMoveCheckpoint, mergeReturned, openCarry, planOutsideReturn, ProjectMissingError, returnOutside, unchangedSince, type OpenedCarry, type OutsideReturned } from "../workspaces/index.js"
import { cloudRuntimeOf, MovePlanSchema, namedUuid } from "./cloud-moves.js"
import type { CloudWorktrees } from "./cloud-worktrees.js"

/**
 * A Thread of this Mac's that moved to the cloud, coming back: a move the other way, by the same rules. One owner
 * throughout: the cloud Thread stops taking work before its machine packs, and records itself released before this
 * Mac changes anything; this Mac claims the Thread in its own store only once the checkout and every Session's records
 * are here. Step by step:
 *
 * 1. The cloud begins the return: its Thread takes no work but its machine's departure from now.
 * 2. The machine packs (`mako:move-depart`): only once nothing in the Thread works, it releases the Thread in its own
 *    store toward this Mac, so nothing there runs it from then, and sends the checkout as a checkpoint and each
 *    Session's records with what went of them.
 * 3. The cloud records the Thread released, with what the machine packed: nothing runs it in the cloud from now.
 * 4. This Mac keeps its worktree again as it is right then (a checkpoint of its own, in the return's folder), lays the
 *    machine's checkout over it, merges in what the person changed meanwhile, and writes each Session's records into
 *    its harness's store, holding at least what went. Only what this Mac sent forward comes back to its place.
 * 5. This Mac claims the Thread in its own store, each Session one generation on, and its conversations stop being
 *    the cloud's. The cloud is told the return is done, and ends the machine.
 *
 * What this Mac must have to take the Thread is made sure of before the cloud lets go: its worktree is a checkout Git
 * reads (made ready again from its project if the project moved or the folder went, `ThreadWorktreeService.
 * readyForReturn`), and kept as it is (4's copy) while the machine packs. A Thread whose project isn't on this Mac is
 * refused before the cloud is asked anything, and one whose worktree can't be kept cancels at 3: it goes on in the cloud.
 *
 * A failure before 3 cancels the return: the Thread goes on in the cloud. One after 3 and before 5 puts this Mac's
 * worktree back from the copy it kept and gives the Thread back to the cloud. Either way the machine, which released
 * the Thread as it packed, is told to take it back (`mako:move-stay`) before the return counts as stayed. An answer the
 * cloud didn't give is asked for again, never guessed: until it's heard, the Thread runs nowhere (`unsettled`, waiting
 * on the cloud). So is work of this Mac's after the cloud let go that isn't a refusal (recording the claim), waiting on
 * this Mac. One Thread has one return open at a time: asked back again under another id, the open one goes on. Each
 * step's plan is written first (`<data root>/cloud/returns/<move>.json`), so a host that stops mid-way settles the
 * return at its next start, and the person's "Ask again" settles it now. Every write of the worktree (making it ready,
 * keeping it, laying and merging, putting it back) is one of `CloudWorktrees`', so none overlaps the follow's.
 */

const ReturnSessionSchema = z.object({
  session: z.string(),
  conversationId: z.string(),
  harness: z.string(),
  nativeId: z.string(),
  /** Its generation in this Mac's store as the return began. */
  generation: z.number().int().positive(),
  /** Begun in the cloud (a `+` tab, a fork): no journal here until the return makes one from its records, at `path`. */
  begun: z.boolean().optional(),
  path: z.string().optional(),
  /** The access mode it ran in there as the return began: it goes on in it here. */
  modeId: z.string().optional(),
})

/** `staying`: the cloud has the Thread again, and its machine is still to be told to take it back. */
const PhaseSchema = z.enum(["preparing", "released", "applied", "claimed", "done", "staying", "stayed"])

const ReturnPlanSchema = z.object({
  move: MoveIdSchema,
  thread: ThreadIdSchema,
  asked: z.string(),
  cloudThread: z.string(),
  folder: z.string(),
  /** The forward move's handoff: the Thread and its Sessions as this Mac released them, which the way back mirrors. */
  forward: HandoffSchema,
  sessions: z.array(ReturnSessionSchema).min(1),
  /** Conversations begun in the cloud whose harness never started there: nothing of theirs to bring. */
  left: z.array(z.string()).default([]),
  phase: PhaseSchema,
  /** This Mac's device, the owner the machine releases the Thread toward. */
  device: z.uuid(),
  /** Set before the machine is asked to pack: from then it may hold the Thread released, until told to stay. */
  departing: z.boolean().optional(),
  departure: ReturnDepartureSchema.optional(),
  /**
   * This Mac's worktree as it was before the return laid the machine's over it, kept until the return is done; `others`,
   * each other repository's in a project of several.
   */
  kept: z.object({ checkpoint: MoveCheckpointSchema, file: z.string(), others: z.array(z.object({ path: z.string(), checkpoint: MoveCheckpointSchema, file: z.string() })).optional() }).optional(),
  /**
   * The repositories the machine's checkout was laid in, each written down before it was: a host that stops after takes
   * the worktree up again from `kept` as it was then, never keeping again what's partly the cloud's as the person's.
   */
  laying: z.array(z.string()).optional(),
  /** How the Thread's work landed where it wasn't simply laid down (`ReturnLanded`), once it was taken here. */
  landed: z.object({
    merged: z.array(z.string()),
    conflicts: z.array(z.string()),
    mine: z.string().optional(),
    outside: z.object({
      placed: z.array(z.string()),
      removed: z.array(z.string()),
      waiting: z.array(z.string()),
      unsent: z.array(z.string()).optional(),
      failed: z.array(z.object({ path: z.string(), why: z.string() })).optional(),
      kept: z.string().optional(),
    }),
  }).optional(),
  /** What the agents hear on their next turn here about how its work landed (`notices`), and which have heard it. */
  note: z.string().optional(),
  told: z.array(z.string()).optional(),
  reason: z.string().optional(),
  /** Why it stayed, when a harness here was older than the one that wrote its sessions there: the update that lets it come. */
  outdated: OutdatedRestoreSchema.optional(),
  /** Why it stayed, when its project wasn't on this Mac: where its worktree is, and the project it was made from. */
  missing: ReturnProjectMissingSchema.optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
  /**
   * Taken back from the archive, under the archive's ID: its machine is gone, so it starts released, from what the
   * archive kept, and one that can't be taken here stays archived rather than going back to a machine.
   */
  from: z.literal("archive").optional(),
})
type ReturnPlan = z.infer<typeof ReturnPlanSchema>
type Kept = NonNullable<ReturnPlan["kept"]>
/** A return still under way, one a later ask for the same Thread goes on with rather than beginning another. */
const OPEN_PHASES: readonly ReturnPlan["phase"][] = ["preparing", "released", "applied", "claimed"]

/** What the way back needs of the host. */
export type CloudReturnsOptions = {
  /** Where returns' plans and kept worktrees are: `<data root>/cloud/returns`. */
  folder: string
  /** Where moves' plans are: the way back reads the forward move's. */
  moves: string
  git: Git
  account(): CloudAccount | undefined
  threads(): {
    journalPlacement(conversationId: string): { thread: ThreadId; session: SessionId } | undefined
    threadSessions(thread: ThreadId): Array<{ session: SessionId; journals: string[] }>
    execution(session: SessionId): SessionExecution | undefined
    /** The Thread and its Sessions as they stand here, for the claim: those it gained in the cloud too. */
    threadHandoff(thread: ThreadId): Pick<Handoff, "thread" | "sessions">
    readonly self: ExecutionOwner
    person(): Actor
  } | undefined
  /** The Thread store's claim, through the live conversations so their residents follow (`LiveMoves.claim`). */
  claim(input: { operationId: string; handoff: Handoff; actor: Actor }): ClaimReceipt
  receiveRecords(link: RecordsLink, sessions: ReceivingSession[]): Promise<ReceivedRecords[]>
  /**
   * Makes the Thread's worktree here ready to take it back, before the cloud is asked (`ThreadWorktreeService.
   * readyForReturn`): `repository`, the GitHub repository it works in; `project`, the folder the person chose as its
   * project's now. Throws `ProjectMissingError` when its project isn't here.
   */
  ready(input: { thread: ThreadId; folder: string; branch?: string; repository: string; project?: string }): Promise<void>
  /** Pulls each session's records into this Mac's record store, writing none into its harness (`SessionCatalog.stageRecords`). */
  stageRecords(link: RecordsLink, sessions: ReceivingSession[]): Promise<StagedRecords[]>
  /** How a harness here gets to a newer version (`RuntimeUpdates.restoreRuntime`), for a return it's too old to take. */
  updateOffer(harness: string): RuntimeUpdateOffer
  cloud: {
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string): Promise<EncodedValue>
    releaseThread(threadId: string): Promise<string[]>
    threadConversations(threadId: string): Array<{ conversationId: string; harness: string; nativeId: string | undefined; mode?: string }>
  }
  /** The mode a session ran in, remembered here as the session's (`SessionMemory.remember`), so it resumes in it. */
  rememberMode?(harness: string, nativeId: string, modeId: string): void
  /** A journal here for a conversation begun in the cloud, from its records written back at `path`. */
  capture(conversationId: string, path: string): Promise<void>
  step(conversationId: string, move: string, step: ThreadReturnStep): void
  /** Where a Thread's files outside its worktree wait, when the person changed them here meanwhile: `<data root>/cloud/outside`. */
  outside?: string
  /**
   * The worktree here following the Thread in the cloud (`CloudFollow`): the checkout last laid in each repository, which
   * a way back merges the person's changes from in place of what the move sent; forgotten once the Thread is back.
   */
  followed?: { laid(cloudThread: string, path: string): Promise<MoveCheckpoint | undefined>; forget(cloudThread: string): Promise<void> }
  /** This Mac's journal takes the Thread's file history from the cloud (`Attribution.carryThreadHistory`); false while it isn't open. */
  carryHistory?(history: ThreadFileHistory): Promise<boolean>
  /** The owner of the Thread's worktree writes, which the follow writes through too: every write here is one of its. */
  worktrees: CloudWorktrees
}

export class CloudReturns {
  readonly #options: CloudReturnsOptions
  readonly #running = new Map<string, Promise<ThreadReturnOutcome>>()
  /**
   * By cloud Thread, each return of this host's bringing it back now, settled once it's over: none begins a
   * conversation meanwhile, and a call for one of its conversations waits for it.
   */
  readonly #returning = new Map<string, Set<Promise<void>>>()
  /** By conversation, what its agent hasn't heard yet of how a return landed (`notices`). */
  readonly #untold = new Map<string, Array<{ move: MoveId; note: string }>>()
  /** Each record that an agent heard, written one after another: each reads the plan as the last one left it. */
  #noting: Promise<void> = Promise.resolve()

  constructor(options: CloudReturnsOptions) {
    this.#options = options
  }

  /**
   * Brings the Thread of `conversationId` back from the cloud under `move`, or answers how that return went. A return of
   * the Thread's still open under another id (unsettled) is the one that goes on. `options.project`: the folder its
   * project is in now, when the one its worktree was made from moved.
   */
  bringBack(conversationId: string, move: string, options: ThreadReturnOptions = {}): Promise<ThreadReturnOutcome> {
    const running = this.#running.get(move)
    if (running) return running
    const work = this.#bringBack(conversationId, MoveIdSchema.parse(move), options).finally(() => this.#running.delete(move))
    this.#running.set(move, work)
    return work
  }

  /**
   * The return of this host's bringing the cloud Thread `cloudThread` back now, which settles once it's over, however
   * it went; undefined when none is.
   */
  returning(cloudThread: string): Promise<void> | undefined {
    const running = this.#returning.get(cloudThread)
    return running ? Promise.all(running).then(() => undefined) : undefined
  }

  /**
   * The harnesses the Thread of `conversationId` runs in the cloud, each Session's, those begun there included: what
   * bringing it back weighs against this Mac's (`HarnessCheck`). Undefined when it doesn't run in the cloud.
   */
  async harnessesAway(conversationId: string): Promise<string[] | undefined> {
    const threads = this.#options.threads()
    const placed = threads?.journalPlacement(conversationId)
    if (!threads || !placed) return undefined
    const owners = new Set<string>()
    for (const { session } of threads.threadSessions(placed.thread)) {
      const execution = threads.execution(session)
      if (execution?.state !== "elsewhere" || execution.owner.kind !== "cloud") return undefined
      owners.add(execution.owner.runtime)
    }
    const [runtime] = owners
    if (owners.size !== 1 || !runtime) return undefined
    const forward = await this.#forward(placed.thread, RuntimeIdSchema.parse(runtime)).catch(() => undefined)
    if (!forward) return undefined
    const begunThere = this.#options.cloud.threadConversations(forward.cloudThread)
    return [...new Set([...forward.sessions.map((session) => session.harness), ...begunThere.map((begun) => begun.harness)])]
  }

  /**
   * Brings an archived cloud Thread back to this Mac, the one it came from, from what its archive kept: its last
   * checkout and its records, as the second half of a return. Refused, saying why, for one this Mac's store doesn't
   * hold (it came from another Mac, or began in the cloud) or whose archive kept nothing.
   */
  restore(archived: ArchivedThread): Promise<ThreadReturnOutcome> {
    const running = this.#running.get(archived.move)
    if (running) return running
    const work = this.#restore(archived).finally(() => this.#running.delete(archived.move))
    this.#running.set(archived.move, work)
    return work
  }

  async #restore(archived: ArchivedThread): Promise<ThreadReturnOutcome> {
    const move = MoveIdSchema.parse(archived.move)
    const known = await this.#read(move).catch(() => undefined)
    if (known?.phase === "done") return { kind: "back" }
    if (known && OPEN_PHASES.includes(known.phase)) return this.#resume(known)
    const threads = this.#options.threads()
    const asked = archived.sessions.find((row) => threads?.journalPlacement(row.conversation))?.conversation
    const refused = (reason: string): ThreadReturnOutcome => {
      hostLog("returns", "an archived Thread wasn't restored here", { move, cloudThread: archived.thread, reason })
      return { kind: "stayed", reason }
    }
    if (!asked) return refused("This Thread came to the cloud from another Mac, or began there: restore it on the Mac it came from.")
    const record = await heard(this.#account().returnState(archived.thread, move)).catch((error: Error) => error)
    if (record instanceof Error) return { kind: "unsettled", reason: `Mako couldn't hear the cloud: ${record.message}. It stays archived; restore it again.`, waitsOn: "cloud" }
    if (record?.phase === "returned") return { kind: "back" }
    if (record?.phase !== "archived") return refused("The cloud doesn't read this Thread as archived.")
    if (!record.departure) return refused("Its machine kept nothing to bring back when it was archived: it ran nothing, or couldn't start.")
    let plan: ReturnPlan
    try {
      plan = await this.#plan(asked, move, {}, archived)
    } catch (error) {
      const reason = errorMessage({ error })
      const missing = error instanceof ProjectMissingError ? error.missing : undefined
      hostLog("returns", "an archived Thread wasn't restored here", { move, reason })
      return { kind: "stayed", reason, ...missing && { missing } }
    }
    plan.from = "archive"
    plan.departure = record.departure
    plan.phase = "released"
    await this.#write(plan)
    return this.#resume(plan)
  }

  /** Settles every return a stopped host left unsettled, as its plan stands. */
  async settle(): Promise<void> {
    for (const name of await readdir(this.#options.folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = await this.#read(MoveIdSchema.parse(name.slice(0, -".json".length))).catch(() => undefined)
      if (plan?.phase === "done") this.#tell(plan)
      if (!plan || plan.phase === "done" || plan.phase === "stayed" || this.#running.has(plan.move)) continue
      if (plan.phase === "staying") {
        await this.#tellStay(plan).catch((error: Error) => hostWarn("returns", "a machine still to be told its Thread stays couldn't be told yet", { move: plan.move, error: error.message }))
        continue
      }
      const work = this.#resume(plan).finally(() => this.#running.delete(plan.move))
      this.#running.set(plan.move, work)
      await work.catch((error: Error) => hostWarn("returns", "a return a stopped host left couldn't be settled yet", { move: plan.move, error: error.message }))
    }
  }

  async #bringBack(conversationId: string, move: MoveId, options: ThreadReturnOptions): Promise<ThreadReturnOutcome> {
    const known = await this.#read(move).catch(() => undefined)
    if (known) {
      if (known.phase === "done") return { kind: "back" }
      if (known.phase === "stayed" || known.phase === "staying") {
        if (known.phase === "staying") await this.#tellStay(known).catch(() => undefined)
        return stayedOutcome(known)
      }
      return this.#resume(known)
    }
    // The cloud takes one return of a Thread at a time: one left open goes on, under its own id, and its window hears it.
    const open = await this.#open(conversationId)
    if (open) {
      const running = this.#running.get(open.move)
      if (running) return running
      const work = this.#resume(open).finally(() => this.#running.delete(open.move))
      this.#running.set(open.move, work)
      return work
    }
    let plan: ReturnPlan
    try {
      plan = await this.#plan(conversationId, move, options)
    } catch (error) {
      // Refused before the cloud was asked anything: the Thread goes on there as it was.
      const reason = errorMessage({ error })
      const missing = error instanceof ProjectMissingError ? error.missing : undefined
      hostLog("returns", "a return was refused before the cloud was asked", { move, reason, ...missing?.project !== undefined && { project: missing.project } })
      this.#options.step(conversationId, move, { kind: "stayed", reason, ...missing && { missing } })
      return { kind: "stayed", reason, ...missing && { missing } }
    }
    await this.#write(plan)
    return this.#resume(plan)
  }

  /** The return of the Thread of `conversationId` still under way here, if one is: begun and neither done nor stayed. */
  async #open(conversationId: string): Promise<ReturnPlan | undefined> {
    const thread = this.#options.threads()?.journalPlacement(conversationId)?.thread
    if (!thread) return undefined
    let open: ReturnPlan | undefined
    for (const name of await readdir(this.#options.folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = ReturnPlanSchema.safeParse(JSON.parse(await readFile(join(this.#options.folder, name), "utf8").catch(() => "null"))).data
      if (plan?.thread === thread && OPEN_PHASES.includes(plan.phase) && (!open || plan.began > open.began)) open = plan
    }
    return open
  }

  /** What the return carries, read before anything changes: refused, with the reason, when the Thread can't come back. */
  async #plan(conversationId: string, move: MoveId, options: ThreadReturnOptions, archived?: ArchivedThread): Promise<ReturnPlan> {
    const account = this.#options.account()
    if (!account || !(await account.id())) throw new Error("Bringing a Thread back needs this Mac signed in to Mako Cloud.")
    const threads = this.#options.threads()
    if (!threads) throw new Error("Returns need the Thread store, which didn't open.")
    const placed = threads.journalPlacement(conversationId)
    if (!placed) throw new Error("This conversation isn't in a Thread.")
    const owners = new Set<string>()
    const members = threads.threadSessions(placed.thread)
    for (const { session } of members) {
      const execution = threads.execution(session)
      if (execution?.state !== "elsewhere" || execution.owner.kind !== "cloud") throw new Error("This Thread runs on this Mac already.")
      owners.add(execution.owner.runtime)
    }
    if (owners.size !== 1) throw new Error("This Thread's Sessions run in more than one place, so it can't come back as one.")
    const [runtime] = owners
    const forward = await this.#forward(placed.thread, RuntimeIdSchema.parse(runtime))
    if (!forward.handoff) throw new Error("The move that took this Thread to the cloud kept no record of what it released.")
    // Each Session's conversation in the cloud: the one that moved there, or one begun there (a `+` tab, a fork),
    // whose records come back to make its journal here. A tab that never sent there brings nothing but its Session.
    const begunThere = this.#options.cloud.threadConversations(forward.cloudThread)
    const sessions: z.infer<typeof ReturnSessionSchema>[] = []
    const left: string[] = []
    for (const { session, journals } of members) {
      const generation = threads.execution(session)?.generation ?? 1
      const moved = forward.sessions.find((each) => each.session === session)
      if (moved) {
        const modeId = begunThere.find((each) => each.conversationId === moved.conversationId)?.mode
        sessions.push({ session, conversationId: moved.conversationId, harness: moved.harness, nativeId: moved.nativeId, generation, ...modeId && { modeId } })
        continue
      }
      for (const begun of begunThere.filter((each) => journals.includes(each.conversationId))) {
        // What this Mac heard can trail the machine (a fork names its native session only once its first turn runs
        // there): the machine, which runs it, says.
        // An archived Thread's machine is gone: the archive says what each ran.
        const nativeId = begun.nativeId ?? (archived ? archived.sessions.find((row) => row.conversation === begun.conversationId)?.nativeId : await this.#nativeThere(forward.cloudThread, begun.conversationId))
        if (nativeId) sessions.push({ session, conversationId: begun.conversationId, harness: begun.harness, nativeId, generation, begun: true, ...begun.mode && { modeId: begun.mode } })
        else left.push(begun.conversationId)
      }
    }
    if (left.length) hostLog("returns", "conversations begun in the cloud whose harness never started there bring nothing back", { move, conversations: left.join(", ") })
    const device = await account.deviceId()
    if (!device) throw new Error("This Mac isn't one of the account's devices, so nothing can be sent back to it.")
    // Last, as it may change this Mac: its worktree made a checkout Git reads, of a project that's here. A write of the
    // worktree's, so a follow under way finishes first and none lays anything after.
    await this.#options.worktrees.returnWrite(forward.cloudThread, () => this.#ready(placed.thread, forward, options.project))
    return { move, thread: placed.thread, asked: conversationId, cloudThread: forward.cloudThread, folder: forward.folder, forward: forward.handoff, sessions, left, phase: "preparing", device, began: Date.now(), timings: {} }
  }

  /** The native session a conversation begun in the cloud runs there, as its machine says; undefined if it never started. */
  async #nativeThere(cloudThread: string, conversationId: string): Promise<string | undefined> {
    const value = await this.#options.cloud.callThread(cloudThread, "mako:live-snapshot", [conversationId], conversationId)
    return z.object({ session: z.object({ nativeId: z.string().nullish() }).loose() }).loose().nullable().parse(decodeRuntimeValue(value))?.session.nativeId || undefined
  }

  /** The Thread's worktree made ready to take it, by what the move that took it there recorded (`ready`). */
  async #ready(thread: ThreadId, forward: z.infer<typeof MovePlanSchema>, project?: string): Promise<void> {
    const branch = forward.checkpoint?.branch
    await this.#options.ready({ thread, folder: forward.folder, repository: forward.repository.url, ...branch && { branch }, ...project !== undefined && { project } })
  }

  /** The move that took the Thread to the cloud runtime `runtime`, as its plan stands done. */
  async #forward(thread: ThreadId, runtime: string): Promise<z.infer<typeof MovePlanSchema>> {
    for (const name of await readdir(this.#options.moves).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = MovePlanSchema.safeParse(JSON.parse(await readFile(join(this.#options.moves, name), "utf8").catch(() => "null"))).data
      if (plan?.phase === "started" && plan.thread === thread && cloudRuntimeOf(plan.cloudThread) === runtime) return plan
    }
    throw new Error("This Mac has no record of the move that took this Thread to the cloud.")
  }

  async #resume(plan: ReturnPlan): Promise<ThreadReturnOutcome> {
    let over = () => {}
    const settled = new Promise<void>((resolve) => (over = resolve))
    const running = this.#returning.get(plan.cloudThread) ?? new Set()
    running.add(settled)
    this.#returning.set(plan.cloudThread, running)
    try {
      return await this.#carry(plan)
    } finally {
      // Forgotten before it settles, so whatever waited on it finds the Thread where the return left it.
      running.delete(settled)
      if (!running.size) this.#returning.delete(plan.cloudThread)
      over()
    }
  }

  async #carry(plan: ReturnPlan): Promise<ThreadReturnOutcome> {
    const step = (next: ThreadReturnStep) => this.#options.step(plan.asked, plan.move, next)
    try {
      if (plan.phase === "preparing") {
        step({ kind: "packing" })
        const outcome = await this.#release(plan)
        if (outcome) return outcome
      }
      if (plan.phase === "released") {
        step({ kind: "bringing" })
        const outcome = await this.#take(plan)
        if (outcome) return outcome
      }
      if (plan.phase === "applied") {
        // Each session goes on here in the mode it ran in there, which the person may have changed meanwhile.
        for (const session of plan.sessions) if (session.modeId) this.#options.rememberMode?.(session.harness, session.nativeId, session.modeId)
        this.#claim(plan)
        plan.phase = "claimed"
        plan.timings.claimed = Date.now() - plan.began
        await this.#write(plan)
      }
      if (plan.phase === "claimed") {
        // Every conversation of the cloud Thread is answered here from now, then each begun there gets its journal
        // here from its records, under its own id: the window's tab of it goes on here.
        await this.#options.cloud.releaseThread(plan.cloudThread)
        for (const session of plan.sessions) {
          if (!session.begun) continue
          if (!session.path) throw new Error(`the records of ${session.harness}'s session ${session.nativeId} came back with no path`)
          await this.#options.capture(session.conversationId, session.path)
        }
        await heard(this.#account().finishReturn(plan.cloudThread, plan.move))
        await dropKept(plan.kept)
        await this.#options.followed?.forget(plan.cloudThread)
        plan.phase = "done"
        plan.timings.done = Date.now() - plan.began
        await this.#write(plan)
        this.#tell(plan)
        hostLog("returns", "a Thread came back from the cloud", { move: plan.move, cloudThread: plan.cloudThread, sessions: plan.sessions.length, ...plan.timings })
      }
    } catch (error) {
      // Only what can't be told yet: a refused step stayed (`#stay`) or was given back above. What's unsettled says who
      // it waits on: an answer the cloud didn't give, or this Mac's own work after the cloud let go.
      const waitsOn: ReturnWaitsOn = error instanceof UnheardError ? "cloud" : "here"
      const message = errorMessage({ error })
      const reason = unsettledReason(waitsOn, plan.phase, message)
      hostWarn("returns", "a return is unsettled", { move: plan.move, phase: plan.phase, waitsOn, error: message })
      step({ kind: "unsettled", reason, waitsOn })
      return { kind: "unsettled", reason, waitsOn }
    }
    step({ kind: "back", conversations: plan.sessions.map((session) => session.conversationId), ...plan.landed && { landed: plan.landed } })
    return { kind: "back", ...plan.landed && { landed: plan.landed } }
  }

  /**
   * Steps 1 to 3: the cloud stops taking work, the machine packs, the cloud records it released. This Mac keeps its
   * worktree meanwhile, so one it can't keep cancels the return before the release, as a machine that can't pack does:
   * either answers a stay. Throws only when the cloud can't be heard.
   */
  async #release(plan: ReturnPlan): Promise<ThreadReturnOutcome | undefined> {
    const account = this.#account()
    // A machine that took a carry gives one back; one from before carries is never asked for what it can't read.
    const carry = (await this.#forward(plan.thread, cloudRuntimeOf(plan.cloudThread)).catch(() => undefined))?.takesCarry === true
    // Beside the cloud's steps, not after them: the copy is taken while the machine packs.
    const keeping = this.#options.worktrees.returnWrite(plan.cloudThread, () => this.#keep(plan)).then((kept) => {
      // Kept, it's the plan's: a return that stays removes it, one that comes puts it back on a failure.
      if ("kept" in kept) plan.kept = kept.kept
      return kept
    })
    const begun = await heard(account.beginReturn(plan.cloudThread, plan.move))
    if (begun.phase === "cancelled" || begun.phase === "given-back") {
      await keeping
      return this.#stay(plan, begun.reason)
    }
    if (begun.phase === "returning") {
      if (!plan.departing) {
        plan.departing = true
        await this.#write(plan)
      }
      // Both settled before the cloud is told anything: a stay must never reach a machine still packing.
      const [kept, packed] = await Promise.all([
        keeping,
        this.#options.cloud.callThread(plan.cloudThread, "mako:move-depart", [{ move: plan.move, folder: plan.folder, conversations: plan.sessions.map((session) => session.conversationId), device: plan.device, ...carry && { carry: true } }], plan.asked)
          .then((value) => ({ departure: ReturnDepartureSchema.parse(decodeRuntimeValue(value)) }), (error: Error) => ({ error })),
      ])
      if ("error" in packed) return this.#cancel(plan, errorMessage({ error: packed.error }))
      if ("error" in kept) return this.#cancel(plan, `This Mac couldn't keep its worktree as it is before taking the cloud's: ${errorMessage({ error: kept.error })}`)
      plan.timings.packed = Date.now() - plan.began
      return this.#landed(plan, await heard(account.releaseReturn(plan.cloudThread, plan.move, packed.departure)))
    }
    // Released already (a host that stopped after the cloud heard it): what was kept goes with it, if it could be.
    await keeping
    return this.#landed(plan, begun)
  }

  /** A return given up before its release: the Thread goes on in the cloud, unless the cloud had released it already. */
  async #cancel(plan: ReturnPlan, reason: string): Promise<ThreadReturnOutcome | undefined> {
    const answered = await heard(this.#account().cancelReturn(plan.cloudThread, plan.move, reason))
    if (answered.phase === "cancelled") return this.#stay(plan, answered.reason)
    return this.#landed(plan, answered)
  }

  /** This Mac's worktree as it is, kept beside the return's plan until the return is over; or why it couldn't be. */
  async #keep(plan: ReturnPlan): Promise<{ kept: Kept } | { error: unknown }> {
    if (plan.kept) return { kept: plan.kept }
    return this.#capture(plan)
  }

  /**
   * This Mac's worktree as it is now, each repository of it (the project's others too), copied beside the return's
   * plan; or why it couldn't be. Each copy is named by its hash, so one taken again never writes over a copy an earlier
   * plan names with other bytes, and nothing of a copy that couldn't be taken whole is left.
   */
  async #capture(plan: ReturnPlan): Promise<{ kept: Kept } | { error: unknown }> {
    const made: string[] = []
    let scratch: string | undefined
    try {
      await mkdir(this.#options.folder, { recursive: true })
      const into = await mkdtemp(join(this.#options.folder, `${plan.move}-kept-`))
      scratch = into
      const copy = async (path: string, at: number): Promise<{ checkpoint: MoveCheckpoint; file: string }> => {
        const taken = await captureMoveCheckpoint(this.#options.git, path, await mkdtemp(join(into, "repository-")))
        const file = join(this.#options.folder, `${plan.move}.kept-${at}-${taken.checkpoint.sha256.slice(0, 16)}.bundle`)
        await rename(taken.file, file)
        made.push(file)
        return { checkpoint: taken.checkpoint, file }
      }
      const first = await copy(plan.folder, 0)
      const forward = await this.#forward(plan.thread, cloudRuntimeOf(plan.cloudThread)).catch(() => undefined)
      const others: NonNullable<Kept["others"]> = []
      for (const [at, other] of (forward?.others ?? []).entries()) others.push({ path: other.path, ...(await copy(other.path, at + 1)) })
      return { kept: { ...first, ...others.length && { others } } }
    } catch (error) {
      const named = keptFiles(plan.kept)
      for (const file of made) if (!named.includes(file)) await rm(file, { force: true })
      return { error }
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true })
    }
  }

  /**
   * The worktree kept again, as it is right before the machine's is laid over it: what the person changed while the
   * machine packed and its checkout came down (or while a host stopped mid-way) is what's merged in and what a failure
   * puts back. The plan names the new copy before the old one goes.
   */
  async #keepAgain(plan: ReturnPlan): Promise<Kept> {
    const fresh = await this.#capture(plan)
    if ("error" in fresh) throw fresh.error
    const before = keptFiles(plan.kept)
    plan.kept = fresh.kept
    await this.#write(plan)
    const now = keptFiles(plan.kept)
    for (const file of before) if (!now.includes(file)) await rm(file, { force: true })
    return fresh.kept
  }

  /**
   * The return as the cloud records it, past its start. Released, or already done (a Mac that stopped after telling
   * the cloud and before writing it down): either way this Mac takes it from its departure, so it never skips its own
   * claim; taking and claiming again find their work done.
   */
  async #landed(plan: ReturnPlan, state: ReturnState): Promise<ThreadReturnOutcome | undefined> {
    if (state.phase === "cancelled" || state.phase === "given-back") return this.#stay(plan, state.reason)
    if (state.phase === "returning") throw new Error("the cloud still reads the return as begun")
    plan.departure = state.departure
    plan.phase = "released"
    plan.timings.released = Date.now() - plan.began
    await this.#write(plan)
    return undefined
  }

  /**
   * Step 4: this Mac's worktree kept, the machine's checkout laid over it, each Session's records taken into its
   * harness's store. A failure puts back what it laid and gives the Thread back to the cloud.
   *
   * Everything comes down first; then the worktree is kept again and the machine's laid and merged over it as one write
   * of the worktree's (`CloudWorktrees`). The carry is taken only as far as this Mac sent it forward, by this Mac's own
   * record of that move, never by what the machine says: a repository it didn't send isn't written, and a file outside
   * the worktree that never left here is kept apart, never put in place.
   */
  async #take(plan: ReturnPlan): Promise<ThreadReturnOutcome | undefined> {
    const departure = plan.departure
    if (!departure) throw new Error("the return was released with nothing packed")
    const account = this.#account()
    const worktrees = this.#options.worktrees
    /** The repositories this return laid anything in, an earlier try's too: what a failure puts back from the copies kept. */
    const laid = new Set<string>(plan.laying)
    try {
      // Released before this Mac kept its worktree (an earlier version kept it only as it took it): made ready now, and
      // kept below, or the Thread is given back, as any failure to take it here is.
      if (!plan.kept) {
        const forward = await this.#forward(plan.thread, cloudRuntimeOf(plan.cloudThread))
        await worktrees.returnWrite(plan.cloudThread, () => this.#ready(plan.thread, forward))
      }
      // Each part timed, so a slow way back says where it waited.
      const parts: Record<string, number> = {}
      const timed = async <Value>(part: string, work: () => Promise<Value>): Promise<Value> => {
        const began = performance.now()
        try {
          return await work()
        } finally {
          parts[part] = Math.round(performance.now() - began)
        }
      }
      const forward = await this.#forward(plan.thread, cloudRuntimeOf(plan.cloudThread)).catch(() => undefined)
      const scratch = await mkdtemp(join(this.#options.folder, `${plan.move}-back-`))
      let ahead: StagedRecords[] = []
      // How the work landed, repository by repository, and what came back from outside the worktree, read while the
      // carry was open.
      const landed: Array<Pick<ReturnLanded, "merged" | "conflicts" | "mine">> = []
      let carried: OpenedCarry | undefined
      const outsideBytes = new Map<string, Buffer>()
      try {
        const file = join(scratch, "checkpoint.bundle")
        // The checkout and the records come down at once. The records go only into Mako's record store here, so the
        // checkout is still laid down before any session is written into its harness; the restore after pulls only
        // what this missed, all of it if this failed.
        await Promise.all([
          timed("checkpointRead", () => account.readCheckpoint(plan.cloudThread, departure.checkpoint.sha256, file)),
          timed("recordsAhead", () => withFreshLink(() => account.threadRecords(plan.cloudThread), (link) => this.#options.stageRecords(link, departure.sessions)))
            .then((staged) => { ahead = staged }, (error: Error) => hostWarn("returns", "a return's records couldn't come down ahead; the restore pulls them", { move: plan.move, error: describeGatewayFailure(error) })),
        ])
        // The project's other repositories, each by its own checkpoint: only those this Mac sent forward.
        const others: Array<{ repository: MoveCarryRepository; file: string }> = []
        if (departure.carry) {
          const carryFile = join(scratch, "carry.bundle")
          await timed("carryRead", () => account.readCheckpoint(plan.cloudThread, departure.carry?.sha256 ?? "", carryFile))
          carried = await openCarry(this.#options.git, carryFile, departure.carry, scratch)
          const sent = new Set((forward?.others ?? []).map((other) => other.path))
          for (const repository of carried.carry.repositories.slice(1)) {
            if (!sent.has(repository.path)) {
              hostWarn("returns", "the cloud's carry named a repository this Mac never sent; it isn't written", { move: plan.move, path: repository.path })
              continue
            }
            const bundle = join(scratch, `${repository.checkpoint.sha256}.bundle`)
            await timed("othersRead", () => account.readCheckpoint(plan.cloudThread, repository.checkpoint.sha256, bundle))
            others.push({ repository, file: bundle })
          }
          // What's outside the worktree is placed once nothing else can fail, as the files here are then: its bytes are
          // read now, while the carry is open.
          for (const entry of carried.carry.outside) outsideBytes.set(entry.path, await carried.bytes(entry.path))
        }
        await worktrees.returnWrite(plan.cloudThread, async () => {
          // Kept again unless an earlier try (a host that stopped) began laying: then the copy it took stands.
          const kept = plan.laying?.length && plan.kept ? plan.kept : await timed("kept", () => this.#keepAgain(plan))
          const lay = async (path: string) => {
            laid.add(path)
            if (plan.laying?.includes(path)) return
            plan.laying = [...plan.laying ?? [], path]
            await this.#write(plan)
          }
          await lay(plan.folder)
          await timed("checkpointApplied", () => applyMoveCheckpoint(this.#options.git, plan.folder, file, departure.checkpoint, { replace: true }))
          // What the person changed in the worktree meanwhile is merged in, never written over; then the project's other
          // repositories the same way.
          const sent = (await this.#options.followed?.laid(plan.cloudThread, plan.folder)) ?? forward?.checkpoint
          if (sent) landed.push(await timed("merged", () => this.#merge(plan, plan.folder, sent, kept, departure.checkpoint, scratch)))
          for (const { repository, file: bundle } of others) {
            await lay(repository.path)
            await timed("othersApplied", () => applyMoveCheckpoint(this.#options.git, repository.path, bundle, repository.checkpoint, { replace: true }))
            const base = (await this.#options.followed?.laid(plan.cloudThread, repository.path)) ?? forward?.others.find((other) => other.path === repository.path)?.checkpoint
            const mine = kept.others?.find((other) => other.path === repository.path)
            if (base && mine) landed.push(await timed("merged", () => this.#merge(plan, repository.path, base, mine, repository.checkpoint, scratch)))
          }
        })
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
      const received = await timed("records", () => withFreshLink(() => account.threadRecords(plan.cloudThread), (link) => this.#options.receiveRecords(link, departure.sessions)))
      hostLog("returns", "a return's checkout and records were taken here", {
        move: plan.move, ...parts,
        ahead: ahead.map((each) => `${each.harness}: ${describeSync(each)}`).join("; "),
        sessions: received.map((each) => `${each.harness}: pulled ${describeSync(each.pulled)}; ${each.restored.kind}${"ms" in each.restored ? ` in ${each.restored.ms} ms` : ""}`).join("; "),
      })
      for (const each of received) {
        const restored = each.restored
        if (restored.kind === "outdated")
          throw new OutdatedReturnError(`${each.harness} here is older than the version that wrote this session in the cloud; update it, then bring the Thread back.`, {
            harness: each.harness, installed: restored.installed, offer: this.#options.updateOffer(each.harness),
            ...restored.wrote && { wrote: restored.wrote }, ...restored.upTo && { upTo: restored.upTo }, ...restored.lacks && { lacks: restored.lacks },
          })
        if (restored.kind === "forked") throw new Error(`${each.harness} here holds a copy of this session that went on without the cloud's turns.`)
        if (restored.kind === "refused") throw new Error(restored.reason)
        for (const session of plan.sessions) if (session.begun && session.harness === each.harness && session.nativeId === each.nativeId) session.path = restored.path
      }
      this.#everyConversationCarried(plan)
      // Nothing can refuse the return from here: what came back from outside the worktree goes in place, weighed against
      // the files as they are now, each file on its own; and the Thread's file history is taken.
      const waiting = join(this.#options.outside ?? join(this.#options.folder, "..", "outside"), plan.thread)
      const opened = carried
      const done: OutsideReturned = opened
        ? await timed("outside", async () => {
          // What left this Mac, by path and hash: the only files the way back may put in place or remove.
          const left = new Map((forward?.carry?.manifest.outside ?? []).map((entry) => [entry.path, entry.sha256]))
          const steps = await planOutsideReturn(opened.carry, left)
          return returnOutside({
            ...opened,
            bytes: async (path) => {
              const bytes = outsideBytes.get(path)
              if (!bytes) throw new Error("its bytes didn't come with the carry")
              return bytes
            },
          }, steps, waiting)
        })
        : { placed: [], removed: [], waiting: [], unsent: [], failed: [] }
      if (done.failed.length) hostWarn("returns", "files outside the worktree didn't come back to their places", { move: plan.move, failed: done.failed.map((each) => `${each.path}: ${each.why}`).join("; ").slice(0, 2_000) })
      const history = carried?.history ? (await this.#options.carryHistory?.(carried.history)) ?? false : undefined
      const mine = landed.find((each) => each.mine)?.mine
      const apart = done.waiting.length + done.unsent.length > 0
      const outside: ReturnLanded["outside"] = {
        placed: done.placed, removed: done.removed, waiting: done.waiting,
        ...done.unsent.length && { unsent: done.unsent }, ...done.failed.length && { failed: done.failed }, ...apart && { kept: waiting },
      }
      const result: ReturnLanded = { merged: landed.flatMap((each) => each.merged), conflicts: landed.flatMap((each) => each.conflicts), ...mine && { mine }, outside }
      // Said only when it wasn't simply laid down: the person's changes merged in, or anything from outside the worktree.
      if (result.merged.length || result.mine || done.placed.length || done.removed.length || done.waiting.length || done.unsent.length || done.failed.length) plan.landed = result
      const note = landedNote(result, waiting)
      if (note) plan.note = note
      if (carried || plan.landed) hostLog("returns", "a return's carry was taken here", { move: plan.move, merged: result.merged.length, conflicts: result.conflicts.length, placed: done.placed.length, removed: done.removed.length, waiting: done.waiting.length, unsent: done.unsent.length, failed: done.failed.length, ...history !== undefined && { history } })
    } catch (error) {
      const reason = errorMessage({ error })
      // What the person reads is the reason; what lay beneath it (a store's own error, the versions and columns a
      // refusal weighed) is for the log alone.
      const cause = error instanceof Error && error.cause !== undefined ? errorMessage({ error: error.cause }) : undefined
      const outdated = error instanceof OutdatedReturnError ? JSON.stringify(error.outdated) : undefined
      hostWarn("returns", "a return couldn't be taken here; the worktree is put back and the Thread given back", { move: plan.move, reason, ...cause !== undefined && { cause }, ...outdated !== undefined && { outdated } })
      const kept = plan.kept
      // Only what this return laid is put back: a worktree it never wrote holds the person's latest, not the copy.
      if (kept && laid.size) {
        // A worktree that can't be put back keeps its copy beside the plan, and the Thread still goes back to the cloud.
        let whole = true
        await worktrees.returnWrite(plan.cloudThread, async () => {
          for (const each of [{ path: plan.folder, checkpoint: kept.checkpoint, file: kept.file }, ...kept.others ?? []]) {
            if (!laid.has(each.path)) continue
            await applyMoveCheckpoint(this.#options.git, each.path, each.file, each.checkpoint, { replace: true }).catch((restore: Error) => {
              hostWarn("returns", "this Mac's worktree couldn't be put back as it was; its copy stays", { move: plan.move, folder: each.path, file: each.file, error: errorMessage({ error: restore }) })
              whole = false
            })
          }
        })
        if (!whole) plan.kept = undefined
        // Put back whole, the worktree is the person's again: a later try keeps it afresh.
        else plan.laying = undefined
        await this.#write(plan)
      }
      if (error instanceof OutdatedReturnError) plan.outdated = error.outdated
      if (error instanceof ProjectMissingError) plan.missing = error.missing
      // From the archive there's no machine to give it back to: it stays archived, as it was.
      if (plan.from === "archive") return this.#stayArchived(plan, reason)
      const given = await heard(account.giveBackReturn(plan.cloudThread, plan.move, reason))
      if (given.phase === "given-back") return this.#stay(plan, given.reason)
      throw new Error(`the cloud reads the return as ${given.phase} after this Mac gave it back`, { cause: error })
    }
    plan.phase = "applied"
    plan.timings.applied = Date.now() - plan.began
    await this.#write(plan)
    return undefined
  }

  /**
   * The person's changes to `folder` while the Thread was away, merged into the machine's checkout laid there
   * (`mergeReturned`); nothing to merge when the worktree still read as what this Mac sent (`base`).
   */
  async #merge(plan: ReturnPlan, folder: string, base: MoveCheckpoint, kept: { checkpoint: MoveCheckpoint; file: string }, theirs: MoveCheckpoint, scratch: string): Promise<Pick<ReturnLanded, "merged" | "conflicts" | "mine">> {
    if (unchangedSince(base, kept.checkpoint)) return { merged: [], conflicts: [] }
    const file = join(scratch, `${base.sha256}.base.bundle`)
    await this.#account().readCheckpoint(plan.cloudThread, base.sha256, file)
    const merged = await mergeReturned(this.#options.git, folder, { base, mine: kept.checkpoint, theirs, bundles: { base: file, mine: kept.file } })
    const prefix = folder === plan.folder ? "" : `${folder}: `
    return { merged: merged.merged.map((path) => `${prefix}${path}`), conflicts: merged.conflicts.map((path) => `${prefix}${path}`), ...merged.mine && { mine: merged.mine } }
  }

  /**
   * What the agents of a Thread that came back hear on their next turn about how its work landed, each once: the
   * person's changes merged in, conflicts to resolve, files outside the worktree waiting (`landedNote`). Recorded as
   * heard in the return's plan, so a restart doesn't say it again.
   */
  notices(conversationId: string): string[] {
    const untold = this.#untold.get(conversationId)
    if (!untold?.length) return []
    this.#untold.delete(conversationId)
    // One after another: two agents hearing the same return at once each read the plan the other wrote.
    for (const { move } of untold)
      this.#noting = this.#noting.then(async () => {
        const plan = await this.#read(move)
        await this.#write({ ...plan, told: [...new Set([...plan.told ?? [], conversationId])] })
      }).catch((error: Error) => hostWarn("returns", "couldn't record that an agent heard how its return landed", { move, conversation: conversationId, error: error.message }))
    return untold.map(({ note }) => note)
  }

  /** A return's note, for each of its conversations that hasn't heard it. */
  #tell(plan: ReturnPlan): void {
    if (!plan.note || plan.phase !== "done") return
    for (const { conversationId } of plan.sessions) {
      if (plan.told?.includes(conversationId)) continue
      const untold = (this.#untold.get(conversationId) ?? []).filter((each) => each.move !== plan.move)
      this.#untold.set(conversationId, [...untold, { move: plan.move, note: plan.note }])
    }
  }

  /**
   * Before anything is claimed: every conversation the cloud Thread has, that this Mac's store places in it, comes back
   * with this return. One begun there after the return was planned (a tab opened as it began) would be left on a
   * machine that ends, so the Thread is given back instead, and the person brings it back again.
   */
  #everyConversationCarried(plan: ReturnPlan): void {
    const threads = this.#options.threads()
    if (!threads) throw new Error("The Thread store closed.")
    const carried = new Set([...plan.sessions.map((session) => session.conversationId), ...plan.left])
    const there = new Set(this.#options.cloud.threadConversations(plan.cloudThread).map((each) => each.conversationId))
    const missed = threads.threadSessions(plan.thread).flatMap((session) => session.journals).filter((journal) => there.has(journal) && !carried.has(journal))
    if (missed.length) throw new Error("A conversation began in the cloud as the Thread set off back; bring it back again to bring that one too.")
    const sessions = plan.sessions.filter((session) => session.begun)
    const pathless = sessions.find((session) => !session.path)
    if (pathless) throw new Error(`${pathless.harness}'s session ${pathless.nativeId}, begun in the cloud, didn't come back.`)
  }

  /**
   * Step 5's claim: the Thread and every Session it has as this Mac's store records them now, each one past its
   * generation here, those it gained in the cloud included, so none is left owned by a machine that ends.
   */
  #claim(plan: ReturnPlan): void {
    const threads = this.#options.threads()
    if (!threads) throw new Error("The Thread store closed.")
    const here = threads.threadHandoff(plan.thread)
    const handoff = HandoffSchema.parse({
      move: plan.move,
      source: { kind: "cloud", runtime: cloudRuntimeOf(plan.cloudThread) },
      target: threads.self,
      releasedAt: plan.timings.released === undefined ? Date.now() : plan.began + plan.timings.released,
      thread: here.thread,
      sessions: here.sessions.map((session) => ({ ...session, generation: session.generation + 1 })),
    })
    this.#options.claim({ operationId: namedUuid(`mako return\0${plan.move}\0claim`), handoff, actor: threads.person() })
  }

  async #stay(plan: ReturnPlan, reason: string): Promise<ThreadReturnOutcome> {
    plan.phase = "staying"
    plan.reason = reason
    await this.#write(plan)
    await dropKept(plan.kept)
    // Its machine runs it again once told; until then it's still the cloud's, and a later start tells it.
    await this.#tellStay(plan).catch((error: Error) => hostWarn("returns", "a machine still to be told its Thread stays couldn't be told yet", { move: plan.move, error: error.message }))
    hostLog("returns", "a Thread stayed in the cloud", { move: plan.move, reason })
    const outcome = stayedOutcome(plan)
    this.#options.step(plan.asked, plan.move, outcome)
    return outcome
  }

  /** A restore that couldn't be taken here: its worktree was put back, and the Thread stays archived in the cloud. */
  async #stayArchived(plan: ReturnPlan, reason: string): Promise<ThreadReturnOutcome> {
    plan.phase = "stayed"
    plan.reason = `${reason.replace(/[.\s]*$/, "")}. It stays archived.`
    await this.#write(plan)
    await dropKept(plan.kept)
    hostLog("returns", "an archived Thread couldn't be restored here; it stays archived", { move: plan.move, reason })
    const outcome = stayedOutcome(plan)
    this.#options.step(plan.asked, plan.move, outcome)
    return outcome
  }

  /** The machine takes back the Thread it released as it packed; nothing to tell when it was never asked to pack. */
  async #tellStay(plan: ReturnPlan): Promise<void> {
    if (plan.departing) await this.#options.cloud.callThread(plan.cloudThread, "mako:move-stay", [{ move: plan.move, device: plan.device, reason: (plan.reason ?? "It stays in the cloud.").slice(0, 2_000) }], plan.asked)
    plan.phase = "stayed"
    await this.#write(plan)
  }

  #account(): CloudAccount {
    const account = this.#options.account()
    if (!account) throw new Error("This Mac signed out of Mako Cloud.")
    return account
  }

  async #read(move: MoveId): Promise<ReturnPlan> {
    return ReturnPlanSchema.parse(JSON.parse(await readFile(join(this.#options.folder, `${move}.json`), "utf8")))
  }

  async #write(plan: ReturnPlan): Promise<void> {
    await mkdir(this.#options.folder, { recursive: true })
    const file = join(this.#options.folder, `${plan.move}.json`)
    // Beside it under a name of its own, so two writers never rename one half-written file.
    const beside = `${file}.${randomBytes(4).toString("hex")}.tmp`
    await writeFile(beside, JSON.stringify(ReturnPlanSchema.parse(plan)))
    await rename(beside, file)
  }
}

/** Every copy of the worktree a plan keeps: its first repository's and each other's. */
function keptFiles(kept: Kept | undefined): string[] {
  return kept ? [kept.file, ...(kept.others ?? []).map((other) => other.file)] : []
}

/** A return over, or given up: every copy of the worktree it kept goes, each repository's. */
async function dropKept(kept: Kept | undefined): Promise<void> {
  for (const file of keptFiles(kept)) await rm(file, { force: true })
}

/** At most this many paths are named in a note; the rest are counted. */
const NOTE_PATHS = 5

/** Paths named in a sentence: the first few, then how many more. */
function named(paths: readonly string[]): string {
  const shown = paths.slice(0, NOTE_PATHS).join(", ")
  return paths.length > NOTE_PATHS ? `${shown} and ${paths.length - NOTE_PATHS} more` : shown
}

/**
 * What an agent back from the cloud hears about how its work landed, when it wasn't simply laid down: the person's
 * changes merged in, the files that hold conflict markers, the branch their commits are on, and files outside the
 * worktree the person had changed meanwhile, whose cloud copies wait. Undefined when there's nothing to say.
 */
export function landedNote(landed: ReturnLanded, waiting: string): string | undefined {
  const lines: string[] = []
  const conflicts = new Set(landed.conflicts)
  const clean = landed.merged.filter((path) => !conflicts.has(path))
  if (clean.length) lines.push(`While you worked in the cloud, the user changed ${clean.length === 1 ? "a file" : `${clean.length} files`} in this worktree on their Mac; Mako kept their changes beside yours: ${named(clean)}.`)
  if (conflicts.size) lines.push(`You and the user both changed ${named([...conflicts])}: ${conflicts.size === 1 ? "it holds" : "they hold"} Git's conflict markers, theirs as \`mako/merge/this-mac\` and yours as \`mako/merge/cloud\`. Resolve them before building on ${conflicts.size === 1 ? "it" : "them"}.`)
  if (landed.mine) lines.push(`The user's own commits on this branch meanwhile are on \`${landed.mine}\`.`)
  if (landed.outside.waiting.length) lines.push(`Files outside the worktree that you changed in the cloud, and the user changed here meanwhile, kept the user's version; yours wait under ${waiting}: ${named(landed.outside.waiting)}.`)
  if (landed.outside.unsent?.length) lines.push(`Files you wrote outside the worktree in the cloud that never came from this Mac weren't put in place; they wait under ${waiting}: ${named(landed.outside.unsent)}.`)
  if (landed.outside.failed?.length) lines.push(`Files outside the worktree that couldn't be written back on the user's Mac: ${named(landed.outside.failed.map((each) => `${each.path} (${each.why})`))}.`)
  return lines.length ? lines.join(" ") : undefined
}

/** How a return that stayed answers, from its plan: why, and what lets it come (an update, the project's folder). */
function stayedOutcome(plan: ReturnPlan): Extract<ThreadReturnOutcome, { kind: "stayed" }> {
  const { outdated, missing } = plan
  return { kind: "stayed", reason: plan.reason ?? "It stayed in the cloud.", ...outdated && { outdated }, ...missing && { missing } }
}

/** A cloud call whose answer this Mac didn't get: what's unsettled waits on the cloud, not on anything here. */
class UnheardError extends Error {
  constructor(cause: unknown) {
    super(errorMessage({ error: cause }), { cause })
    this.name = "UnheardError"
  }
}

/** A step the cloud answers, marked so a failure reads as the cloud unheard. */
async function heard<Value>(call: Promise<Value>): Promise<Value> {
  try {
    return await call
  } catch (error) {
    throw new UnheardError(error)
  }
}

/** What an unsettled return says: who it waits on, where the Thread is meanwhile, and what asks again. */
function unsettledReason(waitsOn: ReturnWaitsOn, phase: ReturnPlan["phase"], message: string): string {
  const again = "Ask again, or Mako asks when it next starts."
  if (phase === "claimed")
    return waitsOn === "cloud"
      ? `It runs on this Mac, and Mako couldn't tell the cloud it's done: ${message}. Its cloud machine stays until the cloud hears. ${again}`
      : `It runs on this Mac, and Mako couldn't finish setting up its conversations here: ${message}. ${again}`
  if (waitsOn === "here")
    return `This Mac couldn't finish taking the Thread: ${message}. The cloud let it go, so it runs nowhere until this Mac does. ${again}`
  return phase === "preparing"
    ? `Mako couldn't hear the cloud: ${message}. Until it does, it can't tell whether the cloud let the Thread go, so it runs nowhere. ${again}`
    : `Mako couldn't hear the cloud: ${message}. The cloud let the Thread go and this Mac hasn't taken it, so it runs nowhere until Mako hears. ${again}`
}

/** A return refused because a harness here is older than the one that wrote its sessions in the cloud. */
class OutdatedReturnError extends Error {
  readonly outdated: OutdatedRestore
  constructor(message: string, outdated: OutdatedRestore) {
    super(message)
    this.outdated = outdated
  }
}

/** The Session ids a return's handoff names, for a test or a readout. */
export function returnSessions(handoff: Handoff): SessionId[] {
  return handoff.sessions.map((session) => SessionIdSchema.parse(session.id))
}
