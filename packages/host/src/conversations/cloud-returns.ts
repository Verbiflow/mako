import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema, ReturnDepartureSchema, type ReturnState } from "@mako/protocol/moves"
import { withFreshLink, type ReceivedRecords, type ReceivingSession, type RecordsLink } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { ThreadReturnOutcome, ThreadReturnStep } from "../contracts/cloud-threads.js"
import { OutdatedRestoreSchema, type OutdatedRestore, type RuntimeUpdateOffer } from "../contracts/restore-plan.js"
import { decodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import { HandoffSchema, MoveIdSchema, RuntimeIdSchema, type ClaimReceipt, type ExecutionOwner, type Handoff, type MoveId, type SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type SessionId, type ThreadId } from "../contracts/thread-identity.js"
import type { CloudAccount } from "../usage/index.js"
import { applyMoveCheckpoint, captureMoveCheckpoint } from "../workspaces/index.js"
import { cloudRuntimeOf, MovePlanSchema, namedUuid } from "./cloud-moves.js"

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
 * 4. This Mac keeps its worktree as it is (a checkpoint of its own, in the return's folder), then lays the machine's
 *    checkout over it and writes each Session's records into its harness's store, holding at least what went.
 * 5. This Mac claims the Thread in its own store, each Session one generation on, and its conversations stop being
 *    the cloud's. The cloud is told the return is done, and ends the machine.
 *
 * A failure before 3 cancels the return: the Thread goes on in the cloud. One after 3 and before 5 puts this Mac's
 * worktree back from the copy it kept and gives the Thread back to the cloud. Either way the machine, which released
 * the Thread as it packed, is told to take it back (`mako:move-stay`) before the return counts as stayed. An answer the cloud didn't give is asked
 * for again, never guessed: until it's heard, the Thread runs nowhere (`unsettled`). Each step's plan is written first
 * (`<data root>/cloud/returns/<move>.json`), so a host that stops mid-way settles the return at its next start.
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
  /** This Mac's worktree as it was before the return laid the machine's over it, kept until the return is done. */
  kept: z.object({ checkpoint: MoveCheckpointSchema, file: z.string() }).optional(),
  reason: z.string().optional(),
  /** Why it stayed, when a harness here was older than the one that wrote its sessions there: the update that lets it come. */
  outdated: OutdatedRestoreSchema.optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
})
type ReturnPlan = z.infer<typeof ReturnPlanSchema>

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
  /** How a harness here gets to a newer version (`RuntimeUpdates.restoreRuntime`), for a return it's too old to take. */
  updateOffer(harness: string): RuntimeUpdateOffer
  cloud: {
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string): Promise<EncodedValue>
    releaseThread(threadId: string): Promise<string[]>
    threadConversations(threadId: string): Array<{ conversationId: string; harness: string; nativeId: string | undefined }>
  }
  /** A journal here for a conversation begun in the cloud, from its records written back at `path`. */
  capture(conversationId: string, path: string): Promise<void>
  step(conversationId: string, move: string, step: ThreadReturnStep): void
}

export class CloudReturns {
  readonly #options: CloudReturnsOptions
  readonly #running = new Map<string, Promise<ThreadReturnOutcome>>()
  /** The cloud Threads a return of this host's is bringing back now: none begins a conversation meanwhile. */
  readonly #returning = new Map<string, number>()

  constructor(options: CloudReturnsOptions) {
    this.#options = options
  }

  /** Brings the Thread of `conversationId` back from the cloud under `move`, or answers how that return went. */
  bringBack(conversationId: string, move: string): Promise<ThreadReturnOutcome> {
    const running = this.#running.get(move)
    if (running) return running
    const work = this.#bringBack(conversationId, MoveIdSchema.parse(move)).finally(() => this.#running.delete(move))
    this.#running.set(move, work)
    return work
  }

