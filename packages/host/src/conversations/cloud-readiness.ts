import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { withFreshLink, type RecordsLink, type SentRecords } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, type CloudRepository } from "../contracts/cloud-threads.js"
import type { CloudAccount } from "../usage/index.js"
import { captureMoveCheckpoint } from "../workspaces/index.js"
import type { WorkingThread } from "./cloud-handoffs.js"

/** How often a Thread at work is brought up to date in its cloud Thread standing by. */
export const READY_EVERY_MS = 30_000
/** After a move takes a Thread's cloud Thread, it isn't kept ready again for this long: it's leaving, or it stayed. */
const TAKEN_REST_MS = 5 * 60_000
/** A Thread standing by that nothing has used or brought up to date for this long is forgotten here. */
const READY_KEPT_MS = 7 * 24 * 60 * 60_000

const ReadyEntrySchema = z.object({
  cloudThread: z.string(),
  folder: z.string(),
  repository: CloudRepositorySchema,
  /** The checkout as last sent, by its checkpoint's hash: sent again only when it changed. */
  checkpoint: z.string().optional(),
  at: z.number(),
})
type ReadyEntry = z.infer<typeof ReadyEntrySchema>
const ReadyFileSchema = z.object({ version: z.literal(1), threads: z.record(z.string(), ReadyEntrySchema) })

/** What keeping a Thread ready asks of the account: a cloud Thread standing by, its checkpoints and its records. */
export type ReadinessAccount = Pick<CloudAccount, "createThread" | "sendCheckpoint" | "threadRecords">

/** What a move of a Thread would carry, read as its plan reads it: refused when it couldn't move. */
export type ReadyPlan = { thread: string; folder: string; repository: CloudRepository; paths: string[]; harness: string }

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
  /** Whether a move of the Thread runs now: one on its way isn't kept ready (`CloudMoves.leaving`). */
  leaving(thread: string): boolean
  /** What a move of the Thread of `conversationId` would carry; throws, saying why, when it couldn't move. */
  plan(conversationId: string): Promise<ReadyPlan>
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  newCloudThread(): string
}

/**
 * Keeping this Mac's Threads at work ready to move (rule 3 of moves): while a Thread works here and could be handed
 * to the cloud, a cloud Thread stands by for it (made with `standby`: no machine until a move's first call), and its
 * checkout and its sessions' records are sent there as they change, every `READY_EVERY_MS`, only what changed. A move
 * then takes that cloud Thread (`take`) and sends only the last seconds, so a handoff as the lid closes fits in the
 * moments macOS gives. A cloud Thread a move took isn't kept ready again: the next Thread to stand by is a new one.
 * Only while the person lets agents be handed off as this Mac sleeps: nothing of a Thread goes to the cloud otherwise.
 */
export class CloudReadiness {
  readonly #options: CloudReadinessOptions
  #entries: Record<string, ReadyEntry> | undefined
  /** Writes, one at a time: rounds for several Threads save as they finish. */
  #writing: Promise<void> = Promise.resolve()
  /** By local Thread: a round bringing it up to date, which `take` waits for. */
  readonly #rounds = new Map<string, Promise<void>>()
  /** By local Thread: why it couldn't be kept ready, said once until it changes. */
  readonly #said = new Map<string, string>()
  /** By local Thread: when a move took its cloud Thread. */
  readonly #taken = new Map<string, number>()

  constructor(options: CloudReadinessOptions) {
    this.#options = options
  }

