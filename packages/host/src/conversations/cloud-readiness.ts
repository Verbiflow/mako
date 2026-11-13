import { autoContinueOp, type QuietNote } from "@mako/protocol/handoff"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema, type MoveCheckpoint } from "@mako/protocol/moves"
import type { QuietRepository } from "@mako/protocol/handoff"
import { withFreshLink, type RecordsLink, type SentRecords } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, type CloudRepository } from "../contracts/cloud-threads.js"
import type { CloudAccount } from "../usage/index.js"
import { captureMoveCheckpoint, captureThreadCheckpoint, threadFingerprint, type ThreadCheckpointInput } from "../workspaces/index.js"
import type { WorkingThread } from "./cloud-handoffs.js"

/** How often a Thread at work is brought up to date in its cloud Thread standing by. */
export const READY_EVERY_MS = 30_000
/** Threads brought up to date at once; the rest wait their turn within the same refresh. */
const ROUNDS_AT_ONCE = 2
/** After a move takes a Thread's cloud Thread, it isn't kept ready again for this long: it's leaving, or it stayed. */
const TAKEN_REST_MS = 5 * 60_000
/** A Thread standing by that nothing has used or brought up to date for this long is forgotten here. */
const READY_KEPT_MS = 7 * 24 * 60 * 60_000
/**
 * A move takes a Thread standing by only if a round brought it up to date this recently. The cloud ends one its device
 * stopped keeping ready after half an hour (a Thread at work is kept ready every `READY_EVERY_MS`), so a move never
 * takes one that ended: an older one is left, and the move makes its own.
 */
const READY_FRESH_MS = 20 * 60_000
/**
 * A Thread whose conversation hasn't moved since its last round is passed over (`revision`): its checkout capture, its
 * cloud Thread's renewal and its records' send would each find what they sent last. It's brought up anyway once its
 * last round is this old, so the cloud Thread standing by stays well inside `READY_FRESH_MS`, and a checkout changed
 * from outside the conversation is sent within it. A move still sends its own last seconds.
 */
const STILL_KEPT_MS = 5 * 60_000
/** A Thread's checkpoint is taken this long after a tool call of its that wrote, so a burst of edits makes one. */
export const CAPTURE_AFTER_WRITE_MS = 5_000
/** While its turn runs, a Thread's checkpoint is taken at most this often; its turn's end takes one at once. */
export const CAPTURE_EVERY_MS = 30_000

/**
 * A Thread's changes in one repository of the main checkout, as the cloud acknowledged them: the cloud keeps the
 * bundle by its hash on the cloud Thread standing by, and this is what a going-away names for the cloud to continue
 * from. `unpushed` commits ride in the bundle, and whatever shows it to the person says how many.
 */
const AcknowledgedSchema = z.object({
  root: z.string(),
  checkpoint: MoveCheckpointSchema,
  unpushed: z.number().int().nonnegative(),
  left: z.array(z.object({ path: z.string(), why: z.string() })),
  /** Each file the checkpoint holds of the Thread's, by content address, null for one it deleted (`ThreadCheckpoint.versions`). */
  versions: z.array(z.object({ path: z.string(), ref: z.string().nullable() })).optional(),
  /** Where it sits in the Thread's folder, as the machine lays it out, and its GitHub repository: a going-away names the others so. */
  folder: z.string().optional(),
  url: z.string().optional(),
  at: z.number(),
})
export type Acknowledged = z.infer<typeof AcknowledgedSchema>

/** A going-away note's word on one Thread, as `CloudReadiness.noted` keeps it. */
const NotedSchema = z.object({ note: z.string(), sessions: z.array(z.object({ session: z.string(), generation: z.number().int() })), sha256: z.array(z.string()) })
type Noted = z.infer<typeof NotedSchema>
/** How many going-away notes a Thread keeps the word of: a continue comes from one of the last few, or from none. */
const NOTES_KEPT = 8

