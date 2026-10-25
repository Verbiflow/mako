import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { sessionStream, threadStream, type Actor, type ClientSessionOverSockets, type Subscription } from "@mako/protocol"
import { ControlActivitySchema } from "@mako/control-runtime/contracts"
import { z } from "zod"
import type { ListedSession, ListedState } from "@mako/protocol/thread-listing"
import { hostHistoryPaging } from "../base/host-client.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { CloudRepositorySchema, githubRepositoryUrl, type CloudPrepareLaunch, type CloudPrepareOutcome, type CloudProjectsOffer, type CloudRepository, type CloudStartStep } from "../contracts/cloud-threads.js"
import { hostCallReplay } from "../contracts/host-call-policy.js"
import { CLOUD_CALL_UNCONFIRMED_MESSAGE, CLOUD_RECONNECTING_MESSAGE, OwnerUnavailableError, RuntimeDisconnectedError } from "../contracts/host-connection.js"
import { ForkInputSchema } from "../contracts/conversation-control.js"
import { sessionAfter, type LiveBatch, type LiveSnapshot, type LiveStartOptions, type LiveSummary } from "../contracts/live-conversations.js"
import { decodeRuntimeValue, encodeRuntimeEvent, encodeRuntimeValue, splitRuntimeEventLine, type EncodedValue, type RuntimeEvent } from "../contracts/runtime-value.js"
import type { SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, type Actor as StoreActor, type SessionId, type ThreadPlacement } from "../contracts/thread-identity.js"
import { gatewayHostCalls, type GatewayHostCallsOptions } from "../transport/index.js"
import type { CloudAccount, CloudThreadMaking } from "../usage/index.js"
import { CloudControlPreviews } from "./cloud-control-previews.js"
import { cloudRuntimeOf, namedUuid } from "./cloud-moves.js"
import { AccountSessions } from "./account-threads.js"
import { CloudPreviews } from "./cloud-previews.js"
import { conversationCallId, type ConversationRoutingResult } from "./shared-conversations.js"
import { LiveHistoryReader } from "./live-history-reader.js"
import type { LiveHistoryRead } from "../contracts/live-history.js"
import type { ThreadPage } from "@mako/sessions"
import type { Entry as HistoryEntry } from "@mako/sessions/entries"
import type { CopyPage } from "@mako/sessions/reading-copies"

/** The newest this many are kept, and followed while they're open. */
const KEPT = 50
/** A device found off is read from the account's copy for this long before it's asked again. */
const ASLEEP_MS = 15_000
/** Entries a copy's snapshot holds; a reader asks for earlier ones by the page. */
const COPY_PAGE = 100
/** The calls a copy answers: reading the conversation. Anything else needs its device. */
const COPY_READS = new Set(["mako:live-snapshot", "mako:live-read"])
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
/**
 * While a Thread made ahead's machine comes up (about 12 s with a clone), it's asked again this often, for at most this
 * long, so its harness starts once the machine is ready rather than at the composer's next ask, half a minute on.
 */
const READY_ASK_MS = 2_000
const READY_ASK_FOR_MS = 90_000
/** Onboarding offers this many of the Mac's most recent projects for project bases. */
const PROJECTS_OFFERED = 5
const OfferedSchema = z.object({ accounts: z.array(z.string()) })

const SummaryIdentitySchema = z.object({ session: z.object({ id: z.string(), status: z.string() }).loose(), revision: z.number(), createdAt: z.number() }).loose()
/** A cloud host's own `LiveSummary`, checked for the identity and revision this router reads. */
const LiveSummarySchema = z.custom<LiveSummary>((value) => SummaryIdentitySchema.safeParse(value).success)
/** A cloud host's own `LiveBatch`, checked for the revision a summary follows. */
const LiveBatchSchema = z.custom<LiveBatch>((value) => z.object({ revision: z.number() }).loose().safeParse(value).success)

const EntrySchema = z.object({
  conversationId: z.string(),
  threadId: z.string(),
  harness: z.string(),
  /** The repository its cloud Thread clones; none for a conversation another device runs in its own folder. */
  repository: CloudRepositorySchema.optional(),
  createdAt: z.number(),
  /** The cloud has the Thread: made once, so a start repeated after a crash makes it again under the same ID only until then. */
  created: z.boolean(),
  /** The last of the Thread's events this host relayed; it follows on from there. */
  seq: z.number().int().nonnegative(),
  /** The window's own ID for a conversation that took one started ahead (`conversationId`), so a repeated start finds it. */
  startedAs: z.string().optional(),
  summary: LiveSummarySchema.optional(),
  /**
   * Listed by the account, not started or moved here: another device's, or one this Mac forgot. Known from the
   * account's list alone until a window opens it, and never remembered: the list says it again.
   */
  listed: z.literal(true).optional(),
  /**
   * Another device's runtime that runs it (`d-<device>`), for a listed conversation that isn't in the cloud: its calls
   * go there, and `threadId` holds its session stream (`sessionStream`), which carries its live updates while watched.
   */
  runtime: z.string().optional(),
  /**
   * A listed session Mako hasn't opened on its device (a terminal's): the path its device reads it at, which the first
   * call opening it captures there as this conversation (`mako:live-capture`). Gone once the list says it's open.
   */
  capture: z.string().optional(),
  /** Its native session, which its device's copy in the account is kept by: read while that device is off. */
  nativeId: z.string().optional(),
})

type Entry = z.infer<typeof EntrySchema>

/** How a list shows a Session's state, as a session's status: `waiting` is a turn at work, with what it waits on said beside. */
const LISTED_STATUS = { working: "running", waiting: "running", idle: "ready", failed: "failed", moving: "starting" } as const satisfies Record<ListedState, LiveSummary["session"]["status"]>

/**
 * What a window lists of a Session it knows only from the account's list: the row, where it runs in words, and nothing
 * that takes its owner. Opening it reads the rest there, as it would any cloud conversation's.
 */
