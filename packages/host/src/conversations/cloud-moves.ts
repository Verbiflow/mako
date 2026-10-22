import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema, type MoveAnswer, type MoveCheckpoint } from "@mako/protocol/moves"
import type { RecordsLink, SentRecords } from "@mako/sessions/record-sync"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, type CloudRepository, type ThreadMoveOutcome, type ThreadMoveStep } from "../contracts/cloud-threads.js"
import type { EncodedValue } from "../contracts/runtime-value.js"
import type { LiveSnapshot, LiveStartOptions } from "../contracts/live-conversations.js"
import { HandoffSchema, MoveIdSchema, RuntimeIdSchema, type ClaimReceipt, type ExecutionOwner, type Handoff, type MoveId, type Refusal, type RuntimeId } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type SessionId, type ThreadId } from "../contracts/thread-identity.js"
import type { CloudAccount } from "../usage/index.js"
import { captureMoveCheckpoint } from "../workspaces/index.js"
import { MoveNotQuietError } from "./live-moves.js"

/**
 * A Thread of this Mac's moving to the cloud, natively: its checkout carried to a machine that clones the repository
 * at this Mac's own path, each Session's native records written into its harness's store there, and each Session
 * resumed as the same native session. The Thread has one owner throughout:
 *
 * 1. Everything that can go ahead does, while the Thread still runs here: the cloud Thread is made (its machine
 *    boots and clones meanwhile), the checkout's checkpoint and every Session's records are sent.
 * 2. This Mac releases the Thread (`LiveMoves.release`): only once nothing in it is working, refusing rather than
 *    waiting. From then nothing runs it anywhere.
 * 3. What changed since is sent, a few files and lines at most, and the machine applies it all (`mako:move-arrive`).
 * 4. The cloud claims the move: the gateway keeps one answer per move, a claim or a refusal, whichever came first.
 *    Claimed, this Mac confirms and the Sessions start on the machine; refused, this Mac takes the Thread back.
 *
 * A failure before the release changes nothing here. One after it, before the claim, asks the cloud to refuse; if
 * the cloud claimed first, the move goes on. An answer lost on the way is asked for again by the move's id, and
 * never guessed: until it's known, the Thread runs nowhere (`unsettled`). Each move's plan is written before each
 * step (`<data root>/cloud/moves/<move>.json`), so a host that stops mid-move settles it when it starts again.
 */

/** A UUID fixed by a name: version 8 (named by its maker), variant 10, from the name's SHA-256. */
function namedUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The cloud runtime a cloud Thread is, as a Thread store names an owner: a fixed UUID of its ID. */
export function cloudRuntimeOf(cloudThread: string): RuntimeId {
  return RuntimeIdSchema.parse(namedUuid(`mako cloud thread\0${cloudThread}`))
}

/** A move's step as the Thread store takes it, once: the same UUID each time the step is asked. */
function stepOperation(move: MoveId, step: "release" | "cancel" | "confirm" | "reclaim"): string {
  return namedUuid(`mako move\0${move}\0${step}`)
}

const PlanSessionSchema = z.object({
  session: z.string(),
  /** The journal its window shows, which keeps its id in the cloud. */
  conversationId: z.string(),
  harness: z.string(),
  nativeId: z.string(),
  /** Its native session's path here, which its records are read by. */
  path: z.string(),
  modeId: z.string().optional(),
  tuning: SessionSettingsSchema.optional(),
})
type PlanSession = z.infer<typeof PlanSessionSchema>

const PhaseSchema = z.enum(["preparing", "released", "claimed", "started", "kept-here"])

const PlanSchema = z.object({
  move: MoveIdSchema,
  thread: ThreadIdSchema,
  /** The conversation the move was asked from, whose window hears its steps. */
  asked: z.string(),
  cloudThread: z.string(),
  folder: z.string(),
  repository: CloudRepositorySchema,
  sessions: z.array(PlanSessionSchema).min(1),
  phase: PhaseSchema,
  checkpoint: MoveCheckpointSchema.optional(),
  handoff: HandoffSchema.optional(),
  reason: z.string().optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
})
type Plan = z.infer<typeof PlanSchema>

