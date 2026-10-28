import { createReadStream, existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises"
import { join } from "node:path"
import { fetch as fetchWith } from "undici"
import type { ActivityMark } from "@mako/protocol"
import { MACHINE_SAVE_EVERY_MS, MachineSaveSchema, diskLevel, type Disk, type MachineSave, type SaveProblem, type SavedConversation } from "@mako/protocol/saves"
import type { MoveCarryRef, MoveCheckpoint } from "@mako/protocol/moves"
import type { Git } from "@mako/git"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import type { Handoff } from "../contracts/thread-execution.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { captureMoveCheckpoint, MoveCheckpointError } from "../workspaces/index.js"

/**
 * A cloud machine keeping its Thread safe from its own loss: the machine tracker. After each tool call that could
 * change files, at each turn's end, and every `MACHINE_SAVE_EVERY_MS` while anything works, it captures the Thread's
 * checkout as a move checkpoint, sends it beside the Thread's records unless the cloud has it, and saves to the
 * Thread's object what a new machine needs to carry on (`@mako/protocol/saves`). A machine that's lost loses at most
 * what changed since: a new one restores the save (`machine-restore.ts`).
 *
 * Saves run one at a time, coalesced: a change while one runs is saved right after it. Capture makes the same
 * checkpoint for the same checkout, so an unchanged checkout sends nothing, and a save that says nothing new isn't sent
 * again. Capture works in memory (`/dev/shm`) where the machine has it, so a full disk still saves.
 *
 * A save refused as fenced means this machine's generation moved on: it stops saving for good.
 */

/** A change is saved this long after it, so a burst of calls is one save. */
const SETTLE_MS = 1_000
/** In-memory scratch, where the machine has it: a disk that's full can still save. */
const MEMORY_SCRATCH = "/dev/shm"

export type MachineSaveLink = {
  records: RecordsLink
  /** `PUT` and `GET` here: the Thread's save, under the machine's credential. */
  save: { url: string; authorization: string }
}

export type MachineSavesDeps = {
  git: Git
  link(): MachineSaveLink | undefined
  /** The folder the Thread works in, once the agent made it. */
  workspace(): string | undefined
  /**
   * The Thread's conversations here, as a new machine opens them again: `turns` are the turns running now, by the request
   * each answers, each with the call it runs, if any. A turn named here is one a new machine continues.
   */
  conversations(turns: ReadonlyMap<string, string | undefined>): SavedConversation[]
  /** The machine store's Thread, as a release would hand it over, without releasing it. */
  handoff(): Handoff | undefined
  /** Each conversation's native records, sent through to their newest: at a turn's end, so the save's records are up. */
  flushRecords?(): Promise<void>
  /**
   * The rest of the Thread as a move carries it (its other repositories, files outside its folder, file history), sent
   * beside its records; its first repository's checkpoint is `checkpoint`. Absent where there's no carry to take.
   */
  carry?(folder: string, records: RecordsLink, checkpoint: MoveCheckpoint): Promise<MoveCarryRef | undefined>
  /** A folder of the host's own, for capture's scratch when there's no memory to work in. */
  scratch: string
  /** Where memory scratch is; tests point it elsewhere. */
  memoryScratch?: string
  now?(): number
}

export type MachineSavesState = {
  saves: number
  sent: number
  last?: { at: number; why: string; ms: number; sha256?: string; bytes?: number; sent: boolean; problem?: string }
  fenced?: string
  failing?: string
}

export class MachineSaves {
  readonly #deps: MachineSavesDeps
  readonly #now: () => number
  /**
   * Each turn running now, by the request it answers, with the call it runs: what a save says was cut if the machine is
   * lost. From the turns' own start and end, never from a request's status, which reads as dispatching a moment past
   * its turn's end: a save then named an ended turn, and the next machine continued it again.
   */
  readonly #turns = new Map<string, string | undefined>()
  #timer: NodeJS.Timeout | undefined
  #every: NodeJS.Timeout | undefined
  #saving: Promise<void> | undefined
  #again: string | undefined
  #checkpoint: MoveCheckpoint | undefined
  /** The carry last taken: again at a turn's end and while work goes on, not after each call, which the checkout covers. */
  #carry: MoveCarryRef | undefined
  /** The checkpoint the cloud has, by hash. */
  #sentCheckpoint: string | undefined
  /** What the last save sent said, but for its time and exact free bytes. */
  #sentSays: string | undefined
  #restored: MachineSave["restored"] | undefined
  #settling = false
  #held = false
  #stopped = false
  readonly #state: MachineSavesState = { saves: 0, sent: 0 }

  constructor(deps: MachineSavesDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  state(): MachineSavesState {
    return { ...this.#state }
  }

  /**
   * A conversation's activity, as attribution reads it from its live batches: a call that could write (not a read)
   * ends, or a turn ends, and the checkout is saved soon. `session` carries the conversation's id.
   */
  activity(mark: Pick<ActivityMark, "kind" | "edge" | "id" | "turn" | "label" | "readOnly">): void {
    if (mark.kind === "turn") {
      if (mark.edge === "start") this.#turns.set(mark.id, undefined)
      else {
        this.#turns.delete(mark.id)
        this.changed("a turn ended")
      }
    }
    if (mark.kind === "call" && mark.turn) {
      if (mark.edge === "start" && !mark.readOnly) this.#turns.set(mark.turn, mark.label || "a tool call")
      if (mark.edge === "end") {
        if (this.#turns.has(mark.turn)) this.#turns.set(mark.turn, undefined)
        if (!mark.readOnly) this.changed("a tool call ended")
      }
    }
  }

  /** While anything works, a save at least every `MACHINE_SAVE_EVERY_MS`, so a long command's writes are kept too. */
  working(busy: boolean): void {
    if (this.#stopped) return
    if (busy && !this.#every) {
      this.#every = setInterval(() => this.changed("work goes on"), MACHINE_SAVE_EVERY_MS)
      this.#every.unref()
    } else if (!busy && this.#every) {
      clearInterval(this.#every)
      this.#every = undefined
    }
  }

  /**
   * A new machine restoring its Thread's save: nothing is saved meanwhile (the sessions it opens would be saved before
   * the checkout under them is the Thread's), and the Thread's object would refuse it. Released by `restoredFrom`, or
   * by `released` when there was nothing to restore.
   */
  hold(): void {
    this.#held = true
  }

  /** The machine restored a lost one's save: its first save says so, for the hop's record. */
  restoredFrom(restored: NonNullable<MachineSave["restored"]>): void {
    this.#restored = restored
    this.released("restored a save")
  }

  released(why: string): void {
    this.#held = false
    this.changed(why)
  }

  /** Something changed: saved within `SETTLE_MS`, after a save already running. */
  changed(why: string): void {
    if (this.#stopped || this.#state.fenced) return
    this.#again = why
    if (this.#timer || this.#saving || this.#held) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#run()
    }, SETTLE_MS)
    this.#timer.unref()
  }

  /**
   * A save now, waited for: a turn's end, which the host says to its Thread only once this has landed. So a machine
   * that says it's idle has a save at least as new as its last change.
   */
  async settle(why: string): Promise<void> {
    if (this.#stopped || this.#state.fenced || this.#held) return
    this.#settling = true
    try {
      // A save running may have read the checkout before the last change: one more after it.
      await this.#saving
      clearTimeout(this.#timer)
      this.#timer = undefined
      this.#again = why
      while (this.#again && !this.#stopped && !this.#state.fenced) await this.#run(true)
    } finally {
      this.#settling = false
    }
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    clearInterval(this.#every)
    this.#timer = undefined
    this.#every = undefined
  }

  async #run(flush = false): Promise<void> {
    if (this.#saving) return this.#saving
    const why = this.#again ?? "asked"
    this.#again = undefined
    this.#saving = this.#save(why, flush).finally(() => {
      this.#saving = undefined
      // Changed while it saved: once more, after the settling time.
      if (this.#again && !this.#settling && !this.#stopped && !this.#state.fenced) this.changed(this.#again)
    })
    return this.#saving
  }

  async #save(why: string, flush: boolean): Promise<void> {
    const link = this.#deps.link()
    const folder = this.#deps.workspace()
    if (!link || !folder) return
    const began = performance.now()
    const at = this.#now()
    try {
      const [disk, captured] = await Promise.all([diskOf(folder), this.#capture(folder, link, at)])
      const { problem } = captured
      if (flush) await this.#deps.flushRecords?.().catch((error: Error) => hostWarn("machine", "a turn's records weren't sent through before its save", { error: errorMessage({ error }) }))
      const save: MachineSave = { version: 1, at, folder, conversations: this.#deps.conversations(this.#turns) }
      if (this.#checkpoint) save.checkpoint = this.#checkpoint
      const carryDue = flush || why !== "a tool call ended" || !this.#carry
      if (this.#checkpoint && this.#deps.carry && carryDue) {
        const checkpoint = this.#checkpoint
        this.#carry = await this.#deps.carry(folder, link.records, checkpoint).catch((error: Error) => {
          hostWarn("machine", "the rest of the Thread wasn't saved this time; its checkout was", { why, error: errorMessage({ error }) })
          return this.#carry
        })
      }
      if (this.#carry) save.carry = this.#carry
      const handoff = this.#deps.handoff()
      if (handoff) save.handoff = handoffJson(handoff)
      if (disk) save.disk = disk
      if (problem) save.problem = problem
      if (this.#restored) save.restored = this.#restored
      MachineSaveSchema.parse(save)
      this.#state.saves += 1
      // The same as last said (its checkout, conversations, handoff, problem and the disk's level): nothing to send, but
      // at a turn's end, which the Thread hears as this save coming after the turn's work, whatever it says.
      const says = JSON.stringify({ ...save, at: 0, handoff: handoff && unstamped(handoff), disk: disk && diskLevel(disk), problem: problem?.message })
      const send = says !== this.#sentSays || captured.sent || flush
      if (send) {
        await this.#put(link, save)
        this.#sentSays = says
        this.#restored = undefined
        this.#state.sent += 1
      }
      delete this.#state.failing
      const last: NonNullable<MachineSavesState["last"]> = { at, why, ms: Math.round(performance.now() - began), sent: send }
      if (this.#checkpoint) {
        last.sha256 = this.#checkpoint.sha256
        last.bytes = this.#checkpoint.bytes
      }
      if (problem) last.problem = problem.message
      this.#state.last = last
      if (send) hostLog("machine", "saved", { why, ms: last.ms, checkpoint: this.#checkpoint?.sha256.slice(0, 12) ?? "none", bytes: this.#checkpoint?.bytes ?? 0, free: disk?.freeBytes ?? -1, problem: problem?.kind ?? "none" })
    } catch (error) {
      const message = errorMessage({ error })
      if (this.#state.failing !== message) hostWarn("machine", "a save failed; the next change tries again", { why, error: message })
      this.#state.failing = message
    }
  }

  /** The checkout captured and sent, unless it's what the cloud has; why not, when it couldn't be. */
  async #capture(folder: string, link: MachineSaveLink, at: number): Promise<{ problem?: SaveProblem; sent: boolean }> {
    // A Thread with no repository works in the machine's home: its conversations are saved, and there's no checkout.
    if (!existsSync(join(folder, ".git"))) return { sent: false }
    const root = existsSync(this.#deps.memoryScratch ?? MEMORY_SCRATCH) ? this.#deps.memoryScratch ?? MEMORY_SCRATCH : this.#deps.scratch
    await mkdir(root, { recursive: true })
    const scratch = await mkdtemp(join(root, "mako-save-"))
    try {
      let captured: Awaited<ReturnType<typeof captureMoveCheckpoint>>
      try {
        captured = await captureMoveCheckpoint(this.#deps.git, folder, scratch)
      } catch (error) {
        if (!(error instanceof MoveCheckpointError)) return { problem: { kind: "failed", message: errorMessage({ error }).slice(0, 2_000), at }, sent: false }
        // A repository with no commits has nothing to carry yet; the others are the person's to hear.
        if (error.kind === "no-commits") return { sent: false }
        return { problem: { kind: error.kind === "too-large" || error.kind === "conflicts" ? error.kind : "failed", message: error.message, at }, sent: false }
      }
      const { checkpoint, file } = captured
      this.#checkpoint = checkpoint
      if (this.#sentCheckpoint === checkpoint.sha256) return { sent: false }
      await sendCheckpoint(link.records, checkpoint, file)
      this.#sentCheckpoint = checkpoint.sha256
      return { sent: true }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async #put(link: MachineSaveLink, save: MachineSave): Promise<void> {
    const response = await fetchWith(link.save.url, {
      method: "PUT",
      headers: { authorization: link.save.authorization, "content-type": "application/json" },
      body: JSON.stringify(save),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 409) {
      const said = (await response.text().catch(() => "")).slice(0, 300)
      // Not yet restored: said again once it has (`hold`), never taken as fenced.
      if (said.includes("restore-first")) throw new Error("the Thread's object waits for this machine to restore its save first")
      this.#state.fenced = said || "fenced"
      hostWarn("machine", "a save was refused: this machine no longer runs its Thread", { status: response.status })
      this.stop()
      return
    }
    if (!response.ok) throw new Error(`the cloud answered ${response.status} to a save`)
  }
}

/** The checkpoint sent beside the Thread's records, unless the account has it already. */
async function sendCheckpoint(records: RecordsLink, checkpoint: MoveCheckpoint, file: string): Promise<void> {
  const url = `${records.base}/checkpoints/${checkpoint.sha256}`
  const kept = await fetchWith(url, { method: "HEAD", headers: { authorization: records.authorization }, signal: AbortSignal.timeout(30_000) })
  if (kept.ok) return
  if (kept.status !== 404) throw new Error(`the cloud couldn't say whether it has the checkout: it answered ${kept.status}`)
  const put = await fetchWith(url, {
    method: "PUT",
    headers: { authorization: records.authorization, "content-type": "application/octet-stream", "content-length": String(checkpoint.bytes) },
    body: createReadStream(file),
    duplex: "half",
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!put.ok) throw new Error(`the checkout couldn't be sent: the cloud answered ${put.status}`)
}

/** The free space on the disk `path` is on; undefined where it can't be read. */
export async function diskOf(path: string): Promise<Disk | undefined> {
  try {
    const stats = await statfs(path)
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: Math.max(1, stats.blocks * stats.bsize) }
  } catch {
    return undefined
  }
}

/**
 * A handoff as JSON carries it: a store's Thread names its title and the like even when it has none (the key there,
 * undefined), which JSON drops, and a save, read as JSON, refuses. Only what's there is kept.
 */
function handoffJson(handoff: Handoff): Handoff {
  const thread: Handoff["thread"] = { id: handoff.thread.id, owner: handoff.thread.owner }
  if (handoff.thread.title !== undefined) thread.title = handoff.thread.title
  if (handoff.thread.titleSource !== undefined) thread.titleSource = handoff.thread.titleSource
  if (handoff.thread.originalTitle !== undefined) thread.originalTitle = handoff.thread.originalTitle
  const sessions = handoff.sessions.map((session) => {
    const kept: Handoff["sessions"][number] = { id: session.id, origin: session.origin, position: session.position, generation: session.generation, journals: session.journals }
    if (session.parent !== undefined) kept.parent = session.parent
    return kept
  })
  return { move: handoff.move, source: handoff.source, target: handoff.target, releasedAt: handoff.releasedAt, thread, sessions }
}

/** A handoff as it says who's who, without the moment it was read: what makes two saves' handoffs the same. */
function unstamped(handoff: Handoff): Omit<Handoff, "releasedAt"> {
  return { move: handoff.move, source: handoff.source, target: handoff.target, thread: handoff.thread, sessions: handoff.sessions }
}