function listedSummary(row: ListedSession, where: string): LiveSummary {
  const summary: LiveSummary = {
    session: {
      id: row.conversation,
      harness: row.harness,
      cwd: row.folder ?? "",
      status: LISTED_STATUS[row.state],
      connection: "hibernated",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 0,
    createdAt: Date.parse(row.createdAt),
    elsewhere: where,
    threadId: row.thread,
    sessionId: row.session,
  }
  if (row.title) summary.session.title = row.title
  if (row.waitingOn) summary.waitingOn = row.waitingOn
  return summary
}

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
  /** The composer's latest choice of harness, and the next ask while its machine comes up. */
  launch?: CloudPrepareLaunch
  watching?: ReturnType<typeof setTimeout>
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
const ControlActivityEventSchema = z.object({ type: z.literal("control-activity"), activity: ControlActivitySchema })

export type CloudConversationsOptions = {
  /** The Mako account, once its domain is loaded. */
  account(): CloudAccount | undefined
  /** Where the cloud conversations this Mac started are remembered. */
  file: string
  /** Sends an event to this host's windows, as its own conversations' events go. */
  emit(event: RuntimeEvent): void
  /** The GitHub repository a folder of this Mac's works in, for a start that names none. */
  repositoryOf(cwd: string): Promise<CloudRepository>
  /** A conversation's folder on its machine may have changed: its agent worked. At most once a `CHANGED_MS`. */
  changed?(conversationId: string): void
  /**
   * This Mac's Thread store, where a conversation begun in a Thread that moved to the cloud (a `+` tab, a fork) is
   * recorded: its Session runs where the Thread does, and the way back brings it here with the rest.
   */
  threads?(): AwayThreads | undefined
  /** Whether a cloud Thread is on its way back to this Mac: it begins no conversation meanwhile. */
  returning?(cloudThread: string): boolean
  /** The copies other devices keep of their Sessions in the account, read while a device is off. */
  copies?: CloudCopies
}

/** Copies another device keeps of its Sessions in the account (`ReadingCopies`), by that device, read here (`HostCatalog.copyPage`). */
export type CloudCopies = {
  page(device: string, harness: string, nativeId: string, before: number | undefined, limit: number): Promise<CopyPage | null>
  entry(device: string, harness: string, nativeId: string, id: string): Promise<HistoryEntry | null>
}

/** What a conversation begun in a moved Thread reads and records of this Mac's Thread store. */
export type AwayThreads = {
  execution(session: SessionId): SessionExecution | undefined
  sessionPlacement(session: SessionId): ThreadPlacement | undefined
  journalPlacement(conversationId: string): ThreadPlacement | undefined
  adoptElsewhere(input: { operationId: string; conversationId: string; actor: StoreActor } & ({ session: SessionId } | { forkOf: string; forkSession: SessionId })): ThreadPlacement
  person(): StoreActor
}

/** What a fork's answer names: the conversation it made, and the Session its host put it in. */
const ForkAnswerSchema = z.object({ session: z.object({ id: z.string(), harness: z.string() }).loose(), sessionId: z.string().optional() }).loose()

/** A cloud conversation's folder on its machine, as a window reads it: calls answered there, through its Thread. */
export type ElsewhereFolderRoute = {
  conversation: string
  where: string
  call(channel: string, args: readonly unknown[]): Promise<EncodedValue>
}

/** An app's view with an address, as `mako:thread-app` answers for a running one. */
const ReadyAddressSchema = z.object({ kind: z.literal("ready"), address: z.object({ host: z.string(), port: z.number().int() }) }).loose()

/** Where a cloud conversation's folder is, in words. */
export const CLOUD_FOLDER_WHERE = "a cloud machine"
/** A window following a cloud conversation's folder reads its Git again at most this often while its agent works. */
const CHANGED_MS = 1_000

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
  #offering: Promise<CloudProjectsOffer> | undefined
  /** What each conversation's agent shows on its machine, as live video through its Thread. */
  readonly controlPreviews: CloudControlPreviews
  /** By conversation: a change to tell of, waiting out `CHANGED_MS` from the last told. */
  readonly #changes = new Map<string, NodeJS.Timeout>()
  /** Each cloud Thread's ports, served on this Mac. */
  readonly #previews: CloudPreviews
  /** By conversation: the last view of its app a window was given, shown while its machine sleeps. */
  readonly #views = new Map<string, unknown>()
  /** The account's Threads as every device lists them: what puts another device's cloud conversations here. */
  readonly #list = new AccountSessions()
  /** This Mac's device, whose own Sessions are its own, and the names of the account's devices, for where a Session runs. */
  #device: string | undefined
  readonly #deviceNames = new Map<string, string>()
  #unlisten: (() => void) | undefined
  #listing: Promise<void> | undefined
  /**
   * Threads followed from the stream's head rather than from an event relayed: a listed conversation a window opened,
   * whose history its snapshot reads on the machine. Replaying the Thread from its first event would carry all of it.
   */
  readonly #fromHead = new Set<string>()
  /** A listed session's capture on its device, in flight or done, by conversation (`#captureListed`). */
  readonly #capturing = new Map<string, Promise<void>>()
  /** Devices found off (`owner-unavailable`), by runtime, until when their conversations are read from their copies. */
  readonly #asleep = new Map<string, number>()
  /** The windows' reads of copies, paged as a conversation's history is (`LiveHistoryReader`), by `copy:<conversation>`. */
  readonly #copyHistory = new LiveHistoryReader(
    (path, before) => this.#copyThreadPage(path, before),
    async (path, id) => {
      const copy = this.#copyOf(path)
      return copy ? (this.#options.copies?.entry(copy.device, copy.entry.harness, copy.nativeId, id) ?? null) : null
    }
  )

  constructor(options: CloudConversationsOptions) {
    this.#options = options
    this.#previews = new CloudPreviews({ gateway: () => options.account()?.gateway(), token: async () => options.account()?.token() })
    this.controlPreviews = new CloudControlPreviews({ session: async () => (await this.#connected()).session })
  }

  /** Reads what this Mac remembers and follows each open conversation's Thread. */
  start(): Promise<void> {
    this.#loading ??= this.#load().then(() => this.#watchList())
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
    if (channel === "mako:cloud-offer-projects") {
      // SAFETY: the dispatcher parsed this call's arguments with `mako:cloud-offer-projects`'s schema before routing it.
      const [folders] = args as [string[]]
      return { handled: true, value: encodeRuntimeValue(await this.offerProjects(folders)) }
    }
    if (channel === "mako:live-start") {
      // SAFETY: the dispatcher parsed this call's arguments with `mako:live-start`'s schema before routing it.
      const [harness, cwd, options] = args as [string, string, LiveStartOptions]
      if (options.cloud) return { handled: true, value: await this.#start(harness, cwd, options) }
      const away = options.session === undefined ? undefined : await this.#awayThread(SessionIdSchema.parse(options.session))
      if (!away) return { handled: false }
      return { handled: true, value: await this.#startAway(away, harness, cwd, options) }
    }
    if (channel === "mako:control-preview") {
      // SAFETY: the dispatcher parsed this call's arguments with `mako:control-preview`'s schema before routing it.
      const [id] = args as [string]
      await this.start()
      if (!this.#entries.has(id)) return { handled: false }
      return { handled: true, value: encodeRuntimeValue(this.controlPreviews.preview(id)) }
    }
    const id = conversationCallId(channel, args)
    if (!id) return { handled: false }
    await this.start()
    const entry = this.#entries.get(id)
    if (!entry) return { handled: false }
    // Another device's, while it's known to be off: its copy answers a read, and nothing else is tried.
    if (entry.runtime && (this.#asleep.get(entry.runtime) ?? 0) > Date.now()) return { handled: true, value: await this.#offCall(entry, channel, args) }
    try {
      // A session its device's harness keeps that Mako there hasn't opened: opened there first, as this conversation.
      if (entry.capture) await this.#captureListed(entry, entry.capture)
      // A window opened one known only from the account's list: from now its batches come here, from the stream's head.
      if (entry.listed && !this.#following.has(entry.threadId)) {
        this.#fromHead.add(entry.threadId)
        this.#follow(entry)
      }
      if (channel === "mako:live-fork") return { handled: true, value: await this.#fork(entry, args) }
      return { handled: true, value: await this.#call(entry, channel, args) }
    } catch (error) {
      // Its device is off (the cloud refused the call unapplied): read from its copy for a while, and say so.
      if (!(error instanceof OwnerUnavailableError) || !entry.runtime) throw error
      this.#asleep.set(entry.runtime, Date.now() + ASLEEP_MS)
      hostLog("cloud-conversations", "another device is off; its conversation is read from its copy", { conversationId: entry.conversationId, runtime: entry.runtime })
      return { handled: true, value: await this.#offCall(entry, channel, args) }
    }
  }

  /** A call for a conversation whose device is off: a read is answered from its copy in the account; anything else is refused, saying why. */
  async #offCall(entry: Entry, channel: string, args: unknown[]): Promise<EncodedValue> {
    const where = entry.summary?.elsewhere ?? "Its computer"
    if (!COPY_READS.has(channel) || !this.#options.copies || !entry.nativeId)
      throw new Error(`${where} is off, so this conversation can't be changed from here until it's back.`)
    if (channel === "mako:live-snapshot") return encodeRuntimeValue(this.#copyHistory.present(await this.#copySnapshot(entry)))
    // SAFETY: the dispatcher parsed this call's arguments with `mako:live-read`'s schema before routing it.
    const [, input] = args as [string, LiveHistoryRead]
    return encodeRuntimeValue(await this.#copyHistory.read(entry.conversationId, input, () => this.#copySnapshot(entry)))
  }

  /** Where a copy read names a conversation's copy: by the conversation, which says its device and native session. */
  #copyOf(path: string): { entry: Entry; device: string; nativeId: string } | undefined {
    const entry = path.startsWith("copy:") ? this.#entries.get(path.slice("copy:".length)) : undefined
    if (!entry?.runtime || !entry.nativeId) return undefined
    return { entry, device: entry.runtime.slice("d-".length), nativeId: entry.nativeId }
  }

  /** A page of a conversation's copy, as a page of its history: its revision is the copy's records' stamp. */
  async #copyThreadPage(path: string, before?: number): Promise<ThreadPage | null> {
    const copy = this.#copyOf(path)
    const page = copy && (await this.#options.copies?.page(copy.device, copy.entry.harness, copy.nativeId, before, COPY_PAGE))
    if (!copy || !page) return null
    const { header } = page
    const ref: ThreadPage["ref"] = { harness: header.harness, nativeId: header.nativeId, path, revision: header.stamp, updatedAt: new Date(header.at).toISOString() }
    if (header.title) ref.title = header.title
    if (header.cwd) ref.cwd = header.cwd
    if (header.model) ref.model = header.model
    return { ref, entries: page.entries, start: page.start, total: page.total, hasEarlier: page.start > 0, translator: header.translator }
  }

  /** The conversation as its copy has it: its history, and nothing at work, since nothing runs while its device is off. */
  async #copySnapshot(entry: Entry): Promise<LiveSnapshot> {
    const base = await this.#copyThreadPage(`copy:${entry.conversationId}`)
    if (!base) throw new Error(`${entry.summary?.elsewhere ?? "Its computer"} is off, and the account has no copy of this conversation yet.`)
    const at = Date.parse(base.ref.updatedAt ?? "") || Date.now()
    const listed = entry.summary
    const snapshot: LiveSnapshot = {
      session: {
        ...(listed?.session ?? { harness: entry.harness, cwd: base.ref.cwd ?? "", modes: [], currentMode: null, configOptions: [] }),
        id: entry.conversationId,
        status: "ready",
        connection: "hibernated",
      },
      revision: at,
      epoch: `copy-${at}`,
      createdAt: listed?.createdAt ?? entry.createdAt,
      copy: { at },
      base,
      blocks: [],
      permissions: [],
      requests: [],
    }
    if (listed?.elsewhere) snapshot.elsewhere = listed.elsewhere
    if (listed?.threadId) snapshot.threadId = listed.threadId
    if (listed?.sessionId) snapshot.sessionId = listed.sessionId
    if (base.ref.title && !snapshot.session.title) snapshot.session.title = base.ref.title
    return snapshot
  }

  /**
   * Has another device open a session its harness keeps, one a terminal or another app runs, as the conversation the
   * list named: its capture there is kept by path and ID, so two devices opening it at once open one conversation, and
   * one opened since answers as it stands. Once open it's listed as a conversation and called like one.
   */
  #captureListed(entry: Entry, path: string): Promise<void> {
    const id = entry.conversationId
    const known = this.#capturing.get(id)
    if (known) return known
    const capturing = this.#capture(entry, path)
    this.#capturing.set(id, capturing)
    // One that failed (its device asleep, say) is asked again by the next open.
    capturing.catch(() => {
      if (this.#capturing.get(id) === capturing) this.#capturing.delete(id)
    })
    return capturing
  }

  async #capture(entry: Entry, path: string): Promise<void> {
    await this.#call(entry, "mako:live-capture", [entry.conversationId, path])
    if (entry.capture === path) delete entry.capture
    hostLog("cloud-conversations", "a session another device's harness keeps was opened there", { conversationId: entry.conversationId, runtime: entry.runtime ?? "" })
  }

  /**
   * The cloud Thread a Session of this Mac's store runs on, when it runs on one this Mac follows: a `+` tab made in a
   * Thread that moved there. Undefined for a Session that runs here, or in transit (refused where it would start).
   */
  async #awayThread(session: SessionId): Promise<{ threads: AwayThreads; sibling: Entry; session: SessionId } | undefined> {
    const threads = this.#options.threads?.()
    const execution = threads?.execution(session)
    if (!threads || execution?.state !== "elsewhere" || execution.owner.kind !== "cloud") return undefined
    await this.start()
    const runtime = execution.owner.runtime
    const sibling = [...this.#entries.values()].find((entry) => cloudRuntimeOf(entry.threadId) === runtime)
    if (!sibling) throw new Error("This Thread runs in the cloud, but this Mac no longer follows it there, so it can't start a conversation in it.")
    return { threads, sibling, session }
  }

  /**
   * A `+` tab's first send in a Thread that moved to the cloud: the conversation starts on the Thread's machine, in
   * the Session the tab made here, which the machine's store takes under the same ID, so the two stores name it alike
   * and the way back brings it here. Each step is kept by its ID, so a start repeated after a lost answer or a host
   * that stopped finds what the first did: followed here first, then the Session made there, the conversation
   * started there, and recorded in this Mac's store last.
   */
  async #startAway(away: { threads: AwayThreads; sibling: Entry; session: SessionId }, harness: string, cwd: string, options: LiveStartOptions): Promise<EncodedValue> {
    const { threads, sibling, session } = away
    const placed = threads.sessionPlacement(session)
    if (!placed) throw new Error("That tab's Session isn't in a Thread any more.")
    let entry = this.#entries.get(options.conversationId)
    if (!entry) {
      if (this.#options.returning?.(sibling.threadId)) throw new Error("This Thread is on its way back to this Mac; open a new tab once it's here.")
      entry = { conversationId: options.conversationId, threadId: sibling.threadId, harness, repository: sibling.repository, createdAt: Date.now(), created: true, seq: sibling.seq }
      this.#entries.set(entry.conversationId, entry)
      await this.#save()
    }
    this.#follow(entry)
    await this.#call(entry, "mako:thread-create-session", [namedUuid(`mako cloud tab\0${session}`), placed.thread, session])
    // In the Thread's checkout there, where its other conversations work.
    const folder = sibling.summary?.session.cwd || cwd
    const start: LiveStartOptions = { ...options, session }
    for (const key of ["cloud", "worktree", "worktreeStart", "threadPath"] as const) delete start[key]
    const value = await this.#call(entry, "mako:live-start", [harness, folder, start])
    const started = LiveSummarySchema.parse(decodeRuntimeValue(value))
    entry.summary = summaryOf(started)
    this.#saveSoon()
    threads.adoptElsewhere({ operationId: namedUuid(`mako cloud tab\0${session}\0${entry.conversationId}`), conversationId: entry.conversationId, session, actor: threads.person() })
    hostLog("cloud-conversations", "a new tab of a Thread in the cloud started on its machine", { conversationId: entry.conversationId, threadId: entry.threadId, session, harness })
    return encodeRuntimeValue({ ...started, elsewhere: CLOUD_FOLDER_WHERE })
  }

  /**
   * A fork of a cloud conversation, made on its machine. In a Thread that moved there from this Mac, it goes into a
   * new Session beside its parent's, under the ID the machine's store gave it, recorded here too, so the way back
   * brings it home; a fork that would leave the Thread or its checkout waits until the Thread is back.
   */
  async #fork(entry: Entry, args: unknown[]): Promise<EncodedValue> {
    const input = ForkInputSchema.parse(args[1])
    const threads = this.#options.threads?.()
    const placed = threads?.journalPlacement(entry.conversationId)
    if (placed) {
      if (input.thread === "new") throw new Error("A conversation in the cloud forks within its Thread there. Fork it into a new Thread once it's back on this Mac.")
      if (input.worktree || input.move) throw new Error("A conversation in the cloud works in its machine's checkout. Fork it into a worktree once it's back on this Mac.")
      if (!this.#entries.has(input.id) && this.#options.returning?.(entry.threadId)) throw new Error("This Thread is on its way back to this Mac; fork it once it's here.")
    }
    // A fork of a Thread from this Mac goes into a Session named here, from the fork's own ID: a repeat names the same,
    // and no machine's randomness decides it (copies of one snapshot once drew the same IDs).
    const named = placed ? SessionIdSchema.parse(input.session ?? namedUuid(`mako cloud fork session\0${input.id}`)) : undefined
    const value = await this.#call(entry, "mako:live-fork", named ? [args[0], { ...input, session: named }] : args)
    const decoded = decodeRuntimeValue(value)
    const fork = ForkAnswerSchema.parse(decoded)
    if (fork.session.id !== input.id || fork.session.harness !== input.provider) throw new Error("The cloud machine returned a different fork")
    // Filed here first, as the machine filed it, and only then followed as one of the Thread's: a fork this Mac
    // follows but whose Session it doesn't have would be left in the cloud when the Thread comes back.
    if (placed && threads) {
      if (!fork.sessionId) throw new Error("The cloud machine didn't say which Session the fork went into")
      const session = SessionIdSchema.parse(fork.sessionId)
      const known = session === named ? undefined : threads.sessionPlacement(session)
      if (known && known.thread === placed.thread) {
        // A machine on an older image names the fork's Session itself, and once named one of the Thread's own (its
        // parent's, 2026-10-23): filed the same here, so both stores agree and it comes back with the Thread, and said.
        hostWarn("cloud-conversations", "a fork in the cloud went into a Session its Thread already had; filed the same here", { conversationId: input.id, parent: entry.conversationId, parentSession: placed.session, session, sameAsParent: session === placed.session, machineThread: z.object({ threadId: z.string() }).partial().safeParse(decoded).data?.threadId, threadId: entry.threadId })
        threads.adoptElsewhere({ operationId: namedUuid(`mako cloud fork\0${input.id}`), conversationId: input.id, session, actor: threads.person() })
      } else {
        if (session !== named) hostWarn("cloud-conversations", "the cloud machine named a fork's Session itself, as an older host does", { conversationId: input.id, named, session })
        threads.adoptElsewhere({ operationId: namedUuid(`mako cloud fork\0${input.id}`), conversationId: input.id, forkOf: entry.conversationId, forkSession: session, actor: threads.person() })
        hostLog("cloud-conversations", "a conversation in the cloud forked on its machine", { conversationId: input.id, parent: entry.conversationId, threadId: entry.threadId, session })
      }
    }
    if (!this.#entries.has(input.id)) {
      const forked: Entry = { conversationId: input.id, threadId: entry.threadId, harness: input.provider, repository: entry.repository, createdAt: Date.now(), created: true, seq: entry.seq }
      const summary = LiveSummarySchema.safeParse(decoded)
      if (summary.success) forked.summary = summaryOf(summary.data)
      this.#entries.set(forked.conversationId, forked)
      await this.#save()
    }
    return encodeRuntimeValue({ ...z.object({}).loose().parse(decoded), elsewhere: CLOUD_FOLDER_WHERE })
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
    if (!this.#list.known) void this.#readList()
  }

  dispose(): void {
    this.#closed = true
    this.#unlisten?.()
    for (const resume of this.#pauses) resume()
    clearTimeout(this.#saving)
    for (const prepared of this.#prepared.values()) clearTimeout(prepared.watching)
    for (const subscription of this.#following.values()) subscription?.close()
    for (const timer of this.#changes.values()) clearTimeout(timer)
    this.#changes.clear()
    void this.#previews.close()
    this.#following.clear()
    this.controlPreviews.close()
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
    const making: CloudThreadMaking = { prepare: true }
    if (launch) making.harness = launch.harness
    asked.asking = account.createThread(asked.threadId, repository, making).then(({ ready }) => {
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
    if (launch) asked.launch = launch
    if (asked.ready && launch) this.#startAhead(asked, launch)
    else if (launch) this.#watchReady(asked)
    return asked.ready ? "ready" : "preparing"
  }

  /** Asks again every `READY_ASK_MS` while its machine comes up, and starts its harness once the machine is ready. */
  #watchReady(prepared: Prepared): void {
    if (prepared.watching) return
    const key = repositoryKey(prepared.repository)
    const until = Date.now() + READY_ASK_FOR_MS
    const ask = async () => {
      prepared.watching = undefined
      const account = this.#options.account()
      if (this.#closed || !account || this.#prepared.get(key) !== prepared || prepared.ready || Date.now() > until) return
      try {
        prepared.askedAt = Date.now()
        prepared.ready = (await account.createThread(prepared.threadId, prepared.repository, { prepare: true })).ready
      } catch (error) {
        return hostWarn("cloud-conversations", "a cloud Thread made ahead wasn't asked again", { threadId: prepared.threadId, error: error instanceof Error ? error.message : String(error) })
      }
      if (prepared.ready && prepared.launch) this.#startAhead(prepared, prepared.launch)
      else prepared.watching = setTimeout(() => void ask(), READY_ASK_MS)
    }
    prepared.watching = setTimeout(() => void ask(), READY_ASK_MS)
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

  /**
   * Onboarding: the first time this Mac's account has the cloud, the repositories of its most recent projects (by
   * `folders`, newest first) are offered for project bases, so each one's first cloud Thread starts from a clone made
   * ahead. Once per account on this Mac, remembered beside its cloud conversations; nothing is shown either way.
   */
  offerProjects(folders: string[]): Promise<CloudProjectsOffer> {
    this.#offering ??= this.#offerProjects(folders).finally(() => (this.#offering = undefined))
    return this.#offering
  }

  async #offerProjects(folders: string[]): Promise<CloudProjectsOffer> {
    const account = this.#options.account()
    const accountId = await account?.id()
    if (!account || !accountId) return "none"
    const file = join(dirname(this.#options.file), "projects-offered.json")
    const offered = OfferedSchema.safeParse(JSON.parse(await readFile(file, "utf8").catch(() => "{}"))).data?.accounts ?? []
    if (offered.includes(accountId)) return "already"
    const found = await Promise.all(folders.slice(0, PROJECTS_OFFERED).map((folder) => this.#options.repositoryOf(folder).catch(() => undefined)))
    const repositories = [...new Map(found.filter((repository) => repository !== undefined).map((repository) => [repositoryKey(repository), repository])).values()]
    if (repositories.length) await account.askBases(repositories)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ accounts: [...offered, accountId] })}\n`)
    hostLog("cloud-conversations", "offered this Mac's recent projects for project bases", { repositories: repositories.length })
    return repositories.length ? "asked" : "none"
  }

  /** The Thread made ahead for a repository, unless this Mac last asked for it too long ago: that one went unused. */
  #fresh(key: string): Prepared | undefined {
    const prepared = this.#prepared.get(key)
    if (!prepared || Date.now() - prepared.askedAt < PREPARED_KEPT_MS) return prepared
    this.#prepared.delete(key)
    clearTimeout(prepared.watching)
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
    clearTimeout(prepared.watching)
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
    const repository = entry.repository
    // A start this Mac made names its repository; only a conversation listed from another device has none, and isn't started here.
    if (!repository) throw new Error("That conversation runs on another device; it isn't started from this Mac.")
    if (!entry.created) {
      await account.createThread(entry.threadId, repository, { harness })
      entry.created = true
      await this.#save()
      hostLog("cloud-conversations", "made a cloud Thread", { threadId: entry.threadId, conversationId: entry.conversationId, harness, repository: repository.url })
    }
    this.#follow(entry)
    const cwd = ahead?.cwd ?? bootFolder(await this.#call(entry, "mako:boot", []))
    if (step !== "starting") this.#step(options.conversationId, "starting", repository)
    // The machine's own start: in its clone, with nothing of this Mac's folders or Thread store. Repeated for a
    // conversation started ahead, it brings the first message (`LiveConversations.firstMessage` on the machine).
    const start: LiveStartOptions = { ...options, conversationId: entry.conversationId }
    for (const key of ["cloud", "worktree", "worktreeStart", "session", "threadPath"] as const) delete start[key]
    const value = await this.#call(entry, "mako:live-start", [harness, cwd, start])
    const started = LiveSummarySchema.parse(decodeRuntimeValue(value))
    entry.summary = summaryOf(started)
    this.#saveSoon()
    // The machine's answer, saying its folder is elsewhere: the window reads its files and Git there from the start.
    return encodeRuntimeValue({ ...started, elsewhere: CLOUD_FOLDER_WHERE })
  }

  /**
   * A conversation of this Mac's that moved to a cloud Thread: answered there from now on, under its own id, and
   * followed with the Thread's other conversations. Remembered before anything starts on the machine, so a host
   * that stops between finds it and starts it again (`started`).
   */
  async adopt(conversation: { conversationId: string; threadId: string; harness: string; repository: CloudRepository }): Promise<void> {
    await this.start()
    if (this.#entries.has(conversation.conversationId)) return
    const entry: Entry = { ...conversation, createdAt: Date.now(), created: true, seq: 0 }
    this.#entries.set(entry.conversationId, entry)
    await this.#save()
    this.#follow(entry)
    hostLog("cloud-conversations", "a conversation of this Mac's moved to a cloud Thread", { conversationId: entry.conversationId, threadId: entry.threadId, harness: entry.harness })
  }

  /**
   * A conversation that came back to this Mac from its cloud Thread: answered here again from now, its own journal
   * standing, and its Thread no longer followed once none of its conversations is. Forgotten before anything starts
   * here, so a host that stops between never sends its calls to a machine that gave it up.
   */
  async release(conversationId: string): Promise<void> {
    await this.start()
    const entry = this.#entries.get(conversationId)
    if (!entry) return
    this.#entries.delete(conversationId)
    await this.#save()
    if (![...this.#entries.values()].some((other) => other.threadId === entry.threadId)) this.#following.get(entry.threadId)?.close()
    hostLog("cloud-conversations", "a conversation came back from its cloud Thread", { conversationId, threadId: entry.threadId })
  }

  /**
   * Every conversation of a cloud Thread that came back to this Mac: those it began there too, and any start the
   * return cut short. Each is answered here from now; forgotten before anything starts here, as `release`.
   */
  async releaseThread(threadId: string): Promise<string[]> {
    await this.start()
    const released = [...this.#entries.values()].filter((entry) => entry.threadId === threadId).map((entry) => entry.conversationId)
    for (const conversationId of released) await this.release(conversationId)
    return released
  }

  /** The cloud conversations of a cloud Thread: their harness and native session, as their machine last said. */
  threadConversations(threadId: string): Array<{ conversationId: string; harness: string; nativeId: string | undefined }> {
    return [...this.#entries.values()].filter((entry) => entry.threadId === threadId)
      .map((entry) => ({ conversationId: entry.conversationId, harness: entry.harness, nativeId: entry.summary?.session.nativeId || undefined }))
  }

  /** An adopted conversation's start on its machine, as the machine answered it: what windows list from now on. */
  started(conversationId: string, value: EncodedValue): LiveSummary {
    const entry = this.#entries.get(conversationId)
    if (!entry) throw new Error("That conversation isn't one of the cloud's here")
    entry.summary = summaryOf(LiveSummarySchema.parse(decodeRuntimeValue(value)))
    this.#saveSoon()
    return entry.summary
  }

  /** Whether a conversation is answered by its cloud Thread: the Mac's own journal of it, if any, stands aside. */
  has(conversationId: string): boolean {
    return this.#entries.has(conversationId)
  }

  /**
   * One call to a cloud Thread's machine, for a conversation when it has one: `#callThread`, for a move's steps.
   * `refuseUnstarted`: answered at once if the machine can't start, never queued until it can.
   */
  callThread(threadId: string, channel: string, args: readonly unknown[], conversationId?: string, options: { refuseUnstarted?: boolean } = {}): Promise<EncodedValue> {
    return this.#callThread(threadId, channel, args, { ...conversationId && { conversationId }, ...options })
  }

  /**
   * One of its conversations' folders, on its machine, for a window to read: the calls go to that conversation's
   * Thread, waking its machine if it sleeps, as any call to it would. Undefined for a conversation it doesn't have.
   */
  async folder(conversationId: string): Promise<ElsewhereFolderRoute | undefined> {
    await this.start()
    const entry = this.#entries.get(conversationId)
    if (!entry) return undefined
    return { conversation: conversationId, where: CLOUD_FOLDER_WHERE, call: (channel, args) => (channel === "mako:thread-app" ? this.#appView(entry, args) : this.#call(entry, channel, args)) }
  }

  /**
   * A window's look at the app in a cloud conversation's folder, which it keeps asking for: asked passively, so a window
   * left open neither wakes a sleeping machine nor keeps it running; while it sleeps, the last view seen (its app
   * paused with it, still in memory). The app's address is this Mac's preview of its port, which a click wakes.
   */
  async #appView(entry: Entry, args: readonly unknown[]): Promise<EncodedValue> {
    let view: unknown
    try {
      view = decodeRuntimeValue(await this.#callThread(entry.threadId, "mako:thread-app", args, { conversationId: entry.conversationId, passive: true }))
      this.#views.set(entry.conversationId, view)
    } catch (error) {
      const kept = this.#views.get(entry.conversationId)
      // Asleep is a call the gateway didn't apply; any other failure is the machine's, said as it is.
      if (!(error instanceof RuntimeDisconnectedError && !error.unconfirmed) || kept === undefined) throw error
      view = kept
    }
    const ready = ReadyAddressSchema.safeParse(view)
    if (!ready.success) return encodeRuntimeValue(view)
    return encodeRuntimeValue({ ...ready.data, address: await this.#previews.address(entry.threadId, ready.data.address.port) })
  }

  /**
   * One call to the Thread's machine. A call the gateway lost on the way (its machine's link changed under it) or
   * still holds while the machine wakes is repeated here, under its one id, for as long as `CLOUD_REPEAT_MS`, when a
   * repeat can't do it twice (a read, or a call the host settles by its id): the gateway answers a repeat with the
   * first answer. So a send after the machine slept arrives, without the window hearing of the wake. Past that, or
   * for a call only the person may repeat, the window hears it as a reconnect, in a cloud Thread's words.
   */
  #call(entry: Entry, channel: string, args: readonly unknown[]): Promise<EncodedValue> {
    return this.#callThread(entry.threadId, channel, args, { conversationId: entry.conversationId, runtime: entry.runtime })
  }

  /** `#call` to a Thread by its ID, for its conversation when it has one, or made ahead of a person's message. */
  async #callThread(threadId: string, channel: string, args: readonly unknown[], how: { conversationId?: string; runtime?: string | undefined; ahead?: boolean; passive?: boolean; refuseUnstarted?: boolean }): Promise<EncodedValue> {
    const { session, deviceId } = await this.#connected()
    const actor: Actor = { kind: "client", client: "desktop", deviceId }
    // Another device's conversation is answered by that device's runtime, through the cloud.
    const calls: GatewayHostCallsOptions = how.runtime ? { runtimeId: how.runtime, actor, history: hostHistoryPaging() } : { threadId, actor, history: hostHistoryPaging() }
    if (how.ahead) calls.ahead = true
    if (how.passive) calls.passive = true
    if (how.refuseUnstarted) calls.refuseUnstarted = true
    const send = gatewayHostCalls(session, calls).call(channel, args)
    // A passive look is answered at once, asleep or not; it's never waited out.
    const repeatable = !how.passive && hostCallReplay(channel) !== "never"
    const began = performance.now()
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(attempt)
      } catch (error) {
        if (!(error instanceof RuntimeDisconnectedError)) throw error
        // Another device's runtime that isn't connected, said before the call was applied: it's off, and a call doesn't
        // wake a Mac as it does a cloud Thread's machine. Said at once, as itself, for its copy to answer a read.
        if (how.runtime && error instanceof OwnerUnavailableError && !error.unconfirmed) throw error
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
          const fromHead = this.#fromHead.has(entry.threadId)
          // Another device's conversation streams only while watched, and keeps nothing to replay: always from now.
          const subscription = entry.runtime
            ? session.subscribe({ stream: entry.threadId, after: 0 })
            : session.subscribe({ stream: threadStream(entry.threadId), after: fromHead ? Number.MAX_SAFE_INTEGER : entry.seq })
          this.#following.set(entry.threadId, subscription)
          for (;;) {
            const frame = await subscription.next()
            if (frame.seq <= entry.seq) continue
            this.#fromHead.delete(entry.threadId)
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
    void run().finally(() => {
      this.#following.delete(entry.threadId)
      this.#fromHead.delete(entry.threadId)
    })
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
    if (!head.success || head.data.channel !== "event") return
    if (head.data.type === "control-activity") {
      // The machine's host emits every conversation's; only this one's is this Thread's to show.
      const event = ControlActivityEventSchema.safeParse(JSON.parse(parts.payload))
      if (!event.success || this.#entries.get(event.data.activity.conversationId)?.threadId !== entry.threadId) return
      const { activity } = event.data
      this.controlPreviews.activity(entry.threadId, activity)
      this.#options.emit({ type: "control-activity", payload: parts.payload })
      return
    }
    // One subscription follows a Thread; a Thread moved from this Mac can carry several of its conversations.
    const target = head.data.type === "live-batch" && head.data.conversation ? this.#entries.get(head.data.conversation) : undefined
    if (!target || target.threadId !== entry.threadId) return
    if (target.summary) {
      const { batch } = z.object({ batch: LiveBatchSchema }).parse(JSON.parse(parts.payload))
      const summary: LiveSummary = { ...target.summary, session: sessionAfter(target.summary.session, batch), revision: batch.revision }
      if (batch.epoch) summary.epoch = batch.epoch
      target.summary = summaryOf(summary)
    }
    this.#options.emit({ type: "live-batch", conversation: target.conversationId, payload: parts.payload })
    this.#noteChange(target.conversationId)
  }

  /** Its agent worked: a window on its folder reads it again, once a `CHANGED_MS` at most, after the last batch of a burst. */
  #noteChange(conversationId: string): void {
    const changed = this.#options.changed
    if (!changed || this.#changes.has(conversationId)) return
    const timer = setTimeout(() => {
      this.#changes.delete(conversationId)
      changed(conversationId)
    }, CHANGED_MS)
    timer.unref()
    this.#changes.set(conversationId, timer)
  }

  /** Hears the account's list of Threads change, and reads it whole once. */
  #watchList(): void {
    const account = this.#options.account()
    if (this.#closed || this.#unlisten || !account?.onThreadListings) return
    this.#unlisten = account.onThreadListings((heard) => {
      if (heard === "account-changed") {
        this.#list.clear()
        this.#reconcile()
        void this.#readList()
      } else if (this.#list.heard(heard)) this.#reconcile()
      else if (!this.#list.known) void this.#readList()
    })
    void this.#readList()
  }

  /** The account's list, read whole: once at start, after a sign-in, and after a wake while it isn't known. */
  #readList(): Promise<void> {
    this.#listing ??= (async () => {
      const account = this.#options.account()
      if (this.#closed || !account?.sessionListings || !(await account.id())) return
      try {
        this.#device = await account.deviceId()
        const [listings, devices] = await Promise.all([account.sessionListings(), account.devices?.().catch(() => undefined)])
        for (const device of devices?.devices ?? []) this.#deviceNames.set(device.id, device.name)
        if (this.#list.listed(listings)) this.#reconcile()
      } catch (error) {
        hostLog("cloud-conversations", "the account's Threads couldn't be listed; listed again when the account or the network changes", { error: error instanceof Error ? error.message : String(error) })
      }
    })().finally(() => {
      this.#listing = undefined
    })
    return this.#listing
  }

  /**
   * Holds the conversations known from the account's list to it: a Session another device has (in the cloud or on
   * itself) is listed here, changed as the list changes, and gone when it leaves it. This Mac's own Sessions, and the
   * cloud conversations this Mac started or moved, are never touched, and one a window opened goes on from its own
   * batches, which say more and sooner. Windows hear what changed and list it as they list a conversation at boot:
   * nothing wakes a machine or reaches a Mac until one opens.
   */
  #reconcile(): void {
    const wanted = new Map<string, { row: ListedSession; threadId: string; runtime?: string; where: string }>()
    for (const row of this.#list.sessions().values()) {
      if (row.runsOn.kind === "device") {
        if (row.runsOn.deviceId === this.#device) continue
        const runtime = `d-${row.runsOn.deviceId}`
        wanted.set(row.conversation, { row, threadId: sessionStream(runtime, row.conversation), runtime, where: this.#deviceNames.get(row.runsOn.deviceId) ?? "another computer" })
      } else if (!this.#options.returning?.(row.runsOn.threadId)) wanted.set(row.conversation, { row, threadId: row.runsOn.threadId, where: CLOUD_FOLDER_WHERE })
    }
    const unlisted: string[] = []
    // Deleting from a Map as it's walked is safe: the walk goes on past what went.
    for (const entry of this.#entries.values()) {
      if (!entry.listed || wanted.get(entry.conversationId)?.threadId === entry.threadId) continue
      this.#entries.delete(entry.conversationId)
      this.controlPreviews.forget(entry.conversationId)
      this.#views.delete(entry.conversationId)
      this.#capturing.delete(entry.conversationId)
      unlisted.push(entry.conversationId)
      if (![...this.#entries.values()].some((other) => other.threadId === entry.threadId)) this.#following.get(entry.threadId)?.close()
    }
    const listed: LiveSummary[] = []
    for (const [id, { row, threadId, runtime, where }] of wanted) {
      const known = this.#entries.get(id)
      if (known && (!known.listed || this.#following.has(known.threadId))) continue
      const summary = listedSummary(row, where)
      if (known?.summary && JSON.stringify(known.summary) === JSON.stringify(summary)) continue
      const entry: Entry = known ?? { conversationId: id, threadId, harness: row.harness, createdAt: summary.createdAt, created: true, seq: 0, listed: true }
      if (runtime) entry.runtime = runtime
      if (row.capture && runtime) entry.capture = row.capture.path
      else delete entry.capture
      if (row.nativeId) entry.nativeId = row.nativeId
      entry.summary = summary
      this.#entries.set(id, entry)
      listed.push(summary)
    }
    // A Session that moved (another device's to the cloud, or back) is listed where it runs now, never unlisted on the way.
    const gone = unlisted.filter((id) => !listed.some((summary) => summary.session.id === id))
    if (listed.length) this.#options.emit(encodeRuntimeEvent({ type: "live-listed", summaries: listed }))
    if (gone.length) this.#options.emit(encodeRuntimeEvent({ type: "live-unlisted", ids: gone }))
    if (listed.length || gone.length) hostLog("cloud-conversations", "the account's list changed what's listed here", { listed: listed.length, unlisted: gone.length, moved: unlisted.length - gone.length })
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
    const kept = [...this.#entries.values()].filter((entry) => !entry.listed).sort((left, right) => right.createdAt - left.createdAt).slice(0, KEPT)
    for (const entry of this.#entries.values())
      if (!entry.listed && !kept.includes(entry)) {
        this.#entries.delete(entry.conversationId)
        this.controlPreviews.forget(entry.conversationId)
      }
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
  const summary: LiveSummary = { session: snapshot.session, revision: snapshot.revision, createdAt: snapshot.createdAt, elsewhere: CLOUD_FOLDER_WHERE }
  // A Thread moved from this Mac has the same IDs in both stores: a window places its tabs by them.
  if (snapshot.threadId) summary.threadId = snapshot.threadId
  if (snapshot.sessionId) summary.sessionId = snapshot.sessionId
  if (snapshot.epoch) summary.epoch = snapshot.epoch
  if (snapshot.threadPath) summary.threadPath = snapshot.threadPath
  if (snapshot.nativePaths) summary.nativePaths = snapshot.nativePaths
  if (snapshot.hasSessionQuestions) summary.hasSessionQuestions = snapshot.hasSessionQuestions
  return summary
}
