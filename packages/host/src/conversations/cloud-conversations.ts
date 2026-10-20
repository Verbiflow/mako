import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { threadStream, type Actor, type ClientSessionOverSockets, type Subscription } from "@mako/protocol"
import { z } from "zod"
import { hostHistoryPaging } from "../base/host-client.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, githubRepositoryUrl, type CloudPrepareLaunch, type CloudPrepareOutcome, type CloudRepository, type CloudStartStep } from "../contracts/cloud-threads.js"
import { hostCallReplay } from "../contracts/host-call-policy.js"
import { CLOUD_CALL_UNCONFIRMED_MESSAGE, CLOUD_RECONNECTING_MESSAGE, RuntimeDisconnectedError } from "../contracts/host-connection.js"
import { sessionAfter, type LiveBatch, type LiveStartOptions, type LiveSummary } from "../contracts/live-conversations.js"
import { decodeRuntimeValue, encodeRuntimeEvent, encodeRuntimeValue, splitRuntimeEventLine, type EncodedValue, type RuntimeEvent } from "../contracts/runtime-value.js"
import { gatewayHostCalls } from "../transport/index.js"
import type { GatewayHostCallsOptions } from "../transport/gateway-client.js"
import type { CloudAccount } from "../usage/index.js"
import { conversationCallId, type ConversationRoutingResult } from "./shared-conversations.js"

/** The newest this many are kept, and followed while they're open. */
const KEPT = 50
const RETRY_MS = 1_000
const RETRY_MAX_MS = 30_000
/** For this long after a wake, a follow tries again this often: the network comes back within a second or two. */
const WOKEN_MS = 15_000
const WOKEN_RETRY_MS = 250
const SAVE_MS = 1_000
/** How long a call that didn't reach its Thread is repeated before the window hears of it: a wake takes seconds. */
const CLOUD_REPEAT_MS = 60_000
const CLOUD_REPEAT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const
/** A Thread made ahead is taken up only this soon after this Mac last asked: the cloud ends one unused 30 minutes on. */
const PREPARED_KEPT_MS = 25 * 60_000
/**
 * Asked this recently and ready then, its machine still runs: the composer asks at most every 30 s while the person
 * writes, and the cloud keeps an idle machine at least two minutes from the last ask.
 */
const READY_AFTER_ASK_MS = 60_000
/** After this many made ahead in a row went unused for one repository, the next waits for this much writing. */
const UNUSED_BEFORE_WARY = 3
const WARY_COMPOSING_MS = 10_000

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
  /** The window's own ID for a conversation that took one started ahead (`conversationId`), so a repeated start finds it. */
  startedAs: z.string().optional(),
  summary: LiveSummarySchema.optional(),
})

type Entry = z.infer<typeof EntrySchema>

/**
 * A cloud Thread made ahead of a new conversation's first message, while the person writes it with Cloud chosen.
 * Only in memory: one this Mac forgets is the cloud's to end.
 */
type Prepared = {
  threadId: string
  repository: CloudRepository
  since: number
  /** When this Mac last asked (`Date.now()`), and whether its machine was ready then. */
  askedAt: number
  ready: boolean
  /** The last ask; the Thread is made once one has answered. */
  asking: Promise<void>
  made: boolean
  /** The conversation started on its machine once it was ready, its harness running before the first message. */
  started?: StartedAhead
}

/**
 * A conversation started ahead on a Thread made ahead: the harness and settings the composer had (`key`), its folder
 * on the machine, and its start, which resolves to whether it went.
 */
type StartedAhead = { conversationId: string; key: string; cwd: string | undefined; starting: Promise<boolean> }

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

/** The folder the machine's host works in: its tab in front, which is the clone. */
function bootFolder(boot: EncodedValue): string {
  const tabs = BootTabsSchema.parse(decodeRuntimeValue(boot))
  const cwd = tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.session.meta.cwd
  if (!cwd) throw new Error("The cloud machine has no folder to work in")
  return cwd
}

/** A harness with its settings, as two starts that would begin the same compare. */
function launchKey(harness: string, modeId: string | undefined, tuning: LiveStartOptions["tuning"]): string {
  const options = tuning?.options ? Object.fromEntries(Object.entries(tuning.options).sort(([a], [b]) => a.localeCompare(b))) : undefined
  return JSON.stringify([harness, modeId ?? null, tuning?.model ?? null, options ?? null])
}

function newThreadId(): string {
  return `t-${randomBytes(8).toString("hex")}`
}