  /** Whether a return of this host's is bringing the cloud Thread `cloudThread` back now. */
  returning(cloudThread: string): boolean {
    return (this.#returning.get(cloudThread) ?? 0) > 0
  }

  /** Settles every return a stopped host left unsettled, as its plan stands. */
  async settle(): Promise<void> {
    for (const name of await readdir(this.#options.folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = await this.#read(MoveIdSchema.parse(name.slice(0, -".json".length))).catch(() => undefined)
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

  async #bringBack(conversationId: string, move: MoveId): Promise<ThreadReturnOutcome> {
    const known = await this.#read(move).catch(() => undefined)
    if (known) {
      if (known.phase === "done") return { kind: "back" }
      if (known.phase === "stayed" || known.phase === "staying") {
        if (known.phase === "staying") await this.#tellStay(known).catch(() => undefined)
        return { kind: "stayed", reason: known.reason ?? "It stayed in the cloud.", ...known.outdated && { outdated: known.outdated } }
      }
      return this.#resume(known)
    }
    let plan: ReturnPlan
    try {
      plan = await this.#plan(conversationId, move)
    } catch (error) {
      const reason = errorMessage({ error })
      this.#options.step(conversationId, move, { kind: "stayed", reason })
      return { kind: "stayed", reason }
    }
    await this.#write(plan)
    return this.#resume(plan)
  }

  /** What the return carries, read before anything changes: refused, with the reason, when the Thread can't come back. */
  async #plan(conversationId: string, move: MoveId): Promise<ReturnPlan> {
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
        sessions.push({ session, conversationId: moved.conversationId, harness: moved.harness, nativeId: moved.nativeId, generation })
        continue
      }
      for (const begun of begunThere.filter((each) => journals.includes(each.conversationId))) {
        // What this Mac heard can trail the machine (a fork names its native session only once its first turn runs
        // there): the machine, which runs it, says.
        const nativeId = begun.nativeId ?? (await this.#nativeThere(forward.cloudThread, begun.conversationId))
        if (nativeId) sessions.push({ session, conversationId: begun.conversationId, harness: begun.harness, nativeId, generation, begun: true })
        else left.push(begun.conversationId)
      }
    }
    if (left.length) hostLog("returns", "conversations begun in the cloud whose harness never started there bring nothing back", { move, conversations: left.join(", ") })
    if (!existsSync(forward.folder)) throw new Error(`Its worktree on this Mac, ${forward.folder}, is gone; it has nowhere to come back to.`)
    const device = await account.deviceId()
    if (!device) throw new Error("This Mac isn't one of the account's devices, so nothing can be sent back to it.")
    return { move, thread: placed.thread, asked: conversationId, cloudThread: forward.cloudThread, folder: forward.folder, forward: forward.handoff, sessions, left, phase: "preparing", device, began: Date.now(), timings: {} }
  }

  /** The native session a conversation begun in the cloud runs there, as its machine says; undefined if it never started. */
  async #nativeThere(cloudThread: string, conversationId: string): Promise<string | undefined> {
    const value = await this.#options.cloud.callThread(cloudThread, "mako:live-snapshot", [conversationId], conversationId)
    return z.object({ session: z.object({ nativeId: z.string().nullish() }).loose() }).loose().nullable().parse(decodeRuntimeValue(value))?.session.nativeId || undefined
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
    this.#returning.set(plan.cloudThread, (this.#returning.get(plan.cloudThread) ?? 0) + 1)
    try {
      return await this.#carry(plan)
    } finally {
      const left = (this.#returning.get(plan.cloudThread) ?? 1) - 1
      if (left > 0) this.#returning.set(plan.cloudThread, left)
      else this.#returning.delete(plan.cloudThread)
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
        await this.#account().finishReturn(plan.cloudThread, plan.move)
        if (plan.kept) await rm(plan.kept.file, { force: true })
        plan.phase = "done"
        plan.timings.done = Date.now() - plan.began
        await this.#write(plan)
        hostLog("returns", "a Thread came back from the cloud", { move: plan.move, cloudThread: plan.cloudThread, sessions: plan.sessions.length, ...plan.timings })
      }
    } catch (error) {
      // Only what can't be told yet: a refused step stayed (`#keep`) or was taken back above.
      const reason = `This Mac couldn't hear the cloud: ${errorMessage({ error })}. It asks again; the Thread runs nowhere until it hears.`
      hostWarn("returns", "a return is unsettled", { move: plan.move, phase: plan.phase, error: errorMessage({ error }) })
      step({ kind: "unsettled", reason })
      return { kind: "unsettled", reason }
    }
    step({ kind: "back", conversations: plan.sessions.map((session) => session.conversationId) })
    return { kind: "back" }
  }