/** What a move needs of the host. */
export type CloudMovesOptions = {
  /** Where moves' plans are kept: `<data root>/cloud/moves`. */
  folder: string
  git: Git
  account(): CloudAccount | undefined
  threads(): {
    journalPlacement(conversationId: string): { thread: ThreadId; session: SessionId } | undefined
    threadSessions(thread: ThreadId): Array<{ session: SessionId; journals: string[]; natives: Array<{ harness: string; nativeId: string }> }>
    moveStatus(move: MoveId): { phase: string } | undefined
    person(): Actor
  } | undefined
  moves: {
    begin(input: { move: MoveId; thread: ThreadId; target: ExecutionOwner; actor: Actor }): void
    cancel(input: { operationId: string; move: MoveId; actor: Actor }): void
    release(input: { operationId: string; move: MoveId; actor: Actor }): Promise<Handoff>
    confirm(input: { operationId: string; receipt: ClaimReceipt; actor: Actor }): void
    reclaim(input: { operationId: string; refusal: Refusal; actor: Actor }): void
  }
  /** What a move reads of a conversation: its native session, where it works, and its mode. */
  snapshot(conversationId: string): { session: Pick<LiveSnapshot["session"], "harness" | "nativeId" | "nativePath" | "cwd" | "currentMode"> } | null
  /** The Thread's own checkout here, its worktree; undefined for a Thread in the main checkout. */
  checkout(conversationId: string): { path: string; worktrees: unknown[] } | undefined
  repositoryOf(folder: string): Promise<CloudRepository>
  /** Sends Sessions' records to the cloud Thread now (`SessionCatalog.sendRecords`). */
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  cloud: {
    adopt(conversation: { conversationId: string; threadId: string; harness: string; repository: CloudRepository }): Promise<void>
    started(conversationId: string, value: EncodedValue): void
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string): Promise<EncodedValue>
  }
  /** The settings and access a native session last ran with, as this Mac remembers them. */
  remembered(harness: string, nativeId: string): { modeId?: string; settings?: SessionSettings } | null | undefined
  step(conversationId: string, move: string, step: ThreadMoveStep): void
  newCloudThread(): string
}

export class CloudMoves {
  readonly #options: CloudMovesOptions
  /** Moves running in this host, by id: a repeat of one joins it. */
  readonly #running = new Map<string, Promise<ThreadMoveOutcome>>()

  constructor(options: CloudMovesOptions) {
    this.#options = options
  }

  /** Moves the Thread of `conversationId` to the cloud under `move`, or answers how that move went. */
  move(conversationId: string, move: string): Promise<ThreadMoveOutcome> {
    const running = this.#running.get(move)
    if (running) return running
    const work = this.#move(conversationId, MoveIdSchema.parse(move)).finally(() => this.#running.delete(move))
    this.#running.set(move, work)
    return work
  }

  /** Settles every move a stopped host left unsettled: before the release, kept here; after, as the cloud answered. */
  async settle(): Promise<void> {
    const names = await readdir(this.#options.folder).catch(() => [])
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const plan = await this.#read(MoveIdSchema.parse(name.slice(0, -".json".length))).catch(() => undefined)
      if (!plan || plan.phase === "started" || plan.phase === "kept-here" || this.#running.has(plan.move)) continue
      const work = this.#resume(plan).finally(() => this.#running.delete(plan.move))
      this.#running.set(plan.move, work)
      await work.catch((error: Error) => hostWarn("moves", "a move a stopped host left couldn't be settled yet", { move: plan.move, error: error.message }))
    }
  }

  async #move(conversationId: string, move: MoveId): Promise<ThreadMoveOutcome> {
    const known = await this.#read(move).catch(() => undefined)
    if (known) return known.phase === "started" ? { kind: "moved", cloudThread: known.cloudThread } : known.phase === "kept-here" ? { kind: "kept-here", reason: known.reason ?? "It stayed here." } : this.#resume(known)
    let plan: Plan
    try {
      plan = await this.#plan(conversationId, move)
    } catch (error) {
      const reason = errorMessage({ error })
      this.#options.step(conversationId, move, { kind: "kept-here", reason })
      return { kind: "kept-here", reason }
    }
    await this.#write(plan)
    return this.#resume(plan)
  }

