import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { ReturnDepartureSchema, type ReturnState } from "@mako/protocol/moves"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { CloudArchiveOutcome, CloudArchiveStep } from "../contracts/thread-lifecycle.js"
import { decodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import type { CloudAccount } from "../usage/index.js"
import type { ArchiveInputs } from "./cloud-conversations.js"

/**
 * A cloud Thread archived by its person, from this Mac, whichever device it came from: a return whose destination is
 * the archive (`@mako/protocol/moves`). The cloud stops it taking work (refusing, in words, while it works or moves),
 * its machine packs its checkout and each Session's records as a return's would, the cloud records it released, then
 * archived: it deletes the machine, keeps the records, and every device's list drops its Sessions and shows it with the
 * archived ones. Its Thread object is the one keeper of whether it's archived; nothing here writes an archive key.
 *
 * A machine that refuses to pack (a turn just started) cancels the archive, and the Thread goes on as it was. One with
 * nothing to pack (no conversation started there) is archived without it. One that can't start is archived only if the
 * person says so (`anyway`): its records are kept, its checkout's changes since it last moved aren't.
 *
 * Each step is the cloud's to answer, and asked again it stands, so the plan is written before each
 * (`<data root>/cloud/archives/<op>.json`) and a host that stops mid-way settles it at its next start: an archive begun
 * is never left with its Thread fenced. Two asks for one Thread while an archive runs join it.
 */

/**
 * How a machine's departure refuses mid-turn (`move-departure.ts`), the one word on whether its Thread works: it waits
 * out a turn's last bookkeeping, and refuses a turn, naming it.
 */
const BETWEEN_TURNS = /^A Thread goes back between turns: (.*?)\.?$/s

/** What the Thread's machine is refused for when it can't start: the words the cloud's refusals use (`thread/core.ts`). */
const UNSTARTED = /couldn't start in the cloud|didn't start in the cloud in time|Mako Cloud is full/

const PlanSchema = z.object({
  op: z.uuid(),
  thread: z.string(),
  /** Its conversations whose harness started on the machine, which it packs; none when nothing ran there. */
  conversations: z.array(z.uuid()),
  folder: z.string().optional(),
  /** This Mac's device: the machine releases the Thread toward it as it packs, as a return does. */
  device: z.uuid(),
  anyway: z.boolean().default(false),
  phase: z.enum(["begun", "released", "archived", "cancelled"]),
  reason: z.string().optional(),
  began: z.number(),
  timings: z.record(z.string(), z.number()).default({}),
})
type Plan = z.infer<typeof PlanSchema>

export type CloudArchivesOptions = {
  /** Where archives' plans are: `<data root>/cloud/archives`. */
  folder: string
  account(): CloudAccount | undefined
  cloud: {
    callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string, options?: { refuseUnstarted?: boolean }): Promise<EncodedValue>
    archiveInputs(threadId: string): ArchiveInputs
  }
  step(step: CloudArchiveStep): void
}

export class CloudArchives {
  readonly #options: CloudArchivesOptions
  /** By cloud Thread, the archive running for it now: a second ask joins it. */
  readonly #running = new Map<string, Promise<CloudArchiveOutcome>>()

  constructor(options: CloudArchivesOptions) {
    this.#options = options
  }

  /** Archives the cloud Thread `thread` under `op`, or answers how its archive went. */
  archive(thread: string, op: string, anyway = false): Promise<CloudArchiveOutcome> {
    const running = this.#running.get(thread)
    if (running) return running
    const work = this.#archive(thread, op, anyway).finally(() => this.#running.delete(thread))
    this.#running.set(thread, work)
    return work
  }

