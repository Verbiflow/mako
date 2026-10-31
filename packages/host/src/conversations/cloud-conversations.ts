import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { LinkClosedError, NothingArrivedError, PROBE_ANSWER_MS, SILENT_WHILE_WORKING_MS, StreamCursor, followAgainInMs, threadStream, type Actor, type ClientSessionOverSockets, type EventFrame, type Subscription } from "@mako/protocol"
import { MACHINE_NOTICE_PREFIX, ThreadMachineNoticeSchema } from "@mako/protocol/saves"
import { ControlActivitySchema } from "@mako/control-runtime/contracts"
import { z } from "zod"
import type { ArchivedThread, ListedSession } from "@mako/protocol/thread-listing"
import { attentionFact } from "@mako/protocol/attention"
import { CLOUD_FOLDER_WHERE, listedOwner, listedPromptedAt, listedSummary } from "../contracts/listed-conversations.js"
import { laterPrompt, promptedAfter } from "../contracts/worked-at.js"
import type { FollowRecorder, SyncRecorder } from "../contracts/sync-readings.js"
import { listedArchiveInputs, type ArchiveInputs } from "../contracts/cloud-archive.js"
import { hostHistoryPaging } from "../base/host-client.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { bootFolder, CloudRepositorySchema, githubRepositoryUrl, type CloudPrepareLaunch, type CloudPrepareOutcome, type CloudProjectsOffer, type CloudRepository, type CloudStartStep } from "../contracts/cloud-threads.js"
import { deferredWhenAsleep } from "../contracts/host-call-policy.js"
import { OwnerUnavailableError, RuntimeDisconnectedError } from "../contracts/host-connection.js"
import { ForkInputSchema } from "../contracts/conversation-control.js"
import { sessionAfter, type CompactLiveBatch, type HeardLiveBatch, type LiveRequest, type LiveStartOptions, type LiveSummary } from "../contracts/live-conversations.js"
import type { WaitingMessage } from "@mako/protocol/waiting"
import { decodeRuntimeValue, encodeRuntimeEvent, encodeRuntimeValue, readEventLine, type EncodedValue, type RuntimeEvent } from "../contracts/runtime-value.js"
import { COMPACT_LIVE_FORM } from "@mako/protocol/live-form"
import type { SessionExecution } from "../contracts/thread-execution.js"
import type { CloudMachineState, ThreadAppView } from "../contracts/thread-app.js"
import { SessionIdSchema, type Actor as StoreActor, type SessionId, type ThreadPlacement } from "../contracts/thread-identity.js"
import { gatewayHostCalls, type GatewayHostCallsOptions } from "../transport/index.js"
import { sendWithRepeats, type GatewayCallLog } from "../contracts/gateway-host-calls.js"
import type { CloudAccount, CloudThreadMaking } from "../usage/index.js"
import { CloudControlPreviews } from "./cloud-control-previews.js"
import { cloudRuntimeOf, namedUuid } from "./cloud-moves.js"
import { AccountSessions, type AccountListHeard } from "@mako/protocol/account-sessions"
import { CloudPreviews } from "./cloud-previews.js"
import { conversationCallId } from "../contracts/conversation-calls.js"
import type { ConversationRoutingResult } from "./shared-conversations.js"
import { COPY_PAGE, CopyHistory, copySnapshot, copyThreadPage, type CopyCall, type CopyCapture, type CopyConversation, type CopySource } from "../contracts/copy-history.js"
import type { CopyPage } from "@mako/sessions/copy-reader"

/** The newest this many are kept, and followed while they're open. */
const KEPT = 50
/** A device found off is read from the account's copy for this long before it's asked again. */
const ASLEEP_MS = 15_000
/** A message for this Mac's own Session that couldn't be taken yet (the host still starting) is tried again after this. */
const TAKE_AGAIN_MS = 30_000
/** For this long after a wake, a follow tries again this often: the network comes back within a second or two. */
const WOKEN_MS = 15_000
const SAVE_MS = 1_000
/** Where a routed call's repeats are said: this module's lines in the host's log. */
const CALL_LOG: GatewayCallLog = { warn: (message, fields) => hostWarn("cloud-conversations", message, fields), info: (message, fields) => hostLog("cloud-conversations", message, fields) }
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
/**
 * The accounts this Mac offered its recent projects to, and, from builds that keep it, which projects (a folder and its
 * repository, the newest first), which turning the cloud on follows the bases of. An older build rewrites the file only
 * on offering another account, and keeps `accounts`.
 */
const OfferedSchema = z.object({
  accounts: z.array(z.string()),
  projects: z.record(z.string(), z.array(z.object({ folder: z.string(), repository: CloudRepositorySchema }))).optional(),
})
type Offered = z.infer<typeof OfferedSchema>

const SummaryIdentitySchema = z.object({ session: z.object({ id: z.string(), status: z.string() }).loose(), revision: z.number(), createdAt: z.number() }).loose()
/** A cloud host's own `LiveSummary`, checked for the identity and revision this router reads. */
const LiveSummarySchema = z.custom<LiveSummary>((value) => SummaryIdentitySchema.safeParse(value).success)
/** A cloud host's own `LiveBatch`, whole or compact, checked for the revision a summary follows. */
const LiveBatchSchema = z.custom<HeardLiveBatch>((value) => z.object({ revision: z.number() }).loose().safeParse(value).success)

const AppProcessSchema = z.object({
  name: z.string(),
  state: z.enum(["starting", "running", "exited", "stopped"]),
  port: z.number().int().optional(),
  exit: z.object({ code: z.number(), afterMs: z.number(), at: z.number() }).optional(),
})

/**
 * A cloud app as a window's look last found it, kept only as far as a sleeping machine's app is shown: its project,
 * and when it was set up, its phase, its processes (their memory isn't, which a pause holds still) and the port on the
 * machine its address was at. Written when that changes, never for a look that found the same.
 */
const KeptReadySchema = z.object({
  phase: z.enum(["stopped", "preparing", "starting", "running", "crashed", "waiting"]),
  processes: z.array(AppProcessSchema),
  startedAt: z.number().optional(),
  port: z.number().int().optional(),
})
const KeptAppSchema = z.object({ project: z.string(), ready: KeptReadySchema.optional() })
type KeptApp = z.infer<typeof KeptAppSchema>

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
  /** Its folder's app as this Mac last saw its machine awake: what a window is shown while the machine sleeps. */
  app: KeptAppSchema.optional(),
})

type Entry = z.infer<typeof EntrySchema>

/** What a look's answer says of the app, read leniently: a view of any kind names its project. */
const LookedAppSchema = z.object({
  kind: z.string(),
  project: z.string(),
  phase: z.string().optional(),
  processes: z.array(z.object({ name: z.string(), state: z.string(), port: z.number().optional(), exit: z.unknown().optional() }).loose()).optional(),
  startedAt: z.number().optional(),
  address: z.object({ port: z.number().int() }).loose().optional(),
}).loose()
type LookedApp = z.infer<typeof LookedAppSchema>