const ReadyEntrySchema = z.object({
  cloudThread: z.string(),
  folder: z.string(),
  repository: CloudRepositorySchema,
  /** The checkout as last sent, by its checkpoint's hash: sent again only when it changed. */
  checkpoint: z.string().optional(),
  /** That checkpoint whole, as a going-away names it for the cloud to apply (`noteCheckpoint`). */
  sent: MoveCheckpointSchema.optional(),
  /** A Thread in the main checkout: its own changes, one per repository, as the cloud last acknowledged them. */
  acknowledged: z.array(AcknowledgedSchema).optional(),
  /**
   * Each going-away note's word on this Thread, newest last (`NOTES_KEPT` at most): the note, the Sessions it named at
   * their generations, and each checkpoint it carried, by hash. The way back reads the one the account's continue came
   * from (`continuedFrom`), whose op names it: only what that note carried may leave the project folder. A build before
   * kept the latest alone, without its Sessions; no continue can be matched to that, so it counts as none.
   */
  noted: z.union([z.array(NotedSchema), z.object({ note: z.string(), sha256: z.array(z.string()) })]).optional(),
  /** A project folder's Thread: its project worktree, where its Sessions open on the machine (`noteProject`). */
  project: z.string().optional(),
  /** With `project`: the folder of this Mac's it mirrors (`noteProject`). */
  projectFrom: z.string().optional(),
  at: z.number(),
})
type ReadyEntry = z.infer<typeof ReadyEntrySchema>
const ReadyFileSchema = z.object({ version: z.literal(1), threads: z.record(z.string(), ReadyEntrySchema) })

/** What keeping a Thread ready asks of the account: a cloud Thread standing by, its checkpoints and its records. */
export type ReadinessAccount = Pick<CloudAccount, "createThread" | "sendCheckpoint" | "threadRecords">

/** A Thread's recorded notes; a build before kept one without its Sessions, which no continue can be matched to. */
function notesOf(entry: { noted?: Noted[] | { note: string; sha256: string[] } }): Noted[] {
  return Array.isArray(entry.noted) ? entry.noted : []
}

/** The note a continue of `thread` came from: the one whose op (`autoContinueOp`) is the continue's. */
async function continuedFrom(thread: string, notes: readonly Noted[], op: string): Promise<Noted | undefined> {
  for (const each of notes) if ((await autoContinueOp(thread, each.sessions, each.note)) === op) return each
  return undefined
}

/** As the cloud weighs them: a cloud Thread is made for one repository and one branch, and refuses any other. */
const sameRepository = (left: CloudRepository, right: CloudRepository) => left.url === right.url && left.branch === right.branch

/** A cloud Thread kept ready, as a move takes it: and the checkpoint the cloud keeps for it, by its hash. */
export type TakenReady = { cloudThread: string; checkpoint?: string }

/** What a move of a Thread would carry, read as its plan reads it: refused when it couldn't move. */
/** `planned`: a Thread in the main checkout, kept ready at the worktree its move would make, which isn't there yet. */
/** `repositories`: with `planned`, the main checkout's repositories it works in and the branch its move would make. */
export type ReadyPlan = {
  thread: string
  folder: string
  repository: CloudRepository
  paths: string[]
  harness: string
  planned?: true
  repositories?: { root: string; branch: string; folder?: string; url?: string }[]
  /** A project folder of several repositories: its project worktree, around `folder` (the first one's), where its Sessions work. */
  project?: string
  /** With `project`: the folder of this Mac's it mirrors, where the Thread's Sessions work now (the project folder, or that very worktree). */
  projectFrom?: string
}

/**
 * The record of changes as readiness reads it. The host's: `heard` and `settled` are both the journal's `heard` (what
 * a turn's count waits for, never rescans), and `partition` is read on a worker (`partitionOffLoop`).
 */
export type ReadinessLedger = ThreadCheckpointInput["ledger"] & {
  /** Every change heard so far journaled. */
  heard(): Promise<void>
}

/** How long a turn's end waits for the journal to have heard its last writes before it captures anyway. */
const END_HEARD_MS = 3_000
/** A round a write or a turn's end asked for that failed is tried again this long after, at most this many times. */
const RETRY_MS = 5_000
const RETRIES = 3

/** What started a round: a write (or the next one due), its turn's end, or the job that keeps the cloud Thread fresh. */
type RoundCause = "write" | "end" | "refresh"