  /** Settles every archive a stopped host left under way, as its plan stands. */
  async settle(): Promise<void> {
    for (const name of await readdir(this.#options.folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = await this.#read(name.slice(0, -".json".length)).catch(() => undefined)
      if (!plan || plan.phase === "archived" || plan.phase === "cancelled" || this.#running.has(plan.thread)) continue
      const work = this.#carry(plan).finally(() => this.#running.delete(plan.thread))
      this.#running.set(plan.thread, work)
      const outcome = await work.catch((error: Error) => ({ kind: "refused" as const, thread: plan.thread, reason: error.message }))
      hostLog("archives", "an archive a stopped host left was settled", { op: plan.op, thread: plan.thread, outcome: outcome.kind })
    }
  }

  async #archive(thread: string, op: string, anyway: boolean): Promise<CloudArchiveOutcome> {
    const known = await this.#read(op).catch(() => undefined)
    if (known) {
      if (known.phase === "archived") return { kind: "archived", thread }
      // Asked again under the same ID, it answers the same: archiving anyway is a new ask.
      if (known.phase === "cancelled") return { kind: "refused", thread, reason: known.reason ?? "It wasn't archived." }
      return this.#carry(known)
    }
    const account = this.#account()
    const device = await account.deviceId()
    if (!device) return { kind: "refused", thread, reason: "This Mac isn't one of the account's devices, so it can't archive the account's Threads." }
    const { conversations, folder } = this.#options.cloud.archiveInputs(thread)
    const plan: Plan = { op, thread, conversations, device, anyway, phase: "begun", began: Date.now(), timings: {} }
    if (folder) plan.folder = folder
    await this.#write(plan)
    return this.#carry(plan)
  }

  async #carry(plan: Plan): Promise<CloudArchiveOutcome> {
    const account = this.#account()
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
          const outcome = await this.#pack(plan)
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
      hostWarn("archives", "an archive is unsettled", { op: plan.op, thread: plan.thread, phase: plan.phase, error: message })
      return { kind: "refused", thread: plan.thread, reason: `Mako couldn't hear the cloud: ${message}. It stays as it was until Mako does; archive it again, or Mako asks when it next starts.` }
    }
  }

  /** The machine packs and the cloud records it released; or the archive is cancelled, saying why. Undefined once released. */
  async #pack(plan: Plan): Promise<CloudArchiveOutcome | undefined> {
    const account = this.#account()
    if (plan.anyway) {
      // The person's word, with nothing packed: its records are kept, its checkout's changes since it moved aren't.
      hostLog("archives", "an archive keeps only its records, as its person asked", { op: plan.op, thread: plan.thread })
      return undefined
    }
    // Never archived without its checkout unasked: what this Mac doesn't know the machine runs, it can't ask it to pack.
    if (!plan.conversations.length || !plan.folder) {
      const reason = "Mako can't tell yet what this Thread runs in the cloud, so its checkout can't be saved. Try again in a moment."
      const cancelled = await account.cancelReturn(plan.thread, plan.op, reason)
      if (cancelled.phase === "cancelled") return this.#refused(plan, reason, true)
      throw new Error(`the cloud reads the archive as ${cancelled.phase} after it was cancelled`)
    }
    const packed = await this.#options.cloud
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

  async #refused(plan: Plan, reason: string, unstarted = false): Promise<CloudArchiveOutcome> {
    plan.phase = "cancelled"
    plan.reason = reason
    await this.#write(plan)
    hostLog("archives", "an archive was refused; the Thread goes on as it was", { op: plan.op, thread: plan.thread, reason, conversations: plan.conversations.join(", "), folder: plan.folder })
    return { kind: "refused", thread: plan.thread, reason, ...(unstarted && { anyway: true as const }) }
  }

  async #done(plan: Plan, how: string): Promise<CloudArchiveOutcome> {
    plan.phase = "archived"
    plan.timings.archived = Date.now() - plan.began
    await this.#write(plan)
    hostLog("archives", "a cloud Thread was archived", { op: plan.op, thread: plan.thread, how, conversations: plan.conversations.length, ...plan.timings })
    return { kind: "archived", thread: plan.thread }
  }

  #account(): CloudAccount {
    const account = this.#options.account()
    if (!account) throw new Error("This Mac signed out of Mako Cloud.")
    return account
  }

  async #read(op: string): Promise<Plan> {
    return PlanSchema.parse(JSON.parse(await readFile(join(this.#options.folder, `${op}.json`), "utf8")))
  }

  async #write(plan: Plan): Promise<void> {
    await mkdir(this.#options.folder, { recursive: true })
    const file = join(this.#options.folder, `${plan.op}.json`)
    await writeFile(`${file}.tmp`, JSON.stringify(PlanSchema.parse(plan)))
    await rename(`${file}.tmp`, file)
  }
}