  /** What a move carries, read before anything changes: refused, with the reason, when the Thread can't move. */
  async #plan(conversationId: string, move: MoveId): Promise<Plan> {
    const account = this.#options.account()
    if (!account || !(await account.id())) throw new Error("Moving to the cloud needs this Mac signed in to Mako Cloud.")
    const threads = this.#options.threads()
    if (!threads) throw new Error("Moves need the Thread store, which didn't open.")
    const placed = threads.journalPlacement(conversationId)
    if (!placed) throw new Error("This conversation isn't in a Thread yet.")
    const checkout = this.#options.checkout(conversationId)
    if (!checkout) throw new Error("A Thread moves to the cloud from its own worktree. Move it into one first; the main checkout stays here.")
    if (checkout.worktrees.length !== 1) throw new Error("A Thread working in several repositories can't move to the cloud yet.")
    const folder = checkout.path
    const repository = await this.#options.repositoryOf(folder)
    const sessions: PlanSession[] = []
    for (const moving of threads.threadSessions(placed.thread)) {
      const conversation = moving.journals.includes(conversationId) ? conversationId : moving.journals.at(-1)
      const snapshot = conversation ? this.#options.snapshot(conversation) : null
      const { nativeId, nativePath, harness, cwd } = snapshot?.session ?? {}
      if (!conversation || !snapshot || !nativeId || !nativePath || !harness) throw new Error("Every tab in the Thread needs to have started before it moves: send a first message or close the empty tab.")
      if (cwd !== folder && !cwd?.startsWith(`${folder}/`)) throw new Error(`A tab in this Thread works in ${cwd ?? "another folder"}, outside its worktree, so the Thread can't move.`)
      const remembered = this.#options.remembered(harness, nativeId)
      const planned: PlanSession = { session: moving.session, conversationId: conversation, harness, nativeId, path: nativePath }
      const modeId = remembered?.modeId ?? snapshot.session.currentMode ?? undefined
      if (modeId) planned.modeId = modeId
      if (remembered?.settings) planned.tuning = remembered.settings
      sessions.push(planned)
    }
    if (!sessions.length) throw new Error("This Thread has no sessions to move.")
    return { move, thread: placed.thread, asked: conversationId, cloudThread: this.#options.newCloudThread(), folder, repository, sessions, phase: "preparing", began: Date.now(), timings: {} }
  }