function repositoryKey(repository: CloudRepository): string {
  return `${repository.url}#${repository.branch ?? ""}`
}

/** A repository as a person names their project: its name on GitHub. */
function projectName(repository: CloudRepository): string {
  return repository.url.slice(repository.url.lastIndexOf("/") + 1)
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
  /** Counts wakes, so a follow that was waiting out its backoff, or lost its stream to one, follows again at once. */
  #wakes = 0
  #wokeAt = Number.NEGATIVE_INFINITY
  readonly #pauses = new Set<() => void>()
  /** By repository: one made ahead at a time for each. */
  readonly #prepared = new Map<string, Prepared>()
  /** By repository: how many made ahead in a row went unused. */
  readonly #unused = new Map<string, number>()

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
    if (channel === "mako:cloud-prepare") {
      // SAFETY: the dispatcher parsed this call's arguments with `mako:cloud-prepare`'s schema before routing it.
      const [folder, composingMs, launch] = args as [string, number, CloudPrepareLaunch | undefined]
      return { handled: true, value: encodeRuntimeValue(await this.prepare(folder, composingMs, launch)) }
    }
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

  /**
   * After a sleep or a network change: a connection that went quiet ends now, and each Thread is followed again at
   * once from the last event relayed, so what the machine did meanwhile arrives as soon as the network is back.
   */
  wake(): void {
    this.#wakes += 1
    this.#wokeAt = performance.now()
    this.#session?.session.wake()
    for (const resume of this.#pauses) resume()
  }

  dispose(): void {
    this.#closed = true
    for (const resume of this.#pauses) resume()
    clearTimeout(this.#saving)
    for (const subscription of this.#following.values()) subscription?.close()
    this.#following.clear()
    this.#session?.session.close()
    this.#session = undefined
  }

  /**
   * The person is writing a new cloud conversation's first message in `folder`, for `composingMs` so far: its Thread
   * is made ahead, one per repository, and its machine starts and clones while they write. Asked again as they go
   * on, which keeps the machine running. The first message takes the Thread up (`#start`); one left too long is the
   * cloud's to end, and the next ask makes another. After a few in a row went unused, it waits for more writing.
   * With `launch`, once the machine is ready, the conversation is started there too, its harness running before the
   * message comes (`#startAhead`).
   */
  async prepare(folder: string, composingMs: number, launch?: CloudPrepareLaunch): Promise<CloudPrepareOutcome> {
    await this.start()
    const account = this.#options.account()
    if (!account || !(await account.deviceId())) return "none"
    const repository = await this.#options.repositoryOf(folder).catch(() => undefined)
    if (!repository) return "none"
    const key = repositoryKey(repository)
    let prepared = this.#fresh(key)
    if (!prepared) {
      if ((this.#unused.get(key) ?? 0) >= UNUSED_BEFORE_WARY && composingMs < WARY_COMPOSING_MS) return "later"
      prepared = { threadId: newThreadId(), repository, since: Date.now(), askedAt: Date.now(), ready: false, asking: Promise.resolve(), made: false }
      this.#prepared.set(key, prepared)
      hostLog("cloud-conversations", "making a cloud Thread ahead of its first message", { threadId: prepared.threadId, repository: repository.url })
    }
    const asked = prepared
    asked.askedAt = Date.now()
    asked.asking = account.createThread(asked.threadId, repository, { prepare: true }).then(({ ready }) => {
      asked.made = true
      asked.ready = ready
    })
    try {
      await asked.asking
    } catch (error) {
      // Never made: the next ask starts afresh. Made already, it stays for its next ask or its first message.
      if (!asked.made && this.#prepared.get(key) === asked) this.#prepared.delete(key)
      hostWarn("cloud-conversations", "a cloud Thread wasn't made ahead", { threadId: asked.threadId, error: error instanceof Error ? error.message : String(error) })
      return "none"
    }
    if (asked.ready && launch) this.#startAhead(asked, launch)
    return asked.ready ? "ready" : "preparing"
  }

  /**
   * Starts the conversation on a Thread made ahead whose machine is ready, with the composer's harness and settings and
   * no message, so its harness is up when the message comes. Its calls are made ahead (`OperationEnvelope.ahead`): the
   * Thread stays made ahead. A different choice since replaces it; one that didn't start is left for the send to do.
   * A harness's start uses no model, so this costs nothing beyond the machine already running.
   */
  #startAhead(prepared: Prepared, launch: CloudPrepareLaunch): void {
    const key = launchKey(launch.harness, launch.modeId, launch.tuning)
    if (prepared.started?.key === key) return
    const previous = prepared.started
    const started: StartedAhead = { conversationId: randomUUID(), key, cwd: undefined, starting: Promise.resolve(false) }
    const ahead = { ahead: true }
    started.starting = (async () => {
      try {
        if (previous) await this.#callThread(prepared.threadId, "mako:live-close", [previous.conversationId], ahead).catch(() => undefined)
        started.cwd = bootFolder(await this.#callThread(prepared.threadId, "mako:boot", [], ahead))
        const options: LiveStartOptions = { conversationId: started.conversationId }
        if (launch.modeId) options.modeId = launch.modeId
        if (launch.tuning) options.tuning = launch.tuning
        await this.#callThread(prepared.threadId, "mako:live-start", [launch.harness, started.cwd, options], ahead)
        hostLog("cloud-conversations", "started a harness ahead of its first message", { threadId: prepared.threadId, conversationId: started.conversationId, harness: launch.harness })
        return true
      } catch (error) {
        hostWarn("cloud-conversations", "a harness wasn't started ahead; the send starts it", { threadId: prepared.threadId, harness: launch.harness, error: error instanceof Error ? error.message : String(error) })
        if (prepared.started === started) delete prepared.started
        return false
      }
    })()
    prepared.started = started
  }

  /** The Thread made ahead for a repository, unless this Mac last asked for it too long ago: that one went unused. */
  #fresh(key: string): Prepared | undefined {
    const prepared = this.#prepared.get(key)
    if (!prepared || Date.now() - prepared.askedAt < PREPARED_KEPT_MS) return prepared
    this.#prepared.delete(key)
    const unused = (this.#unused.get(key) ?? 0) + 1
    this.#unused.set(key, unused)
    hostLog("cloud-conversations", "a cloud Thread made ahead went unused", { threadId: prepared.threadId, unused })
    return undefined
  }

  /** The Thread made ahead for a repository, for a new conversation to start in once it's made; none to take, undefined. */
  async #take(repository: CloudRepository): Promise<Prepared | undefined> {
    const key = repositoryKey(repository)
    const prepared = this.#fresh(key)
    if (!prepared) return undefined
    this.#prepared.delete(key)
    await prepared.asking.catch(() => undefined)
    if (!prepared.made) return undefined
    this.#unused.delete(key)
    hostLog("cloud-conversations", "a new conversation takes up the cloud Thread made ahead", { threadId: prepared.threadId, aheadMs: Date.now() - prepared.since, sinceAskedMs: Date.now() - prepared.askedAt, ready: prepared.ready })
    return prepared
  }

  /**
   * The conversation started ahead on a Thread taken up, when the send's harness and settings are the ones it started
   * with and its start went; one that differs is closed, and the send starts its own.
   */
  async #aheadFor(prepared: Prepared, harness: string, options: LiveStartOptions): Promise<StartedAhead | undefined> {
    const started = prepared.started
    if (!started) return undefined
    if (started.key === launchKey(harness, options.modeId, options.tuning) && (await started.starting)) return started
    void this.#callThread(prepared.threadId, "mako:live-close", [started.conversationId], {}).catch(() => undefined)
    hostLog("cloud-conversations", "the send's harness or settings changed since one was started ahead; it starts its own", { threadId: prepared.threadId })
    return undefined
  }

  /** Where a new cloud conversation's start is, for its window: in words about its project and its harness, never the machine. */
  #step(conversationId: string, step: CloudStartStep, repository: CloudRepository): void {
    this.#options.emit(encodeRuntimeEvent({ type: "cloud-start-step", conversationId, step, project: projectName(repository) }))
  }

  async #start(harness: string, folder: string, options: LiveStartOptions): Promise<EncodedValue> {
    await this.start()
    let entry = this.#entries.get(options.conversationId) ?? [...this.#entries.values()].find((known) => known.startedAs === options.conversationId)
    let step: CloudStartStep = "preparing"
    let ahead: StartedAhead | undefined
    if (!entry) {
      const named = options.cloud?.repository
      const repository = named ? CloudRepositorySchema.parse(named) : await this.#options.repositoryOf(folder)
      const prepared = await this.#take(repository)
      ahead = prepared && (await this.#aheadFor(prepared, harness, options))
      // Ready a moment ago, it's ready now: the window goes straight to the harness starting.
      if (ahead || (prepared?.ready && Date.now() - prepared.askedAt < READY_AFTER_ASK_MS)) step = "starting"
      this.#step(options.conversationId, step, repository)
      entry = {
        // A conversation started ahead goes on under its own ID; the window takes it up from the start's answer.
        conversationId: ahead?.conversationId ?? options.conversationId,
        threadId: prepared?.threadId ?? newThreadId(),
        harness,
        repository,
        createdAt: Date.now(),
        created: prepared !== undefined,
        seq: 0,
      }
      if (ahead) entry.startedAs = options.conversationId
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
    const cwd = ahead?.cwd ?? bootFolder(await this.#call(entry, "mako:boot", []))
    if (step !== "starting") this.#step(options.conversationId, "starting", entry.repository)
    // The machine's own start: in its clone, with nothing of this Mac's folders or Thread store. Repeated for a
    // conversation started ahead, it brings the first message (`LiveConversations.firstMessage` on the machine).
    const start: LiveStartOptions = { ...options, conversationId: entry.conversationId }
    for (const key of ["cloud", "worktree", "worktreeStart", "session", "threadPath"] as const) delete start[key]
    const value = await this.#call(entry, "mako:live-start", [harness, cwd, start])
    entry.summary = summaryOf(LiveSummarySchema.parse(decodeRuntimeValue(value)))
    this.#saveSoon()
    return value
  }

  /**
   * One call to the Thread's machine. A call the gateway lost on the way (its machine's link changed under it) or
   * still holds while the machine wakes is repeated here, under its one id, for as long as `CLOUD_REPEAT_MS`, when a
   * repeat can't do it twice (a read, or a call the host settles by its id): the gateway answers a repeat with the
   * first answer. So a send after the machine slept arrives, without the window hearing of the wake. Past that, or
   * for a call only the person may repeat, the window hears it as a reconnect, in a cloud Thread's words.
   */
  #call(entry: Entry, channel: string, args: readonly unknown[]): Promise<EncodedValue> {
    return this.#callThread(entry.threadId, channel, args, { conversationId: entry.conversationId })
  }

  /** `#call` to a Thread by its ID, for its conversation when it has one, or made ahead of a person's message. */
  async #callThread(threadId: string, channel: string, args: readonly unknown[], how: { conversationId?: string; ahead?: boolean }): Promise<EncodedValue> {
    const { session, deviceId } = await this.#connected()
    const actor: Actor = { kind: "client", client: "desktop", deviceId }
    const calls: GatewayHostCallsOptions = { threadId, actor, history: hostHistoryPaging() }
    if (how.ahead) calls.ahead = true
    const send = gatewayHostCalls(session, calls).call(channel, args)
    const repeatable = hostCallReplay(channel) !== "never"
    const began = performance.now()
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(attempt)
      } catch (error) {
        if (!(error instanceof RuntimeDisconnectedError)) throw error
        const waitMs = CLOUD_REPEAT_BACKOFF_MS[Math.min(attempt - 1, CLOUD_REPEAT_BACKOFF_MS.length - 1)]!
        if (repeatable && attempt < 8 && performance.now() - began + waitMs < CLOUD_REPEAT_MS) {
          hostLog("cloud-conversations", "a call didn't reach the Thread yet; repeating it", { threadId, channel, attempt, inMs: waitMs })
          await new Promise((resolve) => setTimeout(resolve, waitMs))
          continue
        }
        // As a call to another host's conversation: the window settles a lost one by its own ids, never this router.
        throw new RuntimeDisconnectedError(error.unconfirmed, how.conversationId, error.unconfirmed && !repeatable ? CLOUD_CALL_UNCONFIRMED_MESSAGE : CLOUD_RECONNECTING_MESSAGE)
      }
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
      let wakes = this.#wakes
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
        const woken = performance.now() - this.#wokeAt < WOKEN_MS
        if (this.#wakes === wakes) await this.#pause(woken ? WOKEN_RETRY_MS : wait)
        if (this.#wakes !== wakes) {
          // Woken: the stream that ended went with the sleep, and the network may be back; no backoff carried over.
          wakes = this.#wakes
          wait = RETRY_MS
          continue
        }
        wait = Math.min(wait * 2, RETRY_MAX_MS)
      }
    }
    void run().finally(() => this.#following.delete(entry.threadId))
  }

  /** Waits `ms`, or less when the Mac wakes or this closes. */
  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const resume = () => {
        clearTimeout(timer)
        this.#pauses.delete(resume)
        resolve()
      }
      const timer = setTimeout(resume, ms)
      timer.unref()
      this.#pauses.add(resume)
    })
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