  /**
   * Steps 1 to 3: the cloud stops taking work, the machine packs, the cloud records it released. Answers a stay when
   * the machine couldn't pack (the return cancelled); throws only when the cloud can't be heard.
   */
  async #release(plan: ReturnPlan): Promise<ThreadReturnOutcome | undefined> {
    const account = this.#account()
    const begun = await account.beginReturn(plan.cloudThread, plan.move)
    if (begun.phase === "cancelled" || begun.phase === "given-back") return this.#stay(plan, begun.reason)
    if (begun.phase === "returning") {
      let departure
      if (!plan.departing) {
        plan.departing = true
        await this.#write(plan)
      }
      try {
        departure = ReturnDepartureSchema.parse(decodeRuntimeValue(await this.#options.cloud.callThread(plan.cloudThread, "mako:move-depart", [{ move: plan.move, folder: plan.folder, conversations: plan.sessions.map((session) => session.conversationId), device: plan.device }], plan.asked)))
      } catch (error) {
        const reason = errorMessage({ error })
        const answered = await account.cancelReturn(plan.cloudThread, plan.move, reason)
        if (answered.phase === "cancelled") return this.#stay(plan, answered.reason)
        return this.#landed(plan, answered)
      }
      plan.timings.packed = Date.now() - plan.began
      return this.#landed(plan, await account.releaseReturn(plan.cloudThread, plan.move, departure))
    }
    return this.#landed(plan, begun)
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
   * harness's store. A failure puts the worktree back and gives the Thread back to the cloud.
   */
  async #take(plan: ReturnPlan): Promise<ThreadReturnOutcome | undefined> {
    const departure = plan.departure
    if (!departure) throw new Error("the return was released with nothing packed")
    const account = this.#account()
    await mkdir(this.#options.folder, { recursive: true })
    if (!plan.kept) {
      const scratch = await mkdtemp(join(this.#options.folder, `${plan.move}-kept-`))
      const captured = await captureMoveCheckpoint(this.#options.git, plan.folder, scratch)
      const file = join(this.#options.folder, `${plan.move}.kept.bundle`)
      await rename(captured.file, file)
      await rm(scratch, { recursive: true, force: true })
      plan.kept = { checkpoint: captured.checkpoint, file }
      await this.#write(plan)
    }
    try {
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
      const scratch = await mkdtemp(join(this.#options.folder, `${plan.move}-back-`))
      try {
        const file = join(scratch, "checkpoint.bundle")
        await timed("checkpointRead", () => account.readCheckpoint(plan.cloudThread, departure.checkpoint.sha256, file))
        await timed("checkpointApplied", () => applyMoveCheckpoint(this.#options.git, plan.folder, file, departure.checkpoint, { replace: true }))
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
      const received = await timed("records", () => withFreshLink(() => account.threadRecords(plan.cloudThread), (link) => this.#options.receiveRecords(link, departure.sessions)))
      hostLog("returns", "a return's checkout and records were taken here", {
        move: plan.move, ...parts,
        sessions: received.map((each) => `${each.harness}: pulled ${each.pulled.versions} versions, ${each.pulled.bytes} bytes in ${each.pulled.ms} ms; ${each.restored.kind}${"ms" in each.restored ? ` in ${each.restored.ms} ms` : ""}`).join("; "),
      })
      for (const each of received) {
        const restored = each.restored
        if (restored.kind === "outdated")
          throw new OutdatedReturnError(`${each.harness} here is older than the version that wrote this session in the cloud; update it, then bring the Thread back.`, {
            harness: each.harness, installed: restored.installed, offer: this.#options.updateOffer(each.harness),
            ...restored.wrote && { wrote: restored.wrote }, ...restored.upTo && { upTo: restored.upTo },
          })
        if (restored.kind === "forked") throw new Error(`${each.harness} here holds a copy of this session that went on without the cloud's turns.`)
        if (restored.kind === "refused") throw new Error(restored.reason)
        for (const session of plan.sessions) if (session.begun && session.harness === each.harness && session.nativeId === each.nativeId) session.path = restored.path
      }
      this.#everyConversationCarried(plan)
    } catch (error) {
      const reason = errorMessage({ error })
      hostWarn("returns", "a return couldn't be taken here; the worktree is put back and the Thread given back", { move: plan.move, reason })
      await applyMoveCheckpoint(this.#options.git, plan.folder, plan.kept.file, plan.kept.checkpoint, { replace: true })
      if (error instanceof OutdatedReturnError) plan.outdated = error.outdated
      const given = await account.giveBackReturn(plan.cloudThread, plan.move, reason)
      if (given.phase === "given-back") return this.#stay(plan, given.reason)
      throw new Error(`the cloud reads the return as ${given.phase} after this Mac gave it back`, { cause: error })
    }
    plan.phase = "applied"
    plan.timings.applied = Date.now() - plan.began
    await this.#write(plan)
    return undefined
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
    if (plan.kept) await rm(plan.kept.file, { force: true })
    // Its machine runs it again once told; until then it's still the cloud's, and a later start tells it.
    await this.#tellStay(plan).catch((error: Error) => hostWarn("returns", "a machine still to be told its Thread stays couldn't be told yet", { move: plan.move, error: error.message }))
    hostLog("returns", "a Thread stayed in the cloud", { move: plan.move, reason })
    const outdated = plan.outdated
    this.#options.step(plan.asked, plan.move, { kind: "stayed", reason, ...outdated && { outdated } })
    return { kind: "stayed", reason, ...outdated && { outdated } }
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
    await writeFile(`${file}.tmp`, JSON.stringify(ReturnPlanSchema.parse(plan)))
    await rename(`${file}.tmp`, file)
  }
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