export type CloudReadinessOptions = {
  /** Where each local Thread's cloud Thread standing by is remembered: `<data root>/cloud/ready.json`. */
  file: string
  git: Git
  /** A folder of this host's own for checkpoints while they're made. */
  scratch: string
  account(): ReadinessAccount | undefined
  /** Whether Threads at work are kept ready: the person lets them be handed off as this Mac sleeps, and it can. */
  enabled(): Promise<boolean>
  /** This Mac's Threads at work now. */
  working(): WorkingThread[]
  /** Where a conversation stands (its live revision), or undefined when unknown: a round runs whenever it moved. */
  revision?(conversationId: string): number | undefined
  /** Whether a move of the Thread runs now: one on its way isn't kept ready (`CloudMoves.leaving`). */
  leaving(thread: string): boolean
  /** What a move of the Thread of `conversationId` would carry; throws, saying why, when it couldn't move. */
  plan(conversationId: string): Promise<ReadyPlan>
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  newCloudThread(): string
  /** The record of changes, which a Thread in the main checkout's checkpoint is divided by; undefined until it opens. */
  ledger?(): ReadinessLedger | undefined
  /** A Thread's checkpoint in one repository: `captureThreadCheckpoint`, which a test replaces. */
  capture?(input: ThreadCheckpointInput): ReturnType<typeof captureThreadCheckpoint>
  /** `CAPTURE_AFTER_WRITE_MS` and `CAPTURE_EVERY_MS`, shorter in a test. */
  timing?: { afterWriteMs: number; everyMs: number; retryMs?: number }
}

/**
 * Keeping this Mac's Threads at work ready to move (rule 3 of moves): while a Thread works here and could be handed
 * to the cloud, a cloud Thread stands by for it (made with `standby`: no machine until a move's first call), and its
 * checkout and its sessions' records are sent there as they change, every `READY_EVERY_MS`, only what changed. A move
 * then takes that cloud Thread (`take`) and sends only the last seconds, so a handoff as the lid closes fits in the
 * moments macOS gives. A cloud Thread a move took isn't kept ready again: the next Thread to stand by is a new one. A
 * Thread in the main checkout stands by at the worktree its move would make (`ReadyPlan.planned`), its checkout sent by
 * the move once that's there.
 * Only while the person lets agents be handed off as this Mac sleeps: nothing of a Thread goes to the cloud otherwise.
 *
 * A Thread in the main checkout also sends its own changes as they're made (`captureThreadCheckpoint`, one per
 * repository): `CAPTURE_AFTER_WRITE_MS` after a tool call of its that wrote (`wrote`), at most every
 * `CAPTURE_EVERY_MS` while its turn runs, and at once at its turn's end (`settled`). One round runs at a time per
 * Thread, and a change while it runs makes one more after it. A capture whose `threadFingerprint` matches the last is
 * skipped, and one whose checkpoint the cloud acknowledged already isn't sent again. What the cloud acknowledged is kept
 * (`acknowledged`); a failed send leaves the last acknowledged one, and the next write or end tries again.
 */
export class CloudReadiness {
  readonly #options: CloudReadinessOptions
  #entries: Record<string, ReadyEntry> | undefined
  /** Writes, one at a time: rounds for several Threads save as they finish. */
  #saving: Promise<void> = Promise.resolve()
  /** By local Thread: a round bringing it up to date, which `take` waits for. */
  readonly #rounds = new Map<string, Promise<void>>()
  /** By local Thread: why it couldn't be kept ready, said once until it changes. */
  readonly #said = new Map<string, string>()
  /** By local Thread: when a move took its cloud Thread. */
  readonly #taken = new Map<string, number>()
  /** By local Thread: the conversation and its revision its last round brought up, and when. */
  readonly #broughtUp = new Map<string, { conversationId: string; revision: number; at: number }>()
  /** By local Thread: a round asked for while one ran, run once it ends (the strongest cause asked). */
  readonly #again = new Map<string, { working: WorkingThread; cause: RoundCause }>()
  /** By conversation: a Thread whose turn wrote, until its turn's end takes its last checkpoint. */
  readonly #writing = new Map<string, WorkingThread>()
  /** By local Thread: the capture due after a write. */
  readonly #due = new Map<string, ReturnType<typeof setTimeout>>()
  /** By local Thread: when its checkpoint was last captured, and what the journal read then (`threadFingerprint`). */
  readonly #captured = new Map<string, { at: number; fingerprints: Map<string, string> }>()
  /** By local Thread: tries again of a round a write or a turn's end asked for that failed. */
  readonly #retries = new Map<string, { count: number; timer?: ReturnType<typeof setTimeout> }>()
  /** File work under way (scratch folders, the worktree's checkpoint, the ready file), which `ioSettled` waits out. */
  readonly #io = new Set<Promise<unknown>>()

  constructor(options: CloudReadinessOptions) {
    this.#options = options
  }

