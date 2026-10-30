import { z } from "zod"
import { ReturnDepartureSchema, type ReturnDeparture, type ReturnState } from "@mako/protocol/moves"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { errorMessage } from "./error-message.js"
import { decodeRuntimeValue, type EncodedValue } from "./runtime-value.js"
import type { CloudArchiveOutcome, CloudArchiveStep } from "./thread-lifecycle.js"

/**
 * A cloud Thread archived by its person, from any device of the account, whichever device it came from: a return whose
 * destination is the archive (`@mako/protocol/moves`). The cloud stops it taking work (refusing, in words, while it
 * works or moves), its machine packs its checkout and each Session's records as a return's would, the cloud records it
 * released, then archived: it deletes the machine, keeps the records, and every device's list drops its Sessions and
 * shows it with the archived ones. Its Thread object is the one keeper of whether it's archived; nothing here writes an
 * archive key.
 *
 * A machine that refuses to pack (a turn just started) cancels the archive, and the Thread goes on as it was. One with
 * nothing to pack (no conversation started there) is archived without it. One that can't start is archived only if the
 * person says so (`anyway`): its records are kept, its checkout's changes since it last moved aren't.
 *
 * Each step is the cloud's to answer, and asked again it stands, so the plan is kept before each and a device that
 * stops mid-way settles it when it next starts: an archive begun is never left with its Thread fenced. Two asks for one
 * Thread while an archive runs join it.
 *
 * The one procedure a Mac's host and a browser both run (`CloudArchives` on a Mac, `web-client/archive.ts`): where
 * the plans are kept, how the account's return steps reach the cloud and how a call reaches the machine are each
 * device's own, and handed in.
 */

/**
 * How a machine's departure refuses mid-turn (`move-departure.ts`), the one word on whether its Thread works: it waits
 * out a turn's last bookkeeping, and refuses a turn, naming it.
 */
const BETWEEN_TURNS = /^A Thread goes back between turns: (.*?)\.?$/s

/** What the Thread's machine is refused for when it can't start: the words the cloud's refusals use (`thread/core.ts`). */
const UNSTARTED = /couldn't start in the cloud|didn't start in the cloud in time|Mako Cloud is full/

export const CloudArchivePlanSchema = z.object({
  op: z.uuid(),
  thread: z.string(),
  /** Its conversations whose harness started on the machine, which it packs; none when nothing ran there. */
  conversations: z.array(z.uuid()),
  folder: z.string().optional(),
  /** The asking device: the machine releases the Thread toward it as it packs, as a return does. */
  device: z.uuid(),
  anyway: z.boolean().default(false),
  phase: z.enum(["begun", "released", "archived", "cancelled"]),
  reason: z.string().optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
})
export type CloudArchivePlan = z.infer<typeof CloudArchivePlanSchema>

/** What archiving a cloud Thread asks its machine to pack: its conversations that started there, at its folder. */
export type ArchiveInputs = { conversations: string[]; folder: string | undefined }

/**
 * What the account's list says a cloud Thread's machine would pack: each of its conversations whose harness started
 * there (one that never started has nothing to keep), and the folder they work in there. A device that knows more of
 * the Thread than its list (a Mac's own conversations moved there) adds its own.
 */
export function listedArchiveInputs(rows: Iterable<ListedSession>, threadId: string): ArchiveInputs {
  const conversations: string[] = []
  let folder: string | undefined
  for (const row of rows) {
    if (row.runsOn.kind !== "cloud" || row.runsOn.threadId !== threadId) continue
    folder ??= row.folder
    // A session its harness keeps that Mako there never opened (`capture`) is no conversation of the machine's.
    if (row.nativeId && !row.capture && !conversations.includes(row.conversation)) conversations.push(row.conversation)
  }
  return { conversations, folder }
}

/** A plan as it was kept; undefined for text that isn't one. */
export function readCloudArchivePlan(text: string): CloudArchivePlan | undefined {
  try {
    return CloudArchivePlanSchema.safeParse(JSON.parse(text)).data
  } catch {
    // Not JSON: cut short as it was written, which a plan written whole in place never is.
    return undefined
  }
}

/** Where a device keeps archives' plans, each as its JSON's text: a Mac's files, a browser's storage. */
export interface CloudArchivePlans {
  /** The text kept under `op`; undefined, or a rejection, when there's none. */
  read(op: string): Promise<string | undefined>
  /** Kept whole under `op`, in place of what was, before the step its plan names is asked. */
  write(op: string, text: string): Promise<void>
  /** The ops of every plan kept. */
  list(): Promise<string[]>
}

