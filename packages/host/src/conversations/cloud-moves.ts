import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema, type MoveAnswer, type MoveCheckpoint } from "@mako/protocol/moves"
import { RecordHoldingsSchema, withFreshLink, type RecordsLink, type SentRecords } from "@mako/sessions/record-sync"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, type CloudRepository, type ThreadHandOff, type ThreadMoveOutcome, type ThreadMoveStep } from "../contracts/cloud-threads.js"
import type { EncodedValue } from "../contracts/runtime-value.js"
import type { LiveSnapshot, LiveStartOptions } from "../contracts/live-conversations.js"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import { executionRefusal, HandoffSchema, MoveIdSchema, RuntimeIdSchema, type ClaimReceipt, type ExecutionOwner, type Handoff, type MoveId, type Refusal, type RuntimeId, type SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type SessionId, type ThreadId } from "../contracts/thread-identity.js"
import type { CloudAccount } from "../usage/index.js"
import { captureMoveCheckpoint } from "../workspaces/index.js"
import type { ReadyPlan } from "./cloud-readiness.js"
import { MoveNotQuietError } from "./live-moves.js"

/**
 * A Thread of this Mac's moving to the cloud, natively: its checkout carried to a machine that clones the repository
 * at this Mac's own path, each Session's native records written into its harness's store there, and each Session
 * resumed as the same native session. The Thread has one owner throughout:
 *
 * 1. Everything that can go ahead does, while the Thread still runs here: the cloud Thread is made, the checkout's
 *    checkpoint and every Session's records are sent, and its machine boots and clones the folder: the release waits
 *    for it, so a cloud that can't start the machine never leaves the Thread in transit.
 * 2. This Mac releases the Thread (`LiveMoves.release`): only once nothing in it is working, refusing rather than
 *    waiting. From then nothing runs it anywhere.
 * 3. What changed since is sent, a few files and lines at most, and the machine applies it all (`mako:move-arrive`).
 *    Each Session is opened there as it arrives, its harness ready before the machine answers, so one that can't
 *    start there (not signed in, say) refuses the move here, never after the cloud took it.
 * 4. The cloud claims the move: the gateway keeps one answer per move, a claim or a refusal, whichever came first.
 *    Claimed, this Mac confirms and takes the Sessions' summaries from the machine; refused, this Mac takes the
 *    Thread back, and the cloud ends the machine.
 *
 * A failure before the release changes nothing here. One after it, before the claim, asks the cloud to refuse; if
 * the cloud claimed first, the move goes on. An answer lost on the way is asked for again by the move's id, and
 * never guessed: until it's known, the Thread runs nowhere (`unsettled`). Each move's plan is written before each
 * step (`<data root>/cloud/moves/<move>.json`), so a host that stops mid-move settles it when it starts again.
 */

/** A UUID fixed by a name: version 8 (named by its maker), variant 10, from the name's SHA-256. */
export function namedUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The cloud runtime a cloud Thread is, as a Thread store names an owner: a fixed UUID of its ID. */
export function cloudRuntimeOf(cloudThread: string): RuntimeId {
  return RuntimeIdSchema.parse(namedUuid(`mako cloud thread\0${cloudThread}`))
}

/** What a sleeping Mac's handoff must leave for the release and the hand-over after the pause. */
const RELEASE_TAKES_MS = 4_000
/** How long a handoff waits for the turns it paused to settle, and how often it looks. */
const PAUSE_SETTLES_MS = 15_000
const PAUSE_LOOK_MS = 100
/** The most a waiting message's attachment read from a file carries to the cloud. */
const CARRIED_FILE_BYTES = 20 * 1024 * 1024

/** A message's attachments as the cloud takes them: one only a path here names goes with its bytes. */
async function inlined(attachments: readonly PromptAttachment[]): Promise<PromptAttachment[]> {
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.data !== undefined || !attachment.path) return attachment
    const bytes = await readFile(attachment.path).catch(() => undefined)
    if (!bytes || bytes.length > CARRIED_FILE_BYTES) return attachment
    return { ...attachment, data: bytes.toString("base64"), size: bytes.length }
  }))
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
  /** What the last send pushed of its records, each unit at its head: what the machine must hold before it writes them. */
  holdings: RecordHoldingsSchema.optional(),
})
type PlanSession = z.infer<typeof PlanSessionSchema>

const PhaseSchema = z.enum(["preparing", "released", "claimed", "started", "kept-here"])