  /** Carries a move on from wherever its plan stands. */
  async #resume(plan: Plan): Promise<ThreadMoveOutcome> {
    const step = (next: ThreadMoveStep) => this.#options.step(plan.asked, plan.move, next)
    if (plan.phase === "preparing") {
      step({ kind: "packing" })
      try {
        await this.#ahead(plan)
        await this.#release(plan)
      } catch (error) {
        return this.#keep(plan, errorMessage({ error }), false)
      }
    }
    if (plan.phase === "released") {
      step({ kind: "handing-over" })
      let answer: MoveAnswer | undefined
      try {
        answer = await this.#answered(plan)
        if (!answer) {
          // Nothing runs the Thread now: what changed since it was sent ahead goes, a few files and lines at most, and
          // the machine arrives with that, never with what went before the release.
          await Promise.all([this.#sendCheckpoint(plan), this.#sendRecords(plan)])
          plan.timings.sent = Date.now() - plan.began
          await this.#write(plan)
          await this.#arrive(plan)
          answer = await this.#account().claimMove(plan.cloudThread, plan.move, this.#claimRequest(plan))
        }
      } catch (error) {
        answer = await this.#refuse(plan, errorMessage({ error }))
        if (!answer) {
          const reason = `This Mac couldn't hear the cloud's answer: ${errorMessage({ error })}. It asks again; the Thread runs nowhere until it hears.`
          step({ kind: "unsettled", reason })
          return { kind: "unsettled", reason }
        }
      }
      if (answer.kind === "refused") return this.#keep(plan, answer.reason, true)
      this.#confirm(plan, answer)
      plan.phase = "claimed"
      plan.timings.claimed = Date.now() - plan.began
      await this.#write(plan)
    }
    if (plan.phase === "claimed") {
      step({ kind: "resuming" })
      await this.#start(plan)
      plan.phase = "started"
      plan.timings.started = Date.now() - plan.began
      await this.#write(plan)
      hostLog("moves", "a Thread moved to the cloud", { move: plan.move, cloudThread: plan.cloudThread, sessions: plan.sessions.length, ...plan.timings })
    }
    step({ kind: "moved", conversations: plan.sessions.map((session) => session.conversationId) })
    return { kind: "moved", cloudThread: plan.cloudThread }
  }

  /** Everything that can go before the release: the cloud Thread made, the checkout and each Session's records sent. */
  async #ahead(plan: Plan): Promise<void> {
    const account = this.#account()
    await account.createThread(plan.cloudThread, plan.repository, { folder: plan.folder, harness: plan.sessions[0]?.harness ?? "" })
    plan.timings.made = Date.now() - plan.began
    await Promise.all([this.#sendCheckpoint(plan), this.#sendRecords(plan)])
    plan.timings.ahead = Date.now() - plan.began
    await this.#write(plan)
  }

  async #release(plan: Plan): Promise<void> {
    const threads = this.#options.threads()
    if (!threads) throw new Error("The Thread store closed.")
    const actor = threads.person()
    const target: ExecutionOwner = { kind: "cloud", runtime: cloudRuntimeOf(plan.cloudThread) }
    this.#options.moves.begin({ move: plan.move, thread: plan.thread, target, actor })
    try {
      plan.handoff = await this.#options.moves.release({ operationId: stepOperation(plan.move, "release"), move: plan.move, actor })
    } catch (error) {
      this.#options.moves.cancel({ operationId: stepOperation(plan.move, "cancel"), move: plan.move, actor })
      throw error instanceof MoveNotQuietError ? new Error(`Moves happen between turns: ${error.reasons.join("; ")}.`) : error
    }
    plan.phase = "released"
    plan.timings.released = Date.now() - plan.began
    await this.#write(plan)
  }

  async #sendCheckpoint(plan: Plan): Promise<void> {
    await mkdir(this.#options.folder, { recursive: true })
    const scratch = await mkdtemp(join(this.#options.folder, `${plan.move}-`))
    try {
      const { checkpoint, file } = await captureMoveCheckpoint(this.#options.git, plan.folder, scratch)
      if (checkpoint.sha256 !== plan.checkpoint?.sha256) await this.#account().sendCheckpoint(plan.cloudThread, checkpoint, file)
      plan.checkpoint = checkpoint
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async #sendRecords(plan: Plan): Promise<void> {
    const link = await this.#account().threadRecords(plan.cloudThread)
    await this.#options.sendRecords(link, plan.sessions.map((session) => session.path))
  }

  /** The machine applies the checkout and writes each Session into its harness's store; nothing starts. */
  async #arrive(plan: Plan): Promise<void> {
    const checkpoint: MoveCheckpoint | undefined = plan.checkpoint
    if (!checkpoint) throw new Error("The move has no checkpoint to carry.")
    await this.#options.cloud.callThread(plan.cloudThread, "mako:move-arrive", [{ move: plan.move, folder: plan.folder, checkpoint, sessions: plan.sessions.map(({ harness, nativeId }) => ({ harness, nativeId })) }])
    plan.timings.arrived = Date.now() - plan.began
  }

  #claimRequest(plan: Plan) {
    const handoff = plan.handoff
    if (!handoff) throw new Error("The move has no handoff to claim.")
    return { thread: handoff.thread.id, sessions: handoff.sessions.map((session) => ({ id: session.id, generation: session.generation })), handoff }
  }

  /** What the cloud answered this move before, if it did: a claim this Mac never heard goes on. */
  #answered(plan: Plan): Promise<MoveAnswer | undefined> {
    return this.#account().moveAnswer(plan.cloudThread, plan.move)
  }

  /** The cloud's refusal of a move that couldn't arrive, or its claim if that came first; undefined if it can't be told. */
  async #refuse(plan: Plan, reason: string): Promise<MoveAnswer | undefined> {
    try {
      return await this.#account().refuseMove(plan.cloudThread, plan.move, reason)
    } catch (error) {
      hostWarn("moves", "the cloud couldn't be asked to refuse a move; asked again later", { move: plan.move, error: errorMessage({ error }) })
      return undefined
    }
  }

  #confirm(plan: Plan, answer: Extract<MoveAnswer, { kind: "claimed" }>): void {
    const threads = this.#options.threads()
    if (!threads) throw new Error("The Thread store closed.")
    const receipt: ClaimReceipt = {
      move: plan.move,
      owner: { kind: "cloud", runtime: cloudRuntimeOf(plan.cloudThread) },
      sessions: answer.sessions.map((session) => ({ id: SessionIdSchema.parse(session.id), generation: session.generation })),
    }
    this.#options.moves.confirm({ operationId: stepOperation(plan.move, "confirm"), receipt, actor: threads.person() })
  }