  /** Brings every Thread at work up to date in its cloud Thread standing by, one round each. */
  async refresh(): Promise<void> {
    if (!(await this.#options.enabled())) return
    const resting = (thread: string) => this.#options.leaving(thread) || Date.now() - (this.#taken.get(thread) ?? Number.NEGATIVE_INFINITY) < TAKEN_REST_MS
    // Each round captures its checkout through Git (an `add --all` of the whole worktree) and sends its records
    // through the sync daemon: with every Thread at work at once, a Mac of many Fins ran hundreds of them together.
    const due = this.#options.working().filter((working) => !resting(working.thread) && this.#moved(working)).values()
    await Promise.all(Array.from({ length: ROUNDS_AT_ONCE }, async () => {
      for (const working of due) await this.#round(working, "refresh")
    }))
    await this.#prune()
  }

  /**
   * The cloud Thread standing by for `thread`, for a move of it to take, when it stands by for the same folder and
   * repository: once taken, it's this move's alone, with the hash of the checkpoint last sent for it, which the cloud
   * keeps already. Waits for a round still sending to it.
   */
  async take(thread: string, folder: string, repository: CloudRepository): Promise<TakenReady | undefined> {
    await this.#rounds.get(thread)?.catch(() => undefined)
    const entries = await this.#load()
    const entry = entries[thread]
    if (!entry) return undefined
    if (entry.folder !== folder || !sameRepository(entry.repository, repository)) {
      hostLog("readiness", "a move didn't take a cloud Thread standing by for another folder or branch", { thread, cloudThread: entry.cloudThread, folderMoved: entry.folder !== folder, stoodBy: entry.repository.branch ?? "its default", moves: repository.branch ?? "its default" })
      return undefined
    }
    if (Date.now() - entry.at > READY_FRESH_MS) {
      // Not kept ready lately (the Mac slept, or the Thread rested): the cloud may have ended it. Forgotten here.
      delete entries[thread]
      await this.#save()
      hostLog("readiness", "a move didn't take a cloud Thread not kept ready lately", { thread, cloudThread: entry.cloudThread, staleMs: Date.now() - entry.at })
      return undefined
    }
    this.#taken.set(thread, Date.now())
    this.#broughtUp.delete(thread)
    this.#forget(thread)
    delete entries[thread]
    await this.#save()
    hostLog("readiness", "a move takes the cloud Thread kept ready for it", { thread, cloudThread: entry.cloudThread, readyForMs: Date.now() - entry.at })
    return { cloudThread: entry.cloudThread, ...entry.checkpoint && { checkpoint: entry.checkpoint } }
  }

  /**
   * A tool call of `conversationId`'s that may have written finished: its Thread's checkpoint is taken
   * `CAPTURE_AFTER_WRITE_MS` from now, or `CAPTURE_EVERY_MS` after its last, whichever is later. One already due stays.
   */
  wrote(conversationId: string): void {
    const working = this.#options.working().find((each) => each.conversationId === conversationId)
    if (!working || this.#options.leaving(working.thread)) return
    this.#writing.set(conversationId, working)
    if (this.#due.has(working.thread)) return
    const { afterWriteMs, everyMs } = this.#options.timing ?? { afterWriteMs: CAPTURE_AFTER_WRITE_MS, everyMs: CAPTURE_EVERY_MS }
    const last = this.#captured.get(working.thread)?.at ?? Number.NEGATIVE_INFINITY
    const wait = Math.max(afterWriteMs, last + everyMs - Date.now())
    const timer = setTimeout(() => {
      this.#due.delete(working.thread)
      void this.#whenEnabled(working, "write")
    }, wait)
    timer.unref?.()
    this.#due.set(working.thread, timer)
  }

  /** A conversation changed (its turn may have ended): a Thread whose turn wrote and no longer works takes its checkpoint now. */
  settled(conversationId: string): void {
    const working = this.#writing.get(conversationId)
    if (!working || this.#options.working().some((each) => each.conversationId === conversationId)) return
    this.#writing.delete(conversationId)
    clearTimeout(this.#due.get(working.thread))
    this.#due.delete(working.thread)
    void this.#whenEnabled(working, "end")
  }

  /**
   * As this Mac goes away: each Thread's last changes captured and sent (a turn's end's round, one running joined), and
   * waited for until `by` at most. Whatever isn't acknowledged by then, the cloud continues without: it never waits.
   */
  async flush(working: readonly WorkingThread[], by: number): Promise<void> {
    if (!working.length) return
    for (const each of working) this.#forgetTimers(each.thread)
    // A round running already takes the end after it (`#again`): waited for too.
    const through = async (each: WorkingThread) => {
      await this.#whenEnabled(each, "end")
      for (let round = this.#rounds.get(each.thread); round; round = this.#rounds.get(each.thread)) await round.catch(() => undefined)
    }
    await waitAtMost(Promise.all(working.map(through)), Math.max(0, by - Date.now()))
  }

  /**
   * The checkpoint a going-away names for `thread`: the last the cloud acknowledged, on the cloud Thread standing by
   * where it went. A Thread in the main checkout names its first repository's, which its cloud Thread is made for.
   */
  async noteCheckpoint(thread: string): Promise<(MoveCheckpoint & { standby: string }) | undefined> {
    const entry = (await this.#load())[thread]
    if (!entry) return undefined
    // A worktree's whole checkout, or a Thread in the main checkout's own changes in its first repository.
    // Only ever one the cloud acknowledged: each is kept the moment its send answered, never before.
    const whole = entry.acknowledged?.[0]?.checkpoint ?? (entry.sent?.sha256 === entry.checkpoint ? entry.sent : undefined)
    return whole && { ...whole, standby: entry.cloudThread }
  }

  /**
   * The other repositories a going-away names for a Thread in a project folder: each but the first with the checkpoint
   * the cloud acknowledged of it, where it sits in the Thread's folder and its GitHub repository. One without a place or
   * a GitHub repository can't be laid out on a machine, so it isn't named; its changes stay here.
   */
  async noteOthers(thread: string): Promise<QuietRepository[]> {
    const entry = (await this.#load())[thread]
    return (entry?.acknowledged ?? []).slice(1).flatMap((each) => {
      const url = each.url && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(each.url) ? each.url : undefined
      return each.folder && url ? [{ path: each.folder, url, ...each.checkpoint.branch && { branch: each.checkpoint.branch }, checkpoint: each.checkpoint }] : []
    })
  }

  /**
   * Where a going-away says `thread`'s Sessions open on the machine, when that isn't its standby's folder: a project
   * folder's project worktree, around the first repository's worktree its standby holds. Only beside a standby.
   */
  async noteProject(thread: string): Promise<string | undefined> {
    return (await this.#load())[thread]?.project
  }

  /** The folder of this Mac's `thread`'s project worktree mirrors (`noteProject`): each Session goes by its path from there. */
  async noteProjectFrom(thread: string): Promise<string | undefined> {
    const entry = (await this.#load())[thread]
    return entry?.project ? entry.projectFrom : undefined
  }

  /**
   * What the cloud acknowledged of a Thread in the main checkout, by repository, for its going-away to name; with `op`,
   * a continue the account made of it, the checkpoints the note that continue came from carried (`noted`), and none
   * when no note recorded here names it (a press, a note refused, one long gone).
   */
  async acknowledged(thread: string, op?: string): Promise<{ cloudThread: string; acknowledged: Acknowledged[]; noted?: string[] } | undefined> {
    await this.#rounds.get(thread)?.catch(() => undefined)
    const entry = (await this.#load())[thread]
    if (!entry?.acknowledged?.length) return undefined
    const from = op === undefined ? undefined : await continuedFrom(thread, notesOf(entry), op)
    return { cloudThread: entry.cloudThread, acknowledged: entry.acknowledged, ...from && { noted: from.sha256 } }
  }

  /**
   * A going-away note as it goes (`CloudHandOffs`, after the account left out what its gateway doesn't take): each of
   * its Threads kept ready here records the note, the Sessions it named and the checkpoints it carried, beside the
   * notes before it. Only what the note a continue came from carried may leave the project folder later.
   */
  async noted(note: QuietNote): Promise<void> {
    const entries = await this.#load()
    let changed = false
    for (const thread of note.threads) {
      const entry = entries[thread.thread]
      if (!entry) continue
      const sha256 = thread.checkpoint ? [thread.checkpoint.sha256, ...(thread.others ?? []).map((other) => other.checkpoint.sha256)] : []
      const kept = notesOf(entry).filter((each) => each.note !== note.note)
      entry.noted = [...kept, { note: note.note, sessions: thread.sessions.map(({ session, generation }) => ({ session, generation })), sha256 }].slice(-NOTES_KEPT)
      changed = true
    }
    if (changed) await this.#save()
  }

  /** The account refused these Threads of a note (or took no note at all): nothing is continued from it, so its word goes. */
  async refused(note: string, threads: readonly string[]): Promise<void> {
    const entries = await this.#load()
    let changed = false
    for (const thread of threads) {
      const entry = entries[thread]
      const kept = entry ? notesOf(entry) : []
      if (!entry || !kept.some((each) => each.note === note)) continue
      entry.noted = kept.filter((each) => each.note !== note)
      changed = true
    }
    if (changed) await this.#save()
  }

  /** A round a write or a turn's end asked for failed: it's tried again `RETRY_MS` later, `RETRIES` times at most. */
  #retryLater(working: WorkingThread, cause: RoundCause): void {
    const retry = this.#retries.get(working.thread) ?? { count: 0 }
    if (retry.count >= RETRIES || retry.timer) return
    retry.count += 1
    retry.timer = setTimeout(() => {
      retry.timer = undefined
      void this.#whenEnabled(working, cause)
    }, this.#options.timing?.retryMs ?? RETRY_MS)
    retry.timer.unref?.()
    this.#retries.set(working.thread, retry)
  }

  /** A round went through: what failed before needs no more tries. */
  #retried(thread: string): void {
    const retry = this.#retries.get(thread)
    if (retry?.timer) return
    this.#retries.delete(thread)
  }

  /** A capture due after a write isn't needed: a round runs now. */
  #forgetTimers(thread: string): void {
    clearTimeout(this.#due.get(thread))
    this.#due.delete(thread)
    for (const [conversationId, working] of this.#writing) if (working.thread === thread) this.#writing.delete(conversationId)
  }

  /** Lets go of a Thread's triggers: a move took it. */
  #forget(thread: string): void {
    clearTimeout(this.#due.get(thread))
    this.#due.delete(thread)
    this.#again.delete(thread)
    this.#captured.delete(thread)
    clearTimeout(this.#retries.get(thread)?.timer)
    this.#retries.delete(thread)
    for (const [conversationId, working] of this.#writing) if (working.thread === thread) this.#writing.delete(conversationId)
  }

  async #whenEnabled(working: WorkingThread, cause: RoundCause): Promise<void> {
    try {
      if (await this.#options.enabled()) await this.#round(working, cause)
    } catch (error) {
      this.#sayOnce(working.thread, "a Thread at work couldn't be brought up to date in the cloud", errorMessage({ error }))
    }
  }

  /** Whether a Thread's conversation moved since its last round, or that round is `STILL_KEPT_MS` old. */
  #moved(working: WorkingThread): boolean {
    const last = this.#broughtUp.get(working.thread)
    const revision = this.#options.revision?.(working.conversationId)
    return !last || revision === undefined || last.conversationId !== working.conversationId || last.revision !== revision ||
      Date.now() - last.at >= STILL_KEPT_MS
  }

  #round(working: WorkingThread, cause: RoundCause): Promise<void> {
    const running = this.#rounds.get(working.thread)
    if (running) {
      // Superseded: what changed while this round ran goes in one round after it.
      if (cause !== "refresh") {
        const asked = this.#again.get(working.thread)
        this.#again.set(working.thread, { working, cause: asked?.cause === "end" ? "end" : cause })
      }
      return running
    }
    const round = this.#bringUp(working, cause).finally(() => {
      this.#rounds.delete(working.thread)
      const again = this.#again.get(working.thread)
      this.#again.delete(working.thread)
      if (again) void this.#round(again.working, again.cause)
    })
    this.#rounds.set(working.thread, round)
    return round
  }

  async #bringUp(working: WorkingThread, cause: RoundCause): Promise<void> {
    const account = this.#options.account()
    if (!account) return
    // Read before the round, so a change while it runs is a move the next refresh brings up.
    const revision = this.#options.revision?.(working.conversationId)
    let plan: ReadyPlan
    try {
      plan = await this.#options.plan(working.conversationId)
    } catch (error) {
      // A Thread that couldn't move (a tab outside its worktree, say) isn't kept ready; said once.
      this.#sayOnce(working.thread, "a Thread at work isn't kept ready to move", errorMessage({ error }))
      return
    }
    const entries = await this.#load()
    let entry = entries[plan.thread]
    if (!entry || entry.folder !== plan.folder || !sameRepository(entry.repository, plan.repository)) {
      entry = { cloudThread: this.#options.newCloudThread(), folder: plan.folder, repository: plan.repository, at: Date.now() }
      entries[plan.thread] = entry
      await this.#save()
    }
    let ready = entry
    const began = performance.now()
    try {
      const made = await account.createThread(ready.cloudThread, ready.repository, { folder: ready.folder, harness: plan.harness, standby: true, standsByFor: plan.thread })
      if (made.ended) {
        // The cloud ended it unused (nothing kept it ready for a while): a new one stands by in its place.
        hostLog("readiness", "a cloud Thread standing by had ended; standing by with a new one", { thread: plan.thread, ended: ready.cloudThread })
        ready = { cloudThread: this.#options.newCloudThread(), folder: plan.folder, repository: plan.repository, at: Date.now() }
        entries[plan.thread] = ready
        await this.#save()
        await account.createThread(ready.cloudThread, ready.repository, { folder: ready.folder, harness: plan.harness, standby: true, standsByFor: plan.thread })
      }
      const [checkpoint, sent] = await Promise.all([
        // A Thread in the main checkout sends its own changes, when a write or its turn's end asks; a worktree Thread its checkout.
        plan.planned ? this.#sendThreadCheckpoints(account, ready, plan, working.thread, cause) : this.#sendCheckpoint(account, ready),
        withFreshLink(() => account.threadRecords(ready.cloudThread), (link) => this.#options.sendRecords(link, plan.paths)),
      ])
      ready.at = Date.now()
      if (plan.project) ready.project = plan.project
      else delete ready.project
      if (plan.project && plan.projectFrom) ready.projectFrom = plan.projectFrom
      else delete ready.projectFrom
      if (checkpoint) ready.checkpoint = checkpoint
      await this.#save()
      if (revision !== undefined) this.#broughtUp.set(working.thread, { conversationId: working.conversationId, revision, at: ready.at })
      this.#said.delete(plan.thread)
      const versions = sent.reduce((total, each) => total + each.versions, 0)
      const bytes = sent.reduce((total, each) => total + each.bytes, 0)
      if (versions || checkpoint) hostLog("readiness", "a Thread at work was brought up to date in the cloud", { thread: plan.thread, cloudThread: ready.cloudThread, versions, bytes, checkpoint: checkpoint ? "sent" : "unchanged", ms: Math.round(performance.now() - began) })
      this.#retried(working.thread)
    } catch (error) {
      this.#sayOnce(plan.thread, "a Thread at work couldn't be brought up to date in the cloud", errorMessage({ error }))
      if (cause !== "refresh") this.#retryLater(working, cause)
    }
  }

  /**
   * A Thread in the main checkout's own changes, one checkpoint per repository, each sent when it changed since the
   * last the cloud acknowledged; the acknowledged ones are kept on `entry`. A refresh takes them only once nothing has
   * for `STILL_KEPT_MS`, for changes made outside a turn. Answers the first repository's hash when anything went.
   */
  async #sendThreadCheckpoints(account: ReadinessAccount, entry: ReadyEntry, plan: ReadyPlan, thread: string, cause: RoundCause): Promise<string | undefined> {
    const ledger = this.#options.ledger?.()
    if (!ledger || !plan.repositories?.length) return undefined
    const last = this.#captured.get(thread)
    if (cause === "refresh" && last && Date.now() - last.at < STILL_KEPT_MS) return undefined
    // A turn's end: its last writes may not be journaled yet, and a fingerprint reads only what is. Waited for, briefly,
    // and then captured whatever the fingerprint says: the capture reads the files themselves.
    if (cause === "end") await waitAtMost(ledger.heard(), END_HEARD_MS)
    const fingerprints = new Map<string, string>()
    let sent: string | undefined
    const acknowledged = [...entry.acknowledged ?? []]
    for (const { root, branch, folder, url } of plan.repositories) {
      const partition = await ledger.partition(root, thread)
      const fingerprint = `${branch}\n${threadFingerprint(ledger.head(root), partition, root)}`
      const kept = acknowledged.findIndex((each) => each.root === root)
      if (cause !== "end" && kept >= 0 && last?.fingerprints.get(root) === fingerprint) {
        fingerprints.set(root, fingerprint)
        continue
      }
      await this.#disk(mkdir(this.#options.scratch, { recursive: true }))
      const scratch = await this.#disk(mkdtemp(join(this.#options.scratch, "thread-")))
      try {
        const capture = this.#options.capture ?? captureThreadCheckpoint
        const taken = await capture({ git: this.#options.git, ledger, thread, repoRoot: root, branch, folder: scratch, partition })
        if (kept < 0 || acknowledged[kept]!.checkpoint.sha256 !== taken.checkpoint.sha256) {
          await account.sendCheckpoint(entry.cloudThread, taken.checkpoint, taken.file)
          const now: Acknowledged = { root, checkpoint: taken.checkpoint, unpushed: taken.unpushed, left: taken.left, versions: taken.versions, ...folder && { folder }, ...url && { url }, at: Date.now() }
          if (kept >= 0) acknowledged[kept] = now
          else acknowledged.push(now)
          entry.acknowledged = acknowledged
          sent ??= taken.checkpoint.sha256
          hostLog("readiness", "a Thread's own changes went to the cloud", {
            thread,
            cloudThread: entry.cloudThread,
            cause,
            files: taken.took.length,
            left: taken.left.length,
            bytes: taken.checkpoint.bytes,
            ms: Math.round(taken.ms),
            ...taken.unpushed && { unpushed: `includes ${taken.unpushed} unpushed commit${taken.unpushed === 1 ? "" : "s"}` },
          })
        }
        // Kept only once the cloud holds what this fingerprint names: a failure before leaves the repository to capture again.
        fingerprints.set(root, fingerprint)
      } finally {
        await this.#disk(rm(scratch, { recursive: true, force: true }))
      }
    }
    this.#captured.set(thread, { at: Date.now(), fingerprints })
    return sent
  }

  /** The checkout's checkpoint, sent when it changed since the last; answers its hash when it went. */
  async #sendCheckpoint(account: ReadinessAccount, entry: ReadyEntry): Promise<string | undefined> {
    const sent = await this.#sendWorktreeCheckpoint(account, entry)
    // Both at once, the moment the cloud holds it: a going-away read between them (its flush cut short) names this.
    if (sent) {
      entry.sent = sent
      entry.checkpoint = sent.sha256
    }
    return sent?.sha256
  }

  /** The worktree's checkpoint, sent when it changed since the last; answers it whole when it went. */
  async #sendWorktreeCheckpoint(account: ReadinessAccount, entry: ReadyEntry): Promise<MoveCheckpoint | undefined> {
    await this.#disk(mkdir(this.#options.scratch, { recursive: true }))
    const scratch = await this.#disk(mkdtemp(join(this.#options.scratch, "ready-")))
    try {
      const { checkpoint, file } = await this.#disk(captureMoveCheckpoint(this.#options.git, entry.folder, scratch))
      // Unchanged, the cloud has it already; kept whole if it wasn't yet (an entry from before it was).
      if (checkpoint.sha256 === entry.checkpoint) {
        entry.sent ??= checkpoint
        return undefined
      }
      await account.sendCheckpoint(entry.cloudThread, checkpoint, file)
      return checkpoint
    } finally {
      await this.#disk(rm(scratch, { recursive: true, force: true }))
    }
  }

  #sayOnce(thread: string, what: string, reason: string): void {
    if (this.#said.get(thread) === reason) return
    this.#said.set(thread, reason)
    hostWarn("readiness", what, { thread, reason })
  }

  async #prune(): Promise<void> {
    const entries = await this.#load()
    const stale = Object.entries(entries).filter(([, entry]) => Date.now() - entry.at > READY_KEPT_MS)
    if (!stale.length) return
    for (const [thread] of stale) delete entries[thread]
    await this.#save()
  }

  async #load(): Promise<Record<string, ReadyEntry>> {
    if (this.#entries) return this.#entries
    const saved = ReadyFileSchema.safeParse(JSON.parse(await this.#disk(readFile(this.#options.file, "utf8").catch(() => "null"))))
    this.#entries = saved.success ? saved.data.threads : {}
    return this.#entries
  }

  #save(): Promise<void> {
    const write = this.#disk(this.#saving.then(async () => {
      const threads = await this.#load()
      await mkdir(dirname(this.#options.file), { recursive: true })
      await writeFile(`${this.#options.file}.tmp`, JSON.stringify(ReadyFileSchema.parse({ version: 1, threads })), { mode: 0o600 })
      await rename(`${this.#options.file}.tmp`, this.#options.file)
    }))
    this.#saving = write.catch(() => {})
    return write
  }

  /** `work`, counted as file work under way until it settles. */
  #disk<T>(work: Promise<T>): Promise<T> {
    this.#io.add(work)
    void work.then(() => this.#io.delete(work), () => this.#io.delete(work))
    return work
  }

  /**
   * Resolves once no file work it started is under way, and what each piece of it went on to do has run up to its next
   * wait. Its timers' times are what a test asserts, and the disk's own pace is the runner's: a test that moves the
   * clock itself waits here after each step, so time moves only while nothing real is under way (`test-checkpoint-trigger.ts`).
   */
  async ioSettled(): Promise<void> {
    for (;;) {
      await new Promise<void>((next) => setImmediate(next))
      if (!this.#io.size) return
      await Promise.allSettled([...this.#io])
    }
  }
}

/** Waits for `work`, or `ms` at most. */
async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([work.catch(() => undefined), new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
  clearTimeout(timer)
}