/** The account's steps of a return that an archive asks of the cloud, as a Mac's `CloudAccount` takes them. */
export interface CloudReturnSteps {
  /** The asking device's ID in the account; undefined while it isn't one of its devices. */
  deviceId(): Promise<string | undefined>
  beginReturn(threadId: string, move: string, to?: "archive"): Promise<ReturnState>
  /** What the cloud recorded for a return, if anything; undefined while it hasn't. */
  returnState(threadId: string, move: string): Promise<ReturnState | undefined>
  cancelReturn(threadId: string, move: string, reason: string): Promise<ReturnState>
  releaseReturn(threadId: string, move: string, departure: ReturnDeparture): Promise<ReturnState>
  archiveReturn(threadId: string, move: string): Promise<ReturnState>
}

export type CloudArchiveLogFields = Record<string, string | number | boolean | undefined>
/** Where an archive's lines go: a host's log, a browser's console. */
export type CloudArchiveLog = {
  info(message: string, fields: CloudArchiveLogFields): void
  warn(message: string, fields: CloudArchiveLogFields): void
}

export type CloudArchiverOptions = {
  plans: CloudArchivePlans
  /** The account's return steps; throws, saying why, while there's no account to ask. */
  account(): CloudReturnSteps
  /** One call to the cloud Thread's machine, for a conversation of it; `refuseUnstarted`: refused at once if it can't start. */
  callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string, options?: { refuseUnstarted?: boolean }): Promise<EncodedValue>
  step(step: CloudArchiveStep): void
  log: CloudArchiveLog
  /** The asking device as its person calls it, starting a sentence: "This Mac", "This browser". */
  self: string
}

export class CloudArchiver {
  readonly #options: CloudArchiverOptions
  /** By cloud Thread, the archive running for it now: a second ask joins it. */
  readonly #running = new Map<string, Promise<CloudArchiveOutcome>>()

  constructor(options: CloudArchiverOptions) {
    this.#options = options
  }

  /**
   * Archives the cloud Thread `thread` under `op`, or answers how its archive went. `inputs` is what its machine packs,
   * read only for an archive not yet begun under `op`: one begun packs what its plan kept.
   */
  archive(thread: string, op: string, anyway: boolean, inputs: () => ArchiveInputs): Promise<CloudArchiveOutcome> {
    const running = this.#running.get(thread)
    if (running) return running
    const work = this.#archive(thread, op, anyway, inputs).finally(() => this.#running.delete(thread))
    this.#running.set(thread, work)
    return work
  }

  /** Settles every archive a stopped device left under way, as its plan stands. */
  async settle(): Promise<void> {
    for (const op of await this.#options.plans.list().catch(() => [])) {
      const plan = await this.#read(op)
      if (!plan || plan.phase === "archived" || plan.phase === "cancelled" || this.#running.has(plan.thread)) continue
      const work = this.#carry(plan).finally(() => this.#running.delete(plan.thread))
      this.#running.set(plan.thread, work)
      const outcome = await work.catch((error: Error) => ({ kind: "refused" as const, thread: plan.thread, reason: error.message }))
      this.#options.log.info("an archive a stopped host left was settled", { op: plan.op, thread: plan.thread, outcome: outcome.kind })
    }
  }

  async #archive(thread: string, op: string, anyway: boolean, inputs: () => ArchiveInputs): Promise<CloudArchiveOutcome> {
    const known = await this.#read(op)
    if (known) {
      if (known.phase === "archived") return { kind: "archived", thread }
      // Asked again under the same ID, it answers the same: archiving anyway is a new ask.
      if (known.phase === "cancelled") return { kind: "refused", thread, reason: known.reason ?? "It wasn't archived." }
      return this.#carry(known)
    }
    const account = this.#options.account()
    const device = await account.deviceId()
    if (!device) return { kind: "refused", thread, reason: `${this.#options.self} isn't one of the account's devices, so it can't archive the account's Threads.` }
    const { conversations, folder } = inputs()
    const plan: CloudArchivePlan = { op, thread, conversations, device, anyway, phase: "begun", began: Date.now(), timings: {} }
    if (folder) plan.folder = folder
    await this.#write(plan)
    return this.#carry(plan)
  }