  /** Each Session, its conversation now the cloud's, resumed on the machine as the same native session. */
  async #start(plan: Plan): Promise<void> {
    for (const session of plan.sessions) {
      await this.#options.cloud.adopt({ conversationId: session.conversationId, threadId: plan.cloudThread, harness: session.harness, repository: plan.repository })
      const options: LiveStartOptions = { conversationId: session.conversationId, resume: session.nativeId }
      if (session.modeId) options.modeId = session.modeId
      if (session.tuning) options.tuning = session.tuning
      const value = await this.#options.cloud.callThread(plan.cloudThread, "mako:live-start", [session.harness, plan.folder, options], session.conversationId)
      this.#options.cloud.started(session.conversationId, value)
    }
  }

  /** The Thread stays here: before the release, nothing changed; after a refusal, this Mac takes it back. */
  async #keep(plan: Plan, reason: string, released: boolean): Promise<ThreadMoveOutcome> {
    if (released) {
      const threads = this.#options.threads()
      if (threads) {
        const refusal: Refusal = { move: plan.move, by: { kind: "cloud", runtime: cloudRuntimeOf(plan.cloudThread) }, reason }
        this.#options.moves.reclaim({ operationId: stepOperation(plan.move, "reclaim"), refusal, actor: threads.person() })
      }
    } else {
      const threads = this.#options.threads()
      if (threads?.moveStatus(plan.move)?.phase === "leaving") this.#options.moves.cancel({ operationId: stepOperation(plan.move, "cancel"), move: plan.move, actor: threads.person() })
    }
    plan.phase = "kept-here"
    plan.reason = reason
    await this.#write(plan)
    hostLog("moves", "a Thread stayed here", { move: plan.move, released, reason })
    this.#options.step(plan.asked, plan.move, { kind: "kept-here", reason })
    return { kind: "kept-here", reason }
  }

  #account(): CloudAccount {
    const account = this.#options.account()
    if (!account) throw new Error("This Mac signed out of Mako Cloud.")
    return account
  }

  async #read(move: MoveId): Promise<Plan> {
    return PlanSchema.parse(JSON.parse(await readFile(join(this.#options.folder, `${move}.json`), "utf8")))
  }

  /** The plan, written whole before the step it says is next: a rename, so a stop leaves the last one or this one. */
  async #write(plan: Plan): Promise<void> {
    await mkdir(this.#options.folder, { recursive: true })
    const file = join(this.#options.folder, `${plan.move}.json`)
    await writeFile(`${file}.tmp`, JSON.stringify(PlanSchema.parse(plan)))
    await rename(`${file}.tmp`, file)
  }
}
