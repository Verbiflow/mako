import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { encodeOperation, type ThreadFileHistory } from "@mako/protocol"
import type { ContinueState, ListedContinue } from "@mako/protocol/continues"
import { MOVE_ANSWER_WAIT_MS, MoveCarryRefSchema, MoveCarrySchema, MoveCheckpointSchema, type MoveAnswer, type MoveCarryRepository, type MoveCheckpoint, type MoveLeft } from "@mako/protocol/moves"
import { RecordHoldingsSchema, describeSync, withFreshLink, type RecordsLink, type SentRecords } from "@mako/sessions/record-sync"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, goesOff, type CloudRepository, type MoveCarried, type MoveSent, type ThreadHandOff, type ThreadMoveOutcome, type ThreadMoveStep } from "../contracts/cloud-threads.js"
import { hostCallInput, toHostOperation } from "../contracts/host-operations.js"
import { decodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import type { LiveSnapshot, LiveStartOptions } from "../contracts/live-conversations.js"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import { executionRefusal, HandoffSchema, MoveIdSchema, RuntimeIdSchema, type ClaimReceipt, type ExecutionOwner, type Handoff, type MoveId, type Refusal, type RuntimeId, type SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type Actor, type SessionId, type ThreadId } from "../contracts/thread-identity.js"
import type { CloudAccount } from "../usage/index.js"
import { captureCarry, captureMoveCheckpoint, readOutside, type OutsideCandidate, type PlannedCheckout } from "../workspaces/index.js"
import type { ReadyPlan, TakenReady } from "./cloud-readiness.js"
import type { ThreadHarnessCheck } from "../contracts/cloud-harnesses.js"
import type { MoveHaste } from "../contracts/workspace-moves.js"
import type { CheckedSession } from "./harness-check.js"
import { MoveNotQuietError } from "./live-moves.js"
import { logMoveDiagnostic, moveDiagnosticReason } from "./move-diagnostics.js"

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
 *
 * A Thread the account continued in the cloud while this Mac was off (`@mako/protocol/continues`) is one more move,
 * that this Mac joins when it's back (`joinContinue`): it releases the Thread at the generation the account's handoff
 * named, so nothing runs it here, then takes the cloud's answer as for any move it handed over.
 */

/** A UUID fixed by a name: version 8 (named by its maker), variant 10, from the name's SHA-256. */
/**
 * The request a turn parked as this Mac went off goes on under in the cloud: the one id the going-away's note names
 * (`ParkedTurn.continuation`), which the account's continue sends it on under, and the one this Mac's join sends it
 * under (`#sendParked`). The host's continue takes one request id once, so the turn runs once whoever sends it first.
 */
export function parkedContinuation(move: string, request: string): string {
  return namedUuid(`mako move\0${move}\0${request}\0continue`)
}

export function namedUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The cloud runtime a cloud Thread is, as a Thread store names an owner: a fixed UUID of its ID. */
export function cloudRuntimeOf(cloudThread: string): RuntimeId {
  return RuntimeIdSchema.parse(namedUuid(`mako cloud thread\0${cloudThread}`))
}

/** Runs one step of a move, its failure saying which step, which a bare one ("file closed") doesn't. */
function named<Value>(what: string, work: Promise<Value>): Promise<Value> {
  return work.catch((error: Error) => {
    throw new Error(`${what}: ${errorMessage({ error })}`, { cause: error })
  })
}

/** What a machine answers when it's ready for a move: `carry`, that it takes one (`MoveCarry`). */
const ReadyAnswerSchema = z.object({ folder: z.string(), carry: z.boolean().optional() }).loose()

/** What a sleeping Mac's handoff must leave for the release and the hand-over after the pause. */
const RELEASE_TAKES_MS = 4_000
/** How long a handoff with a deadline waits for the attribution journal as its Thread goes onto its own branch. */
const HASTE_SETTLE_MS = 1_500
/** Why a Mac going off kept a Thread it couldn't release in time. */
const TOO_LATE = "There wasn't time to hand it off before this Mac went off. It waits, paused: Continue in the cloud from another device takes it, or it goes on here when this Mac is back."
/**
 * How long this host waits for the cloud's answer to a move it carries through: its arrival refuses the move within
 * two minutes if its machine can't take the Thread, and a claim follows a machine's arrival at once.
 */
const ANSWER_WAIT_MS = 5 * 60_000

/** What a caller of `move` may wait for short of the whole move: this Mac let go (`released`), or the cloud has it (`handed`). */
export type Milestone = "released" | "handed"

/** A milestone a move reaches once, with the cloud Thread it reached it for. */
type Reached = { promise: Promise<string>; resolve(cloudThread: string): void }

function deferred(): Reached {
  let resolve: (cloudThread: string) => void = () => undefined
  const promise = new Promise<string>((settle) => { resolve = settle })
  return { promise, resolve }
}
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
  /** The folder it works in, when it isn't the move's `folder`: a project of several repositories, or a folder inside one. */
  cwd: z.string().optional(),
  modeId: z.string().optional(),
  tuning: SessionSettingsSchema.optional(),
  /** What the last send pushed of its records, each unit at its head: what the machine must hold before it writes them. */
  holdings: RecordHoldingsSchema.optional(),
})
type PlanSession = z.infer<typeof PlanSessionSchema>

/**
 * Where a move stands: `preparing` (nothing changed here), `released` (nothing runs the Thread here; this Mac sends
 * what only it has), `handed` (the cloud carries it through: arrives it, claims it, starts it), `claimed` (the cloud's,
 * as this Mac now records), `started` (followed here as the cloud's), or `kept-here`.
 */
const PhaseSchema = z.enum(["preparing", "released", "handed", "claimed", "started", "kept-here"])

/** A move's plan as it's kept on disk: the way back reads a moved Thread's from it. */
export const MovePlanSchema = z.object({
  move: MoveIdSchema,
  thread: ThreadIdSchema,
  /** The conversation the move was asked from, whose window hears its steps. */
  asked: z.string(),
  /** The conversation the person asked from, when its harness forked onto its own branch and `asked` is the fork. */
  from: z.string().optional(),
  cloudThread: z.string(),
  /** The folder the cloud Thread is made at, which its machine clones `repository` into: the Thread's worktree, or the first repository's in a project of several. */
  folder: z.string(),
  repository: CloudRepositorySchema,
  /** The Thread's own folder, when it isn't `folder`: a project of several repositories, one worktree each. */
  project: z.string().optional(),
  /** The Thread's other repositories: each cloned beside the first by the machine, and carried by its own checkpoint. */
  others: z.array(z.object({ path: z.string(), url: z.string(), branch: z.string().optional(), checkpoint: MoveCheckpointSchema.optional() })).default([]),
  sessions: z.array(PlanSessionSchema).min(1),
  phase: PhaseSchema,
  checkpoint: MoveCheckpointSchema.optional(),
  /**
   * The checkpoint the cloud keeps already, by its hash: the one sent while the Thread was kept ready, then each this
   * move sent. One the same isn't asked about again.
   */
  held: z.string().optional(),
  /** What else the move carries (`MoveCarry`, without its bytes), as last sent: the way back reads from it what left here. */
  carry: z.object({ ref: MoveCarryRefSchema, manifest: MoveCarrySchema }).optional(),
  /** Whether the machine takes a carry, as its `mako:move-ready` answered: one before carries is sent the checkout alone. */
  takesCarry: z.boolean().optional(),
  handoff: HandoffSchema.optional(),
  /** A move that pauses running turns to take them along (`ThreadHandOff`), and what it paused. */
  handingOff: z.object({
    why: z.enum(["asked", "quit", "sleep", "shutdown"]),
    releaseBy: z.number().optional(),
    /** Each turn to continue where the Thread lands, with the background work its agent had left running, stopped. */
    paused: z.array(z.object({ conversationId: z.string(), requestId: z.string(), stopped: z.array(z.string()).default([]) })).default([]),
  }).optional(),
  reason: z.string().optional(),
  /**
   * A continue this Mac joined (`joinContinue`): the device it was pressed on, and whether the cloud continued from
   * before this Mac's last turns (`behind`), which stay in its records here.
   */
  continued: z.object({ by: z.string(), at: z.string(), behind: z.boolean().default(false) }).optional(),
  /**
   * The branch this Mac's worktree was on when it joined a continue: the machine cloned the branch pushed, by the
   * remote's name (`checkpoint`'s), which the worktree here may name otherwise (`onBranchHere`). Absent for a move this
   * Mac sent its own checkout with, which names the branch.
   */
  branch: z.string().optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
})
const PlanSchema = MovePlanSchema
type Plan = z.infer<typeof PlanSchema>
/** A Thread weighed for a move before its checkout is: what a Thread in the main checkout has before its own branch. */
type Weighed = Pick<Plan, "thread" | "sessions">
/** A turn a handoff paused: what to continue where the Thread lands, with the background work it stopped. */
type Paused = NonNullable<Plan["handingOff"]>["paused"][number]

