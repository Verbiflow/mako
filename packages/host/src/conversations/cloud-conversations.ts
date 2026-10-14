import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { threadStream, type Actor, type ClientSessionOverSockets, type Subscription } from "@mako/protocol"
import { z } from "zod"
import { hostHistoryPaging } from "../base/host-client.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, githubRepositoryUrl, type CloudRepository } from "../contracts/cloud-threads.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"
import { sessionAfter, type LiveBatch, type LiveStartOptions, type LiveSummary } from "../contracts/live-conversations.js"
import { decodeRuntimeValue, splitRuntimeEventLine, type EncodedValue, type RuntimeEvent } from "../contracts/runtime-value.js"
import { gatewayHostCalls } from "../transport/index.js"
import type { CloudAccount } from "../usage/index.js"
import { conversationCallId, type ConversationRoutingResult } from "./shared-conversations.js"

/** The newest this many are kept, and followed while they're open. */
const KEPT = 50
const RETRY_MS = 1_000
const RETRY_MAX_MS = 30_000
const SAVE_MS = 1_000

const SummaryIdentitySchema = z.object({ session: z.object({ id: z.string(), status: z.string() }).loose(), revision: z.number(), createdAt: z.number() }).loose()
/** A cloud host's own `LiveSummary`, checked for the identity and revision this router reads. */
const LiveSummarySchema = z.custom<LiveSummary>((value) => SummaryIdentitySchema.safeParse(value).success)
/** A cloud host's own `LiveBatch`, checked for the revision a summary follows. */
const LiveBatchSchema = z.custom<LiveBatch>((value) => z.object({ revision: z.number() }).loose().safeParse(value).success)

const EntrySchema = z.object({
  conversationId: z.string(),
  threadId: z.string(),
  harness: z.string(),
  repository: CloudRepositorySchema,
  createdAt: z.number(),
  /** The cloud has the Thread: made once, so a start repeated after a crash makes it again under the same ID only until then. */
  created: z.boolean(),
  /** The last of the Thread's events this host relayed; it follows on from there. */
  seq: z.number().int().nonnegative(),
  summary: LiveSummarySchema.optional(),
})

type Entry = z.infer<typeof EntrySchema>

const StoredSchema = z.object({ conversations: z.array(EntrySchema) })

/** What a start reads of the cloud host's boot: the folder of its tab in front, which is the clone. */
const BootTabsSchema = z.object({
  activeTabId: z.string(),
  tabs: z.array(z.object({ id: z.string(), session: z.object({ meta: z.object({ cwd: z.string() }).loose() }).loose() }).loose()),
}).loose()

const LiveBatchHeadSchema = z.object({ channel: z.string(), type: z.string().optional(), conversation: z.string().optional() })

export type CloudConversationsOptions = {
  /** The Mako account, once its domain is loaded. */
  account(): CloudAccount | undefined
  /** Where the cloud conversations this Mac started are remembered. */
  file: string
  /** Sends an event to this host's windows, as its own conversations' events go. */
  emit(event: RuntimeEvent): void
  /** The GitHub repository a folder of this Mac's works in, for a start that names none. */
  repositoryOf(cwd: string): Promise<CloudRepository>
}