/** A move's plan as it's kept on disk: the way back reads a moved Thread's from it. */
export const MovePlanSchema = z.object({
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
  /** A move that pauses running turns to take them along (`ThreadHandOff`), and what it paused. */
  handingOff: z.object({
    why: z.enum(["asked", "quit", "sleep"]),
    releaseBy: z.number().optional(),
    /** Each turn to continue where the Thread lands, with the background work its agent had left running, stopped. */
    paused: z.array(z.object({ conversationId: z.string(), requestId: z.string(), stopped: z.array(z.string()).default([]) })).default([]),
  }).optional(),
  reason: z.string().optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
})
const PlanSchema = MovePlanSchema
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
    execution(session: SessionId): SessionExecution | undefined
    moveStatus(move: MoveId): { phase: string } | undefined
    person(): Actor
  } | undefined
  moves: {
    /** What keeps the Thread from leaving, once a turn's own bookkeeping has passed (`LiveMoves.settledBlockers`); empty when it could go. */
    settledBlockers(thread: ThreadId, waitMs?: number): Promise<string[]>
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
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string, options?: { refuseUnstarted?: boolean }): Promise<EncodedValue>
  }
  /** The conversations' own work here: a handoff pauses running turns, and a move takes waiting messages along. */
  live: {
    /**
     * Pauses the running turn (`handed-off`), its waiting messages held, and stops the background work its agent left;
     * answers the turn to continue and the work it stopped, or undefined when nothing was at work.
     */
    handOff(conversationId: string): Promise<{ requestId: string; stopped: string[] } | undefined>
    continueTurn(conversationId: string, input: { requestId: string; reason: "handed-off"; continues: string; stopped?: readonly string[]; actor: Actor }): void
    waitingPrompts(conversationId: string): Array<{ id: string; text: string; attachments: PromptAttachment[]; tuning?: SessionSettings; displayText?: string }>
    carried(conversationId: string, requestIds: readonly string[], to: "cloud"): void
  }
  /** The settings and access a native session last ran with, as this Mac remembers them. */
  remembered(harness: string, nativeId: string): { modeId?: string; settings?: SessionSettings } | null | undefined
  step(conversationId: string, move: string, step: ThreadMoveStep): void
  newCloudThread(): string
  /** A cloud Thread kept ready for this Thread (`CloudReadiness.take`), which the move takes in place of a new one. */
  ready?: { take(thread: string, folder: string, repository: CloudRepository): Promise<string | undefined> }
}

export class CloudMoves {
  readonly #options: CloudMovesOptions
  /** Moves running in this host, by id: a repeat of one joins it. */
  readonly #running = new Map<string, Promise<ThreadMoveOutcome>>()
  /** By move running in this host: the Thread it moves, which nothing keeps ready meanwhile (`leaving`). */
  readonly #leaving = new Map<string, string>()

  constructor(options: CloudMovesOptions) {
    this.#options = options
  }