  /** Brings every Thread at work up to date in its cloud Thread standing by, one round each. */
  async refresh(): Promise<void> {
    if (!(await this.#options.enabled())) return
    const resting = (thread: string) => this.#options.leaving(thread) || Date.now() - (this.#taken.get(thread) ?? Number.NEGATIVE_INFINITY) < TAKEN_REST_MS
    await Promise.all(this.#options.working().filter((working) => !resting(working.thread)).map((working) => this.#round(working)))
    await this.#prune()
  }

  /**
   * The cloud Thread standing by for `thread`, for a move of it to take, when it stands by for the same folder and
   * repository: once taken, it's this move's alone. Waits for a round still sending to it.
   */
  async take(thread: string, folder: string, repository: CloudRepository): Promise<string | undefined> {
    await this.#rounds.get(thread)?.catch(() => undefined)
    const entries = await this.#load()
    const entry = entries[thread]
    if (!entry || entry.folder !== folder || entry.repository.url !== repository.url) return undefined
    this.#taken.set(thread, Date.now())
    delete entries[thread]
    await this.#save()
    hostLog("readiness", "a move takes the cloud Thread kept ready for it", { thread, cloudThread: entry.cloudThread, readyForMs: Date.now() - entry.at })
    return entry.cloudThread
  }

  #round(working: WorkingThread): Promise<void> {
    const running = this.#rounds.get(working.thread)
    if (running) return running
    const round = this.#bringUp(working).finally(() => this.#rounds.delete(working.thread))
    this.#rounds.set(working.thread, round)
    return round
  }

  async #bringUp(working: WorkingThread): Promise<void> {
    const account = this.#options.account()
    if (!account) return
    let plan: ReadyPlan
    try {
      plan = await this.#options.plan(working.conversationId)
    } catch (error) {
      // A Thread that couldn't move (the main checkout, say) isn't kept ready; said once.
      this.#sayOnce(working.thread, "a Thread at work isn't kept ready to move", errorMessage({ error }))
      return
    }
    const entries = await this.#load()
    let entry = entries[plan.thread]
    if (!entry || entry.folder !== plan.folder || entry.repository.url !== plan.repository.url) {
      entry = { cloudThread: this.#options.newCloudThread(), folder: plan.folder, repository: plan.repository, at: Date.now() }
      entries[plan.thread] = entry
      await this.#save()
    }
    const ready = entry
    const began = performance.now()
    try {
      await account.createThread(ready.cloudThread, ready.repository, { folder: ready.folder, harness: plan.harness, standby: true })
      const [checkpoint, sent] = await Promise.all([
        this.#sendCheckpoint(account, ready),
        withFreshLink(() => account.threadRecords(ready.cloudThread), (link) => this.#options.sendRecords(link, plan.paths)),
      ])
      ready.at = Date.now()
      if (checkpoint) ready.checkpoint = checkpoint
      await this.#save()
      this.#said.delete(plan.thread)
      const versions = sent.reduce((total, each) => total + each.versions, 0)
      const bytes = sent.reduce((total, each) => total + each.bytes, 0)
      if (versions || checkpoint) hostLog("readiness", "a Thread at work was brought up to date in the cloud", { thread: plan.thread, cloudThread: ready.cloudThread, versions, bytes, checkpoint: checkpoint ? "sent" : "unchanged", ms: Math.round(performance.now() - began) })
    } catch (error) {
      this.#sayOnce(plan.thread, "a Thread at work couldn't be brought up to date in the cloud", errorMessage({ error }))
    }
  }

  /** The checkout's checkpoint, sent when it changed since the last; answers its hash when it went. */
  async #sendCheckpoint(account: ReadinessAccount, entry: ReadyEntry): Promise<string | undefined> {
    await mkdir(this.#options.scratch, { recursive: true })
    const scratch = await mkdtemp(join(this.#options.scratch, "ready-"))
    try {
      const { checkpoint, file } = await captureMoveCheckpoint(this.#options.git, entry.folder, scratch)
      if (checkpoint.sha256 === entry.checkpoint) return undefined
      await account.sendCheckpoint(entry.cloudThread, checkpoint, file)
      return checkpoint.sha256
    } finally {
      await rm(scratch, { recursive: true, force: true })
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
    const saved = ReadyFileSchema.safeParse(JSON.parse(await readFile(this.#options.file, "utf8").catch(() => "null")))
    this.#entries = saved.success ? saved.data.threads : {}
    return this.#entries
  }

  #save(): Promise<void> {
    const write = this.#writing.then(async () => {
      const threads = await this.#load()
      await mkdir(dirname(this.#options.file), { recursive: true })
      await writeFile(`${this.#options.file}.tmp`, JSON.stringify(ReadyFileSchema.parse({ version: 1, threads })), { mode: 0o600 })
      await rename(`${this.#options.file}.tmp`, this.#options.file)
    })
    this.#writing = write.catch(() => {})
    return write
  }
}