/**
 * Turns a handoff paused as this Mac went off, for a Thread that didn't move (`goesOff`): none goes on here until this
 * Mac hears its account again, so the Thread reads idle for Continue in the cloud from another device meanwhile.
 */
const ParkedSchema = z.object({
  version: z.literal(1),
  turns: z.array(z.object({ move: z.string(), thread: z.string(), conversationId: z.string(), requestId: z.string(), stopped: z.array(z.string()).default([]), at: z.number() })),
})
type Parked = z.infer<typeof ParkedSchema>["turns"][number]
/** A parked turn nothing took up for this long is forgotten. */
const PARKED_KEPT_MS = 7 * 24 * 60 * 60_000

/**
 * A checkpoint of the machine's checkout, as this Mac lays it in the Thread's worktree: on this Mac's own branch while
 * the machine stays on the branch it began on under the remote's name (`branch`), which another worktree here may
 * have checked out (a project's folder on `main`); a branch the machine went onto is laid as it's named.
 */
export function onBranchHere(checkpoint: MoveCheckpoint, plan: Pick<Plan, "branch" | "checkpoint" | "repository">): MoveCheckpoint {
  const began = plan.checkpoint?.branch ?? plan.repository.branch
  if (!plan.branch || !checkpoint.branch || checkpoint.branch !== began || checkpoint.branch === plan.branch) return checkpoint
  return { ...checkpoint, branch: plan.branch }
}

/** What a move needs of the host. */
export type CloudMovesOptions = {
  /** Where moves' plans are kept: `<data root>/cloud/moves`. */
  folder: string
  git: Git
  account(): CloudAccount | undefined
  /** A continue this Mac joined took the Session's Thread to the cloud: what it left in the main checkout may leave it (`CheckoutLeave`). */
  joinedAway?(session: string, op: string): void
  /** Since when a Session waits for the account's word after a going-away the account took (`AwayNotes.holds`): its parked turns don't go on here meanwhile. */
  awayHeld?(session: string): number | undefined
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
  /** The Thread's own checkout here, its worktree (a folder of them, one a repository, in a project of several); undefined for a Thread in the main checkout. */
  checkout(conversationId: string): { path: string; worktrees: Array<{ path: string }> } | undefined
  /**
   * Moves the Thread of a conversation in the main checkout onto its own branch, as "Move to its own branch" does,
   * taking only its own changes; answers the conversation that goes on there (itself, or its fork). `asItself`: the
   * same session or nothing, never a fork, as a handoff's paused turn needs.
   */
  ownBranch?(conversationId: string, options?: { asItself?: boolean; haste?: MoveHaste }): Promise<string>
  /**
   * The worktree `ownBranch` would put the Thread of a conversation in the main checkout in now, with nothing made
   * (`ThreadWorktreeMoves.planned`): its folder, and the repository there it's a worktree of.
   */
  planned?(conversationId: string): Promise<PlannedCheckout | undefined>
  /** The Thread's paths outside its folder that its journal ties to it (`Attribution.changes`' footprint, with evidence). */
  outside?(thread: ThreadId): OutsideCandidate[]
  /** The Thread's file history (`Attribution.threadHistory`), carried so the side it lands on resolves its files alike. */
  history?(thread: ThreadId): ThreadFileHistory | undefined
  /**
   * Whether a conversation of the Thread is archived here: no tab shows it, so it starts nowhere and stays as it is, such
   * as the one a fork onto the Thread's own branch left behind in the main checkout.
   */
  archived?(conversationId: string): boolean
  repositoryOf(folder: string): Promise<CloudRepository>
  /** Sends Sessions' records to the cloud Thread now (`SessionCatalog.sendRecords`). */
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  cloud: {
    adopt(conversation: { conversationId: string; threadId: string; harness: string; repository: CloudRepository }): Promise<void>
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string, options?: { refuseUnstarted?: boolean }): Promise<EncodedValue>
  }
  /** The conversations' own work here: a handoff pauses running turns, and a move takes waiting messages along. */
  live: {
    /**
     * Pauses the running turn (`handed-off`), its waiting messages held, and stops the background work its agent left;
     * answers the turn to continue and the work it stopped, or undefined when nothing was at work.
     */
    handOff(conversationId: string): Promise<{ requestId: string; stopped: string[] } | undefined>
    /** `stayed`: the move didn't happen, so the turn goes on here, saying so (`continueTurnPrompt`). */
    continueTurn(conversationId: string, input: { requestId: string; reason: "handed-off"; continues: string; stopped?: readonly string[]; stayed?: true; actor: Actor }): void
    waitingPrompts(conversationId: string): Array<{ id: string; text: string; attachments: PromptAttachment[]; tuning?: SessionSettings; displayText?: string }>
    carried(conversationId: string, requestIds: readonly string[], to: "cloud"): void
  }
  /** The settings and access a native session last ran with, as this Mac remembers them. */
  remembered(harness: string, nativeId: string): { modeId?: string; settings?: SessionSettings } | null | undefined
  step(conversationId: string, move: string, step: ThreadMoveStep): void
  /** A move stopped running in this host, however it ended: with its last step, or a throw that sent none. */
  ended?(move: string): void
  newCloudThread(): string
  /**
   * Brings the account's copy of the project's carried files (its recipe's `carry`) up to date, if the person allowed
   * it (`CloudCarriedFiles.sync`): the machine places them as it starts and again as the move arrives.
   */
  carried?(folder: string, why: string): Promise<void>
  /** A cloud Thread kept ready for this Thread (`CloudReadiness.take`), which the move takes in place of a new one. */
  ready?: { take(thread: string, folder: string, repository: CloudRepository): Promise<TakenReady | undefined> }
  /**
   * The Thread's harnesses here weighed against the cloud's (`HarnessCheck`): a Session the cloud can't resume refuses
   * the move here, before anything is made, rather than as it arrives.
   */
  harnesses?: { check(sessions: readonly CheckedSession[]): Promise<ThreadHarnessCheck> }
}

/**
 * What a move took besides its checkout, for the person: from its carry, or, to a machine that takes none, what stayed.
 * Nothing when it was only its checkout.
 */
function carriedOf(plan: Plan): MoveCarried | undefined {
  const manifest = plan.carry?.manifest
  if (!manifest) return undefined
  const carried = plan.takesCarry
    ? { repositories: manifest.repositories.length, outside: manifest.outside.length, left: manifest.left }
    : { repositories: 1, outside: 0, left: [...manifest.outside.map(({ path }): MoveLeft => ({ path, why: "older-cloud" })), ...manifest.left] }
  return carried.repositories > 1 || carried.outside || carried.left.length ? carried : undefined
}

/** Said at most this often while a move's checkout goes ahead: often enough for a bar to move, rarely enough for a link. */
export const SENT_EVERY_MS = 250

/**
 * How much of a move's checkout has gone, told to `say` as it goes: each file to send adds its bytes to what has to go
 * (`adding`), and what a file's upload says it sent counts towards it. Said at most every `SENT_EVERY_MS`, and once
 * more when everything has gone, so the last word is the whole.
 */
export class SentProgress {
  readonly #say: (sent: MoveSent) => void
  readonly #now: () => number
  #of = 0
  #bytes = 0
  #saidAt = Number.NEGATIVE_INFINITY