/** The part of a look's view a sleeping machine's app is shown from. */
function keptApp({ kind, project, phase, processes, startedAt, address }: LookedApp): KeptApp {
  if (kind !== "ready") return { project }
  const ready = KeptReadySchema.safeParse({
    phase,
    processes: processes?.map(({ name, state, port, exit }) => ({ name, state, ...port !== undefined && { port }, ...exit !== undefined && { exit } })) ?? [],
    ...startedAt !== undefined && { startedAt },
    ...address && { port: address.port },
  })
  return ready.success ? { project, ready: ready.data } : { project }
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


const ControlActivityEventSchema = z.object({ type: z.literal("control-activity"), activity: ControlActivitySchema })

export type CloudConversationsOptions = {
  /** The Mako account, once its domain is loaded. */
  account(): CloudAccount | undefined
  /** Where how this Mac's following of other devices' work goes is kept, for Diagnostics' Sync. */
  readings?: SyncRecorder
  /** Where the cloud conversations this Mac started are remembered. */
  file: string
  /** Sends an event to this host's windows, as its own conversations' events go. */
  emit(event: RuntimeEvent): void
  /** The GitHub repository a folder of this Mac's works in, for a start that names none. */
  repositoryOf(cwd: string): Promise<CloudRepository>
  /**
   * Brings the account's copy of the folder's project's carried files (its recipe's `carry`) up to date, if the person
   * allowed it, before a cloud Thread of it is made: its machine places them as it starts (`CloudCarriedFiles.sync`).
   */
  carried?(folder: string, why: string): Promise<void>
  /** A conversation's folder on its machine may have changed: its agent worked. At most once a `CHANGED_MS`. */
  changed?(conversationId: string): void
  /** A turn of a conversation on cloud Thread `threadId` ended there: what follows the Thread here reads it (`CloudFollow`). */
  turnEnded?(conversationId: string, threadId: string): void
  /**
   * This Mac's Thread store, where a conversation begun in a Thread that moved to the cloud (a `+` tab, a fork) is
   * recorded: its Session runs where the Thread does, and the way back brings it here with the rest.
   */
  threads?(): AwayThreads | undefined
  /**
   * The return bringing a cloud Thread back to this Mac now, which settles once it's over, however it went; undefined
   * when none is. It begins no conversation meanwhile, and a call for one of its conversations waits for it, then goes
   * where the Thread runs after: nothing takes work while a Thread is in transit.
   */
  returning?(cloudThread: string): Promise<void> | undefined
  /** The copies other devices keep of their Sessions in the account, read while a device is off. */
  copies?: CloudCopies
  /** How long a device found off is read from its copy before it's asked again (`ASLEEP_MS`); a test's is short. */
  asleepMs?: number
  /**
   * Takes a message that waited in the account for one of this Mac's own Sessions: admits it here, under its own ID,
   * as a message the person sent (`mako:live-prompt`). `not-mine` when this Mac doesn't own the Session (it moved; its
   * owner takes it), `later` when the host can't take one yet.
   */
  takeWaiting?(message: WaitingMessage): Promise<"taken" | "not-mine" | "later">
  /**
   * Whether this Mac's own harness stores keep this native session, in this folder: the one this Mac lists itself. A
   * second Mako on this Mac (another profile, a build being tried) reads the same stores and lists the same sessions
   * as its own, under Sessions of its own; listed here too, each would show twice.
   */
  keepsNative?(harness: string, nativeId: string, folder: string | undefined): boolean | undefined
  /**
   * The account's archived cloud Threads changed (`ArchivedThread`), as its list and stream say them: what each device
   * shows as archived, from the account's word alone. Said only from a list read of `account`: a list not read yet,
   * or forgotten at a sign-out, says nothing of what's archived.
   */
  archivedChanged?(account: string, archived: ReadonlyMap<string, ArchivedThread>): void
  /**
   * What turning the cloud on reads of these changed: the projects offered, a cloud Thread made ahead or its machine
   * ready, a cloud Thread made (`offeredProjects`, `preparedMachine`, `firstCloudThread`).
   */
  turnOnChanged?(): void
  /** How long changes to the sessions this Mac keeps are gathered before they're looked at (`NATIVE_CHANGED_MS`). */
  nativeChangedMs?: number
}

/** Copies another device keeps of its Sessions in the account (`ReadingCopies`), by that device, read here (`HostCatalog.copyPage`). */
export type CloudCopies = {
  page(device: string, harness: string, nativeId: string, before: number | undefined, limit: number): Promise<CopyPage | null>
}

/** What a conversation begun in a moved Thread reads and records of this Mac's Thread store. */
export type AwayThreads = {
  execution(session: SessionId): SessionExecution | undefined
  /** `execution` for many Sessions in one read (`ThreadStore.executionsOf`). */
  executionsOf(sessions: Iterable<SessionId>): ReadonlyMap<SessionId, SessionExecution>
  sessionPlacement(session: SessionId): ThreadPlacement | undefined
  journalPlacement(conversationId: string): ThreadPlacement | undefined
  adoptElsewhere(input: { operationId: string; conversationId: string; actor: StoreActor } & ({ session: SessionId } | { forkOf: string; forkSession: SessionId })): ThreadPlacement
  person(): StoreActor
}

/** What a fork's answer names: the conversation it made, and the Session its host put it in. */
const ForkAnswerSchema = z.object({ session: z.object({ id: z.string(), harness: z.string() }).loose(), sessionId: z.string().optional() }).loose()

/**
 * A cloud conversation's folder on its machine, as a window reads it: each call answered where the conversation runs
 * when it's made, through its Thread then, or `here` once it runs on this Mac again (its Thread came back).
 */
export type ElsewhereFolderRoute = {
  conversation: string
  where: string
  call(channel: string, args: readonly unknown[]): Promise<{ value: EncodedValue } | "here">
}

/** An app's view with an address, as `mako:thread-app` answers for a running one. */
const ReadyAddressSchema = z.object({ kind: z.literal("ready"), address: z.object({ host: z.string(), port: z.number().int() }) }).loose()

/** The host log's line as a cloud Thread's machine changes, as this Mac knows it. */
const MACHINE_WORDS = {
  asleep: "a cloud Thread's machine is asleep",
  waking: "a call of this Mac's is waking a cloud Thread's machine",
  awake: "a cloud Thread's machine is awake",
} as const satisfies Record<CloudMachineState, string>
/** A window following a cloud conversation's folder reads its Git again at most this often while its agent works. */
const CHANGED_MS = 1_000
/** The sessions this Mac's stores keep changed: what changed in this long is looked at together, one look at a time. */
const NATIVE_CHANGED_MS = 250

/** The folder the machine's host works in: its tab in front, which is the clone. */

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
  /** The row each listed conversation was last listed from: what its next row's change is read against (`attentionFact`). */
  readonly #heardRows = new Map<string, ListedSession>()
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
  /**
   * By conversation, the requests whose end was heard, the newest few: a request's later changes (what its turn
   * changed, counted after it) restate its end, which says nothing new.
   */
  readonly #ended = new Map<string, Set<string>>()
  /** Conversations whose turn end was heard from a request since their session last ran: its stopping says it again. */
  readonly #endHeard = new Set<string>()
  /** Each cloud Thread's ports, served on this Mac. */
  readonly #previews: CloudPreviews
  /**
   * Cloud Threads whose machine this Mac found asleep, by Thread: from a window's look the cloud didn't apply, until
   * the machine is heard awake (a call answered, or its events came). `calls` counts this Mac's calls to it on their
   * way meanwhile, each of which wakes it: while there are any, it's waking.
   */
  readonly #sleeping = new Map<string, { calls: number }>()
  /** The account's Threads as every device lists them: what puts another device's cloud conversations here. */
  readonly #list = new AccountSessions()
  /** This Mac's device, whose own Sessions are its own, and the names of the account's devices, for where a Session runs. */
  #device: string | undefined
  readonly #deviceNames = new Map<string, string>()
  /** Devices the list named that this Mac hadn't heard of, each asked the account about once (`#nameDevice`). */
  readonly #askedNames = new Set<string>()
  #unlisten: (() => void) | undefined
  #listing: Promise<void> | undefined
  /** The archived cloud Threads last told of (`archivedChanged`), by their account and IDs. */
  #archivedKey: string | undefined
  /** The account whose list was read last: its archived Threads are the ones told of. */
  #accountId: string | undefined
  /** The native sessions whose keeping changed since the last look (`nativeChanged`), by `nativeKey`; "all" for every one. */
  #nativeChanges: Set<string> | "all" | undefined
  #nativeLook: ReturnType<typeof setTimeout> | undefined
  /**
   * Threads followed from the stream's head rather than from an event relayed: a listed conversation a window opened,
   * whose history its snapshot reads on the machine. Replaying the Thread from its first event would carry all of it.
   */
  readonly #fromHead = new Set<string>()
  /** A listed session's capture on its device, in flight or done, by conversation (`#captureListed`). */
  readonly #capturing = new Map<string, Promise<void>>()
  /** Devices found off (`owner-unavailable`), by runtime, until when their conversations are read from their copies. */
  readonly #asleep = new Map<string, number>()
  /** The next look at whether a device found off is back, while a window has one of its conversations open. */
  #waking: ReturnType<typeof setTimeout> | undefined
  /**
   * How many times each Session's waiting messages changed here: a copy's revision moves with them, so a window, and
   * the history reader's views, take its snapshot anew rather than one from before.
   */
  readonly #waitingChanges = new Map<string, number>()
  /** Waiting messages being taken here now, by ID: a list heard twice meanwhile takes each once. */
  readonly #taking = new Set<string>()
  #takeAgain: ReturnType<typeof setTimeout> | undefined
  /** The windows' reads of copies, answered as every client answers them (`CopyHistory`). */
  readonly #copyHistory = new CopyHistory()

  constructor(options: CloudConversationsOptions) {
    this.#options = options
    this.#previews = new CloudPreviews({
      gateway: () => options.account()?.gateway(),
      token: async () => options.account()?.token(),
      // A preview's request wakes a sleeping machine as a call does, and its answer is the machine up.
      request: (threadId) => {
        const ended = this.#calling(threadId)
        return (answered) => {
          if (answered) this.#heardAwake(threadId)
          ended()
        }
      },
    })
    this.controlPreviews = new CloudControlPreviews({ session: async () => (await this.#connected()).session })
    options.readings?.listFrom(() => this.#list.sessions().values())
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
    const entry = await this.#current(id)
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
      this.#asleep.set(entry.runtime, Date.now() + (this.#options.asleepMs ?? ASLEEP_MS))
      hostLog("cloud-conversations", "another device is off; its conversation is read from its copy", { conversationId: entry.conversationId, runtime: entry.runtime })
      this.#watchForWaking()
      return { handled: true, value: await this.#offCall(entry, channel, args) }
    }
  }

  /**
   * While a window has open a conversation of a device found off, asks that device every `ASLEEP_MS` whether it's back,
   * with the smallest read there is (`mako:live-state`). Once it answers, its conversations are listed again, so a
   * window reads the one on screen anew, live, and leaves its copy; until then it stays off. Nothing is asked of a
   * device whose conversations nobody has open.
   */
  #watchForWaking(): void {
    if (this.#waking || this.#closed) return
    this.#waking = setTimeout(() => {
      this.#waking = undefined
      void this.#lookForWaking().finally(() => {
        if (this.#asleep.size) this.#watchForWaking()
      })
    }, this.#options.asleepMs ?? ASLEEP_MS)
    this.#waking.unref?.()
  }

  async #lookForWaking(): Promise<void> {
    for (const runtime of this.#asleep.keys()) {
      const open = [...this.#entries.values()].filter((entry) => entry.runtime === runtime && this.#following.has(entry.threadId))
      const asked = open[0]
      if (!asked) {
        this.#asleep.delete(runtime)
        continue
      }
      try {
        await this.#call(asked, "mako:live-state", [asked.conversationId])
      } catch (error) {
        if (error instanceof OwnerUnavailableError) this.#asleep.set(runtime, Date.now() + (this.#options.asleepMs ?? ASLEEP_MS))
        else hostWarn("cloud-conversations", "couldn't ask whether another device is back", { runtime, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      this.#asleep.delete(runtime)
      const summaries = open.flatMap((entry) => (entry.summary ? [entry.summary] : []))
      hostLog("cloud-conversations", "another device is back; its conversations are read there again", { runtime, open: open.length })
      if (summaries.length) this.#options.emit(encodeRuntimeEvent({ type: "live-listed", summaries }))
    }
  }

  /** A call for a conversation whose device is off: answered from its copy in the account, as every client answers it (`CopyHistory`). */
  async #offCall(entry: Entry, channel: string, args: unknown[]): Promise<EncodedValue> {
    return encodeRuntimeValue(await this.#copyHistory.call(channel, args, this.#copyCall(entry)))
  }

  /**
   * How a conversation of a device that's off is read here: its copy by this Mac's catalog (`HostCatalog.copyPage`),
   * and a message to it kept by the account until that device takes it, under the request's own ID.
   */
  #copyCall(entry: Entry): CopyCall {
    const session = entry.summary?.sessionId
    const account = this.#account()
    const { waitMessage, editWaiting, unwaitMessage } = account
    return {
      conversationId: entry.conversationId,
      where: entry.summary?.elsewhere ?? "Its computer",
      capture: () => this.#copyCapture(entry),
      ...session && waitMessage && editWaiting && unwaitMessage && {
        waiting: {
          wait: async (requestId, text) => {
            await waitMessage.call(account, session, requestId, { conversation: entry.conversationId, text })
            hostLog("cloud-conversations", "a message waits in the account for another device that's off", { conversationId: entry.conversationId, session, requestId })
          },
          edit: async (requestId, expectedText, text) => {
            await editWaiting.call(account, session, requestId, expectedText, text)
          },
          remove: async (requestId) => {
            await unwaitMessage.call(account, session, requestId)
          },
        },
      },
      retold: () => this.#retold(entry),
    }
  }

  /** The conversation's copy as this Mac reads it now: its newest page, and earlier ones by the page. */
  async #copyCapture(entry: Entry): Promise<CopyCapture | null> {
    const copies = this.#options.copies
    const nativeId = entry.nativeId
    if (!copies || !entry.runtime || !nativeId) return null
    const device = entry.runtime.slice("d-".length)
    const source: CopySource = { page: (before, limit) => copies.page(device, entry.harness, nativeId, before, limit) }
    const page = await source.page(undefined, COPY_PAGE)
    if (!page) return null
    const session = entry.summary?.sessionId
    const conversation: CopyConversation = {
      conversationId: entry.conversationId,
      harness: entry.harness,
      createdAt: entry.createdAt,
      waiting: session ? this.#list.waiting(session) : [],
      waitingChanges: session ? (this.#waitingChanges.get(session) ?? 0) : 0,
      ...entry.summary && { listed: entry.summary },
    }
    return { snapshot: copySnapshot(conversation, copyThreadPage(page, `copy:${entry.conversationId}`)), source }
  }

  /** Another device changed a Session's waiting messages: a window reading one of its conversations from its copy reads it again. */
  #retoldWaiting(session: string): void {
    this.#waitingChanges.set(session, (this.#waitingChanges.get(session) ?? 0) + 1)
    for (const entry of this.#entries.values())
      if (entry.summary?.sessionId === session && entry.runtime && (this.#asleep.get(entry.runtime) ?? 0) > Date.now()) this.#retold(entry)
  }

  /** Windows read a conversation of a device that's off again: its waiting messages changed. */
  #retold(entry: Entry): void {
    const session = entry.summary?.sessionId
    if (session) this.#waitingChanges.set(session, (this.#waitingChanges.get(session) ?? 0) + 1)
    if (entry.summary) this.#options.emit(encodeRuntimeEvent({ type: "live-listed", summaries: [entry.summary] }))
  }

  /**
   * Takes the messages waiting for this Mac's own Sessions: each admitted here under its own ID, which settles a
   * message taken twice as one, then the account told it was taken. Heard on the account's list, read whole when this
   * Mac comes back and changed on its stream while it's on. One this Mac no longer owns is its new owner's to take.
   */
  #takeWaiting(): void {
    const take = this.#options.takeWaiting
    const account = this.#options.account()
    if (!take || !account?.tookWaiting || !this.#device || this.#closed) return
    for (const [session, messages] of this.#list.allWaiting()) {
      const row = this.#list.sessions().get(session)
      if (row?.runsOn.kind !== "device" || row.runsOn.deviceId !== this.#device) continue
      for (const message of messages) {
        if (this.#taking.has(message.id)) continue
        this.#taking.add(message.id)
        void (async () => {
          const outcome = await take(message)
          if (outcome === "taken") {
            await account.tookWaiting?.(message.session, message.id)
            hostLog("cloud-conversations", "a message that waited for this Mac was taken", { session, requestId: message.id, from: message.from })
          } else if (outcome === "later") this.#takeLater()
        })()
          .catch((error: Error) => {
            hostWarn("cloud-conversations", "a message that waited for this Mac couldn't be taken yet", { session, requestId: message.id, error: error.message })
            this.#takeLater()
          })
          .finally(() => this.#taking.delete(message.id))
      }
    }
  }

  #takeLater(): void {
    if (this.#takeAgain || this.#closed) return
    this.#takeAgain = setTimeout(() => {
      this.#takeAgain = undefined
      this.#takeWaiting()
    }, TAKE_AGAIN_MS)
    this.#takeAgain.unref?.()
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
   * Thread that moved there. Undefined for a Session that runs here, or in transit (refused where it would start). On
   * its way back, asked again once the return settles, as any call for the Thread waits for it (`#current`).
   */
  async #awayThread(session: SessionId): Promise<{ threads: AwayThreads; sibling: Entry; session: SessionId } | undefined> {
    for (;;) {
      const threads = this.#options.threads?.()
      const execution = threads?.execution(session)
      if (!threads || execution?.state !== "elsewhere" || execution.owner.kind !== "cloud") return undefined
      await this.start()
      const runtime = execution.owner.runtime
      const sibling = [...this.#entries.values()].find((entry) => cloudRuntimeOf(entry.threadId) === runtime)
      if (!sibling) throw new Error("This Thread runs in the cloud, but this Mac no longer follows it there, so it can't start a conversation in it.")
      const returning = this.#options.returning?.(sibling.threadId)
      if (!returning) return { threads, sibling, session }
      await returning
    }
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
    clearTimeout(this.#waking)
    clearTimeout(this.#takeAgain)
    clearTimeout(this.#nativeLook)
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
      this.#options.turnOnChanged?.()
    }
    const asked = prepared
    asked.askedAt = Date.now()
    const making: CloudThreadMaking = { prepare: true }
    if (launch) making.harness = launch.harness
    await this.#carried(folder, "a cloud Thread made ahead")
    asked.asking = account.createThread(asked.threadId, repository, making).then(({ ready }) => {
      asked.made = true
      const was = asked.ready
      asked.ready = ready
      if (ready !== was) this.#options.turnOnChanged?.()
    })
    try {
      await asked.asking
    } catch (error) {
      // Never made: the next ask starts afresh. Made already, it stays for its next ask or its first message.
      if (!asked.made && this.#prepared.get(key) === asked) {
        this.#prepared.delete(key)
        this.#options.turnOnChanged?.()
      }
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
        if (prepared.ready) this.#options.turnOnChanged?.()
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
    const offered = await this.#readOffered()
    const before = offered.accounts.includes(accountId)
    // Offered by a build that didn't keep which projects: they're noted now, for turning the cloud on, not asked again.
    if (before && offered.projects?.[accountId]) return "already"
    const found = await Promise.all(folders.slice(0, PROJECTS_OFFERED).map(async (folder) => {
      const repository = await this.#options.repositoryOf(folder).catch(() => undefined)
      return repository && { folder, repository }
    }))
    // Each repository once, as its newest folder.
    const byRepository = new Map<string, { folder: string; repository: CloudRepository }>()
    for (const project of found) if (project && !byRepository.has(repositoryKey(project.repository))) byRepository.set(repositoryKey(project.repository), project)
    const projects = [...byRepository.values()]
    if (projects.length && !before) await account.askBases(projects.map((project) => project.repository))
    const file = this.#offeredFile()
    await mkdir(dirname(file), { recursive: true })
    const accounts = before ? offered.accounts : [...offered.accounts, accountId]
    await writeFile(file, `${JSON.stringify({ accounts, projects: { ...offered.projects, [accountId]: projects } } satisfies Offered)}\n`)
    this.#options.turnOnChanged?.()
    if (before) return "already"
    hostLog("cloud-conversations", "offered this Mac's recent projects for project bases", { repositories: projects.length })
    return projects.length ? "asked" : "none"
  }

  #offeredFile(): string {
    return join(dirname(this.#options.file), "projects-offered.json")
  }

  async #readOffered(): Promise<Offered> {
    const text = await readFile(this.#offeredFile(), "utf8").catch(() => "{}")
    return OfferedSchema.safeParse(JSON.parse(text)).data ?? { accounts: [] }
  }

  /**
   * The recent projects offered to this account for bases, the newest first, for turning the cloud on to follow:
   * undefined until known, empty when none was on GitHub.
   */
  async offeredProjects(accountId: string): Promise<Array<{ folder: string; repository: CloudRepository }> | undefined> {
    const offered = await this.#readOffered()
    // Offered by an older build, which didn't keep which: unknown until this window offers again, never "none".
    return offered.accounts.includes(accountId) ? offered.projects?.[accountId] : undefined
  }

  /** Asks the cloud again for these repositories' bases: a person's "Try again" after one failed. */
  async askBasesAgain(repositories: CloudRepository[]): Promise<void> {
    const account = this.#options.account()
    if (account && repositories.length) await account.askBases(repositories)
  }

  /** The first cloud Thread this Mac knows of, started here or listed by the account: when it was made. */
  firstCloudThread(): number | undefined {
    let first: number | undefined
    for (const entry of this.#entries.values()) if (entry.repository && entry.created && (first === undefined || entry.createdAt < first)) first = entry.createdAt
    return first
  }

  /** A cloud Thread made ahead for this repository, its machine still coming up or ready for a first message. */
  preparedMachine(repository: CloudRepository): "warming" | "ready" | undefined {
    const prepared = this.#prepared.get(repositoryKey(repository))
    if (!prepared || Date.now() - prepared.askedAt >= PREPARED_KEPT_MS) return undefined
    return prepared.ready ? "ready" : "warming"
  }


  /** The Thread made ahead for a repository, unless this Mac last asked for it too long ago: that one went unused. */
  #fresh(key: string): Prepared | undefined {
    const prepared = this.#prepared.get(key)
    if (!prepared || Date.now() - prepared.askedAt < PREPARED_KEPT_MS) return prepared
    this.#prepared.delete(key)
    clearTimeout(prepared.watching)
    this.#options.turnOnChanged?.()
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
    this.#options.turnOnChanged?.()
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

  /** The project's carried files brought up to date first; a failure is said, and the Thread starts without the newest. */
  async #carried(folder: string, why: string): Promise<void> {
    await this.#options.carried?.(folder, why).catch((error: Error) => hostWarn("cloud-conversations", "the project's carried files weren't brought up to date in the cloud", { why, error: error.message }))
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
      await this.#carried(folder, "a cloud Thread started")
      await account.createThread(entry.threadId, repository, { harness })
      entry.created = true
      await this.#save()
      hostLog("cloud-conversations", "made a cloud Thread", { threadId: entry.threadId, conversationId: entry.conversationId, harness, repository: repository.url })
    }
    // Made now, or taken up from one made ahead: this Mac's first cloud Thread may be this one.
    this.#options.turnOnChanged?.()
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
    const known = this.#entries.get(conversation.conversationId)
    if (known && !known.listed && known.threadId === conversation.threadId) return
    // The move's answer is where it runs now. The account's list hears of a move a moment after it, so what it put here
    // first is taken over: on this Thread, as it stands, still followed; on another (the one that gave it back), gone.
    let entry: Entry
    if (known?.listed && known.threadId === conversation.threadId) {
      entry = known
      Object.assign(entry, { harness: conversation.harness, repository: conversation.repository, created: true })
      for (const key of ["listed", "runtime", "capture"] as const) delete entry[key]
    } else {
      if (known) this.#forget(known)
      entry = { ...conversation, createdAt: Date.now(), created: true, seq: 0 }
      this.#entries.set(entry.conversationId, entry)
    }
    await this.#save()
    this.#follow(entry)
    hostLog("cloud-conversations", "a conversation of this Mac's moved to a cloud Thread", { conversationId: entry.conversationId, threadId: entry.threadId, harness: entry.harness, ...known && { took: known.listed ? "listed" : known.threadId } })
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
    this.#forget(entry)
    await this.#save()
    hostLog("cloud-conversations", "a conversation came back from its cloud Thread", { conversationId, threadId: entry.threadId })
  }

  /** No longer answered here, and its Thread no longer followed once none of its conversations is. */
  #forget(entry: Entry): void {
    this.#entries.delete(entry.conversationId)
    this.#ended.delete(entry.conversationId)
    this.#endHeard.delete(entry.conversationId)
    if (![...this.#entries.values()].some((other) => other.threadId === entry.threadId)) this.#following.get(entry.threadId)?.close()
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

  /**
   * The cloud Thread a conversation or a Session runs in, or ran in before it was archived: by this Mac's own cloud
   * conversations, the account's list, and its archived Threads. Undefined for one another device or this Mac runs.
   */
  async cloudThreadOf(where: { conversationId?: string; sessionId?: string }): Promise<string | undefined> {
    // What's known now: this Mac's own, and the list as last read. Never waits on the cloud, so a local archive doesn't.
    await this.start()
    const { conversationId, sessionId } = where
    const entry = conversationId ? this.#entries.get(conversationId) : undefined
    if (entry) return entry.runtime ? undefined : entry.threadId
    const named = (row: ListedSession) => (conversationId !== undefined && row.conversation === conversationId) || (sessionId !== undefined && row.session === sessionId)
    for (const row of this.#list.sessions().values()) if (named(row)) return row.runsOn.kind === "cloud" ? row.runsOn.threadId : undefined
    for (const archived of this.#list.archived().values()) if (archived.sessions.some(named)) return archived.thread
    if (sessionId) for (const each of this.#entries.values()) if (!each.runtime && each.summary?.sessionId === sessionId) return each.threadId
    return undefined
  }

  /**
   * Archives a conversation another device runs, by asking that device: its archive is its owner's word, and every
   * device's list drops it once its owner does. False for one no other device runs; throws, saying so, while it's off.
   */
  async archiveOnOwner(conversationId: string, command: { id: string; archived: boolean }): Promise<boolean> {
    await this.start()
    const entry = this.#entries.get(conversationId)
    if (!entry?.runtime) return false
    await this.#call(entry, "mako:thread-archive", [{ id: command.id, target: { kind: "live", id: conversationId }, archived: command.archived }])
    return true
  }

  /** The cloud Thread's archive, as the account says it; undefined while it isn't archived. */
  archiveOf(threadId: string): ArchivedThread | undefined {
    return this.#list.archived().get(threadId)
  }

  /**
   * What archiving a cloud Thread asks its machine to pack: each of its conversations whose harness started there (one
   * that never started has nothing to keep), by the account's list and this Mac's own, and the folder they work in there.
   */
  archiveInputs(threadId: string): ArchiveInputs {
    const listed = listedArchiveInputs(this.#list.sessions().values(), threadId)
    const conversations = new Set(listed.conversations)
    let folder = listed.folder
    // This Mac's own, moved or started there: each runs on the machine from its start, though what the machine said of
    // it may not have reached here yet (an archive asked as its move lands).
    for (const entry of this.#entries.values()) {
      if (entry.runtime || entry.listed || entry.threadId !== threadId) continue
      folder ??= entry.summary?.session.cwd || undefined
      conversations.add(entry.conversationId)
    }
    return { conversations: [...conversations], folder }
  }

  /** The cloud conversations of a cloud Thread: their harness and native session, as their machine last said. */
  /** `mode`: the access mode it runs in there, as its last update said. */
  threadConversations(threadId: string): Array<{ conversationId: string; harness: string; nativeId: string | undefined; mode?: string }> {
    return [...this.#entries.values()].filter((entry) => entry.threadId === threadId)
      .map((entry) => {
        const mode = entry.summary?.session.currentMode
        return { conversationId: entry.conversationId, harness: entry.harness, nativeId: entry.summary?.session.nativeId || undefined, ...mode && { mode } }
      })
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
    if (!this.#entries.has(conversationId)) return undefined
    return {
      conversation: conversationId,
      where: CLOUD_FOLDER_WHERE,
      // Asked where it runs at each call, as a call naming the conversation is: a window keeps its folder across a move
      // or a return until it hears of it, and its calls go where the conversation runs meanwhile, never where it ran.
      call: async (channel, args) => {
        const entry = await this.#current(conversationId)
        if (!entry) {
          // Back on this Mac, in the folder it moved from, which a moved Thread's machine had at the same path.
          if (this.#options.threads?.()?.journalPlacement(conversationId)) return "here"
          throw new Error("This conversation's folder isn't in the cloud any more.")
        }
        return { value: await (channel === "mako:thread-app" ? this.#appView(entry, args) : this.#call(entry, channel, args)) }
      },
    }
  }

  /**
   * Where a conversation's calls go now: its entry, or none when it runs on this Mac. While its Thread is on its way
   * back, nothing runs it (the cloud refuses the call, and this Mac doesn't have it yet), so a call waits for the
   * return to settle and goes where the Thread runs after: here once it's back, still the cloud if it stayed.
   */
  async #current(conversationId: string): Promise<Entry | undefined> {
    for (;;) {
      const entry = this.#entries.get(conversationId)
      const returning = entry && this.#options.returning?.(entry.threadId)
      if (!returning) return entry
      await returning
    }
  }

  /**
   * A window's look at the app in a cloud conversation's folder, which it keeps asking for: asked passively, so a window
   * left open neither wakes a sleeping machine nor keeps it running. While the machine sleeps the look says so, with the
   * app as this Mac last saw it awake, kept with the conversation, so a host that restarted meanwhile says the same. The
   * app's address is this Mac's preview of its port, which a click wakes.
   */
  async #appView(entry: Entry, args: readonly unknown[]): Promise<EncodedValue> {
    let view: unknown
    try {
      view = decodeRuntimeValue(await this.#callThread(entry.threadId, "mako:thread-app", args, { conversationId: entry.conversationId, passive: true }))
    } catch (error) {
      // Asleep is a look the cloud didn't apply; any other failure is the machine's, said as it is. Another device that's
      // off isn't asleep the same way: no call wakes it.
      if (entry.runtime || !(error instanceof RuntimeDisconnectedError && !error.unconfirmed)) throw error
      this.#fellAsleep(entry.threadId)
      return encodeRuntimeValue(await this.#asleepView(entry))
    }
    const looked = LookedAppSchema.safeParse(view)
    const kept = looked.success ? keptApp(looked.data) : undefined
    if (kept && JSON.stringify(kept) !== JSON.stringify(entry.app)) {
      entry.app = kept
      this.#saveSoon()
    }
    const ready = ReadyAddressSchema.safeParse(view)
    if (!ready.success) return encodeRuntimeValue(view)
    return encodeRuntimeValue({ ...ready.data, address: await this.#previews.address(entry.threadId, ready.data.address.port) })
  }

  /** The app of a conversation whose machine sleeps, from what this Mac kept of it, and waking while a call of its is. */
  async #asleepView(entry: Entry): Promise<ThreadAppView> {
    const view: Extract<ThreadAppView, { kind: "asleep" }> = { kind: "asleep", project: entry.app?.project ?? (entry.repository ? projectName(entry.repository) : ""), where: CLOUD_FOLDER_WHERE }
    if (this.#sleeping.get(entry.threadId)?.calls) view.waking = true
    const ready = entry.app?.ready
    if (ready) {
      const { port, ...last } = ready
      view.last = port === undefined ? last : { ...last, address: await this.#previews.address(entry.threadId, port) }
    }
    return view
  }

  /** A look the cloud didn't apply: the Thread's machine sleeps. Windows hear so once, as it falls asleep. */
  #fellAsleep(threadId: string): void {
    if (this.#sleeping.has(threadId)) return
    this.#sleeping.set(threadId, { calls: 0 })
    this.#tellMachine(threadId, "asleep")
  }

  /**
   * A call of this Mac's on its way to a Thread, which wakes its machine if it sleeps: windows hear it's waking, and
   * when the last such call ended unanswered there, that it may still sleep (their next look says). Answers its end.
   */
  #calling(threadId: string): () => void {
    const sleeping = this.#sleeping.get(threadId)
    if (!sleeping) return () => {}
    if (sleeping.calls++ === 0) this.#tellMachine(threadId, "waking")
    return () => {
      if (this.#sleeping.get(threadId) === sleeping && --sleeping.calls === 0) this.#tellMachine(threadId, "asleep")
    }
  }

  /** The Thread's machine was heard awake: a call answered there, or its events came. */
  #heardAwake(threadId: string): void {
    if (this.#sleeping.delete(threadId)) this.#tellMachine(threadId, "awake")
  }

  #tellMachine(threadId: string, machine: CloudMachineState): void {
    const conversations = [...this.#entries.values()].filter((entry) => entry.threadId === threadId).map((entry) => entry.conversationId)
    hostLog("cloud-conversations", MACHINE_WORDS[machine], { threadId, conversations: conversations.length })
    this.#options.emit(encodeRuntimeEvent({ type: "cloud-machine", conversations, machine }))
  }

  /**
   * One call to the Thread's machine, repeated by `sendWithRepeats` while the gateway lost it or holds it as the
   * machine wakes: so a send after the machine slept arrives, without the window hearing of the wake. Past that, or for
   * a call only the person may repeat, the window hears it as a reconnect, in a cloud Thread's words.
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
    // A call kept for the machine's next wake (a close) neither wakes it nor, answered by the cloud, says it's awake.
    const wakes = !deferredWhenAsleep.has(channel)
    const ended = wakes && !how.passive ? this.#calling(threadId) : undefined
    try {
      const value = await sendWithRepeats(channel, send, { ...how, threadId, log: CALL_LOG })
      if (wakes) this.#heardAwake(threadId)
      return value
    } finally {
      ended?.()
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

  /**
   * Relays the Thread's events from the last one relayed. A stream that ends is followed again at once, then with a
   * backoff while it keeps failing (`followAgainInMs`). A Thread's stream is its log, gap-free from its first event;
   * another device's conversation streams only while watched, numbered once its gateway says so (`StreamCursor`), which
   * keeps the last few: a number skipped is asked for again from there, and one too old to have is read again whole
   * (`#reread`). While the conversation is at work, a stream silent for `SILENT_WHILE_WORKING_MS` has its connection
   * asked whether it's alive, so a stalled link is replaced in seconds.
   */
  #follow(entry: Entry): void {
    if (this.#closed || this.#following.has(entry.threadId)) return
    this.#following.set(entry.threadId, undefined)
    const run = async () => {
      let failures = 0
      let gapsInRow = 0
      let failing = false
      let wakes = this.#wakes
      const cursor = new StreamCursor(entry.runtime ? "live" : "log", entry.runtime || this.#fromHead.has(entry.threadId) ? undefined : entry.seq)
      let readings: FollowRecorder | undefined
      let probedAt: number | undefined
      // An archived Thread takes nothing and says nothing: it isn't followed.
      while (!this.#closed && this.#entries.get(entry.conversationId) === entry && !this.#list.archived().has(entry.threadId)) {
        try {
          const { session } = await this.#connected()
          const stream = entry.runtime ? entry.threadId : threadStream(entry.threadId)
          const after = entry.runtime ? cursor.resumeAfter() : (cursor.last ?? (this.#fromHead.has(entry.threadId) ? Number.MAX_SAFE_INTEGER : entry.seq))
          readings = this.#options.readings?.follow(stream, entry.summary?.session.title)
          const subscription = session.subscribe({ stream, after })
          this.#following.set(entry.threadId, subscription)
          let gap = false
          while (!gap) {
            let frame: EventFrame
            try {
              frame = await subscription.next(this.#working(entry) ? SILENT_WHILE_WORKING_MS : undefined)
            } catch (error) {
              if (!(error instanceof NothingArrivedError)) throw error
              // At work and silent: the link may have stalled. A ping it doesn't answer ends it, and this follows again.
              session.probe(stream, PROBE_ANSWER_MS)
              readings?.probe()
              probedAt = performance.now()
              continue
            }
            const verdict = cursor.heard({ seq: frame.seq, text: frame.event.text })
            if (verdict.kind === "notice" || verdict.kind === "duplicate") continue
            if (verdict.kind === "reread") {
              readings?.reread()
              this.#reread(entry)
              continue
            }
            if (verdict.kind === "gap") {
              readings?.gap()
              readings?.followedAgain("gap")
              gap = true
              continue
            }
            // A gateway that doesn't number the stream numbers it by the clock: what came before the last is a repeat.
            if (!cursor.numbered && frame.seq <= entry.seq) continue
            this.#fromHead.delete(entry.threadId)
            entry.seq = frame.seq
            this.#relay(entry, frame.event.text)
            this.#saveSoon()
            failures = 0
            gapsInRow = 0
            failing = false
          }
          // A number skipped: asked for again at once from the last one held, which the gateway serves from what it
          // kept. One gap after another is a stream that keeps failing.
          if (++gapsInRow <= 3) continue
        } catch (error) {
          if (this.#closed) return
          // Ended by its probe going unanswered, the link had gone silent; otherwise it closed, or couldn't be followed.
          readings?.followedAgain(!(error instanceof LinkClosedError) ? "failed" : probedAt !== undefined && performance.now() - probedAt < PROBE_ANSWER_MS * 2 ? "silent" : "closed")
          probedAt = undefined
          if (!failing) hostWarn("cloud-conversations", "a cloud Thread's events stopped; following again", { threadId: entry.threadId, error: error instanceof Error ? error.message : String(error) })
          failing = true
        }
        const woken = performance.now() - this.#wokeAt < WOKEN_MS
        if (this.#wakes === wakes) await this.#pause(woken ? followAgainInMs(0) : followAgainInMs(failures++))
        if (this.#wakes !== wakes) {
          // Woken: the stream that ended went with the sleep, and the network may be back; no backoff carried over.
          wakes = this.#wakes
          failures = 0
        }
      }
    }
    void run().finally(() => {
      this.#following.delete(entry.threadId)
      this.#fromHead.delete(entry.threadId)
    })
  }

  /** Whether a followed conversation is at work, so silence on its stream may be a stalled link. */
  #working(entry: Entry): boolean {
    return entry.summary?.session.status === "running"
  }

  /**
   * What another device's conversation said while this Mac couldn't hear it is gone from what its gateway keeps: every
   * window reading it reads it again, as for any notice that its history changed.
   */
  #reread(entry: Entry): void {
    const summary = entry.summary
    const batch = { id: entry.conversationId, revision: (summary?.revision ?? 0) + 1, ...(summary?.epoch !== undefined && { epoch: summary.epoch }), updates: [], historyChanged: true }
    hostLog("cloud-conversations", "a watched conversation's stream can't be picked up where it was; its windows read it again", { conversation: entry.conversationId })
    this.#options.emit({ type: "live-batch", conversation: entry.conversationId, payload: JSON.stringify({ type: "live-batch", batch }) })
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
    // The Thread's object's own word on its machine, written into the stream as JSON: every conversation of the Thread
    // here shows it. Read only when the line says so, so a runtime's batches are never parsed for it.
    if (line.startsWith(MACHINE_NOTICE_PREFIX)) return this.#machineNotice(entry, line)
    const head = readEventLine(line)
    if (!head || head.channel !== "event") return
    // Only its host's events are a runtime's lines: the machine is up (woken by another device, or by its own work).
    this.#heardAwake(entry.threadId)
    if (head.type === "control-activity") {
      // The machine's host emits every conversation's; only this one's is this Thread's to show.
      const event = ControlActivityEventSchema.safeParse(JSON.parse(head.payload))
      if (!event.success || this.#entries.get(event.data.activity.conversationId)?.threadId !== entry.threadId) return
      const { activity } = event.data
      this.controlPreviews.activity(entry.threadId, activity)
      this.#options.emit({ type: "control-activity", payload: head.payload })
      return
    }
    // One subscription follows a Thread; a Thread moved from this Mac can carry several of its conversations.
    const target = head.type === "live-batch" && head.conversation ? this.#entries.get(head.conversation) : undefined
    if (!target || target.threadId !== entry.threadId) return
    // In the compact live form, read only by the windows, which hold what it was written against; this reads the fields
    // it carries as they are.
    const { batch } = z.object({ batch: LiveBatchSchema }).parse(JSON.parse(head.payload))
    const compact = head.form === COMPACT_LIVE_FORM
    this.#options.readings?.follow(entry.runtime ? entry.threadId : threadStream(entry.threadId)).heard(batch.emittedAt, compact)
    if (batch.trace) hostLog("sync", "traced update heard", { trace: batch.trace, conversation: target.conversationId, ...(batch.emittedAt !== undefined && { lagMs: Date.now() - batch.emittedAt }) })
    const before = target.summary?.session.status
    if (target.summary) {
      const summary: LiveSummary = { ...target.summary, session: sessionAfter(target.summary.session, batch), revision: batch.revision }
      if (batch.epoch) summary.epoch = batch.epoch
      const promptedAt = promptedAfter(summary.promptedAt, batch)
      if (promptedAt !== undefined) summary.promptedAt = promptedAt
      target.summary = summaryOf(summary)
    }
    // A turn ended there: a request of its reached its end in this batch, or the session stopped running with no
    // request's end heard since it began (a turn the harness began itself). The first holds however the batches fell (a
    // turn begun and ended in one, or a summary this Mac never had), and the stream replays from where this Mac left it,
    // so a turn that ended while it slept or lost the link is heard as it catches up. Each end is said once.
    const after = target.summary?.session.status
    if (before !== "running" && after === "running") this.#endHeard.delete(target.conversationId)
    if (this.#endsRequest(target.conversationId, batch)) {
      this.#endHeard.add(target.conversationId)
      this.#options.turnEnded?.(target.conversationId, entry.threadId)
    } else if (before === "running" && after !== "running" && !this.#endHeard.delete(target.conversationId)) this.#options.turnEnded?.(target.conversationId, entry.threadId)
    this.#options.emit({ type: "live-batch", conversation: target.conversationId, payload: head.payload, ...(compact && { form: COMPACT_LIVE_FORM }) })
    this.#noteChange(target.conversationId)
  }

  /**
   * Whether a relayed batch carries a request of the conversation reaching its end for the first time: a turn ended. A
   * whole list (one went away, or they reordered) restates requests that ended long ago, which are noted, never said.
   */
  #endsRequest(conversationId: string, batch: Pick<HeardLiveBatch, "requests" | "requestChanges"> & Pick<CompactLiveBatch, "requestPatches">): boolean {
    const ended = this.#ended.get(conversationId) ?? new Set<string>()
    this.#ended.set(conversationId, ended)
    const note = (id: string) => {
      ended.add(id)
      for (const oldest of ended) {
        if (ended.size <= ENDED_KEPT) break
        ended.delete(oldest)
      }
    }
    for (const request of batch.requests ?? []) if (ENDED_REQUEST.has(request.status)) note(request.id)
    const changed = [...(batch.requestChanges ?? []), ...(batch.requestPatches ?? []).flatMap((patch) => (patch.set?.status ? [{ id: patch.id, status: patch.set.status }] : []))]
    const fresh = changed.filter((request) => ENDED_REQUEST.has(request.status) && !ended.has(request.id))
    for (const request of fresh) note(request.id)
    return fresh.length > 0
  }

  #machineNotice(entry: Entry, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const notice = ThreadMachineNoticeSchema.safeParse(parsed)
    if (!notice.success) return
    const conversationIds = [...this.#entries.values()].filter((each) => each.threadId === entry.threadId).map((each) => each.conversationId)
    if (!conversationIds.length) return
    hostLog("cloud-conversations", "the cloud's word on a cloud Thread's work", { threadId: entry.threadId, state: notice.data.state, savedAt: notice.data.savedAt ?? -1, reason: notice.data.reason ?? "none" })
    this.#options.emit(encodeRuntimeEvent({ type: "cloud-machine-notice", conversationIds, notice: notice.data }))
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
        return
      }
      // The stream skipped a number: the list is read whole again, replacing what's held in one step.
      if ("gap" in heard) {
        this.#options.readings?.listGap(heard.gap)
        return void this.#readList()
      }
      this.#options.readings?.listHeard(heard.seq)
      if (heard.event.type === "sessions-listed") for (const row of heard.event.sessions) if (row.changedAt) this.#options.readings?.listChanged(row.changedAt)
      const named = this.#named(heard)
      if (this.#list.heard(heard)) {
        // Only the rows the change names are looked at again: one Session's state, while hundreds are listed.
        this.#reconcile(named)
        this.#takeWaiting()
        if (heard.event.type === "messages-waiting") this.#retoldWaiting(heard.event.session)
      } else if (!this.#list.known) void this.#readList()
    })
    void this.#readList()
  }

  /**
   * The conversations a change to the list is about, as the list holds them before it and as the change says them (a
   * Session that moved may be another conversation now); undefined when it may change any row: a device going quiet
   * or coming back, a Thread archived or taken back.
   */
  #named(heard: AccountListHeard): ReadonlySet<string> | undefined {
    const { event } = heard
    const named = new Set<string>()
    const held = (session: string) => {
      const conversation = this.#list.sessions().get(session)?.conversation
      if (conversation !== undefined) named.add(conversation)
    }
    if (event.type === "sessions-listed") for (const row of event.sessions) {
      named.add(row.conversation)
      held(row.session)
    }
    else if (event.type === "sessions-unlisted") for (const session of event.sessions) held(session)
    else if (event.type === "messages-waiting") held(event.session)
    else return undefined
    return named
  }

  /** The account's list, read whole: once at start, after a sign-in, and after a wake while it isn't known. */
  #readList(): Promise<void> {
    this.#listing ??= (async () => {
      const account = this.#options.account()
      const accountId = account?.sessionListings ? await account.id() : undefined
      if (this.#closed || !account?.sessionListings || !accountId) return
      try {
        this.#device = await account.deviceId()
        const [listings, devices] = await Promise.all([account.sessionListings(), account.devices?.().catch(() => undefined)])
        for (const device of devices?.devices ?? []) this.#deviceNames.set(device.id, device.name)
        this.#accountId = accountId
        if (this.#list.listed(listings)) this.#reconcile()
        else this.#archivedNow()
        this.#takeWaiting()
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
   * batches, which say more and sooner, but for whether its device is quiet (a quiet device sends no batches) and its
   * Thread's name (no batch carries it): those are the list's to say of every conversation, followed or not. Windows hear what changed and list it as they list a
   * conversation at boot: nothing wakes a machine or reaches a Mac until one opens.
   *
   * `only` limits it to those conversations, as when the sessions this Mac keeps changed (`nativeChanged`). A row whose
   * keeping this Mac can't say yet (its catalog isn't read, or is being read again) is left as it is, listed or not:
   * a list replaces only what it's the word on.
   */
  #reconcile(only?: ReadonlySet<string>): void {
    this.#archivedNow()
    const picked = (conversation: string) => !only || only.has(conversation)
    const wanted = new Map<string, { row: ListedSession; threadId: string; runtime?: string; where: string; quietSince: string | undefined; archived?: true }>()
    const undecided = new Set<string>()
    // An archived cloud Thread's Sessions, as they were listed when it was archived: every device shows them with the
    // archived ones (`archivedChanged`), at rest, and nothing runs them.
    for (const archived of this.#list.archived().values())
      for (const row of archived.sessions) if (picked(row.conversation)) wanted.set(row.conversation, { row: { ...row, state: "idle" }, threadId: archived.thread, where: CLOUD_FOLDER_WHERE, quietSince: undefined, archived: true })
    const rows = [...this.#list.sessions().values()].filter((row) => picked(row.conversation))
    const executions = this.#executions(rows)
    for (const row of rows) {
      if (!this.#listable(row, executions)) continue
      if (row.runsOn.kind === "device") {
        if (row.runsOn.deviceId === this.#device) continue
        const kept = this.#keptHere(row)
        if (kept === undefined) {
          undecided.add(row.conversation)
          continue
        }
        if (kept) continue
        const owner = listedOwner(row)
        if (owner.kind !== "device") continue
        const name = this.#deviceNames.get(owner.deviceId)
        if (name === undefined) this.#nameDevice(owner.deviceId)
        wanted.set(row.conversation, { row, threadId: owner.stream, runtime: owner.runtimeId, where: name ?? "another computer", quietSince: this.#list.quietSince(owner.deviceId) })
      } else if (!this.#options.returning?.(row.runsOn.threadId)) wanted.set(row.conversation, { row, threadId: row.runsOn.threadId, where: CLOUD_FOLDER_WHERE, quietSince: undefined })
    }
    // How many conversations each Thread has here: one that leaves the last of its Thread's stops its following.
    const perThread = new Map<string, number>()
    for (const entry of this.#entries.values()) perThread.set(entry.threadId, (perThread.get(entry.threadId) ?? 0) + 1)
    const unlisted: string[] = []
    // Deleting from a Map as it's walked is safe: the walk goes on past what went.
    for (const entry of this.#entries.values()) {
      if (!entry.listed || !picked(entry.conversationId) || undecided.has(entry.conversationId) || wanted.get(entry.conversationId)?.threadId === entry.threadId) continue
      this.#entries.delete(entry.conversationId)
      this.#heardRows.delete(entry.conversationId)
      this.controlPreviews.forget(entry.conversationId)
      this.#capturing.delete(entry.conversationId)
      unlisted.push(entry.conversationId)
      const left = (perThread.get(entry.threadId) ?? 1) - 1
      perThread.set(entry.threadId, left)
      if (left <= 0) this.#following.get(entry.threadId)?.close()
    }
    const listed: LiveSummary[] = []
    for (const [id, { row, threadId, runtime, where, quietSince, archived }] of wanted) {
      const known = this.#entries.get(id)
      if (known && !known.listed) {
        // A cloud conversation this Mac started or moved: its machine's row says when the person last wrote to it, from
        // any device, which every rail ranks its project by. Its windows hear that in its batches while it's followed.
        const promptedAt = laterPrompt(known.summary?.promptedAt, listedPromptedAt(row))
        if (known.summary && promptedAt !== undefined && promptedAt !== known.summary.promptedAt) {
          known.summary = { ...known.summary, promptedAt }
          if (!this.#following.has(known.threadId)) listed.push(known.summary)
          this.#saveSoon()
        }
        continue
      }
      const summary = listedSummary(row, where, quietSince)
      // What its change says, by the rule the account's notices use: only of a row heard here before (the first
      // listing is where things stand, which a window marks without announcing), never of an archive's rows (listed
      // at rest, not finished) nor of a quiet device's (nothing there runs).
      const heard = this.#heardRows.get(id)
      if (!archived) this.#heardRows.set(id, row)
      const fact = heard && !archived && quietSince === undefined ? attentionFact(heard, row) : undefined
      if (known && this.#following.has(known.threadId)) {
        // A window follows it: its batches say the rest, but nothing comes from a device gone quiet, nor says it's back.
        const held = known.summary
        if (held?.quietSince !== summary.quietSince) {
          known.summary = summary
          listed.push(summary)
          continue
        }
        // Nor do they carry its Thread's name: the list is the one word on it on every device, followed or not.
        if (!held || held.threadTitle === summary.threadTitle) continue
        const named: LiveSummary = { ...held }
        if (summary.threadTitle === undefined) delete named.threadTitle
        else named.threadTitle = summary.threadTitle
        known.summary = named
        listed.push(named)
        continue
      }
      if (known?.summary && JSON.stringify(known.summary) === JSON.stringify(summary)) continue
      const entry: Entry = known ?? { conversationId: id, threadId, harness: row.harness, createdAt: summary.createdAt, created: true, seq: 0, listed: true }
      if (runtime) entry.runtime = runtime
      if (row.capture && runtime) entry.capture = row.capture.path
      else delete entry.capture
      if (row.nativeId) entry.nativeId = row.nativeId
      entry.summary = summary
      this.#entries.set(id, entry)
      // Said on this listing alone: a later one (a rename) carries no fact, so a window reloaded since never hears it again.
      listed.push(fact ? { ...summary, attention: { kind: fact.kind, key: fact.key } } : summary)
    }
    // A Session that moved (another device's to the cloud, or back) is listed where it runs now, never unlisted on the way.
    const relisted = new Set(listed.map((summary) => summary.session.id))
    const gone = unlisted.filter((id) => !relisted.has(id))
    if (listed.length) this.#options.emit(encodeRuntimeEvent({ type: "live-listed", summaries: listed }))
    if (gone.length) this.#options.emit(encodeRuntimeEvent({ type: "live-unlisted", ids: gone }))
    if (listed.length || gone.length) hostLog("cloud-conversations", "the account's list changed what's listed here", { listed: listed.length, unlisted: gone.length, moved: unlisted.length - gone.length })
  }

  /**
   * The sessions this Mac's harness stores keep changed: another device's rows that are this Mac's own go, or come back.
   * `changed` names the native sessions a write touched; none means any may have (the catalog was read anew, or lost a
   * row). Changes are gathered for `NATIVE_CHANGED_MS` and looked at together, only the rows they name, one look at a
   * time: a catalog writes on every turn of every session, and each used to list the account's rows here anew.
   */
  nativeChanged(changed?: readonly { harness: string; nativeId: string }[]): void {
    if (!this.#options.keepsNative || this.#closed) return
    const held = this.#nativeChanges
    if (!changed) this.#nativeChanges = "all"
    else if (held !== "all") {
      const keys = held ?? new Set<string>()
      for (const each of changed) keys.add(nativeKey(each.harness, each.nativeId))
      this.#nativeChanges = keys
    }
    if (this.#nativeLook) return
    this.#nativeLook = setTimeout(() => {
      this.#nativeLook = undefined
      const changes = this.#nativeChanges
      this.#nativeChanges = undefined
      // A list not read yet has nothing of this Mac's to hide; reading it reconciles it whole.
      if (!changes || !this.#list.known || this.#closed) return
      if (changes === "all") return this.#reconcile()
      const only = new Set<string>()
      for (const row of this.#list.sessions().values()) if (row.nativeId !== undefined && changes.has(nativeKey(row.harness, row.nativeId))) only.add(row.conversation)
      if (only.size) this.#reconcile(only)
    }, this.#options.nativeChangedMs ?? NATIVE_CHANGED_MS)
    this.#nativeLook.unref?.()
  }

  /**
   * Another device's row for a session this Mac's own harness stores keep in the same folder: a second Mako on this Mac
   * reading the same stores, listing what this Mac lists already. One session, one row: this Mac's, read from its own
   * disk. A cloud machine's row is never one: a Session that moved there runs there, whatever copy is left here.
   * Undefined while this Mac's catalog can't say.
   */
  #keptHere(row: ListedSession): boolean | undefined {
    if (row.nativeId === undefined || !this.#options.keepsNative) return false
    return this.#options.keepsNative(row.harness, row.nativeId, row.folder)
  }

  /**
   * A device enrolled since the list was first read (another profile signed in, a new Mac) runs Sessions the list names:
   * the account's devices are read again, once for each such device, and its rows say its name.
   */
  #nameDevice(device: string): void {
    const account = this.#options.account()
    if (this.#askedNames.has(device) || !account?.devices) return
    this.#askedNames.add(device)
    void account.devices().then((devices) => {
      const unheard = devices.devices.filter((known) => this.#deviceNames.get(known.id) !== known.name)
      for (const known of unheard) this.#deviceNames.set(known.id, known.name)
      if (unheard.length && !this.#closed) this.#reconcile()
    }, () => {})
  }

  /**
   * Tells the host of the archived cloud Threads when they changed, and stops following each: it says nothing now. Only
   * a list read says: before one is, or after a sign-out forgot it, the host keeps what it was told last.
   */
  #archivedNow(): void {
    const account = this.#accountId
    if (!this.#list.known || !account) return
    const archived = this.#list.archived()
    const key = `${account}\n${[...archived.keys()].sort().join(",")}`
    if (key === this.#archivedKey) return
    this.#archivedKey = key
    for (const thread of archived.keys()) this.#following.get(thread)?.close()
    this.#options.archivedChanged?.(account, archived)
  }

  /**
   * Whether the list may say where a Session runs. One of this Mac's own runs where its Thread store says, and only its
   * moves and returns route it (`adopt`, `release`): the list hears of each a moment later, and a row from before a
   * return would send this Mac's calls to the cloud Thread that gave it back. Listed only where the store has it too.
   */
  #listable(row: ListedSession, executions: ReadonlyMap<string, SessionExecution>): boolean {
    const execution = executions.get(row.session)
    if (!execution) return true
    return execution.state === "elsewhere" && execution.owner.kind === "cloud" && row.runsOn.kind === "cloud" && execution.owner.runtime === cloudRuntimeOf(row.runsOn.threadId)
  }

  /** What this Mac's Thread store says of the rows' Sessions, read once for all of them (`#listable`). */
  #executions(rows: readonly ListedSession[]): ReadonlyMap<string, SessionExecution> {
    const store = this.#options.threads?.()
    if (!store || !rows.length) return new Map()
    return store.executionsOf(rows.flatMap((row) => {
      const session = SessionIdSchema.safeParse(row.session)
      return session.success ? [session.data] : []
    }))
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
    this.#options.turnOnChanged?.()
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

/** The ends a request reaches: its turn is over, whatever it did. */
const ENDED_REQUEST = new Set<LiveRequest["status"]>(["completed", "failed", "interrupted", "canceled", "uncertain"])
/** How many of a conversation's ended requests are remembered: far more than a batch restates. */
const ENDED_KEPT = 64

/** A native session of a harness, as `nativeChanged` names it. */
const nativeKey = (harness: string, nativeId: string) => `${harness}\n${nativeId}`

/** A snapshot's summary fields, which are all a window needs to list the conversation before it opens it. */
function summaryOf(snapshot: LiveSummary): LiveSummary {
  const summary: LiveSummary = { session: snapshot.session, revision: snapshot.revision, createdAt: snapshot.createdAt, elsewhere: CLOUD_FOLDER_WHERE }
  // A Thread moved from this Mac has the same IDs in both stores: a window places its tabs by them.
  if (snapshot.threadId) summary.threadId = snapshot.threadId
  if (snapshot.sessionId) summary.sessionId = snapshot.sessionId
  if (snapshot.threadTitle) summary.threadTitle = snapshot.threadTitle
  if (snapshot.epoch) summary.epoch = snapshot.epoch
  if (snapshot.threadPath) summary.threadPath = snapshot.threadPath
  if (snapshot.nativePaths) summary.nativePaths = snapshot.nativePaths
  if (snapshot.nativeIds) summary.nativeIds = snapshot.nativeIds
  if (snapshot.hasSessionQuestions) summary.hasSessionQuestions = snapshot.hasSessionQuestions
  if (snapshot.promptedAt !== undefined) summary.promptedAt = snapshot.promptedAt
  return summary
}