  async #carry(plan: CloudArchivePlan): Promise<CloudArchiveOutcome> {
    const account = this.#options.account()
    const step = (kind: CloudArchiveStep["kind"]) => this.#options.step({ thread: plan.thread, kind })
    try {
      if (plan.phase === "begun") {
        step("packing")
        let begun: ReturnState
        try {
          begun = await account.beginReturn(plan.thread, plan.op, "archive")
        } catch (error) {
          // Refused (it works, it moves, it's another account's), or unheard: the cloud's record says which. None, and
          // nothing began, so there's nothing to undo; one, and the archive goes on from it. Unread, the plan stands.
          const record = await account.returnState(plan.thread, plan.op)
          if (!record) return this.#refused(plan, errorMessage({ error }))
          begun = record
        }
        if (begun.move !== plan.op && begun.phase === "archived") return this.#done(plan, "archived already")
        if (begun.phase === "cancelled") return this.#refused(plan, begun.reason)
        if (begun.phase === "archived") return this.#done(plan, "archived")
        if (begun.phase === "returning") {
          const outcome = await this.#pack(plan, account)
          if (outcome) return outcome
        } else if (begun.phase === "released") {
          plan.phase = "released"
          await this.#write(plan)
        }
      }
      step("ending")
      const archived = await account.archiveReturn(plan.thread, plan.op)
      if (archived.phase !== "archived") throw new Error(`the cloud reads the archive as ${archived.phase}`)
      return this.#done(plan, "archived")
    } catch (error) {
      // A step the cloud didn't answer: the plan stands, and asking again (or the next start) goes on from it.
      const message = errorMessage({ error })
      this.#options.log.warn("an archive is unsettled", { op: plan.op, thread: plan.thread, phase: plan.phase, error: message })
      return { kind: "refused", thread: plan.thread, reason: `Mako couldn't hear the cloud: ${message}. It stays as it was until Mako does; archive it again, or Mako asks when it next starts.` }
    }
  }

  /** The machine packs and the cloud records it released; or the archive is cancelled, saying why. Undefined once released. */
  async #pack(plan: CloudArchivePlan, account: CloudReturnSteps): Promise<CloudArchiveOutcome | undefined> {
    if (plan.anyway) {
      // The person's word, with nothing packed: its records are kept, its checkout's changes since it moved aren't.
      this.#options.log.info("an archive keeps only its records, as its person asked", { op: plan.op, thread: plan.thread })
      return undefined
    }
    // Never archived without its checkout unasked: what this device doesn't know the machine runs, it can't ask it to pack.
    if (!plan.conversations.length || !plan.folder) {
      const reason = "Mako can't tell yet what this Thread runs in the cloud, so its checkout can't be saved. Try again in a moment."
      const cancelled = await account.cancelReturn(plan.thread, plan.op, reason)
      if (cancelled.phase === "cancelled") return this.#refused(plan, reason, true)
      throw new Error(`the cloud reads the archive as ${cancelled.phase} after it was cancelled`)
    }
    const packed = await this.#options
      .callThread(plan.thread, "mako:move-depart", [{ move: plan.op, folder: plan.folder, conversations: plan.conversations, device: plan.device }], plan.conversations[0], { refuseUnstarted: true })
      .then((value) => ({ departure: ReturnDepartureSchema.parse(decodeRuntimeValue(value)) }), (error: Error) => ({ reason: errorMessage({ error }) }))
    if ("reason" in packed) {
      const turn = BETWEEN_TURNS.exec(packed.reason)?.[1]
      const reason = turn ? `This Thread is working (${turn}). Archive it once its turn ends.` : packed.reason
      const cancelled = await account.cancelReturn(plan.thread, plan.op, reason)
      if (cancelled.phase === "cancelled") return this.#refused(plan, reason, UNSTARTED.test(reason))
      throw new Error(`the cloud reads the archive as ${cancelled.phase} after it was cancelled`)
    }
    plan.timings.packed = Date.now() - plan.began
    const released = await account.releaseReturn(plan.thread, plan.op, packed.departure)
    if (released.phase !== "released" && released.phase !== "archived") throw new Error(`the cloud reads the archive as ${released.phase}`)
    plan.phase = "released"
    await this.#write(plan)
    return undefined
  }

  async #refused(plan: CloudArchivePlan, reason: string, unstarted = false): Promise<CloudArchiveOutcome> {
    plan.phase = "cancelled"
    plan.reason = reason
    await this.#write(plan)
    this.#options.log.info("an archive was refused; the Thread goes on as it was", { op: plan.op, thread: plan.thread, reason, conversations: plan.conversations.join(", "), folder: plan.folder })
    return { kind: "refused", thread: plan.thread, reason, ...(unstarted && { anyway: true as const }) }
  }

  async #done(plan: CloudArchivePlan, how: string): Promise<CloudArchiveOutcome> {
    plan.phase = "archived"
    plan.timings.archived = Date.now() - plan.began
    await this.#write(plan)
    this.#options.log.info("a cloud Thread was archived", { op: plan.op, thread: plan.thread, how, conversations: plan.conversations.length, ...plan.timings })
    return { kind: "archived", thread: plan.thread }
  }

  /** The plan kept under `op`; undefined when there's none, or what's kept can't be read as one. */
  async #read(op: string): Promise<CloudArchivePlan | undefined> {
    const text = await this.#options.plans.read(op).catch(() => undefined)
    return text === undefined ? undefined : readCloudArchivePlan(text)
  }

  async #write(plan: CloudArchivePlan): Promise<void> {
    await this.#options.plans.write(plan.op, JSON.stringify(CloudArchivePlanSchema.parse(plan)))
  }
}