  constructor(say: (sent: MoveSent) => void, now: () => number = Date.now) {
    this.#say = say
    this.#now = now
  }

  /** A file of `bytes` to send: what its upload should be told of its bytes as they go. */
  adding(bytes: number): (sent: number) => void {
    const before = this.#bytes
    this.#of += bytes
    return (sent) => {
      this.#bytes = before + Math.min(sent, bytes)
      if (this.#now() - this.#saidAt < SENT_EVERY_MS) return
      this.#saidAt = this.#now()
      this.#say({ bytes: this.#bytes, of: this.#of })
    }
  }

  /** Everything went: said once more, whole, if any upload said it sent anything (one the cloud had says nothing). */
  done(): void {
    if (!this.#bytes) return
    this.#say({ bytes: this.#of, of: this.#of })
  }
}

export class CloudMoves {
  readonly #options: CloudMovesOptions
  /** Moves running in this host, by id: a repeat of one joins it. */
  readonly #running = new Map<string, Promise<ThreadMoveOutcome>>()
  /** By move running in this host: the Thread it moves, which nothing keeps ready meanwhile (`leaving`). */
  readonly #leaving = new Map<string, string>()
  /** Moves running in this host that the cloud carries through now. */
  readonly #handed = new Set<string>()
  /**
   * By move running in this host, what a caller may wait for short of the whole move (`answer`): `released`, once this
   * Mac let go of the Thread; `handed`, once the cloud carries it through, so this Mac is no longer needed for it.
   */
  readonly #milestones = new Map<string, Record<Milestone, Reached>>()
  /** Continues this host joined and settled (moved, or kept here): heard of again, nothing is read. */
  readonly #joinedContinues = new Set<string>()
  /** By continue this host is joining now, the Sessions the account said it carries: none of them runs here meanwhile. */
  readonly #joining = new Map<string, Set<string>>()
  /** Writes of the parked turns, one at a time. */
  #parking: Promise<void> = Promise.resolve()

  constructor(options: CloudMovesOptions) {
    this.#options = options
  }

  /**
   * Moves the Thread of `conversationId` to the cloud under `move`, or answers how that move went. `handOff`: its
   * running turns are paused and go along, continuing in the cloud (`ThreadHandOff`); without it, a Thread at work
   * stays here.
   */
  move(conversationId: string, move: string, handOff?: ThreadHandOff, options: { answer?: Milestone } = {}): Promise<ThreadMoveOutcome> {
    let work = this.#running.get(move)
    if (!work) {
      this.#milestones.set(move, { released: deferred(), handed: deferred() })
      work = this.#move(conversationId, MoveIdSchema.parse(move), handOff).finally(() => this.#ended(move))
      this.#running.set(move, work)
    }
    // Answered short of the whole move: what's left goes on in this host, which outlives a window, and the cloud,
    // which outlives a sleep; the move's steps report it as it goes.
    const reached = options.answer ? this.#milestones.get(move)?.[options.answer].promise : undefined
    if (!reached) return work
    return Promise.race([work, reached.then((cloudThread): ThreadMoveOutcome => ({ kind: "released", cloudThread }))])
  }

  /**
   * Waits, until `deadline` at most, for every move running in this host to need this Mac no more: handed to the
   * cloud, which carries it through, or settled. What a Mac about to sleep waits for, so no Thread it let go of waits
   * on this Mac between here and the cloud. Answers how many still need it.
   */
  async settled(deadline: number): Promise<number> {
    const needing = () => [...this.#running.keys()].filter((move) => !this.#handed.has(move))
    const waits = needing().map((move) => Promise.race([this.#running.get(move), this.#milestones.get(move)?.handed.promise]))
    if (waits.length) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(waits),
        new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())) }),
      ])
      clearTimeout(timer)
    }
    return needing().length
  }

  /** Whether this host joins a continue now (`joinContinue`): only then can `joining` hold a Session. */
  joinsAny(): boolean {
    return this.#joining.size > 0
  }

  /**
   * Whether a continue this host joins now carries `session`: from the account's word until the join ends, nothing of
   * it runs here, so a message typed as this Mac came back goes with the Thread rather than run before its release.
   */
  joining(session: string): boolean {
    for (const sessions of this.#joining.values()) if (sessions.has(session)) return true
    return false
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

  /**
   * What the Thread of `conversationId`'s harnesses here and in the cloud mean for moving it (`HarnessCheck`), read
   * without making or changing anything; throws, saying why, when it couldn't move for any other reason.
   */
  async harnessCheck(conversationId: string): Promise<ThreadHarnessCheck> {
    const plan = await this.#plan(conversationId, MoveIdSchema.parse(randomUUID()), { why: "asked" }, false)
    return this.#options.harnesses?.check(plan.sessions) ?? { kind: "unknown", reason: "This Mako doesn't weigh harness versions." }
  }

  /** What a move of the Thread of `conversationId` would carry, for keeping it ready; throws, saying why, when it couldn't move. */
  async readyPlan(conversationId: string): Promise<ReadyPlan> {
    // A Thread in the main checkout is kept ready where its move would put it: the worktree it goes onto first, as named
    // now, which its move makes unless something takes the name meanwhile. Nothing is there yet, so no checkout goes
    // ahead; the move sends its own. That worktree's branch is new, with no upstream, so the cloud clones the default.
    if (this.#options.ownBranch && this.#options.planned && !this.#options.checkout(conversationId)) {
      const weighed = await this.#plan(conversationId, MoveIdSchema.parse(randomUUID()), { why: "asked" }, true, "later")
      const planned = await this.#options.planned(conversationId)
      if (!planned) throw new Error("The worktree its own branch would have can't be named now, so it isn't kept ready.")
      const { url } = await this.#options.repositoryOf(planned.repository)
      // Each repository with where its worktree would be and its GitHub repository: a going-away names the others so.
      const repositories = await Promise.all(planned.repositories.map(async ({ root, folder }) => ({ root, folder, branch: planned.branch, url: (await this.#options.repositoryOf(root)).url })))
      return { thread: weighed.thread, folder: planned.folder, repository: { url }, paths: weighed.sessions.map((session) => session.path), harness: weighed.sessions[0]?.harness ?? "", planned: true, repositories, ...planned.project && { project: planned.project, ...planned.projectFrom && { projectFrom: planned.projectFrom } } }
    }
    const plan = await this.#plan(conversationId, MoveIdSchema.parse(randomUUID()), { why: "asked" })
    return { thread: plan.thread, folder: plan.folder, repository: plan.repository, paths: plan.sessions.map((session) => session.path), harness: plan.sessions[0]?.harness ?? "", ...plan.project && { project: plan.project, projectFrom: plan.project } }
  }

  /**
   * The Thread of `conversationId` as this Mac goes away (a sleep, a shutdown; `goingAway` names it): every running
   * turn of its Sessions paused and parked (`#stayed`), so it reads idle, and nothing of it moves: no branch, no
   * worktree, no release. It stays this Mac's; the account may continue it from its last acknowledged checkpoint while
   * the Mac is quiet, and it goes on here once the Mac is back otherwise (`unpark`). Answers the Thread and its
   * Sessions at their generations, as the going-away's note names them.
   */
  async goAway(conversationId: string, goingAway: string, handOff: ThreadHandOff): Promise<{ thread: ThreadId; sessions: Array<{ session: SessionId; generation: number }>; parked: Array<{ conversation: string; request: string; continuation: string; stopped: string[] }> }> {
    const threads = this.#options.threads()
    const thread = threads?.journalPlacement(conversationId)?.thread
    if (!threads || !thread) throw new Error("It isn't in this Mac's Threads, so nothing could continue it elsewhere.")
    const move = namedUuid(`mako going away\0${goingAway}\0${thread}`)
    const conversations = this.#conversationsOf(thread, conversationId)
    const paused: Paused[] = []
    await this.#pauseTurns(conversations, thread, handOff, paused).catch((error: Error) => hostWarn("moves", "a Thread's agents didn't all pause as this Mac went away", { thread, error: error.message }))
    await this.#stayed(move, thread, handOff, paused, conversations)
    const sessions = threads.threadSessions(thread).flatMap(({ session }) => {
      const execution = threads.execution(session)
      return execution?.state === "here" ? [{ session, generation: execution.generation }] : []
    })
    // Each named with the request it goes on under, as this Mac's own join would send it (`parkedContinuation`).
    const parked = paused.map((turn) => ({ conversation: turn.conversationId, request: turn.requestId, continuation: parkedContinuation(move, turn.requestId), stopped: turn.stopped }))
    return { thread, sessions, parked }
  }

  /** Settles every move a stopped host left unsettled: before the release, kept here; after, as the cloud answered. */
  async settle(): Promise<void> {
    const names = await readdir(this.#options.folder).catch(() => [])
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const plan = await this.#read(MoveIdSchema.parse(name.slice(0, -".json".length))).catch(() => undefined)
      if (!plan || plan.phase === "started" || plan.phase === "kept-here" || this.#running.has(plan.move)) continue
      this.#leaving.set(plan.move, plan.thread)
      this.#milestones.set(plan.move, { released: deferred(), handed: deferred() })
      const work = this.#resume(plan).finally(() => this.#ended(plan.move))
      this.#running.set(plan.move, work)
      await work.catch((error: Error) => hostWarn("moves", "a move a stopped host left couldn't be settled yet", { move: plan.move, error: error.message }))
    }
  }

  /**
   * A continue of this Mac's Thread that the account carried while this Mac was off (`listed`, as its Session's row
   * says it), joined as a move this Mac handed over: the account is asked to carry it on (a press whose client went
   * away is finished here), this Mac releases the Thread at the generation the account released it at, and the
   * cloud's claim is confirmed (or its refusal takes the Thread back), as for any move. Once per continue; a Thread at
   * work here waits for its turn to end (its row changes then, which joins it again). A continue that failed changes
   * nothing here. While it's joined, nothing of its Sessions runs here (`joining`); a message typed here meanwhile
   * goes to the cloud Thread once it's claimed.
   */
  joinContinue(session: string, listed: ListedContinue): void {
    if (listed.phase === "failed" || this.#joinedContinues.has(listed.op)) return
    this.#joining.get(listed.op)?.add(session)
    if (this.#running.has(listed.op)) return
    const move = MoveIdSchema.parse(listed.op)
    this.#joining.set(move, new Set([session]))
    this.#milestones.set(move, { released: deferred(), handed: deferred() })
    const work = this.#joined(session, move).then((outcome) => {
      if (outcome.kind === "moved" || outcome.kind === "kept-here") this.#joinedContinues.add(move)
      if (outcome.kind === "moved") this.#options.joinedAway?.(session, listed.op)
      return outcome
    }, (error: Error): ThreadMoveOutcome => {
      hostWarn("continues", "a continue in the cloud couldn't be joined here yet", { move, session, cloudThread: listed.cloudThread, error: errorMessage({ error }) })
      return { kind: "unsettled", reason: errorMessage({ error }) }
    }).finally(() => this.#ended(move))
    this.#running.set(move, work)
  }

  async #joined(session: string, move: MoveId): Promise<ThreadMoveOutcome> {
    const known = await this.#read(move).catch(() => undefined)
    if (known) {
      this.#leaving.set(move, known.thread)
      return known.phase === "started" ? { kind: "moved", cloudThread: known.cloudThread } : known.phase === "kept-here" ? { kind: "kept-here", reason: known.reason ?? "It stayed here." } : this.#resume(known)
    }
    const threads = this.#options.threads()
    if (!threads) throw new Error("The Thread store isn't open.")
    const id = SessionIdSchema.parse(session)
    const execution = threads.execution(id)
    if (execution && execution.state !== "here") return { kind: "unsettled", reason: "It isn't this Mac's to give up." }
    // Carried on first: a continue whose press went away before its hand-over goes on from here.
    const state = await this.#account().continueState?.(session, move, { carryOn: true })
    if (!state) throw new Error("The account has no record of this continue.")
    if (state.phase === "failed") {
      hostLog("continues", "a continue in the cloud failed while this Mac was off; the Thread stays here", { move, session, reason: state.reason ?? "" })
      // Nothing took it elsewhere: what it paused as this Mac went off goes on here now, not at the next owner check.
      await this.#goOnHere((turn) => turn.thread === state.thread)
      return { kind: "kept-here", reason: state.reason ?? "It didn't continue in the cloud." }
    }
    const thread = ThreadIdSchema.parse(state.thread)
    const mine = threads.threadSessions(thread)
    // The account released each at its listed generation plus one: this Mac's store must stand there too, or the
    // cloud's claim would never match its release.
    for (const carried of state.sessions) {
      const here = threads.execution(SessionIdSchema.parse(carried.session))
      if (here && here.generation !== carried.generation) throw new Error(`Its Session ${carried.session} is at generation ${here.generation} here, and the continue released it from ${carried.generation}.`)
    }
    if (mine.length !== state.sessions.length || mine.some((each) => !state.sessions.some((carried) => carried.session === each.session)))
      throw new Error("Its Sessions here aren't the ones the account continued.")
    const busy = await this.#options.moves.settledBlockers(thread, 0)
    if (busy.length) {
      hostWarn("continues", "a Thread continued in the cloud is at work here; it's given up once its turn ends", { move, thread, busy: busy.join("; ") })
      return { kind: "unsettled", reason: `It's at work here: ${busy.join("; ")}.` }
    }
    const branch = await this.#options.git.run({ cwd: state.folder, args: ["symbolic-ref", "--short", "--quiet", "HEAD"], codes: [0, 1, 128] })
      .then((read) => (read.code === 0 ? read.stdout.toString("utf8").trim() : undefined), () => undefined)
    const plan: Plan = {
      move, thread, asked: state.sessions[0]!.conversation, cloudThread: state.cloudThread, folder: state.folder,
      repository: CloudRepositorySchema.parse(state.repository), others: [], phase: "released", began: Date.now(), timings: {},
      sessions: state.sessions.map((carried) => {
        const snapshot = this.#options.snapshot(carried.conversation)
        return { session: carried.session, conversationId: carried.conversation, harness: carried.harness, nativeId: carried.nativeId, path: snapshot?.session.nativePath ?? "", ...carried.folder !== state.folder && { cwd: carried.folder }, ...carried.holdings && { holdings: carried.holdings } }
      }),
      continued: { by: state.by, at: state.at, behind: state.sessions.some((carried) => carried.freshness?.behind === true) },
      ...state.start && { checkpoint: state.start },
      ...branch && { branch },
    }
    this.#leaving.set(move, thread)
    const actor = threads.person()
    this.#options.moves.begin({ move, thread, target: { kind: "cloud", runtime: cloudRuntimeOf(plan.cloudThread) }, actor })
    try {
      plan.handoff = await this.#options.moves.release({ operationId: stepOperation(move, "release"), move, actor })
    } catch (error) {
      if (threads.moveStatus(move)?.phase === "leaving") this.#options.moves.cancel({ operationId: stepOperation(move, "cancel"), move, actor })
      throw error
    }
    plan.phase = "handed"
    await this.#write(plan)
    hostLog("continues", "a Thread continued in the cloud while this Mac was off was given up here", {
      move, thread, cloudThread: plan.cloudThread, phase: state.phase, by: state.by, sessions: plan.sessions.length, behind: plan.continued?.behind ?? false,
    })
    this.#reach(plan, "released")
    return this.#resume(plan, state)
  }

  /** A move stopped running here: nothing of it is held, and whoever lists it hears so, however it ended. */
  #ended(move: string): void {
    this.#running.delete(move)
    this.#leaving.delete(move)
    this.#joining.delete(move)
    this.#milestones.delete(move)
    this.#handed.delete(move)
    this.#options.ended?.(move)
  }

  async #move(conversationId: string, move: MoveId, handOff: ThreadHandOff | undefined): Promise<ThreadMoveOutcome> {
    const known = await this.#read(move).catch(() => undefined)
    if (known) this.#leaving.set(move, known.thread)
    if (known) return known.phase === "started" ? { kind: "moved", cloudThread: known.cloudThread, ...known.from && { conversation: known.asked } } : known.phase === "kept-here" ? { kind: "kept-here", reason: known.reason ?? "It stayed here." } : this.#resume(known)
    let plan: Plan
    const from = conversationId
    let stage = "plan"
    /** Turns paused before the Thread went onto its own branch: they go along, or on here if it stays. */
    const paused: Paused[] = []
    try {
      // A Thread in the main checkout goes onto its own branch first, taking only its own changes: the rest of the move
      // goes from there, and the main checkout is never the cloud's. Asked by the person, once nothing else would keep
      // it here. Handed off (a sleep, a shutdown, a quit), its turns are paused first and it goes as itself, never as a
      // fork: a handoff waits for no turn to end, and a fork would leave the paused turn behind.
      if (this.#options.ownBranch && !this.#options.checkout(conversationId)) {
        await this.#plan(conversationId, move, handOff, true, "later")
        const thread = this.#options.threads()?.journalPlacement(conversationId)?.thread
        if (handOff && thread) {
          stage = "pause"
          this.#options.step(conversationId, move, { kind: "pausing" })
          await this.#pauseTurns(this.#conversationsOf(thread, conversationId), thread, handOff, paused)
        }
        this.#options.step(conversationId, move, { kind: "own-branch" })
        stage = "own-branch"
        // A Mac going off moves in haste: the journal is waited for briefly, and the moved Sessions aren't resumed here.
        const haste = handOff?.releaseBy !== undefined ? { by: Math.min(Date.now() + HASTE_SETTLE_MS, handOff.releaseBy - RELEASE_TAKES_MS) } : undefined
        const going = await this.#options.ownBranch(conversationId, { asItself: handOff !== undefined, ...haste && { haste } })
        if (going !== conversationId) this.#options.step(conversationId, move, { kind: "own-branch", to: going })
        conversationId = going
        // A fork has no session of its harness's until its first turn, so there's nothing of it to carry yet.
        if (conversationId !== from && !this.#options.snapshot(conversationId)?.session.nativeId)
          throw new Error("It's on its own branch now, as a conversation forked from this one, which starts with its next message. Send it one, then move it to the cloud.")
      }
      stage = conversationId === from ? "plan" : "plan-on-branch"
      plan = await this.#plan(conversationId, move, handOff)
      if (conversationId !== from) plan.from = from
      if (plan.handingOff) plan.handingOff.paused.push(...paused)
      this.#leaving.set(move, plan.thread)
      // Kept ready while it worked: its records and checkout are there already, and only the last seconds go.
      stage = "standby"
      const ready = await this.#options.ready?.take(plan.thread, plan.folder, plan.repository).catch(() => undefined)
      if (ready) {
        plan.cloudThread = ready.cloudThread
        if (ready.checkpoint) plan.held = ready.checkpoint
        plan.timings.standby = 0
      }
    } catch (error) {
      const reason = errorMessage({ error })
      logMoveDiagnostic(() => hostWarn("moves", "a move stayed here before its plan was saved", { move, conversation: from, ...conversationId !== from && { currentConversation: conversationId }, stage, ...moveDiagnosticReason({ error }) }))
      const placed = this.#options.threads()?.journalPlacement(conversationId)
      await this.#stayed(move, placed?.thread, handOff, paused, [conversationId])
      this.#options.step(conversationId, move, { kind: "kept-here", reason, ...paused.length && { continued: true } })
      return { kind: "kept-here", reason }
    }
    await this.#write(plan)
    return this.#resume(plan)
  }

  /**
   * What a move carries, read before anything changes: refused, with the reason, when the Thread can't move. `checkout:
   * "later"`: weighed for a Thread in the main checkout before it goes onto its own branch: everything but its folder,
   * and nothing is planned.
   */
  async #plan(conversationId: string, move: MoveId, handOff: ThreadHandOff | undefined, weighHarnesses?: boolean, checkout?: "now"): Promise<Plan>
  async #plan(conversationId: string, move: MoveId, handOff: ThreadHandOff | undefined, weighHarnesses: boolean, checkout: "later"): Promise<Weighed>
  async #plan(conversationId: string, move: MoveId, handOff: ThreadHandOff | undefined, weighHarnesses = true, checkout: "now" | "later" = "now"): Promise<Plan | Weighed> {
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
    const own = this.#options.checkout(conversationId)
    if (checkout === "now" && !own)
      throw new Error(handOff && this.#options.ownBranch
        ? "A Thread in the project folder goes onto its own branch before it moves, once its turn has ended. Move it then."
        : "A Thread moves to the cloud from its own worktree. Move it into one first; the main checkout stays here.")
    // A project of several repositories: the cloud Thread is made at the first's worktree, which its machine clones,
    // and the machine clones the others beside it; each goes by its own checkpoint.
    const worktrees = [...own?.worktrees ?? []].sort((left, right) => left.path.localeCompare(right.path))
    const project = own && worktrees.length > 1 ? own.path : undefined
    const folder = project ? worktrees[0]?.path ?? "" : own?.path ?? this.#options.snapshot(conversationId)?.session.cwd ?? ""
    const sessions: PlanSession[] = []
    for (const moving of threads.threadSessions(placed.thread)) {
      const conversation = moving.journals.includes(conversationId) ? conversationId : moving.journals.at(-1)
      if (conversation !== conversationId && conversation && this.#options.archived?.(conversation)) continue
      const snapshot = conversation ? this.#options.snapshot(conversation) : null
      const { nativeId, nativePath, harness, cwd } = snapshot?.session ?? {}
      if (!conversation || !snapshot || !nativeId || !nativePath || !harness) throw new Error("Every tab in the Thread needs to have started before it moves: send a first message or close the empty tab.")
      const root = project ?? folder
      if (own && cwd !== root && !cwd?.startsWith(`${root}/`)) throw new Error(`A tab in this Thread works in ${cwd ?? "another folder"}, outside its worktree, so the Thread can't move.`)
      const remembered = this.#options.remembered(harness, nativeId)
      const planned: PlanSession = { session: moving.session, conversationId: conversation, harness, nativeId, path: nativePath }
      if (own && cwd && cwd !== folder) planned.cwd = cwd
      const modeId = remembered?.modeId ?? snapshot.session.currentMode ?? undefined
      if (modeId) planned.modeId = modeId
      if (remembered?.settings) planned.tuning = remembered.settings
      sessions.push(planned)
    }
    if (!sessions.length) throw new Error("This Thread has no sessions to move.")
    // Weighed before a Thread in the main checkout goes onto its own branch too: its repository must be one the cloud
    // clones. A project folder of several is weighed repository by repository once its worktree is made.
    const inRepository = await this.#options.git.succeeds(folder, ["rev-parse", "--show-toplevel"])
    const repository = own || inRepository ? await this.#options.repositoryOf(folder) : undefined
    const others = []
    for (const worktree of project ? worktrees.slice(1) : []) {
      const other = await this.#options.repositoryOf(worktree.path)
      others.push({ path: worktree.path, url: other.url, ...other.branch && { branch: other.branch } })
    }
    const check = weighHarnesses ? await this.#options.harnesses?.check(sessions) : undefined
    if (check?.kind === "known" && check.refusal) throw new Error(check.refusal)
    if (checkout === "later") return { thread: placed.thread, sessions }
    if (!repository) throw new Error("A Thread moves to the cloud from its own worktree. Move it into one first; the main checkout stays here.")
    const plan: Plan = { move, thread: placed.thread, asked: conversationId, cloudThread: this.#options.newCloudThread(), folder, repository, others, sessions, phase: "preparing", began: Date.now(), timings: {} }
    if (project) plan.project = project
    if (handOff) plan.handingOff = { why: handOff.why, ...handOff.releaseBy !== undefined && { releaseBy: handOff.releaseBy }, paused: [] }
    return plan
  }

  /** Carries a move on from wherever its plan stands. */
  async #resume(plan: Plan, continued?: ContinueState): Promise<ThreadMoveOutcome> {
    const step = (next: ThreadMoveStep) => this.#options.step(plan.asked, plan.move, next)
    if (plan.phase === "preparing") {
      step({ kind: "packing" })
      try {
        await this.#inTime(plan, () => this.#ahead(plan))
        if (plan.handingOff) {
          step({ kind: "pausing" })
          await this.#pause(plan)
        }
        await this.#release(plan)
      } catch (error) {
        return this.#keep(plan, errorMessage({ error }), false)
      }
    }
    // Let go of here: a caller that waits only for that hears it now, whether this host released it or a stopped one did.
    if (plan.phase !== "preparing") this.#reach(plan, "released")
    let answer: MoveAnswer | undefined
    if (plan.phase === "released") {
      step({ kind: "handing-over" })
      try {
        // A move a stopped host already handed over, or the cloud answered, goes on from there.
        answer = await this.#answered(plan)
        if (!answer) {
          // What only this Mac has goes first, a few files and lines at most: nothing runs the Thread now, so the
          // machine arrives with that and never with what went before the release. Then the cloud carries the rest.
          await Promise.all([
            named("Its worktree couldn't be sent after the release", this.#sendCheckout(plan)),
            named("Its sessions' records couldn't be sent after the release", this.#sendRecords(plan)),
          ])
          plan.timings.sent = Date.now() - plan.began
          await named("The cloud couldn't be handed the move", this.#handOver(plan))
          plan.phase = "handed"
          plan.timings.handed = Date.now() - plan.began
          await this.#write(plan)
        }
      } catch (error) {
        hostWarn("moves", "a released move couldn't be handed to the cloud", { move: plan.move, error: errorMessage({ error }), ...error instanceof Error && error.cause instanceof Error && { stack: error.cause.stack?.split("\n").slice(0, 6).join(" | ") ?? "" } })
        answer = await this.#refuse(plan, errorMessage({ error }))
        if (!answer) {
          const reason = `This Mac couldn't hand the Thread to the cloud: ${errorMessage({ error })}. It asks again; the Thread runs nowhere until it hears.`
          step({ kind: "unsettled", reason })
          return { kind: "unsettled", reason }
        }
      }
    }
    if (plan.phase === "handed" && !answer) {
      this.#reach(plan, "handed")
      step({ kind: "resuming", ...plan.continued && { whileAway: { behind: plan.continued.behind } } })
      answer = await this.#awaitAnswer(plan)
      if (!answer) {
        const reason = "The cloud carries this Thread through, and this Mac hasn't heard how it went yet. It asks again; the Thread runs nowhere until it hears."
        step({ kind: "unsettled", reason })
        return { kind: "unsettled", reason }
      }
    }
    if (answer) {
      if (answer.kind === "refused") return this.#keep(plan, answer.reason, true)
      this.#confirm(plan, answer)
      // A continue's start, the checkout the cloud began from, is known once its machine arrived.
      if (plan.continued && !plan.checkpoint) {
        const state = continued?.start ? continued : await this.#account().continueState?.(plan.sessions[0]!.session, plan.move).catch(() => undefined)
        if (state?.start) plan.checkpoint = state.start
      }
      plan.phase = "claimed"
      plan.timings.claimed = Date.now() - plan.began
      await this.#write(plan)
    }
    if (plan.phase === "claimed") {
      // The cloud starts each conversation and carries each paused turn on; this Mac follows them there.
      for (const session of plan.sessions)
        await this.#options.cloud.adopt({ conversationId: session.conversationId, threadId: plan.cloudThread, harness: session.harness, repository: plan.repository })
      // A continue was handed over by the account, before anything waited here: the turns this Mac paused as it went
      // off go on there, then what waits here now goes after them.
      if (plan.continued) {
        await named("The turns paused as this Mac went off couldn't be continued in the cloud", this.#sendParked(plan))
        await named("The messages typed here couldn't be sent to the cloud", this.#sendWaiting(plan))
      }
      plan.phase = "started"
      plan.timings.started = Date.now() - plan.began
      await this.#write(plan)
      hostLog("moves", "a Thread moved to the cloud", { move: plan.move, cloudThread: plan.cloudThread, sessions: plan.sessions.length, ...plan.timings })
    }
    const carried = carriedOf(plan)
    step({ kind: "moved", conversations: plan.sessions.map((session) => session.conversationId), ...plan.handingOff?.paused.length && { continued: true }, ...carried && { carried }, ...plan.continued && { whileAway: { behind: plan.continued.behind } } })
    return { kind: "moved", cloudThread: plan.cloudThread, ...plan.from && { conversation: plan.asked } }
  }

  /**
   * Everything that can go before the release: the cloud Thread made, the checkout and each Session's records sent,
   * and its machine up with the folder cloned (`mako:move-ready`). A machine that can't start (the cloud is full) or
   * can't clone keeps the Thread here, never released, rather than in transit until it can.
   */
  async #ahead(plan: Plan): Promise<void> {
    const account = this.#account()
    // Before the machine is made, so it starts with them; a failure is said, and the Thread moves without the newest.
    await this.#options.carried?.(plan.folder, "a move").catch((error: Error) => hostWarn("moves", "the project's carried files weren't brought up to date in the cloud", { move: plan.move, error: error.message }))
    plan.timings.carried = Date.now() - plan.began
    await account.createThread(plan.cloudThread, plan.repository, { folder: plan.folder, harness: plan.sessions[0]?.harness ?? "" })
    plan.timings.made = Date.now() - plan.began
    // A project of several repositories: the machine clones the others beside the first as it gets ready, so one it
    // can't clone keeps the Thread here. A machine from before carries takes none of these, and says so by refusing.
    const repositories = plan.others.map(({ path, url, branch }) => ({ path, url, ...branch && { branch } }))
    await Promise.all([
      named("Its worktree couldn't be sent ahead", this.#sendCheckout(plan)),
      named("Its sessions' records couldn't be sent ahead", this.#sendRecords(plan)),
      // Never queued: a cloud that can't start the machine now says so now, and the Thread stays here.
      named("Its cloud machine didn't get ready", this.#options.cloud.callThread(plan.cloudThread, "mako:move-ready", [{ folder: plan.folder, harnesses: [...new Set(plan.sessions.map((session) => session.harness))], launches: plan.sessions.map(({ harness, tuning }) => ({ harness, ...tuning && { tuning } })), ...repositories.length && { repositories } }], undefined, { refuseUnstarted: true }).then((answer) => {
        plan.takesCarry = ReadyAnswerSchema.safeParse(decodeRuntimeValue(answer)).data?.carry === true
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
    // Late, a Mac going off still pauses its turns, so nothing runs on it as it goes; the Thread stays (`#keep`).
    if (late() && !goesOff(handingOff)) throw new Error(TOO_LATE)
    await this.#pauseTurns(plan.sessions.map((session) => session.conversationId), plan.thread, handingOff, handingOff.paused, () => this.#write(plan))
    // Released only with time left for the hand-over; otherwise it stays, as `#keep` says.
    if (late()) throw new Error(TOO_LATE)
    plan.timings.paused = Date.now() - plan.began
  }

  /**
   * Each running turn of `conversations` paused, its waiting messages held, into `paused`; then the Thread waits to be
   * quiet, `PAUSE_SETTLES_MS` and to the handoff's deadline at most.
   */
  async #pauseTurns(conversations: readonly string[], thread: ThreadId, handOff: ThreadHandOff, paused: Paused[], saved?: () => Promise<void>): Promise<void> {
    for (const conversationId of conversations) {
      const each = await this.#options.live.handOff(conversationId)
      if (each && !paused.some((known) => known.requestId === each.requestId)) paused.push({ conversationId, ...each })
    }
    await saved?.()
    const until = Math.min(Date.now() + PAUSE_SETTLES_MS, handOff.releaseBy ?? Number.POSITIVE_INFINITY)
    for (;;) {
      const busy = await this.#options.moves.settledBlockers(thread, 0)
      if (!busy.length) return
      if (Date.now() >= until) throw new Error(`Its agents didn't pause in time: ${busy.join("; ")}.`)
      await new Promise((resolve) => setTimeout(resolve, PAUSE_LOOK_MS))
    }
  }

  /** The Thread's conversations a move takes: `asked` for its own Session, each other Session's newest, archived ones left. */
  #conversationsOf(thread: ThreadId, asked: string): string[] {
    return (this.#options.threads()?.threadSessions(thread) ?? []).flatMap((moving) => {
      const conversation = moving.journals.includes(asked) ? asked : moving.journals.at(-1)
      return conversation && (conversation === asked || !this.#options.archived?.(conversation)) ? [conversation] : []
    })
  }

  /**
   * `start`'s work, unless a Mac going off reaches its deadline first: then the move stays, and nothing starts once
   * it's past. What went ahead goes on by itself, and a cloud Thread it makes, this move's alone, is refused once it's
   * there, so the cloud ends its machine.
   */
  async #inTime(plan: Plan, start: () => Promise<void>): Promise<void> {
    const releaseBy = plan.handingOff?.releaseBy
    if (!goesOff(plan.handingOff) || releaseBy === undefined) return start()
    if (Date.now() >= releaseBy - RELEASE_TAKES_MS) throw new Error(TOO_LATE)
    const work = start()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), Math.max(0, releaseBy - RELEASE_TAKES_MS - Date.now())) })
    try {
      if ((await Promise.race([work.then(() => "done" as const), late])) === "done") return
    } finally {
      clearTimeout(timer)
    }
    void work.then(() => this.#refuse(plan, TOO_LATE)).catch(() => undefined)
    throw new Error(TOO_LATE)
  }

  /**
   * Hands the move to the cloud to carry through (`MoveHandOverRequest`): the claim, and every operation this Mac
   * would otherwise send itself, encoded as it would send them under ids of the move's, so a repeat reaches the same
   * end. In order: the machine's arrival (the checkout applied, each Session written and opened there before the
   * claim, so a harness that can't start on the machine refuses the move); each conversation started; each turn the
   * handoff paused continued as Mako's; and every message that waited here, sent under its own id and marked here as
   * gone with the Thread.
   */
  async #handOver(plan: Plan): Promise<void> {
    const checkpoint: MoveCheckpoint | undefined = plan.checkpoint
    if (!checkpoint) throw new Error("The move has no checkpoint to carry.")
    const account = this.#account()
    const deviceId = await account.deviceId()
    if (!deviceId) throw new Error("This Mac isn't signed in to Mako.")
    const calls: Array<{ channel: string; args: unknown[]; key: string }> = []
    const sessions = plan.sessions.map(({ harness, nativeId, holdings, conversationId, cwd, modeId, tuning }) => ({
      harness, nativeId, ...holdings && { holdings },
      open: { conversationId, ...cwd !== undefined && { cwd }, ...modeId !== undefined && { modeId }, ...tuning !== undefined && { tuning } },
    }))
    // With the handoff: the machine's store files the Thread under the same IDs as this Mac's. With the carry, to a
    // machine that takes one: the Thread's other repositories, its files outside its folder and its file history.
    const carry = plan.takesCarry ? plan.carry?.ref : undefined
    calls.push({ channel: "mako:move-arrive", args: [{ move: plan.move, folder: plan.folder, checkpoint, sessions, ...plan.handoff && { handoff: plan.handoff }, ...carry && { carry } }], key: "arrive" })
    for (const session of plan.sessions) {
      const options: LiveStartOptions = { conversationId: session.conversationId, resume: session.nativeId }
      if (session.modeId) options.modeId = session.modeId
      if (session.tuning) options.tuning = session.tuning
      calls.push({ channel: "mako:live-start", args: [session.harness, session.cwd ?? plan.folder, options], key: `start\0${session.conversationId}` })
    }
    for (const { conversationId, requestId, stopped } of plan.handingOff?.paused ?? [])
      calls.push({ channel: "mako:live-continue-turn", args: [conversationId, namedUuid(`mako move\0${plan.move}\0${requestId}\0continue`), { reason: "handed-off", continues: requestId, ...stopped.length && { stopped } }], key: `continue\0${requestId}` })
    const carried = new Map<string, string[]>()
    for (const { conversationId } of plan.sessions) {
      const waiting = this.#options.live.waitingPrompts(conversationId)
      for (const prompt of waiting)
        calls.push({ channel: "mako:live-prompt", args: [conversationId, prompt.id, prompt.text, await inlined(prompt.attachments), prompt.tuning], key: `prompt\0${prompt.id}` })
      if (waiting.length) carried.set(conversationId, waiting.map((prompt) => prompt.id))
    }
    const actor = { kind: "client" as const, client: "desktop" as const, deviceId }
    const operations = calls.map(({ channel, args, key }) => {
      const id = namedUuid(`mako move\0${plan.move}\0${key}`)
      return encodeOperation(toHostOperation(channel, hostCallInput(args, false), { id, target: { kind: "thread", threadId: plan.cloudThread }, actor, correlationId: namedUuid(`mako move\0${plan.move}\0correlation`), attempt: 1 }))
    })
    const state = await account.handOverMove(plan.cloudThread, plan.move, { claim: this.#claimRequest(plan), operations })
    for (const [conversationId, ids] of carried) {
      this.#options.live.carried(conversationId, ids, "cloud")
      hostLog("moves", "messages waiting here went with the Thread", { move: plan.move, conversation: conversationId, messages: ids.length })
    }
    hostLog("moves", "a move was handed to the cloud to carry through", { move: plan.move, cloudThread: plan.cloudThread, operations: operations.length, phase: state.phase })
  }

  /**
   * A joined continue's messages waiting here: typed as this Mac came back, before it heard the account, and held
   * since (`joining`). Each goes to the cloud Thread under its own ID, which runs it once however often it arrives, as
   * a message the account handed over too; then it's marked here as gone with the Thread. One that can't be sent
   * leaves the move claimed, and the next join or settle sends it.
   */
  async #sendWaiting(plan: Plan): Promise<void> {
    for (const { conversationId } of plan.sessions) {
      const waiting = this.#options.live.waitingPrompts(conversationId)
      if (!waiting.length) continue
      for (const prompt of waiting)
        await this.#options.cloud.callThread(plan.cloudThread, "mako:live-prompt", [conversationId, prompt.id, prompt.text, await inlined(prompt.attachments), prompt.tuning], conversationId)
      this.#options.live.carried(conversationId, waiting.map((prompt) => prompt.id), "cloud")
      hostLog("continues", "messages typed here as this Mac came back went to the cloud with the Thread", { move: plan.move, cloudThread: plan.cloudThread, conversation: conversationId, requests: waiting.map((prompt) => prompt.id).join(",") })
    }
  }

  /**
   * The cloud's answer to a move it carries through, waited for at the cloud a few seconds at a time: a claim once its
   * machine took the Thread, or a refusal. Undefined if none came while this host waited (it asks again when it
   * settles its moves); a Mac that sleeps meanwhile asks again as it wakes.
   */
  async #awaitAnswer(plan: Plan): Promise<MoveAnswer | undefined> {
    const until = Date.now() + ANSWER_WAIT_MS
    for (let attempt = 0; Date.now() < until; attempt++) {
      try {
        const answer = await this.#account().moveAnswer(plan.cloudThread, plan.move, MOVE_ANSWER_WAIT_MS)
        if (answer) return answer
      } catch (error) {
        hostWarn("moves", "the cloud's answer to a move it carries couldn't be read yet; asking again", { move: plan.move, attempt, error: errorMessage({ error }) })
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
      }
    }
    return undefined
  }

  /** A move reached a milestone: whoever waits only for that hears it now. */
  #reach(plan: Plan, milestone: Milestone): void {
    if (milestone === "handed") this.#handed.add(plan.move)
    this.#milestones.get(plan.move)?.[milestone].resolve(plan.cloudThread)
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

  /**
   * The Thread's checkout as it stands: each repository's checkpoint, sent unless the cloud has it, then the carry
   * naming them all with the files outside its folder and its file history. Sent ahead and again after the release; a
   * part that hasn't changed is the same bytes, which the cloud has already.
   */
  async #sendCheckout(plan: Plan): Promise<void> {
    await mkdir(this.#options.folder, { recursive: true })
    const scratch = await mkdtemp(join(this.#options.folder, `${plan.move}-`))
    // While it goes ahead, how much of it has gone is said with the packing step; after the release, nothing is.
    const progress = plan.phase === "preparing" ? new SentProgress((sent) => this.#options.step(plan.asked, plan.move, { kind: "packing", sent })) : undefined
    try {
      const account = this.#account()
      const send = (checkpoint: Pick<MoveCheckpoint, "sha256" | "bytes">, file: string) => account.sendCheckpoint(plan.cloudThread, checkpoint, file, progress?.adding(checkpoint.bytes))
      const repositories: MoveCarryRepository[] = []
      for (const [at, path] of [plan.folder, ...plan.others.map((other) => other.path)].entries()) {
        const { checkpoint, file } = await captureMoveCheckpoint(this.#options.git, path, await mkdtemp(join(scratch, "checkout-")))
        const other = at === 0 ? undefined : plan.others[at - 1]
        if (other) {
          if (checkpoint.sha256 !== other.checkpoint?.sha256) await send(checkpoint, file)
          other.checkpoint = checkpoint
        } else {
          if (checkpoint.sha256 !== plan.held) await send(checkpoint, file)
          plan.held = checkpoint.sha256
          plan.checkpoint = checkpoint
        }
        repositories.push({ path, ...other && { url: other.url }, ...other?.branch && { branch: other.branch }, checkpoint })
      }
      const { read, left } = await readOutside(this.#options.outside?.(plan.thread) ?? [], plan.project ?? plan.folder)
      const history = this.#options.history?.(plan.thread)
      const carry = await captureCarry(this.#options.git, { folder: plan.project ?? plan.folder, repositories, outside: read, left, ...history && { history } }, scratch)
      if (carry.ref.sha256 !== plan.carry?.ref.sha256) await send(carry.ref, carry.file)
      progress?.done()
      plan.carry = { ref: carry.ref, manifest: carry.carry }
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
      sessions: sent.map((each) => `${each.harness}: ${each.chunks} chunks, ${describeSync(each)}`).join("; "),
    })
    for (const session of plan.sessions) {
      const went = sent.find((each) => each.harness === session.harness && each.nativeId === session.nativeId)
      if (went) session.holdings = went.holdings
    }
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
    const paused = plan.handingOff?.paused ?? []
    await this.#stayed(plan.move, plan.thread, plan.handingOff, paused, plan.sessions.map((session) => session.conversationId))
    // A continue the cloud refused leaves the Thread here: what it paused as this Mac went off goes on here now.
    if (plan.continued) await this.#goOnHere((turn) => turn.thread === plan.thread)
    plan.phase = "kept-here"
    plan.reason = reason
    await this.#write(plan)
    hostLog("moves", "a Thread stayed here", { move: plan.move, released, reason, continued: paused.length })
    this.#options.step(plan.asked, plan.move, { kind: "kept-here", reason, ...paused.length && { continued: true } })
    return { kind: "kept-here", reason }
  }

  /**
   * A move that may have paused turns stayed here. A Mac going off parks them, pausing any turn of the Thread still
   * running too, so the Thread reads idle while the Mac is off and Continue in the cloud from another device can take
   * it; they go on here once this Mac hears its account again (`unpark`). Otherwise each goes on here now.
   */
  async #stayed(move: string, thread: string | undefined, handOff: ThreadHandOff | undefined, paused: Paused[], conversations: readonly string[]): Promise<void> {
    if (goesOff(handOff) && thread) {
      for (const conversationId of conversations) {
        const each = await this.#options.live.handOff(conversationId).catch((error: Error) => {
          hostWarn("moves", "a turn couldn't be paused as this Mac went off", { move, conversation: conversationId, error: error.message })
          return undefined
        })
        if (each && !paused.some((known) => known.requestId === each.requestId)) paused.push({ conversationId, ...each })
      }
      if (!paused.length) return
      const at = Date.now()
      await this.#changeParked((parked) => [...parked.filter((known) => !paused.some((turn) => turn.requestId === known.requestId)), ...paused.map((turn) => ({ move, thread, ...turn, at }))])
        .catch((error: Error) => hostWarn("moves", "the turns paused as this Mac went off couldn't be kept; they wait for Continue turn", { move, error: error.message }))
      hostLog("moves", "turns paused as this Mac went off wait for it to be back, or for Continue in the cloud", { move, thread, turns: paused.length })
      return
    }
    for (const turn of paused) this.#continueHere(move, turn)
  }

  /** A turn a handoff paused goes on here, as Mako's: nothing of it was lost, and nothing waits for the person. */
  #continueHere(move: string, { conversationId, requestId, stopped }: Paused): void {
    try {
      this.#options.live.continueTurn(conversationId, { requestId: namedUuid(`mako move\0${move}\0${requestId}\0continue-here`), reason: "handed-off", continues: requestId, stopped, stayed: true, actor: { kind: "service", name: "handoff" } })
    } catch (error) {
      hostWarn("moves", "a turn the handoff paused couldn't continue here", { move, conversation: conversationId, error: errorMessage({ error }) })
    }
  }

  /**
   * This Mac heard its account again (`OwnerCheck`): each turn parked as it went off goes on here, if its Thread is
   * still here and not on its way. One the account continued in the cloud meanwhile goes there with the continue this
   * Mac joins (`#sendParked`).
   */
  async unpark(): Promise<void> {
    const threads = this.#options.threads()
    if (!threads) return
    const here = (thread: string) => {
      const id = ThreadIdSchema.safeParse(thread)
      return id.success && !this.leaving(thread) &&
        threads.threadSessions(id.data).every(({ session }) => (threads.execution(session)?.state ?? "here") === "here" && !this.joining(session) && this.#options.awayHeld?.(session) === undefined)
    }
    await this.#goOnHere((turn) => here(turn.thread))
  }

  /** Each parked turn `taken` names goes on here, as Mako's, and is parked no more. */
  async #goOnHere(taken: (turn: Parked) => boolean): Promise<void> {
    const going: Parked[] = []
    await this.#changeParked((parked) => parked.filter((turn) => {
      if (!taken(turn)) return true
      going.push(turn)
      return false
    }))
    for (const turn of going) this.#continueHere(turn.move, turn)
    if (going.length) hostLog("moves", "turns paused as this Mac went off go on here", { turns: going.length })
  }

  /** The turns this Mac parked for the Thread a joined continue took: each continued in the cloud, as a handoff's is. */
  async #sendParked(plan: Plan): Promise<void> {
    const mine = (await this.#parkedTurns()).filter((turn) => turn.thread === plan.thread)
    if (!mine.length) return
    for (const { move, conversationId, requestId, stopped } of mine)
      await this.#options.cloud.callThread(plan.cloudThread, "mako:live-continue-turn", [conversationId, parkedContinuation(move, requestId), { reason: "handed-off", continues: requestId, ...stopped.length && { stopped } }], conversationId)
    await this.#changeParked((parked) => parked.filter((turn) => turn.thread !== plan.thread))
    hostLog("continues", "turns paused as this Mac went off go on in the cloud with the Thread", { move: plan.move, cloudThread: plan.cloudThread, turns: mine.length })
  }

  async #parkedTurns(): Promise<Parked[]> {
    const read = ParkedSchema.safeParse(JSON.parse(await readFile(join(this.#options.folder, "parked-turns"), "utf8").catch(() => "null")))
    return read.success ? read.data.turns : []
  }

  /** Changes the parked turns, one change at a time, each written whole: `<moves folder>/parked-turns`. */
  #changeParked(change: (turns: Parked[]) => Parked[]): Promise<void> {
    const write = this.#parking.then(async () => {
      const turns = change(await this.#parkedTurns()).filter((turn) => Date.now() - turn.at < PARKED_KEPT_MS)
      await mkdir(this.#options.folder, { recursive: true })
      const file = join(this.#options.folder, "parked-turns")
      await writeFile(`${file}.tmp`, JSON.stringify(ParkedSchema.parse({ version: 1, turns })))
      await rename(`${file}.tmp`, file)
    })
    this.#parking = write.catch(() => undefined)
    return write
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