/** The folder's `origin`, when it's on GitHub, and its upstream branch there. */
export async function folderRepository(git: { output(cwd: string, args: readonly string[]): Promise<string> }, cwd: string): Promise<CloudRepository> {
  const url = githubRepositoryUrl(await git.output(cwd, ["remote", "get-url", "origin"]).catch(() => ""))
  if (!url) throw new Error("A cloud Thread works in a GitHub repository, and this folder's origin isn't one.")
  const upstream = await git.output(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")
  const branch = upstream.trim().startsWith("origin/") ? upstream.trim().slice("origin/".length) : ""
  return CloudRepositorySchema.parse(branch ? { url, branch } : { url })
}

/**
 * The conversations this Mac started on cloud machines. Each is a live conversation on its own cloud Thread: the
 * start makes the Thread for its repository and starts the conversation on the machine's host, every call naming
 * the conversation goes there through the cloud, and its events come back from the Thread's stream to this host's
 * windows as its own conversations' do. The Thread keeps every event, so a Mac that slept catches up from the last
 * one it relayed; nothing here wakes a machine except a call to it.
 */
export class CloudConversations {
  readonly #options: CloudConversationsOptions
  readonly #entries = new Map<string, Entry>()
  readonly #following = new Map<string, Subscription | undefined>()
  #loading: Promise<void> | undefined
  #session: { deviceId: string; session: ClientSessionOverSockets } | undefined
  #saving: NodeJS.Timeout | undefined
  #writing: Promise<void> = Promise.resolve()
  #closed = false

  constructor(options: CloudConversationsOptions) {
    this.#options = options
  }

  /** Reads what this Mac remembers and follows each open conversation's Thread. */
  start(): Promise<void> {
    this.#loading ??= this.#load()
    return this.#loading
  }

  /** The remembered conversations, as the host's own live conversations are listed at boot. */
  summaries(): LiveSummary[] {
    return [...this.#entries.values()].flatMap((entry) => (entry.summary ? [entry.summary] : []))
  }

  /** A call this router answers: a cloud start, or a call naming one of its conversations. */
  async route(channel: string, args: unknown[]): Promise<ConversationRoutingResult> {
    if (channel === "mako:live-start") {
      // SAFETY: the dispatcher parsed this call's arguments with `mako:live-start`'s schema before routing it.
      const [harness, cwd, options] = args as [string, string, LiveStartOptions]
      if (!options.cloud) return { handled: false }
      return { handled: true, value: await this.#start(harness, cwd, options) }
    }
    const id = conversationCallId(channel, args)
    if (!id) return { handled: false }
    await this.start()
    const entry = this.#entries.get(id)
    if (!entry) return { handled: false }
    return { handled: true, value: await this.#call(entry, channel, args) }
  }

  dispose(): void {
    this.#closed = true
    clearTimeout(this.#saving)
    for (const subscription of this.#following.values()) subscription?.close()
    this.#following.clear()
    this.#session?.session.close()
    this.#session = undefined
  }

  async #start(harness: string, folder: string, options: LiveStartOptions): Promise<EncodedValue> {
    await this.start()
    let entry = this.#entries.get(options.conversationId)
    if (!entry) {
      const named = options.cloud?.repository
      const repository = named ? CloudRepositorySchema.parse(named) : await this.#options.repositoryOf(folder)
      entry = {
        conversationId: options.conversationId,
        threadId: `t-${randomBytes(8).toString("hex")}`,
        harness,
        repository,
        createdAt: Date.now(),
        created: false,
        seq: 0,
      }
      this.#entries.set(entry.conversationId, entry)
      // Remembered before the cloud is asked, so a start repeated after a crash makes the same Thread.
      await this.#save()
    }
    const account = this.#account()
    if (!entry.created) {
      await account.createThread(entry.threadId, entry.repository)
      entry.created = true
      await this.#save()
      hostLog("cloud-conversations", "made a cloud Thread", { threadId: entry.threadId, conversationId: entry.conversationId, harness, repository: entry.repository.url })
    }
    this.#follow(entry)
    const boot = BootTabsSchema.parse(decodeRuntimeValue(await this.#call(entry, "mako:boot", [])))
    const cwd = boot.tabs.find((tab) => tab.id === boot.activeTabId)?.session.meta.cwd
    if (!cwd) throw new Error("The cloud machine has no folder to work in")
    // The machine's own start: in its clone, with nothing of this Mac's folders or Thread store.
    const start: LiveStartOptions = { ...options }
    for (const key of ["cloud", "worktree", "worktreeStart", "session", "threadPath"] as const) delete start[key]
    const value = await this.#call(entry, "mako:live-start", [harness, cwd, start])
    entry.summary = summaryOf(LiveSummarySchema.parse(decodeRuntimeValue(value)))
    this.#saveSoon()
    return value
  }

  async #call(entry: Entry, channel: string, args: readonly unknown[]): Promise<EncodedValue> {
    const { session, deviceId } = await this.#connected()
    const actor: Actor = { kind: "client", client: "desktop", deviceId }
    try {
      return await gatewayHostCalls(session, { threadId: entry.threadId, actor, history: hostHistoryPaging() }).call(channel, args)(1)
    } catch (error) {
      // As a call to another host's conversation: the window settles a lost one by its own ids, never this router.
      if (error instanceof RuntimeDisconnectedError) throw new RuntimeDisconnectedError(error.unconfirmed, entry.conversationId)
      throw error
    }
  }

  #account(): CloudAccount {
    const account = this.#options.account()
    if (!account) throw new Error("This Mac isn't signed in to Mako.")
    return account
  }

  /** One session as this Mac's device, opened again when the device changed with a sign-in. */
  async #connected(): Promise<{ session: ClientSessionOverSockets; deviceId: string }> {
    const account = this.#account()
    const deviceId = await account.deviceId()
    if (!deviceId) throw new Error("This Mac isn't signed in to Mako.")
    if (this.#session?.deviceId !== deviceId) {
      this.#session?.session.close()
      this.#session = { deviceId, session: account.session() }
    }
    return this.#session
  }

  /** Relays the Thread's events from the last one relayed, resubscribing with a backoff whenever the stream ends. */
  #follow(entry: Entry): void {
    if (this.#closed || this.#following.has(entry.threadId)) return
    this.#following.set(entry.threadId, undefined)
    const run = async () => {
      let wait = RETRY_MS
      let failing = false
      while (!this.#closed && this.#entries.get(entry.conversationId) === entry) {
        try {
          const { session } = await this.#connected()
          const subscription = session.subscribe({ stream: threadStream(entry.threadId), after: entry.seq })
          this.#following.set(entry.threadId, subscription)
          for (;;) {
            const frame = await subscription.next()
            if (frame.seq <= entry.seq) continue
            entry.seq = frame.seq
            this.#relay(entry, frame.event.text)
            this.#saveSoon()
            wait = RETRY_MS
            failing = false
          }
        } catch (error) {
          if (this.#closed) return
          if (!failing) hostWarn("cloud-conversations", "a cloud Thread's events stopped; following again", { threadId: entry.threadId, error: error instanceof Error ? error.message : String(error) })
          failing = true
        }
        await new Promise((resolve) => setTimeout(resolve, wait).unref())
        wait = Math.min(wait * 2, RETRY_MAX_MS)
      }
    }
    void run().finally(() => this.#following.delete(entry.threadId))
  }

  #relay(entry: Entry, line: string): void {
    const parts = splitRuntimeEventLine(line)
    if (!parts) return
    const head = LiveBatchHeadSchema.safeParse(JSON.parse(parts.head))
    if (!head.success || head.data.channel !== "event" || head.data.type !== "live-batch" || head.data.conversation !== entry.conversationId) return
    if (entry.summary) {
      const { batch } = z.object({ batch: LiveBatchSchema }).parse(JSON.parse(parts.payload))
      const summary: LiveSummary = { ...entry.summary, session: sessionAfter(entry.summary.session, batch), revision: batch.revision }
      if (batch.epoch) summary.epoch = batch.epoch
      entry.summary = summaryOf(summary)
    }
    this.#options.emit({ type: "live-batch", conversation: entry.conversationId, payload: parts.payload })
  }

  async #load(): Promise<void> {
    const text = await readFile(this.#options.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text !== undefined) {
      const stored = StoredSchema.safeParse(JSON.parse(text))
      if (!stored.success) hostWarn("cloud-conversations", "the remembered cloud conversations couldn't be read; starting from none", { file: this.#options.file })
      for (const entry of stored.data?.conversations ?? []) this.#entries.set(entry.conversationId, entry)
    }
    for (const entry of this.#entries.values()) if (entry.created && entry.summary?.session.status !== "closed") this.#follow(entry)
  }

  #saveSoon(): void {
    if (this.#saving) return
    this.#saving = setTimeout(() => {
      this.#saving = undefined
      void this.#save().catch((error: Error) => hostWarn("cloud-conversations", "couldn't remember the cloud conversations", { error: error.message }))
    }, SAVE_MS)
    this.#saving.unref()
  }

  #save(): Promise<void> {
    const kept = [...this.#entries.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, KEPT)
    for (const entry of this.#entries.values()) if (!kept.includes(entry)) this.#entries.delete(entry.conversationId)
    const text = JSON.stringify({ conversations: kept })
    const file = this.#options.file
    const write = this.#writing.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(`${file}.tmp`, text, { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    })
    this.#writing = write.catch(() => {})
    return write
  }
}

/** A snapshot's summary fields, which are all a window needs to list the conversation before it opens it. */
function summaryOf(snapshot: LiveSummary): LiveSummary {
  const summary: LiveSummary = { session: snapshot.session, revision: snapshot.revision, createdAt: snapshot.createdAt }
  if (snapshot.epoch) summary.epoch = snapshot.epoch
  if (snapshot.threadPath) summary.threadPath = snapshot.threadPath
  if (snapshot.nativePaths) summary.nativePaths = snapshot.nativePaths
  if (snapshot.hasSessionQuestions) summary.hasSessionQuestions = snapshot.hasSessionQuestions
  return summary
}