  /**
   * Moves the Thread of `conversationId` to the cloud under `move`, or answers how that move went. `handOff`: its
   * running turns are paused and go along, continuing in the cloud (`ThreadHandOff`); without it, a Thread at work
   * stays here.
   */
  move(conversationId: string, move: string, handOff?: ThreadHandOff): Promise<ThreadMoveOutcome> {
    const running = this.#running.get(move)
    if (running) return running
    const work = this.#move(conversationId, MoveIdSchema.parse(move), handOff).finally(() => {
      this.#running.delete(move)
      this.#leaving.delete(move)
    })
    this.#running.set(move, work)
    return work
  }

  /** Whether a move of `thread` runs in this host now: from its plan until it moved or stayed. */
  leaving(thread: string): boolean {
    return [...this.#leaving.values()].includes(thread)
  }

  /**
   * Why the Thread of `conversationId` couldn't be handed to the cloud now, or undefined when it could: what a move's
   * plan would refuse, read without making or changing anything, its agents' work aside (a handoff pauses it).
   */
  async refusal(conversationId: string): Promise<string | undefined> {
    try {
      await this.#plan(conversationId, MoveIdSchema.parse(randomUUID()), { why: "asked" })
      return undefined
    } catch (error) {
      return errorMessage({ error })
    }
  }

  /** What a move of the Thread of `conversationId` would carry, for keeping it ready; throws, saying why, when it couldn't move. */
  async readyPlan(conversationId: string): Promise<ReadyPlan> {
    const plan = await this.#plan(conversationId, MoveIdSchema.parse(randomUUID()), { why: "asked" })
    return { thread: plan.thread, folder: plan.folder, repository: plan.repository, paths: plan.sessions.map((session) => session.path), harness: plan.sessions[0]?.harness ?? "" }
  }

  /** Settles every move a stopped host left unsettled: before the release, kept here; after, as the cloud answered. */
  async settle(): Promise<void> {
    const names = await readdir(this.#options.folder).catch(() => [])
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const plan = await this.#read(MoveIdSchema.parse(name.slice(0, -".json".length))).catch(() => undefined)
      if (!plan || plan.phase === "started" || plan.phase === "kept-here" || this.#running.has(plan.move)) continue
      this.#leaving.set(plan.move, plan.thread)
      const work = this.#resume(plan).finally(() => {
        this.#running.delete(plan.move)
        this.#leaving.delete(plan.move)
      })
      this.#running.set(plan.move, work)
      await work.catch((error: Error) => hostWarn("moves", "a move a stopped host left couldn't be settled yet", { move: plan.move, error: error.message }))
    }
  }

  async #move(conversationId: string, move: MoveId, handOff: ThreadHandOff | undefined): Promise<ThreadMoveOutcome> {
    const known = await this.#read(move).catch(() => undefined)
    if (known) this.#leaving.set(move, known.thread)
    if (known) return known.phase === "started" ? { kind: "moved", cloudThread: known.cloudThread } : known.phase === "kept-here" ? { kind: "kept-here", reason: known.reason ?? "It stayed here." } : this.#resume(known)
    let plan: Plan
    try {
      plan = await this.#plan(conversationId, move, handOff)
      this.#leaving.set(move, plan.thread)
      // Kept ready while it worked: its records and checkout are there already, and only the last seconds go.
      const ready = await this.#options.ready?.take(plan.thread, plan.folder, plan.repository).catch(() => undefined)
      if (ready) {
        plan.cloudThread = ready
        plan.timings.standby = 0
      }
    } catch (error) {
      const reason = errorMessage({ error })
      this.#options.step(conversationId, move, { kind: "kept-here", reason })
      return { kind: "kept-here", reason }
    }
    await this.#write(plan)
    return this.#resume(plan)
  }

  /** What a move carries, read before anything changes: refused, with the reason, when the Thread can't move. */
  async #plan(conversationId: string, move: MoveId, handOff: ThreadHandOff | undefined): Promise<Plan> {
    const account = this.#options.account()
    if (!account || !(await account.id())) throw new Error("Moving to the cloud needs this Mac signed in to Mako Cloud.")
    const threads = this.#options.threads()
    if (!threads) throw new Error("Moves need the Thread store, which didn't open.")
    const placed = threads.journalPlacement(conversationId)
    if (!placed) throw new Error("This conversation isn't in a Thread yet.")
    // A Thread that runs elsewhere, or is on its way, has nothing here to move: said as it is, before anything else.
    for (const { session } of threads.threadSessions(placed.thread)) {
      const execution = threads.execution(session)
      if (execution && execution.state !== "here") throw new Error(execution.state === "elsewhere" && execution.owner.kind === "cloud"
        ? "This Thread runs in the cloud already. Bring it back to this Mac first to move it again."
        : executionRefusal(execution) ?? "This Thread is moving already.")
    }
    // Asked before anything is made: a busy Thread starts no machine. The release asks again, with no wait before it
    // commits. A handoff pauses what works instead, once everything ahead is done.
    if (!handOff) {
      const busy = await this.#options.moves.settledBlockers(placed.thread)
      if (busy.length) throw new Error(`Moves happen between turns: ${busy.join("; ")}.`)
    }
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
    const plan: Plan = { move, thread: placed.thread, asked: conversationId, cloudThread: this.#options.newCloudThread(), folder, repository, sessions, phase: "preparing", began: Date.now(), timings: {} }
    if (handOff) plan.handingOff = { why: handOff.why, ...handOff.releaseBy !== undefined && { releaseBy: handOff.releaseBy }, paused: [] }
    return plan
  }

  /** Carries a move on from wherever its plan stands. */
  async #resume(plan: Plan): Promise<ThreadMoveOutcome> {
    const step = (next: ThreadMoveStep) => this.#options.step(plan.asked, plan.move, next)
    if (plan.phase === "preparing") {
      step({ kind: "packing" })
      try {
        await this.#ahead(plan)
        if (plan.handingOff) {
          step({ kind: "pausing" })
          await this.#pause(plan)
        }
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
      await this.#continueThere(plan)
      plan.phase = "started"
      plan.timings.started = Date.now() - plan.began
      await this.#write(plan)
      hostLog("moves", "a Thread moved to the cloud", { move: plan.move, cloudThread: plan.cloudThread, sessions: plan.sessions.length, ...plan.timings })
    }
    step({ kind: "moved", conversations: plan.sessions.map((session) => session.conversationId), ...plan.handingOff?.paused.length && { continued: true } })
    return { kind: "moved", cloudThread: plan.cloudThread }
  }

  /**
   * Everything that can go before the release: the cloud Thread made, the checkout and each Session's records sent,
   * and its machine up with the folder cloned (`mako:move-ready`). A machine that can't start (the cloud is full) or
   * can't clone keeps the Thread here, never released, rather than in transit until it can.
   */
  async #ahead(plan: Plan): Promise<void> {
    const account = this.#account()
    await account.createThread(plan.cloudThread, plan.repository, { folder: plan.folder, harness: plan.sessions[0]?.harness ?? "" })
    plan.timings.made = Date.now() - plan.began
    // Each failure says which step it stopped, which a bare one ("file closed") doesn't.
    const step = <Value>(what: string, work: Promise<Value>) => work.catch((error: Error) => {
      throw new Error(`${what}: ${errorMessage({ error })}`, { cause: error })
    })
    await Promise.all([
      step("Its worktree couldn't be sent ahead", this.#sendCheckpoint(plan)),
      step("Its sessions' records couldn't be sent ahead", this.#sendRecords(plan)),
      // Never queued: a cloud that can't start the machine now says so now, and the Thread stays here.
      step("Its cloud machine didn't get ready", this.#options.cloud.callThread(plan.cloudThread, "mako:move-ready", [{ folder: plan.folder, harnesses: [...new Set(plan.sessions.map((session) => session.harness))], launches: plan.sessions.map(({ harness, tuning }) => ({ harness, ...tuning && { tuning } })) }], undefined, { refuseUnstarted: true }).then(() => {
        plan.timings.ready = Date.now() - plan.began
      })),
    ])
    // What the hand-over would do with what went ahead, done now on the machine while the Thread still runs here.
    // Only time is at stake: one that fails leaves the hand-over to do it whole.
    const checkpoint = plan.checkpoint
    if (checkpoint) {
      try {
        await this.#options.cloud.callThread(plan.cloudThread, "mako:move-stage", [{ move: plan.move, folder: plan.folder, checkpoint, sessions: plan.sessions.map(({ harness, nativeId }) => ({ harness, nativeId })) }], undefined, { refuseUnstarted: true })
        plan.timings.staged = Date.now() - plan.began
      } catch (error) {
        hostWarn("moves", "a move couldn't be staged ahead; its hand-over does it whole", { move: plan.move, error: errorMessage({ error }) })
      }
    }
    plan.timings.ahead = Date.now() - plan.began
    await this.#write(plan)
  }

  /**
   * A handoff's pause (rule 2): once everything ahead is done, each running turn is paused, its waiting messages held,
   * and the Thread waits to be quiet. On a sleeping Mac's deadline, nothing is paused unless the release can still
   * follow in time; one paused that can't be released continues here (`#keep`).
   */
  async #pause(plan: Plan): Promise<void> {
    const handingOff = plan.handingOff
    if (!handingOff) return
    const late = () => handingOff.releaseBy !== undefined && Date.now() > handingOff.releaseBy - RELEASE_TAKES_MS
    if (late()) throw new Error("There wasn't time to hand it off before this Mac slept; it goes on here when the Mac wakes.")
    for (const { conversationId } of plan.sessions) {
      const paused = await this.#options.live.handOff(conversationId)
      if (paused && !handingOff.paused.some((each) => each.requestId === paused.requestId)) handingOff.paused.push({ conversationId, ...paused })
    }
    await this.#write(plan)
    const until = Math.min(Date.now() + PAUSE_SETTLES_MS, handingOff.releaseBy ?? Number.POSITIVE_INFINITY)
    for (;;) {
      const busy = await this.#options.moves.settledBlockers(plan.thread, 0)
      if (!busy.length) break
      if (Date.now() >= until) throw new Error(`Its agents didn't pause in time: ${busy.join("; ")}.`)
      await new Promise((resolve) => setTimeout(resolve, PAUSE_LOOK_MS))
    }
    // Released only with time left for the hand-over; otherwise it goes on here, as if it had never paused.
    if (late()) throw new Error("There wasn't time to hand it off before this Mac slept; it goes on here when the Mac wakes.")
    plan.timings.paused = Date.now() - plan.began
  }

  /**
   * In the cloud, each turn the handoff paused continues as Mako's, and every message that waited here goes there
   * under its own id, marked here as gone with the Thread. Each is kept by its id, so asked again it does nothing more.
   */
  async #continueThere(plan: Plan): Promise<void> {
    for (const { conversationId, requestId, stopped } of plan.handingOff?.paused ?? [])
      await this.#options.cloud.callThread(plan.cloudThread, "mako:live-continue-turn", [conversationId, namedUuid(`mako move\0${plan.move}\0${requestId}\0continue`), { reason: "handed-off", continues: requestId, ...stopped.length && { stopped } }], conversationId)
    for (const { conversationId } of plan.sessions) {
      const waiting = this.#options.live.waitingPrompts(conversationId)
      for (const prompt of waiting)
        await this.#options.cloud.callThread(plan.cloudThread, "mako:live-prompt", [conversationId, prompt.id, prompt.text, await inlined(prompt.attachments), prompt.tuning], conversationId)
      if (waiting.length) {
        this.#options.live.carried(conversationId, waiting.map((prompt) => prompt.id), "cloud")
        hostLog("moves", "messages waiting here went with the Thread", { move: plan.move, conversation: conversationId, messages: waiting.length })
      }
    }
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

  /** Each Session's records to the cloud Thread, noting what went so the machine can tell it took all of it. */
  async #sendRecords(plan: Plan): Promise<void> {
    // Under a fresh link if the last one's token lapsed on the way: what went stays gone, and the rest follows.
    const sent = await withFreshLink(() => this.#account().threadRecords(plan.cloudThread), (link) => this.#options.sendRecords(link, plan.sessions.map((session) => session.path)))
    hostLog("moves", "a move's records were sent", {
      move: plan.move, phase: plan.phase,
      sessions: sent.map((each) => `${each.harness}: ${each.versions} versions, ${each.chunks} chunks, ${each.bytes} bytes in ${each.requests} requests, ${each.ms} ms`).join("; "),
    })
    for (const session of plan.sessions) {
      const went = sent.find((each) => each.harness === session.harness && each.nativeId === session.nativeId)
      if (went) session.holdings = went.holdings
    }
  }

  /** The machine applies the checkout and writes each Session into its harness's store; nothing starts. */
  async #arrive(plan: Plan): Promise<void> {
    const checkpoint: MoveCheckpoint | undefined = plan.checkpoint
    if (!checkpoint) throw new Error("The move has no checkpoint to carry.")
    // Each opened there before the claim: a harness that can't start on the machine refuses the move while it's this Mac's.
    const sessions = plan.sessions.map(({ harness, nativeId, holdings, conversationId, modeId, tuning }) => ({
      harness, nativeId, ...holdings && { holdings },
      open: { conversationId, ...modeId !== undefined && { modeId }, ...tuning !== undefined && { tuning } },
    }))
    // With the handoff: the machine's store files the Thread under the same IDs as this Mac's.
    await this.#options.cloud.callThread(plan.cloudThread, "mako:move-arrive", [{ move: plan.move, folder: plan.folder, checkpoint, sessions, ...plan.handoff && { handoff: plan.handoff } }])
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

  /** Each Session, its conversation now the cloud's: opened on the machine as it arrived, so its start there answers how it stands. */
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
      // The cloud Thread made ahead was this move's alone: refused, the cloud ends its machine now, not at its lease's end.
      if (plan.timings.made !== undefined) await this.#refuse(plan, reason)
    }
    // A turn the handoff paused goes on here, as Mako's: nothing of it was lost, and nothing waits for the person.
    const paused = plan.handingOff?.paused ?? []
    for (const { conversationId, requestId, stopped } of paused) {
      try {
        this.#options.live.continueTurn(conversationId, { requestId: namedUuid(`mako move\0${plan.move}\0${requestId}\0continue-here`), reason: "handed-off", continues: requestId, stopped, actor: { kind: "service", name: "handoff" } })
      } catch (error) {
        hostWarn("moves", "a turn the handoff paused couldn't continue here", { move: plan.move, conversation: conversationId, error: errorMessage({ error }) })
      }
    }
    plan.phase = "kept-here"
    plan.reason = reason
    await this.#write(plan)
    hostLog("moves", "a Thread stayed here", { move: plan.move, released, reason, continued: paused.length })
    this.#options.step(plan.asked, plan.move, { kind: "kept-here", reason, ...paused.length && { continued: true } })
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
