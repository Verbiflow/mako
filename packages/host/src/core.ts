import type { HostStopping } from "./base/host-stopping.js"
import { randomBytes } from "node:crypto"
import { recipesOverHttp } from "@mako/protocol/recipes-http"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { z } from "zod"
import { decodeRuntimeValue, encodeRuntimeValue } from "./contracts/runtime-value.js"
import { sessionAccessTier } from "./contracts/access.js"
import { listedUnderApex } from "./contracts/agents.js"
import { listedFins } from "./contracts/children.js"
import { githubRepositoryUrl, type ThreadHandOff, type ThreadReturnOptions } from "./contracts/cloud-threads.js"
import { watch, type FSWatcher } from "node:fs"
import { stat, writeFile } from "node:fs/promises"
import { mediaExecutable } from "@mako/control-runtime/media"
import { controlArtifactsRoot, controlRecordingsRoot } from "@mako/control/program"
import { homedir } from "node:os"
import { join } from "node:path"
import { hostLabel, type HostConfig } from "./host-config.js"
import type { HostMethods, RoutedCall, startWebHost } from "./transport/index.js"
import type { HostJobs, JobDemand } from "./base/host-jobs.js"
import type { Foreground } from "./base/foreground.js"
import { heavy } from "./base/heavy-packages.js"
import type { HostWork } from "./base/event-loop.js"
import { Admission } from "./base/admission.js"
import { readPower } from "./base/power.js"
import { SessionIdSchema, ThreadIdSchema, type ThreadId } from "./contracts/thread-identity.js"
import { threadArchiveKey, type ArchiveAnswer, type ArchiveCommand, type CloudArchiveOutcome } from "./contracts/thread-lifecycle.js"
import type { ArchivedThread } from "@mako/protocol/thread-listing"
import type { Domain } from "./base/host-domains.js"
import { hostLog, hostWarn, logsRoot } from "./base/host-log.js"
import { HeapWatch, readHeap } from "./base/heap-watch.js"
import { cloudUrl } from "./base/build-identity.js"
import { NativeUnknown } from "./base/native-unknown.js"
import { StreamMismatches } from "./base/stream-mismatches.js"
import type { HostChannel } from "./contracts/host-call-inputs.js"
import { detachedSecrets, type HostSecretStore } from "./base/host-secrets.js"
import { ATTRIBUTION_SETTLE_MS, declareAttributionMethods, harnessStores, openAttribution, type Attribution } from "./attribution/index.js"
import { childProcessReader, CheckoutLeave, cloudHasAll, cloneRepository, MediaRenditions, OwnedFiles, readSignedFile, readWindowFile, WorkspaceClients, Automations, AutomationLaunches, AutomationNotStartedError, childBackend, probeDelivery, administratorPrompt, declareFileEventsMethods, FileEventsServiceWatch, readFseventsd, WatchReadings, type FileHistory, watchTree, watchOutsideGitDir, ConversationFiles, ArtifactPreviews, checkoutConversations, openWorkspaces, openWorkspaceMovers, BuildSlots, declareWorkspaceMethods, RecipeAccounts, CloudCarriedFiles, declareCarriedFilesMethods, readProjectRecipe, answeredElsewhere, elsewhereRefusal, type HostPool, type AgentHost, type WorkspaceMovers, declareSetupMethods, SetupViews } from "./workspaces/index.js"
import { hostClient, withHostClient } from "./base/host-client.js"
import { ProviderChildren, readMakoProcesses } from "./base/provider-children.js"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { makoRecords, streamsRoot } from "@mako/sessions/record-streams"
import { makoViews, type ThreadRef } from "@mako/sessions"
import { unreadCounts } from "@mako/sessions/unread-index"
import { watchWake } from "./base/wake.js"
import { busySinceLastAsk } from "./base/machine-load.js"
import { Advertiser, ADVERTISE_EVERY_MS } from "./base/advertiser.js"
import { deviceProbe, probeCapabilities, type SimulatorFacts } from "./base/capabilities.js"
import { LentHere } from "./base/lent.js"
import { operationWords } from "@mako/protocol/borrow-words"
import { setupStep } from "./contracts/simulator-setup.js"
import { declareTelemetryMethods, declareCloudAccountMethods, type CloudAccount, type MachineGatewayLink, MachineWorkspace, declareUsageMethods, declareStorageMethods, declareFootprintMethods, readProcessTable, HelperRuns, helperRunsRoot, LeftoverFiles, MakoStorage, RecordRepacks, spendWatch, describeThisDevice, Lending, LEND_BEAT_MS } from "./usage/index.js"
import { resolveHarnessTuning, nativeHarnesses, createHarnessHost, CliReadings, threadHarnesses, openHarnesses, declareHarnessMethods, liveToolEffects, liveCallBounds, installCloudSignIns, CloudSignInSync, AccessChoiceStore, declareAccessChoiceMethods, FinDefaultsStore, declareFinDefaultMethods, callGateAnswer, HookCall, harnessLabel, type CloudSignInPlace, type PrefetchOutcome } from "./harnesses/index.js"
import type { CloudSignIn, CloudSignInInstall } from "./contracts/cloud-sign-ins.js"
import type { CarriedFile } from "./contracts/machine-agent.js"
import type { GitHubPerson } from "./contracts/github-person.js"
import { machineOffer, presentMachine, processMachine } from "./base/machine.js"
import { hostPlatform, nodePlatform, onMac } from "./base/platform.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import type { KeepAwakeSettings } from "./contracts/keep-awake.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import { openThreads, declareThreadMethods, declareUnreadRecordMethods } from "./threads/index.js"
import { accountBorrowing, BorrowedSimulators, ControlResidency, controlLine, openControl, declareControlMethods, controlVideoMedia, type ControlService } from "./control/index.js"
import type { MediaHandler } from "@mako/protocol"
import { workspaceWrites } from "./base/workspace-writes.js"
import { SyncRecorder } from "./contracts/sync-readings.js"
import { AgentAskGate, AutomationTool, HarnessTool, SettingsTool, declareAutomationToolMethods, declareHarnessToolMethods, declareSettingsMethods, FinCapacity, FinCostModel, FinCostSampler, MacCapacity, ThreadActTool, declareAgentAskMethods, declareThreadActMethods, finSlots, openConversations, openMachineTracker, type MachineTracker, type MoveArrivalDeps, declareConversationMethods, declareCloudControlPreviewMethods, CloudArchives, CloudContinues, CloudConversations, CloudFollow, CloudHandOffs, machineLeaving, SHUTDOWN_HOLD_MS, CloudWorktrees, CloudMoves, CloudReadiness, AwayNotes, CloudReturns, HarnessCheck, READY_EVERY_MS, folderRepository, namedUuid, SleepHandOff, sleepWatchHelper, KeepAwake, recountsWork, workingThreads, conversationShown, finAsking, ownedSessions, REPORT_WORK, SessionPublisher, MovesUnderWay, SessionUploads, declareSyncMethods, CloudTurnOnFollower, OwnerFiles, declareTurnOnMethods, ListedRepositories, TURN_ON_POLL_MS, ownerHold, readBackfill, windowStart, installedReading, registerThreadHistoryTools, threadHistoryTools, registerAgentTools, AgentAnswerSchema, callThreadOf, ThreadMoveTool, ThreadMoveAnswerSchema, declareThreadMoveMethods, registerThreadTools, makoNote, type Conversations, sessionOrderIn } from "./conversations/index.js"
import { openTools, startConversationMcp, watchPluginChanges, declareToolMethods, type ConversationMcp } from "./tools/index.js"
import { declareGitMethods, hostGit, machinePullRequestsAs } from "./git/index.js"
import { declareMediaMethods, MachineArtifacts, machineArtifactPlaces, registerShowTool, TurnMedia } from "./media/index.js"
import type { TerminalClients } from "./terminals/index.js"
import { declareApplicationMethods, Updates, type Application } from "./application/index.js"
import { devHostBuildDirectories } from "./base/dev-host-build.js"
import type { HostOwner } from "./create-host.js"
import { backgroundWork } from "./contracts/background-work.js"
import { withChildren } from "./contracts/native-agents.js"
import { personPromptedAt } from "./contracts/worked-at.js"
import { projectFolder, worktreeAt } from "./contracts/worktree-paths.js"

type WebHost = Awaited<ReturnType<typeof startWebHost>>

/** How long after start the held messages the last host left are first looked at for their time. */
const HELD_WAKES_AFTER_START_MS = 2_000
/** A project whose checkout this host couldn't read, or let go of, is asked about again at most this often. */
const HEAD_ASK_AGAIN_MS = 60_000
/**
 * How long attribution's read of the catalog stands with nothing said to move it (`cataloguedRows`): a safety net, not a
 * refresh. Rows the catalog moves are put in place, placements move it, and a folder's worktree origin is read once and
 * kept (`WorktreeOrigins.of`; only a missing folder is looked for again, and its session's next write moves its row).
 * At 30 s it was the one thing still listing the catalog whole: every 30 s, about 170 ms, on a quiet host.
 */
const CATALOGUED_FRESH_MS = 10 * 60_000

/** What the host gives its core: the socket, the method table, and the domains that load on their own. */
/** When a stop still running says where it is: well before the 15 s a machine's agent or a test waits for it. */
const STOP_SLOW_MS: readonly number[] = [2_000, 10_000]

export interface CoreShell {
  config: HostConfig
  /** On a cloud machine: asks its agent to make the Thread's folder again, false where it can't be asked. */
  retryMachineWorkspace?(): boolean
  /** On a cloud machine: asks its agent to place the project's carried files from the account's store again, and waits. */
  refreshMachineCarried?(): Promise<void>
  /** On a cloud machine: reports its Sessions on its runtime's link now, as its tick does (`MachineRuntime.reportSessions`). */
  reportMachineSessions?(): void
  /** On a cloud machine: whether its pull requests go as its person, asked now (`MachineRuntime.githubPerson`); undefined elsewhere. */
  machineGitHubPerson?(): Promise<GitHubPerson | undefined>
  owner: HostOwner
  methods: HostMethods
  stopping: HostStopping
  jobs: HostJobs
  /** Held while a harness starts: routine work waits for it. */
  foreground: Foreground
  /** On while any client is subscribed to events; work that only tells subscribers pauses without one. */
  subscribed: JobDemand
  secrets: HostSecretStore
  terminals: Domain<TerminalClients>
  web(): WebHost | undefined
  /** Set once stopping begins; events stop going out from then on. */
  closing(): boolean
  /** Stops answering on the socket and removes this host's runtime directory. */
  closeSocket(): void
  /** The host's named work, for its event loop watch. */
  work: HostWork
}

/** The domains every window uses, built together, and what the socket asks of them. */
export interface Core {
  route(channel: HostChannel, args: unknown[]): Promise<RoutedCall>
  presentHistory<Result>(value: Result): Result
  /** What a window on this Mac reads: a signed file, or a path in its open workspace (`readWindowFile`). */
  file(request: Request, client?: string): Promise<Response>
  /** What the gateway's link reads: only a file whose signed URL this host issued (`readSignedFile`). */
  signedFile(request: Request): Promise<Response>
  disconnected(client: string): void
  desktop: NonNullable<Parameters<typeof startWebHost>[7]>
  /** On a cloud machine: the sign-ins its agent was given, written where each harness reads them. */
  installCloudSignIns(signIns: readonly CloudSignIn[], place: CloudSignInPlace): Promise<CloudSignInInstall[]>
  /** On a cloud machine: loads what every start loads, before its image's snapshot; answers what it loaded. */
  warm(): Promise<string[]>
  /** On a cloud machine: the folder its agent prepared, where every client's tabs open. */
  openMachineWorkspace(path: string): Promise<void>
  /** On a cloud machine: why its agent couldn't make the Thread's folder, for whatever needs it to say. */
  machineWorkspaceFailed(problem: string, reason: string): void
  /** On a cloud machine: the project's carried files its agent placed in the checkout, with the variables each defines. */
  machineCarriedFiles(files: readonly CarriedFile[]): void
  /** On a cloud machine: the live video of its previews its Threads' clients watch. */
  media: MediaHandler
  /**
   * On a cloud machine: the gateway it works through, as its agent linked it. Its records are kept in step with its
   * Thread's there (`ThreadCatalog.syncRecords`), and its project's recipe with the account's (`RecipeAccounts`).
   */
  machineLinked(link: MachineGatewayLink | null): Promise<void>
  /**
   * On a cloud machine made to replace a lost one: its Thread's save of an earlier generation restored, before its
   * runtime connects (`restoreSave`); undefined when there was nothing to restore.
   */
  restoreMachineSave(link: MachineGatewayLink, generation: number): Promise<{ from: number; ms: number } | undefined>
  /** On a cloud machine: its tracker's saves, told whether anything works and asked for the save a turn's end waits for. */
  machineSaves: { working(busy: boolean): void; settle(why: string): Promise<void> } | undefined
  /** On a cloud machine: its recordings and artifacts, held to their caps. */
  machineArtifacts: MachineArtifacts | undefined
  /** On a project base's builder: what a start in `path` does first, done before its snapshot. */
  prepareFolder(path: string): Promise<void>
  /** On a cloud machine as it boots: what `harness`'s start runs first, run ahead (`startPrefetch`). */
  prefetchStart(harness: string): Promise<PrefetchOutcome | undefined>
  /** Then, once its sign-in is installed: what its start asks its service first (`startPrefetch.signedIn`). */
  prefetchSignedIn(harness: string): Promise<{ ms: number } | undefined>
  /** Work that holds a profile host up: turns, native runs, transfers. */
  activeWork(): boolean
  /** That work, item by item, as the lifecycle lists it: what keeps a cloud machine running. */
  work(): LifecycleWork[]
  /** What tells the account's list of this host's Sessions, and relays a watched conversation to another device. */
  sessions: SessionPublisher
  lifecycleBlocked(): boolean
  /** Everything the core holds, released in order, with the socket and the terminals. */
  stop(): Promise<void>
}

/** How long a hibernated provider's Local Control session waits for it to wake. */

const trace = (stage: string) => {
  if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-runtime]", stage)
}

/**
 * Threads, Conversations and the domains they're built with, in dependency
 * order, with their methods declared. It loads once the socket listens.
 */
/** Parts of the core built further down `openCore`; reached before then only through `?.`, by a caller that came early. */
interface LateParts {
  conversations?: Conversations
  /** What this Mac can serve another place and its room, said to borrowing's brokers (`Advertiser`). */
  advertiser?: Advertiser
  /** The session leases this Mac serves another place's Threads (`Lending`). */
  lending?: Lending
  movers?: WorkspaceMovers
  agentServers?: ConversationMcp
  controlService?: ControlService
  cloud?: CloudAccount
  cloudConversations?: CloudConversations
  cloudReturns?: CloudReturns
  cloudMoves?: CloudMoves
  /** Agents' and shells' moves of a Thread between this Mac and the cloud (`thread_move`). */
  threadMoves?: ThreadMoveTool
  threadActs?: ThreadActTool
  settingsTool?: SettingsTool
  harnessTool?: HarnessTool
  automationTool?: AutomationTool
  agentAsks?: AgentAskGate
  /** The worktrees here of Threads that run in the cloud, following them at each turn's end. */
  cloudFollow?: CloudFollow
  /** Keeps Threads at work ready to move, and takes their checkpoints as they write (`CloudReadiness`). */
  readiness?: CloudReadiness
  /** The Sessions a going-away's note the account took, waiting for its word once this Mac is back (`AwayNotes`). */
  awayNotes?: AwayNotes
  /** This host's Sessions on the account's list: told again when one is archived here. */
  sessions?: SessionPublisher
  /** The keys of the account's archived cloud Threads' Sessions, told to every window (`ThreadArchives.account`). */
  archivedKeys?: () => void
  /** Whether a conversation of this host's is archived here, by its owner's own word. */
  archivedHere?: (conversationId: string) => boolean
  automations?: Automations
  updates?: Updates
  attribution?: Attribution
  /** On a cloud machine: its tracker (`openMachineTracker`), made once the conversations are. */
  machineTracker?: MachineTracker
  keepAwake?: KeepAwake
  /** Turning the cloud on, as one line: told when what it reads changes. */
  turnOn?: CloudTurnOnFollower
  /** The file system's history, for fseventsd's restart to end reads across it. */
  fileHistory?: FileHistory
}

export async function openCore(shell: CoreShell): Promise<Core> {
  const { config, owner, methods, jobs, secrets } = shell
  const { environment, fixtureDesk } = config
  const { crashes } = owner
  const web = () => shell.web()
  // Every probe that only reads the machine (`ps`, `lsof`, `sysctl`) runs in this one child from here on (`hostProbe`),
  // so none spawns on the loop; it starts at the first ask and reads the apps' processes too.
  const probes = childProcessReader()
  shell.stopping.probes = probes
  const git = hostGit(config.gitTrace ?? false)
  const admission = new Admission()
  const machine = processMachine()
  // The record store, and every stream a driver writes into it, are the user root's: an isolated host keeps its own.
  const records = makoRecords(environment.userRoot)
  const views = makoViews(environment.userRoot)
  const streams = streamsRoot(records)
  const providerHost = createHarnessHost({
    dataRoot: environment.dataRoot,
    userRoot: environment.userRoot,
    appRoot: environment.appRoot,
    secrets,
    stores: new NativeStores(fixtureDesk),
    openUrl: (url) => presentMachine(machine).openUrl(url),
    work: shell.work,
    streams,
  })
  const unknown = new NativeUnknown(logsRoot(environment.dataRoot))
  const mismatches = new StreamMismatches(logsRoot(environment.dataRoot), streams)
  const late: LateParts = {}
  /** On a cloud machine, the gateway it's linked through; a laptop has none and reaches the account as itself. */
  let machineLink: MachineGatewayLink | null = null
  /** On a cloud machine: the Thread's folder its agent makes, asked for again by a move or a start that finds it unmade. */
  const machineWorkspace = new MachineWorkspace(() => shell.retryMachineWorkspace?.() ?? false)
  /** On a cloud machine: the account's sign-ins as last installed here; undefined until the agent gave a set. */
  let machineSignIns: readonly CloudSignInInstall[] | undefined
  /** On a cloud machine: what the account's store gave its checkout, which meets a recipe's named secrets there. */
  let machineCarried: readonly CarriedFile[] = []
  /**
   * The account's authority for a project's recipe versions: a machine's Thread's repository, under its credential;
   * on a laptop, the checkout's GitHub repository, as its signed-in device. None for a project the account can't
   * know (no GitHub origin) or a laptop signed out: its recipe stays this computer's alone.
   */
  const recipes = new RecipeAccounts(async (checkout) => {
    const linked = machineLink
    if (linked) {
      const base = new URL(`/v1/machines/${encodeURIComponent(linked.machine)}/recipes`, linked.gatewayUrl).toString()
      return recipesOverHttp({ id: base, base, authorization: () => `Bearer ${linked.credential}` })
    }
    const cloud = late.cloud
    const gateway = cloudUrl(environment)
    if (!cloud || !gateway || !(await cloud.token())) return undefined
    const repository = githubRepositoryUrl(await git.output(checkout, ["remote", "get-url", "origin"]).catch(() => ""))
    if (!repository) return undefined
    const base = new URL("/v1/recipes", gateway).toString()
    return recipesOverHttp({ id: `${base}?repository=${repository}`, base, repository, authorization: async () => `Bearer ${(await cloud.token()) ?? ""}` })
  }, { log: (message, fields) => hostLog("recipes", message, fields) })

  const spent = spendWatch(
    (id) => late.conversations?.live.session(id)?.harness,
    (harness) => providerHost.accounts.usage.spent(harness),
    (harness, refused) => void providerHost.accounts.limitOffer(harness, refused)
      .then((offer) => { if (offer) emit({ type: "account-limit", offer }) })
      .catch((error) => hostWarn("accounts", "limit offer failed", { harness, error: error instanceof Error ? error.message : String(error) })),
  )
  function emit(event: HostEvent, client?: string): void {
    if (shell.closing()) return
    const limits = spent(event)
    if (limits) emit(limits)
    // A row's change can move only its own session's file: only conversations bound to it look again.
    if (event.type === "threads") late.conversations?.live.discoverNativePaths()
    else if (event.type === "thread-ref") late.conversations?.live.discoverNativePaths({ harness: event.ref.harness, nativeId: event.ref.nativeId })
    if (event.type === "thread-run" && event.run.status !== "running") late.conversations?.native.ready(event.run.path)
    // Git status is recomputed after every turn and on focus, which is exactly
    // when HEAD could have moved — so the commit trigger rides on it rather than
    // running a watcher of its own.
    // Selecting a child repository is not a commit in the parent workspace.
    if (event.type === "git" && !event.git.repositories?.length) late.automations?.noticeHead(event.git.head)
    // Turns, tool calls and background work starting and ending: who was running when a file changed.
    if (event.type === "live-batch") {
      late.attribution?.live(event.batch)
      // On a cloud machine, the same reading says when to save the Thread.
      late.machineTracker?.observe(event.batch)
    }
    // A conversation another device watches goes to it as it changes (`SessionPublisher`), and its row, a Session
    // archived here or a Thread renamed here changes what every device lists.
    late.sessions?.own(event)
    // The account and the agents' sign-ins say each change here; turning the cloud on reads them again then.
    if (event.type === "cloud-account" || event.type === "cloud-sign-ins") void late.turnOn?.changed()
    if (recountsWork(event)) late.keepAwake?.changed()
    web()?.event(event, client)
  }
  const previews = new ArtifactPreviews(() => providerHost.artifactPreviews.list())
  const watchReadings = new WatchReadings((message, fields) => hostLog("watch", message, fields))
  const watchBackend = childBackend(undefined, watchReadings)
  const conversationFiles = new ConversationFiles(git, previews, (root, changed, gone, dropped) => watchTree(git, watchBackend, root, changed, gone, dropped))
  const fileEvents = new FileEventsServiceWatch({
    mac: onMac(),
    readDaemon: readFseventsd,
    privileged: administratorPrompt,
    probe: () => probeDelivery(),
    recover: () => {
      watchBackend.recover()
      late.fileHistory?.recover?.()
    },
    activity: () => ({ ...watchReadings.totals(), turnsRunning: (late.conversations?.live.summaries() ?? []).filter(({ session }) => session.status === "running").length }),
    emit: (service) => emit({ type: "file-events-service", service }),
    log: (message, fields) => hostLog("watch", message, fields),
    historyFile: join(environment.dataRoot, "file-events", "fseventsd.jsonl"),
    evidenceRoot: crashes.directory,
    history: () => late.fileHistory,
    uid: process.getuid?.() ?? -1,
    machineBusy: busySinceLastAsk(),
    noticeFile: join(environment.dataRoot, "file-events", "notice.json"),
  })
  watchReadings.follow(fileEvents)
  if (onMac()) shell.jobs.every("read fseventsd's health", 60_000, () => fileEvents.tick(), { firstAfterMs: 5_000 })
  declareFileEventsMethods(methods, fileEvents)
  const workspaceClients = new WorkspaceClients(emit, { git, previews, watch: watchBackend, attachments: join(environment.userRoot, "attachments") })
  /** Start the first tab once, however many callers race for it. */
  const ready = (): Promise<HostPool> => workspaceClients.ready(hostClient())
  /**
   * Run against the tab in front.
   *
   * Every command from the UI is aimed at the conversation on screen — that is
   * the only one with a composer pointed at it — so tab routing does not need to
   * reach the handlers. Background tabs keep streaming; they just take no orders.
   */
  const withHost = async <T>(run: (host: AgentHost) => T | Promise<T>): Promise<T> => run((await ready()).active)
  const renditions = new MediaRenditions({ folder: join(environment.dataRoot, "thumbnails"), ffmpeg: () => mediaExecutable("ffmpeg") })
  // Pictures and pages a cloud Thread, another device or another host here read: fetched from it, kept here.
  const ownerFiles = new OwnerFiles({ gateway: () => late.cloud?.gateway(), token: async () => late.cloud?.token() })
  const owned = new OwnedFiles({ folder: join(environment.dataRoot, "owned-files"), fetch: (owner, url, init) => ownerFiles.fetch(owner, url, init) })
  const workspace = async () => (await ready()).active.workspace

  trace("host ready")
  const children = new ProviderChildren(environment.dataRoot)
  // What decoders and spawners report is this host's from here until it stops.
  const unfollow = [unknown.follow(), mismatches.follow(), children.follow()]
  // Agents an earlier host left running are ended before this one starts any.
  await children.reap().catch((error) => {
    hostWarn("children", "reap failed", { error: error instanceof Error ? error.message : String(error) })
  })
  const threads = openThreads({
    environment,
    readOnly: fixtureDesk,
    ledger: {
      pid: process.pid,
      startedAt: Math.round(performance.timeOrigin),
      label: hostLabel(config),
      socket: config.socket,
      launch: {
        dataRoot: environment.dataRoot, executable: config.executable,
        args: environment.packaged ? [] : [environment.appRoot], cwd: process.cwd(), profile: environment.profile,
        liveAssetsTouch: true,
      },
    },
    harnesses: threadHarnesses(providerHost),
    readFile: (cwd, path, dataDir, purpose) => conversationFiles.read(cwd, path, dataDir, purpose),
    emit,
    jobs: shell.jobs,
    subscribed: shell.subscribed,
  })
  const { catalog, store } = threads
  // On a cloud Thread's machine its simulators are a Mac of the person's, borrowed under a session lease through the
  // machine's own routes to the account's broker.
  const borrowedSimulators = config.machineAgentFd === undefined
    ? undefined
    : new BorrowedSimulators({ port: accountBorrowing(() => machineLink, undefined, shell.stopping.signal), shots: join(environment.dataRoot, "simulators", "borrowed") })
  const control = openControl(config, machine, shell.jobs, emit, () => late.updates?.desktopChanged(), (session) => {
    const parsed = SessionIdSchema.safeParse(session)
    const placed = parsed.success && store ? store.sessionPlacement(parsed.data) : undefined
    if (!store || !placed) return undefined
    const conversation = store.conversationsOf(placed.session).at(-1)
    const live = conversation ? late.conversations?.live.session(conversation) : undefined
    if (!live) return undefined
    const title = store.thread(placed.thread)?.title ?? live.title
    const project = projectFolder(store.worktrees(), live.cwd)
    return { thread: placed.thread, session: placed.session, folder: live.cwd, ...(project && { project }), ...(conversation && { conversation }), ...(title && { title }) }
  }, {
    leaseOf: (via, thread) => late.lending?.leaseOf(via, thread, "ios-simulator")?.id,
    used: (lease, verb) => late.lending?.used(lease, verb),
    artifact: async (lease, file, name) => {
      if (!late.lending) throw new Error("This Mac lends nothing")
      return late.lending.artifact(lease, file, name)
    },
  }, borrowedSimulators)
  const appUpdates = new Updates({
    environment,
    git,
    emit,
    // Whose each uncommitted file of the update's source is: the person sees another Thread's half-done work before building it.
    writers: (paths) => {
      const threadTitle = (id: string) => {
        const parsed = ThreadIdSchema.safeParse(id)
        return (parsed.success ? store?.thread(parsed.data)?.title : undefined) || "an untitled Thread"
      }
      const found = late.attribution?.rewindWriters(paths, 0)
      if (!found) return undefined
      return Object.fromEntries(Object.entries(found).map(([path, writers]) => [path, writers.flatMap((writer) =>
        writer.kind === "thread" ? [threadTitle(writer.thread)] : writer.kind === "person" ? ["you"] : [])]))
    },
    desktop: {
      state: () => control.desktop.update(),
      check: () => control.desktop.ask("update-check", {}),
      install: () => control.desktop.ask("update-install", {}).then(() => {}),
    },
  })
  late.updates = appUpdates
  // Every host's record of the agents it starts, found through the session ledger, this host's own root always.
  const makoProcesses = () => readMakoProcesses([environment.dataRoot, ...threads.memory?.hostDataRoots() ?? []])
  const harnesses = openHarnesses({ host: providerHost, appRoot: environment.appRoot, userRoot: environment.userRoot, catalog, live: () => late.conversations?.live, emit, jobs: shell.jobs, subscribed: shell.subscribed, makoProcesses })
  const tools = openTools(harnesses.tools, environment.dataRoot, () => shell.foreground.idle())
  const conversationsIn = (path: string, status: (value: string) => boolean) => (late.conversations?.live.listed() ?? [])
    .filter(({ session }) => status(session.status) && (session.cwd === path || session.cwd.startsWith(`${path}/`)))
    .map(({ session }) => `“${session.title || "Untitled conversation"}”`)
  // A terminal daemon outlives the host, so a folder's shells are asked of it even before a window opens a terminal.
  const shellsIn = async (path: string) => (await (await shell.terminals.load("a folder's open shells")).runningShells().catch(() => []))
    .filter((terminal) => terminal.cwd === path || terminal.cwd.startsWith(`${path}/`))
    .map((terminal) => `the terminal “${terminal.title}”`)
  const workspaces = openWorkspaces({
    git,
    probes,
    dataRoot: environment.dataRoot,
    recipes,
    // A recipe runs as its place says: a cloud machine's host is started by the machine's agent.
    where: { place: config.machineAgentFd === undefined ? "local" : "cloud", platform: onMac() ? "mac" : hostPlatform() === "linux" ? "linux" : "other" },
    readOnly: fixtureDesk,
    store,
    jobs,
    subscribed: shell.subscribed,
    emit,
    inUse: async (path) => [...conversationsIn(path, (status) => status !== "closed"), ...await shellsIn(path)],
    working: async (path) => conversationsIn(path, (status) => status === "running"),
    workingFolders: async () => (late.conversations?.live.listed() ?? []).filter(({ session }) => session.status === "running").map(({ session }) => session.cwd),
    conversations: checkoutConversations({
      summaries: () => late.conversations?.live.summaries() ?? [],
      relocation: (id) => late.conversations?.live.relocation(id) ?? { kind: "never", reason: "isn't open" },
      relocate: async (id, cwd) => late.conversations?.live.relocate(id, cwd),
    }, shellsIn),
    cleanup: (path) => late.movers?.appTools?.cleanup(path),
    ledger: () => late.attribution,
    watchReadings,
    daemonRestarts: fileEvents,
  })
  late.fileHistory = workspaces.fileHistory
  // Who changed what in every checkout a Thread works in. It catches up on its own, after the host is up.
  const unfollowEffects = fixtureDesk ? undefined : liveToolEffects.subscribe((reported) => {
    late.attribution?.effects(reported.conversation, reported.call)
    // A call that may have written: the Thread's checkpoint follows a few seconds later, when it's kept ready.
    if (reported.call.status !== "refused" && reported.call.effects.some((effect) => effect.kind !== "read")) late.readiness?.wrote(reported.conversation)
  })
  const unfollowBounds = fixtureDesk ? undefined : liveCallBounds.subscribe((bounds) => late.attribution?.bounds(bounds))
  // The catalog as attribution reads it, at every record and every footprint: placed whole once, then kept until the
  // catalog says something moved or a placement in the Thread store did (`placementVersion`; the store's `version`
  // moves on every write, which threw it away at each), and at most `CATALOGUED_FRESH_MS`, for what moves without
  // either (a worktree's origin). Placed again at each read, it was a tenth of the host's allocation.
  let catalogued: { rows: ThreadRef[]; stores: readonly string[] | undefined; version: string | undefined; at: number } | undefined
  // A row the catalog says moved is placed again alone and put in its place: a Fin writing its transcript moves its row
  // many times a minute, and each threw the whole list away. Activity isn't in the rows; anything else lists anew.
  if (!fixtureDesk) catalog.subscribe((event) => {
    if (!catalogued || event.type === "thread-activity") return
    if (event.type !== "thread-ref") {
      catalogued = undefined
      return
    }
    const held = catalogued
    const fresh = catalog.thread({ path: event.ref.path })
    const at = held.rows.findIndex((row) => row.path === event.ref.path)
    if (fresh && at >= 0) held.rows = held.rows.map((row, index) => index === at ? fresh : row)
    else if (fresh) {
      held.rows = [...held.rows, fresh]
      held.stores = undefined
    } else if (at >= 0) {
      held.rows = held.rows.filter((_, index) => index !== at)
      held.stores = undefined
    }
  })
  const cataloguedRows = () => {
    if (!catalogued || catalogued.version !== store?.placementVersion() || Date.now() - catalogued.at > CATALOGUED_FRESH_MS) {
      const rows = catalog.list()
      // Read after the list: what placing it remembered for the first time is in the version it's kept under.
      catalogued = { rows, stores: undefined, version: store?.placementVersion(), at: Date.now() }
    }
    return catalogued
  }
  if (!fixtureDesk) void openAttribution({
    dataRoot: environment.dataRoot,
    userRoot: environment.userRoot,
    defaultDataRoot: environment.defaultDataRoot,
    label: environment.profile ? `${environment.appName} (${environment.profile})` : environment.appName,
    git,
    watch: (root, changed, gone, dropped) => watchTree(git, watchBackend, root, changed, gone, dropped),
    history: workspaces.fileHistory,
    deliveryLagMs: () => watchReadings.lagMs(),
    watchGitDir: (folder, moved) => watchOutsideGitDir(folder, moved),
    jobs,
    stores: () => {
      const held = cataloguedRows()
      return held.stores ??= harnessStores(held.rows.map((ref) => ref.path))
    },
    children: catalog.childSource,
    catalogued: () => cataloguedRows().rows,
    running: () => catalog.activity(),
    placement: (conversation) => store?.journalPlacement(conversation),
    session: (conversation) => {
      const live = late.conversations?.live
      const session = live?.session(conversation)
      return session && { cwd: session.cwd, harness: session.harness, record: (live?.held(conversation) ?? live?.snapshot(conversation))?.threadPath ?? undefined }
    },
  }).then((attribution) => {
    if (shell.closing()) void attribution.close()
    else {
      late.attribution = attribution
      late.conversations?.live.journalOpened()
    }
  }, (error: Error) => hostWarn("attribution", "the journal could not open; changes aren't attributed this run", { error: error.message }))
  const wake = watchWake(shell.jobs, (source) => {
    hostLog("host", "woke", { source })
    fileEvents.woke()
    web()?.terminal({ type: "wake" })
    late.cloud?.wake()
    late.cloudConversations?.wake()
    late.awayNotes?.back("wake")
  })
  const telemetry = await declareTelemetryMethods(methods, {
    environment,
    crashes,
    unknown,
    mismatches,
    unread: () => unreadCounts({ views, records }).groups,
    fixture: fixtureDesk,
    token: () => late.cloud?.token() ?? Promise.resolve(undefined),
    account: () => late.cloud?.id() ?? Promise.resolve(undefined),
    attended: () => (web()?.clients().length ?? 0) > 0,
    inventory: async () => ({
      harnesses: (await harnesses.profiles.all()).filter((profile) => profile.available).map((profile) => profile.id),
      runtimes: harnesses.updates.snapshot(),
      threads: catalog.list().length,
    }),
  })
  declareUnreadRecordMethods(methods, { views, records, live: () => unknown.kinds(), since: Date.now(), streams })
  // This host's Sessions on the account's list, and a watched conversation's live updates to another device.
  // The rows the sync window may take, read again only once the catalog says its list changed: a sweep finds nothing new
  // otherwise, and a session being written (a terminal's at work) changes its own row in place rather than every row
  // being read again.
  let windowRows: ThreadRef[] | undefined
  /** The rows by native session, read again with them: where the uploads read each Session. */
  let windowPaths: Map<string, string> | undefined
  /** Moves with everything the catalog says, so what reads its paths knows they may have. */
  let catalogMoves = 0
  // The Threads moving to the cloud from here, said on their rows from the move's first step.
  const movesUnderWay = new MovesUnderWay()
  // What each project on the list has checked out, as the rail shows it beside the project: read once a project is
  // listed, then followed (a branch switched anywhere arrives as a `checkout-heads` event, which reports again).
  const headsAsked = new Map<string, number>()
  const repositories = new ListedRepositories({ read: (folder) => folderRepository(git, folder), changed: () => late.sessions?.changed(), againMs: HEAD_ASK_AGAIN_MS })
  const listedHead = (project: string) => {
    const known = workspaces.checkoutHeads.known(project)
    if (known !== undefined) return known
    const asked = headsAsked.get(project)
    if (asked === undefined || Date.now() - asked > HEAD_ASK_AGAIN_MS) {
      headsAsked.set(project, Date.now())
      void workspaces.checkoutHeads.read([project]).then(() => late.sessions?.changed(), () => undefined)
    }
    return undefined
  }
  // What a conversation's turn left running: its provider's work as memory holds it, and its Thread's Fins as they stand
  // now. Only its Thread's newest Session hears them move (`finReaders`), so an older one's roster keeps them as they were.
  const heldWork = (id: string) => {
    const held = late.conversations?.live.held(id)
    if (!held) return undefined
    const agents = late.conversations?.agents
    return backgroundWork(held.session, agents ? withChildren(held.nativeAgents, agents.roster(id)) : held.nativeAgents)?.count
  }
  // The account's rows of this Mac's Sessions: every one, or (`only`) those of a few conversations whose batches came, with
  // no native row, which no batch moves.
  const reportedRows = (only?: ReadonlySet<string>) => {
    const live = late.conversations?.live
    const store = threads.store
    // Until the catalog's first discovery is in, its rows would say this Mac has no sessions but Mako's own.
    if (!live || !store || !catalog.ready()) return undefined
    const activity = catalog.activity()
    const made = store.worktrees()
    const make = () => ownedSessions({
      summaries: () => live.summaries(only),
      native: () => only ? [] : (windowRows ??= catalog.recent(windowStart(Date.now()))),
      activity: (path) => activity[path],
      work: () => application.lifecycle.snapshot().work,
      waitingOn: (id) => live.waitingOn(id),
      hidden: () => new Set(threads.archives.snapshot().keys),
      lastMoved: (id, revision) => live.lastMoved(id, revision),
      placement: (id) => store.journalPlacement(id),
      sessionOrder: (placed) => sessionOrderIn(store.thread(placed.thread)?.sessions, placed.session),
      childThread: (thread) => listedUnderApex(store.edges().of(thread)),
      executions: (ids) => store.executionsOf(ids),
      titles: (ids) => store.titlesOf(ids),
      forks: (ids) => store.forksOf(ids),
      moving: (thread) => movesUnderWay.of(thread),
      worktree: (folder) => {
        const found = worktreeAt(made, folder)
        const project = found && projectFolder(made, folder)
        return found && project ? { project, branch: found.worktree.branch } : undefined
      },
      head: listedHead,
      repository: (folder) => repositories.of(folder),
      background: heldWork,
      asking: (id) => finAsking(late.conversations?.agents?.personAsk(id)),
      asked: (id) => live.askWaiting(id),
      fins: (id) => listedFins(late.conversations?.agents?.roster(id)),
      now: Date.now,
    })
    // The folders a whole making asks for are the ones read again (`listing`); a few rows' making leaves them as they are.
    return only ? make() : repositories.listing(make)
  }
  const sessions = new SessionPublisher({
    rows: () => reportedRows(),
    rowsOf: (conversations) => reportedRows(conversations),
    // What a list shows of one conversation, read as each of its batches comes, by the rule its row is made with: a
    // batch that moved it is reported at once. It reads only what memory holds.
    shown: (id) => {
      const live = late.conversations?.live
      const session = live?.session(id)
      if (!live || !session) return undefined
      const held = live.held(id)
      return conversationShown({
        session,
        working: live.workOf(id)?.status,
        waitingOn: (conversation) => live.waitingOn(conversation),
        background: heldWork(id),
        promptedAt: held ? personPromptedAt(held.requests, held.control?.actions) : undefined,
        asking: (conversation) => finAsking(late.conversations?.agents?.personAsk(conversation)),
        asked: (conversation) => live.askWaiting(conversation),
        fins: (conversation) => listedFins(late.conversations?.agents?.roster(conversation)),
      })
    },
    // A change goes to the account within a fraction of a second, on the link this host serves then, named as the tick's
    // job is: a Mac's account link, or a cloud machine's runtime link.
    reportNow: config.machineAgentFd === undefined ? () => late.cloud?.reportSessions?.() : () => shell.reportMachineSessions?.(),
    // A Mac's runtime link, silent while it sends what another device watches, is asked whether it's alive.
    sent: config.machineAgentFd === undefined ? () => late.cloud?.liveSent?.() : undefined,
    work: shell.work,
  })
  catalog.subscribe((event) => {
    catalogMoves += 1
    if (event.type === "thread-ref") {
      const at = windowRows?.findIndex((row) => row.path === event.ref.path) ?? -1
      if (windowRows && at >= 0) windowRows[at] = event.ref
      else {
        windowRows = undefined
        windowPaths = undefined
      }
      // Whether this Mac keeps that session may have changed: the account's rows for it are looked at again, those alone.
      late.cloudConversations?.nativeChanged([event.ref])
    } else if (event.type === "threads" || event.type === "thread-removed") {
      windowRows = undefined
      windowPaths = undefined
      late.cloudConversations?.nativeChanged()
      // A catalog row of an archived cloud Thread's Session (one this Mac had before it moved) shows archived too.
      late.archivedKeys?.()
    }
    else if (event.type !== "thread-activity") return
    sessions.changed()
  })
  late.sessions = sessions
  // How this Mac's sync goes, for Diagnostics: what it follows of other devices' work, the account's list, and what it
  // sends of its own watched conversations.
  const syncReadings = new SyncRecorder()
  syncReadings.ownerFrom(() => sessions.readings())
  // One reporter a link: a cloud machine's link is its machine runtime's, whose tick reports on it. This job, with the
  // account's link (none there), would make each second's report look like a new link's and work the list out again.
  if (config.machineAgentFd === undefined) shell.jobs.every(REPORT_WORK, 1_000, () => late.cloud?.reportSessions?.())
  // The heap, watched so a host filling up says who with while it still can: an out-of-memory report has no
  // JavaScript stack. The line names what memory holds and who read it in; the whole readout goes beside the log.
  const mb = (bytes: number | undefined) => Math.round((bytes ?? 0) / 1_048_576)
  const heap = new HeapWatch(readHeap, (change, level, reading) => {
    const memory = late.conversations?.live.residency().memory
    const fields = {
      level, usedMB: mb(reading.used), limitMB: mb(reading.limit), rssMB: mb(reading.rss),
      conversations: memory?.loaded ?? 0, conversationMB: mb(memory?.bytes), pinnedMB: mb(memory?.pinnedBytes),
      loads: (memory?.loads ?? []).slice(0, 5).map((load) => `${load.by}=${load.count}`).join(", "),
      held: (memory?.held ?? []).slice(0, 5).map((held) => `${held.conversation.slice(0, 8)}:${mb(held.bytes)}MB${held.by ? ` by ${held.by}` : ""}`).join(", "),
    }
    if (change === "easing") return hostLog("memory", "the heap eased", fields)
    hostWarn("memory", "the heap is under pressure", fields)
    const readout = { at: new Date().toISOString(), change, level, heap: reading, memory, jobs: shell.jobs.list() }
    void writeFile(join(logsRoot(environment.dataRoot), "memory-pressure.json"), JSON.stringify(readout, null, 2)).catch((error: Error) =>
      hostWarn("memory", "the memory readout couldn't be written", { error: error.message }))
  }, (reading) => {
    // Every few minutes at any level: what V8 holds against its limit and of the process, and what conversations hold.
    const memory = late.conversations?.live.residency().memory
    hostLog("memory", "the heap", { usedMB: mb(reading.used), limitMB: mb(reading.limit), rssMB: mb(reading.rss), conversations: memory?.loaded ?? 0, conversationMB: mb(memory?.bytes) })
  })
  shell.jobs.every("watch the heap", 10_000, () => void heap.tick(), { runsWhileHeld: true })
  // This Mac's Sessions in the sync window, kept in step in the account, the ones at work first: as Mako draws each, so
  // another device reads one with this Mac off, and as its harness wrote it, so it continues anywhere. A cloud machine
  // keeps its Thread's records instead; a fixture desk sends nothing.
  let uploads: SessionUploads | undefined
  if (!fixtureDesk && config.machineAgentFd === undefined) {
    uploads = new SessionUploads({
      rows: () => sessions.listed(),
      path: (harness, nativeId) => (windowPaths ??= new Map((windowRows ??= catalog.recent(windowStart(Date.now()))).map((ref) => [`${ref.harness}\n${ref.nativeId}`, ref.path]))).get(`${harness}\n${nativeId}`),
      agents: () => threads.store?.childSessions() ?? new Map(),
      scopeVersion: () => (threads.store ? `${threads.store.version()}:${catalogMoves}` : undefined),
      links: async () => {
        const cloud = late.cloud
        const blocked = cloud?.cloudBlocked ? await cloud.cloudBlocked() : "signed-out"
        if (!cloud || blocked) return { state: "off", reason: blocked ?? "signed-out" }
        const device = await cloud.deviceId()
        if (!device) return { state: "off", reason: "signed-out" }
        return { state: "on", copies: await cloud.deviceRecords(device), originals: await cloud.deviceOriginals(device) }
      },
      power: readPower,
      scope: (scope) => catalog.scopeSync(scope),
      copies: (link) => catalog.syncCopies(link),
      originals: (link) => catalog.syncOriginals(link),
      status: () => catalog.syncStatus(),
      backfill: () => readBackfill(records),
      now: Date.now,
      statusChanged: () => void late.turnOn?.changed(),
    })
    const ticking = uploads
    shell.jobs.every("keep this Mac's Sessions in the account", 5_000, () => ticking.tick())
    catalog.onLinkDue((form) => {
      if (form === "copies" || form === "originals")
        void ticking.renew().catch((error: Error) => hostWarn("sync", "this device's links couldn't be renewed", { error: error.message }))
    })
  }
  declareSyncMethods(methods, uploads, syncReadings)
  // The person's access choice per harness, which a start from any surface reads: their account's, kept here too for
  // a start without the network, and alone on a Mac that isn't signed in. A cloud machine acts for no person's account.
  const accessChoices = new AccessChoiceStore({
    file: join(environment.userRoot, "access-choices.json"),
    modes: (harness) => providerHost.liveDrivers.get(harness)?.modes,
    account: async () => {
      const cloud = late.cloud
      if (config.machineAgentFd !== undefined || !cloud?.accessChoices || !cloud.chooseAccess) return undefined
      const id = await cloud.id().catch(() => undefined)
      if (!id) return undefined
      const { accessChoices: read, chooseAccess: write } = cloud
      return {
        read: async () => {
          const answer = await read()
          return answer ? { account: id, ...answer } : undefined
        },
        write: async (choices, fill) => {
          const answer = await write(choices, fill)
          return answer ? { account: id, ...answer } : undefined
        },
      }
    },
    announce: (choices) => emit({ type: "access-choices", choices }),
    log: (message, fields) => hostLog("access", message, fields),
  })
  declareAccessChoiceMethods(methods, accessChoices)
  // What the person's Fins run on, by harness, and what they use there themselves: read by every window and the web app.
  const finDefaults = new FinDefaultsStore(join(environment.userRoot, "fin-defaults.json"))
  // How many Fins this device runs at once: from its hardware and what a Fin costs here, unless the person sets a number.
  const finCapacity = new FinCapacity({
    read: (() => { const mac = new MacCapacity(); return () => mac.read() })(),
    costs: new FinCostModel(join(environment.userRoot, "fin-cost.json")),
    sampler: new FinCostSampler({ table: readProcessTable, owned: () => children.processes().map(({ pid, owner }) => ({ pid, owner })) }),
    own: () => finDefaults.reading().limit,
    ...(finSlots() !== undefined && { fixed: finSlots()! }),
  })
  // What this Mac runs for another place's Threads under borrowing's leases: each holds one of its Fins' places.
  const lent = new LentHere()
  lent.subscribe(() => {
    late.conversations?.agents?.capacityChanged()
    late.advertiser?.roomChanged()
    // A lease served or ended starts or ends work this Mac stays awake for.
    void late.keepAwake?.refresh()
  })
  // The sessions this Mac lends as their source: asks it can answer itself, each lease the broker issues it, beats
  // for them on its runtime link, and every way one ends. A cloud machine and a fixture desk lend nothing.
  const lending = config.machineAgentFd === undefined && !fixtureDesk
    ? new Lending({
        device: async () => late.cloud?.deviceId().catch(() => undefined),
        answer: async (ask, answer) => late.cloud?.borrow?.answer(ask, answer),
        leases: async () => (await late.cloud?.borrow?.leases()) ?? null,
        serve: async (ask) => {
          if (ask.resource.kind !== "operation" || ask.ref !== "ios-simulator") return { answer: "unavailable", reason: "not-found" }
          const listed = await control.simulators.list({ kind: "person" })
          const here = "refused" in listed ? undefined : listed.hosts.find((host) => host.kind === "local")
          return here?.platforms.ios.ready ? { answer: "yes", version: "ready" } : { answer: "unavailable", reason: "not-found" }
        },
        beat: (lease, progress, streams) => late.cloud?.beat?.(lease, progress, streams) ?? false,
        streams: (lease) => (lease.resource.ref === "ios-simulator" ? [{ name: "screen", kind: "video" }] : []),
        lent,
        upload: async (lease, file, name) => {
          if (!late.cloud?.borrow) throw new Error("This Mac isn't signed in to Mako.")
          return late.cloud.borrow.artifact(lease, name, file, (await stat(file)).size)
        },
        words: (lease) => ({ what: operationWords(lease.resource.ref), for: lease.borrower.place.kind === "machine" ? "a cloud Thread" : "a Thread on another device" }),
        ended: (lease) => control.simulators.releaseLease(lease.id),
        log: (message, fields) => hostLog("borrowing", message, fields),
      })
    : undefined
  late.lending = lending
  if (lending) shell.jobs.every("beat for what this Mac lends", LEND_BEAT_MS, () => lending.beat())
  declareFinDefaultMethods(methods, finDefaults, () => {
    const reading = finCapacity.reading()
    return lent.count() ? { ...reading, lent: lent.words() } : reading
  }, () => finCapacity.changed())
  // Every check run holds one of the builds capacity keeps room for, and the rest wait their turn.
  const buildSlots = new BuildSlots(() => finCapacity.builds())
  finCapacity.subscribe(() => buildSlots.changed())
  late.cloud = declareCloudAccountMethods(methods, {
    ...(lending && {
      lending: {
        advertisement: () => late.advertiser?.current(),
        frames: {
          asked: (ask) => void lending.asked(ask),
          lent: (lease) => void lending.lent(lease),
          ended: (lease, why) => lending.ended(lease, why),
        },
        enrolled: () => void lending.sync(),
      },
    }),
    accessChoices: {
      heard: (answer) => void late.cloud?.id().then((account) => account && accessChoices.heard({ account, ...answer }), () => undefined),
      again: () => void accessChoices.sync(),
    },
    sessions,
    signedFiles: (request) => withHostClient("gateway:files", () => readSignedFile(request, renditions, owned)),
    jobs: shell.jobs,
    environment,
    secrets: fixtureDesk ? detachedSecrets() : secrets,
    machine,
    emit,
    fixture: fixtureDesk,
    signedIn: () => void telemetry.signedIn(),
    request: (call) => telemetry.cloudRequest(call),
    harnessSignIns:
      fixtureDesk || config.machineAgentFd !== undefined
        ? undefined
        : (options) => {
            const sync = new CloudSignInSync({
              ...options,
              accounts: providerHost.accounts,
              capabilities: providerHost.accountCapabilities,
            })
            providerHost.accounts.gateLaunches(() => sync.inStep())
            return sync
          },
  })
  // What this Mac chose while it wasn't heard goes to the account, and the account's choices come back.
  void accessChoices.sync()
  // A project's carried files (its recipe's `carry`) kept in the account's secret store, with its person's word, for its
  // cloud Threads: brought up to date before one is made or a Thread moves there. Only a person's own Mac sends them.
  const carriedFiles = fixtureDesk || config.machineAgentFd !== undefined
    ? undefined
    : new CloudCarriedFiles({
        file: join(environment.dataRoot, "cloud", "carried-files.json"),
        git,
        account: async () => {
          const cloud = late.cloud
          const id = await cloud?.id().catch(() => undefined)
          if (!cloud?.carriedFiles || !id || (await cloud.cloudBlocked?.().catch(() => "signed-out" as const))) return undefined
          return { id, store: cloud.carriedFiles }
        },
        repositoryOf: async (folder) => (await folderRepository(git, folder)).url,
        recipe: (checkout) => readProjectRecipe(git, checkout, workspaces.recipes),
      })
  declareCarriedFilesMethods(methods, carriedFiles)
  /** The account's archived cloud Threads, as its list said them last: what every window shows as archived of them. */
  /** The account's archived cloud Threads, as its list last said them; undefined until a list is read this run. */
  let accountArchived: { account: string; archived: ReadonlyMap<string, ArchivedThread> } | undefined
  // A cloud machine runs its conversations itself; only a person's own Mac starts them on one.
  const cloudConversations = fixtureDesk || config.machineAgentFd !== undefined
    ? undefined
    : new CloudConversations({
        account: () => late.cloud,
        readings: syncReadings,
        file: join(environment.dataRoot, "cloud", "conversations.json"),
        emit: (event) => {
          if (!shell.closing()) web()?.conversationEvent(event)
        },
        repositoryOf: (cwd) => folderRepository(git, cwd),
        carried: async (folder, why) => void (await carriedFiles?.sync(folder, why)),
        // Every tab showing that conversation's folder reads its Git again, on the machine.
        changed: (conversationId) => {
          for (const tab of workspaceClients.everyTab()) tab.elsewhereChanged(conversationId)
        },
        turnEnded: (_conversationId, threadId) => late.cloudFollow?.turnEnded(threadId),
        threads: () => threads.store ?? undefined,
        returning: (cloudThread) => late.cloudReturns?.returning(cloudThread),
        keepsNative: (harness, nativeId, folder) => catalog.keepsNative(harness, nativeId, folder),
        // A message that waited in the account for one of this Mac's Sessions while it was off: sent here now, under
        // its own ID, through the same call a window's send makes, so it runs once however often it's heard.
        continued: (session, listed) => late.cloudMoves?.joinContinue(session, listed),
        ownerChecked: () => {
          late.conversations?.live.moves.ownerChecked()
          // Sessions a going-away named, which the account may have continued: whose they are is asked now, never given up on.
          // The account's link checked again is this Mac back.
          late.awayNotes?.back("link")
          void late.awayNotes?.ask()
          // Turns paused as this Mac went off, for a Thread still here, go on now (`CloudMoves.unpark`).
          void late.cloudMoves?.unpark().catch((error: Error) => hostWarn("moves", "turns paused as this Mac went off couldn't go on yet", { error: error.message }))
        },
        takeWaiting: async (message, claim) => {
          const store = threads.store
          const live = late.conversations?.live
          if (!store || !live || !catalog.ready()) return "later"
          const session = SessionIdSchema.safeParse(message.session)
          if (!session.success) return "not-mine"
          const execution = store.execution(session.data)
          if (execution && execution.state !== "here") return "not-mine"
          // A session a terminal ran, which Mako here hasn't opened: opened as the conversation the list named.
          const opened = live.summaries().some((summary) => summary.session.id === message.conversation)
          const ref = opened ? undefined : (windowRows ??= catalog.recent(windowStart(Date.now()))).find((row) => row.sessionId === message.session)
          if (!opened && !ref) return "not-mine"
          if (!(await claim())) return "refused"
          if (ref) await methods.invoke("mako:live-capture", [message.conversation, ref.path])
          await methods.invoke("mako:live-prompt", [message.conversation, message.id, message.text, [], undefined])
          return "taken"
        },
        // Another device's Session while that device is off: read from the copy it keeps in the account.
        copies: {
          page: async (device, harness, nativeId, before, limit) => {
            const cloud = late.cloud
            return cloud ? catalog.copyPage(await cloud.deviceRecords(device), harness, nativeId, before, limit) : null
          },
        },
        archivedChanged: (account, archived) => {
          accountArchived = { account, archived }
          late.archivedKeys?.()
        },
        turnOnChanged: () => void late.turnOn?.changed(),
      })
  // The keys those Threads' Sessions are archived by here. Until the account's list is read this run, and while the
  // catalog can't yet say which of its rows are theirs, the ones kept from before stand (`ThreadArchives.account`).
  late.archivedKeys = () => {
    if (!accountArchived) return
    const keys = new Set<string>()
    const sessionIds = new Set<string>()
    for (const archived of accountArchived.archived.values())
      for (const row of archived.sessions) {
        keys.add(threadArchiveKey({ kind: "live", id: row.conversation }))
        if (row.nativeId) keys.add(threadArchiveKey({ kind: "native", provider: row.harness, nativeId: row.nativeId }))
        sessionIds.add(row.session)
      }
    if (sessionIds.size && !catalog.ready()) return
    if (sessionIds.size) for (const ref of catalog.list()) if (ref.sessionId && sessionIds.has(ref.sessionId)) keys.add(threadArchiveKey({ kind: "file", path: ref.path }))
    const snapshot = threads.archives.account(accountArchived.account, keys)
    if (snapshot) emit({ type: "thread-archives", snapshot })
  }
  late.cloudConversations = cloudConversations
  // Turning the cloud on, as one line every window shows: read again as what owns each step says it changed (above),
  // never by asking them on a timer. Only a base being made and a machine made ahead say nothing as they change: the
  // slow tick looks at those, while one is under way and a window is there to see it.
  const turnOnUnderWay = shell.jobs.demand("turning the cloud on waits on the cloud")
  const turnOn = cloudConversations && uploads && new CloudTurnOnFollower({
    file: join(environment.dataRoot, "cloud", "turn-on.json"),
    emit: (state) => {
      if (!shell.closing()) emit({ type: "cloud-turn-on", turnOn: state })
    },
    watching: () => shell.subscribed.on,
    underWay: (on) => turnOnUnderWay.set(on),
    sources: {
      account: async () => late.cloud?.account?.(),
      signIns: async () => late.cloud?.signIns?.(),
      sync: async () => uploads.status(),
      projects: (accountId) => cloudConversations.offeredProjects(accountId),
      standings: async (repositories) => (await late.cloud?.baseStandings?.(repositories)) ?? null,
      askBases: (repositories) => cloudConversations.askBasesAgain(repositories),
      checkPlan: async () => void (await late.cloud?.checkPlan?.()),
      firstThread: () => cloudConversations.firstCloudThread(),
      machine: (repository) => cloudConversations.preparedMachine(repository),
      now: Date.now,
    },
  })
  declareTurnOnMethods(methods, turnOn)
  if (turnOn) {
    const following = turnOn
    late.turnOn = following
    shell.jobs.every("look again at the cloud turning on", TURN_ON_POLL_MS, () => following.poll(), { needs: [turnOnUnderWay] })
    void following.changed()
  }
  void cloudConversations?.start().catch((error: Error) => hostWarn("cloud-conversations", "couldn't follow the cloud conversations", { error: error.message }))
  const residency = new ControlResidency({
    sessions: control.sessions,
    grants: () => late.agentServers,
    browser: () => late.controlService,
    journal: (conversationId) => join(logsRoot(environment.dataRoot), "local-control", `${conversationId}.jsonl`),
    notice: (message) => emit({ type: "notice", level: "error", message }),
  })
  const opened = await openConversations({
    ...(owner.start && { start: owner.start }),
    stopping: () => shell.closing(),
    streams,
    // A person's own device reaches their others through the account; a fixture desk reaches none.
    ...(!fixtureDesk && { account: () => late.cloud }),
    finDefaults,
    finCapacity,
    lent: () => lent.count(),
    builds: () => buildSlots.reading(),
    invoke: (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
    // A new conversation is on the account's list before its harness has started.
    opened: () => late.sessions?.showsChanged(),
    // Back from away, a conversation begun before then runs nothing until the account says its Session is still this
    // Mac's; one whose continue this Mac joins runs nothing until the join ends.
    ownerCheck: ownerHold({ account: () => cloudConversations, moves: () => late.cloudMoves, session: (conversationId) => threads.store?.journalPlacement(conversationId)?.session, away: (session) => late.awayNotes?.holds(session) }),
    // A cloud machine's harnesses run on the account's sign-ins: nobody is there to sign one in.
    unattended: config.machineAgentFd !== undefined,
    environment,
    git,
    threads,
    harnesses,
    workspaces,
    telemetry,
    emit,
    foreground: shell.foreground,
    work: shell.work,
    jobs: shell.jobs,
    mcpSnapshot: (cwd) => tools.mcp.discover(cwd),
    tools: (bindingId, conversationId) => residency.tools(bindingId, conversationId),
    controlInstructions: makoNote({
      cloudMachine: config.machineAgentFd !== undefined,
      launchedWith: (conversationId) => {
        const launched = workspaces.environments?.launchedWith(conversationId)
        if (launched) void workspaces.processes?.touch(launched.app).catch(() => {})
        return launched
      },
      controlLine: (bindingId) => {
        const session = control.sessions.get(bindingId)
        return session && controlLine(session)
      },
      ownSlot: (conversationId) => {
        const harness = late.conversations?.live.session(conversationId)?.harness
        return harness === undefined ? undefined : harnesses.host.liveDrivers.get(harness)?.makoInstructions !== undefined
      },
      notices: (conversationId) => [...(workspaces.worktrees?.notices(conversationId) ?? []), ...(late.cloudReturns?.notices(conversationId) ?? [])],
    }),
    revokeTools: (bindingId, conversationId) => residency.revoke(bindingId, conversationId),
    rewindWriters: (paths, since) => late.attribution?.rewindWriters(paths, since),
    suspendTools: (bindingId, conversationId) => residency.suspend(bindingId, conversationId),
    settled: (id) => {
      late.readiness?.settled(id)
      late.movers?.moves.settled(id)
      late.movers?.leaves.settled(id)
      late.threadMoves?.settled(id)
    },
    // What a turn left in its worktree is read again for the rail, as its own event rather than a window's poll.
    turnEnded: (_id, cwd) => workspaces.worktrees?.turnEnded(cwd),
    movePending: (id) => {
      const answer = late.movers?.moves.answerFor(id)
      return answer === "asking" || answer === "allowed" || answer === "moving"
    },
    archived: (id) => late.archivedHere?.(id) ?? false,
    // Each turn's changes, counted by the attribution journal once it opens.
    turnLedger: () => {
      const attribution = late.attribution
      return attribution && {
        placement: (conversation) => threads.store?.journalPlacement(conversation),
        // A turn's count waits only for what was heard: never for checkouts rescanned whole after lost events.
        flushed: () => attribution.heard(),
        countTurn: (thread, turn, state) => attribution.countTurn(thread, turn, state),
        settledThrough: (at) => attribution.settledThrough(at),
        counted: (summary, session) => attribution.counted(summary, session),
        turnsChangedAfter: (thread, after) => attribution.turnsChangedAfter(thread, after),
        settleMs: ATTRIBUTION_SETTLE_MS,
      }
    },
    // A turn's review and its undo, from the same journal.
    turnReview: () => {
      const attribution = late.attribution
      return attribution && {
        placement: (conversation) => threads.store?.journalPlacement(conversation),
        settled: () => attribution.settled(),
        blob: (ref) => attribution.blob(ref),
        turnWriters: (thread, turn, file, shown) => attribution.turnWriters(thread, turn, file, shown),
        turnOnly: (thread, turn, file) => attribution.turnOnly(thread, turn, file),
        undoPlan: (thread, scope, checkout) => attribution.undoPlan(thread, scope, checkout),
        running: (checkout) => attribution.running(checkout),
        mako: (write) => attribution.mako(write),
      }
    },
    admission,
  })
  late.conversations = opened
  // Reachable again (its runtime's link is back), this device asks the places holding its Fins how they stand, which
  // tells them it hears: the notices they kept for it come now, not at their next retry.
  late.cloud?.onRuntimeLinked?.(() => opened.agents?.knock())
  const { live, runs, native } = opened
  // What this Mac can serve another place (its OS, Xcode, simulators, emulators, GPU, CLIs) and its room, said to the
  // account's broker on its runtime link and to its own: on a change, as the link enrols, and hourly. Only what the
  // person lends is said, by the grants that stand here and at the account. A cloud machine and a fixture desk lend nothing.
  if (config.machineAgentFd === undefined && !fixtureDesk) {
    const simulatorFacts = async (): Promise<SimulatorFacts | undefined> => {
      const [listed, setup] = await Promise.all([control.simulators.list({ kind: "person" }), control.simulatorSetup.read()])
      if ("refused" in listed) return undefined
      const here = listed.hosts.find((host) => host.kind === "local")
      if (!here) return undefined
      const xcode = setupStep(setup, "xcode")?.xcode?.version
      return { ios: here.platforms.ios, simulators: listed.simulators.filter((simulator) => simulator.hostId === here.id), ...(xcode && { xcode }) }
    }
    const brokers = async () => {
      const saved = await secrets.borrowing()
      return [workspaces.worktrees?.borrowing.borrowing, saved].filter((broker) => broker !== undefined)
    }
    const clis = new CliReadings({ installed: () => harnesses.updates.snapshot(), processes: providerHost.discovery })
    const advertiser = new Advertiser({
      probe: () => probeCapabilities(deviceProbe(simulatorFacts, () => clis.read())),
      lending: async () => {
        const [here, account] = await Promise.all([
          brokers().then((found) => Promise.all(found.map((broker) => broker.grants()))),
          late.cloud?.borrow?.grants().catch(() => null),
        ])
        return [...here.flat(), ...(account ?? [])]
      },
      devices: async () => {
        const [found, account] = await Promise.all([brokers(), late.cloud?.deviceId().catch(() => undefined)])
        return [...found.map((broker) => broker.device), ...(account ? [account] : [])]
      },
      room: () => {
        const capacity = finCapacity.reading()
        return { slots: { used: opened.agents?.workingHere() ?? 0, of: capacity.atOnce }, load: capacity.why }
      },
      sinks: [
        (advertisement) => late.cloud?.advertise?.(advertisement) ?? false,
        async ({ capabilities, slots }) => {
          await Promise.all((await brokers()).map((broker) => broker.advertise(capabilities, slots)))
        },
      ],
      log: (message, fields) => hostLog("borrowing", message, fields),
    })
    late.advertiser = advertiser
    jobs.every("advertise what this Mac can serve", ADVERTISE_EVERY_MS / 12, () => advertiser.probe(), { firstAfterMs: 10_000 })
    jobs.every("advertise this Mac's room", 15_000, () => advertiser.roomChanged())
    jobs.every("advertise what this Mac can serve, hourly", ADVERTISE_EVERY_MS / 4, () => advertiser.due())
  }
  // A message held until a time (a usage limit's reset) sends itself within a tick of it, across restarts.
  // Held messages' times: one timer, armed for the soonest (`LiveConversations.armWakes`), once the host has started.
  setTimeout(() => live.armWakes(), HELD_WAKES_AFTER_START_MS).unref()
  /** Filled once the handoffs exist: the cloud Thread each Thread at work keeps ready, which its move takes. */
  let readinessOnce: CloudReadiness | undefined
  // What the cloud's machines run, weighed against this Mac's harnesses before a Thread moves either way.
  const harnessCheck = cloudConversations && new HarnessCheck({
    account: () => late.cloud,
    writers: (path) => catalog.recordWriters(path),
    installed: (harness) => harnesses.updates.restoreRuntime(harness),
    reread: (harness) => harnesses.updates.reread(harness),
    updates: () => harnesses.updates.snapshot(),
    label: (harness) => opened.harnessLabel(harness),
  })
  // A person's Mac moves its Threads to the cloud (`mako:thread-move`); a machine takes them (`mako:move-arrive`).
  // A Thread the account continued while this Mac was away: its changes leave the main checkout only if every file is as
  // the cloud has it; otherwise they stay, and its row says so (`CheckoutLeave`).
  const checkoutLeave = new CheckoutLeave(join(environment.dataRoot, "cloud", "leaving"), git, (message, facts) => hostLog("leaving", message, facts))
  void checkoutLeave.resume(undefined).catch((error: Error) => hostWarn("leaving", "a rewrite of the project folder cut short couldn't be settled", { error: error.message }))
  /** The conversations of these Sessions, as a window shows them. */
  const heldConversations = (sessions: readonly string[]) => sessions.flatMap((session) => {
    const id = SessionIdSchema.safeParse(session)
    const thread = id.success ? threads.store?.sessionPlacement(id.data)?.thread : undefined
    return (thread ? threads.store?.threadSessions(thread) ?? [] : []).filter((each) => each.session === session).flatMap((each) => each.journals)
  })
  const leaveProjectFolder = async (session: string, op: string) => {
    const id = SessionIdSchema.safeParse(session)
    const thread = id.success ? threads.store?.sessionPlacement(id.data)?.thread : undefined
    // With what the note this continue came from carried (by its op), and nothing a later note recorded.
    const acknowledged = thread && (await late.readiness?.acknowledged(thread, op))
    const attribution = late.attribution
    if (!thread || !acknowledged || !attribution) return
    const repositories = acknowledged.acknowledged.map((each) => ({ root: each.root, versions: each.versions ?? [] }))
    // Only if the cloud has all of it, by its word: its machine applied (`applied`) the first repository's very checkpoint
    // and every other repository's with a change of the Thread's, and the going-away note it came from (by its op, never a
    // later note's) carried each. A continue on a clone, a repository the note left out or acknowledged since, or an
    // account that doesn't say what it applied: taking them out here could lose them, so all of it stays.
    const state = await late.cloud?.continueState?.(session, op).catch(() => undefined)
    const why = cloudHasAll(acknowledged.acknowledged.map((each) => ({ root: each.root, sha256: each.checkpoint.sha256, changes: each.versions?.length ?? 0 })), acknowledged.noted, state?.applied)
    const fromOurs = why === undefined
    const left = fromOurs
      ? await checkoutLeave.leave(thread, repositories[0]!.root, repositories, {
        heard: () => attribution.heard(),
        partition: (checkout, of) => attribution.partitionOffLoop(checkout, of),
        mako: (write) => attribution.mako(write),
      })
      : { kind: "stayed" as const, paths: repositories.flatMap((each) => each.versions.map((version) => version.path)).sort() }
    if (!fromOurs) hostLog("leaving", "a Thread the cloud took keeps its changes in the project folder: the cloud doesn't have all of them", { thread, op, why, applied: state?.applied?.length ?? "none" })
    // Nothing of the Thread's sits in the project folder unannounced: its row says what stayed, and the commits the cloud took.
    const unpushed = acknowledged.acknowledged.reduce((sum, each) => sum + each.unpushed, 0)
    if (left.kind === "stayed" || unpushed) {
      const paths = left.kind === "stayed" ? left.paths : []
      for (const conversation of threads.store?.threadSessions(thread).flatMap((each) => each.journals) ?? []) emit({ type: "checkout-stayed", conversation, paths, unpushed })
    }
  }
  const cloudMoves = cloudConversations && new CloudMoves({
    awayHeld: (session) => late.awayNotes?.holds(session),
    joinedAway: (session, op) => void leaveProjectFolder(session, op).catch((error: Error) => hostWarn("leaving", "a Thread the cloud took couldn't leave the project folder; its changes stay", { session, error: error.message })),
    folder: join(environment.dataRoot, "cloud", "moves"),
    git,
    account: () => late.cloud,
    threads: () => threads.store ?? undefined,
    moves: live.moves,
    snapshot: (id) => live.snapshot(id),
    checkout: (id) => workspaces.worktrees?.threadCheckout(id),
    // A Thread in the main checkout goes onto its own branch first, as the person's "Move to its own branch" does, its
    // companions following; its agent isn't told, since nothing starts a turn on the way to the cloud.
    ownBranch: async (id, options) => {
      const haste = options?.haste
      const movers = late.movers
      const worktreeMoves = movers?.worktreeMoves
      if (!movers || !worktreeMoves) throw new Error("Worktrees need the Thread store, which didn't open.")
      const { moved, following } = await movers.moves.moveNow(id, () => worktreeMoves.carry(id, { lead: true, tell: false, ...options?.asItself && { asItself: true }, ...haste && { haste } }), haste)
      await following
      return moved.session.id
    },
    // Where that branch's worktree would be now, made nothing of: a Thread at work there is kept ready at it.
    planned: async (id) => late.movers?.worktreeMoves?.planned(id),
    // What it carries besides its checkout: the paths outside it the journal ties to it, and its file history.
    outside: (thread) => late.attribution?.changes(thread).outside.filter((entry) => entry.evidence === "strong").map(({ path, access, secret }) => ({ path, access, secret })) ?? [],
    history: (thread) => late.attribution?.threadHistory(thread),
    archived: (conversationId) => late.archivedHere?.(conversationId) ?? false,
    repositoryOf: (cwd) => folderRepository(git, cwd),
    sendRecords: (link, paths) => catalog.sendRecords(link, paths),
    cloud: cloudConversations,
    remembered: (harness, nativeId) => threads.memory?.recall(harness, nativeId),
    live: {
      handOff: (conversationId) => live.handOff(conversationId),
      continueTurn: (conversationId, input) => void live.continueTurn(conversationId, input),
      waitingPrompts: (conversationId) => live.waitingPrompts(conversationId),
      carried: (conversationId, requestIds, to) => live.carried(conversationId, requestIds, to),
    },
    step: (conversationId, move, step) => {
      // Every device's list says the move from its first step; its window and a device watching it hear each step.
      if (movesUnderWay.stepped(threads.store?.journalPlacement(conversationId)?.thread, move, step)) late.sessions?.showsChanged()
      emit({ type: "thread-move-step", conversationId, move, step })
    },
    // However it ended, a throw included: no list says a move that nothing here runs.
    ended: (move) => {
      if (movesUnderWay.ended(move)) late.sessions?.showsChanged()
      // A continue joined, or not: what its Sessions held goes on where they run now.
      live.moves.ownerChecked()
    },
    newCloudThread: () => `t-${randomBytes(8).toString("hex")}`,
    ready: { take: (thread, folder, repository) => readinessOnce?.take(thread, folder, repository) ?? Promise.resolve(undefined) },
    carried: async (folder, why) => void (await carriedFiles?.sync(folder, why)),
    harnesses: harnessCheck,
  })
  late.cloudMoves = cloudMoves || undefined
  if (cloudMoves) {
    const unpark = () => void cloudMoves.unpark().catch((error: Error) => hostWarn("moves", "turns paused as this Mac went off couldn't go on yet", { error: error.message }))
    late.awayNotes = new AwayNotes({
      file: join(environment.dataRoot, "cloud", "away.json"),
      owner: () => {
        const cloud = late.cloud
        return cloud?.owner && ((ask) => cloud.owner!(ask))
      },
      deviceId: async () => late.cloud?.deviceId(),
      join: (session, listed) => cloudMoves.joinContinue(session, listed),
      released: unpark,
      changed: (sessions) => emit({ type: "away-held", conversations: heldConversations(sessions) }),
    })
    // Asked again while any waits and the account couldn't answer: on the account's next link too, through the owner check.
    shell.jobs.every("ask the account whose the Sessions held as this Mac went away are", 30_000, async () => {
      // A going-away that didn't happen (this Mac still runs long after) is over: asking goes on.
      late.awayNotes?.lapse()
      if (late.awayNotes?.any() && !cloudConversations?.ownerCheck(false)) await late.awayNotes.ask()
    })
  }
  void cloudMoves?.settle().catch((error: Error) => hostWarn("moves", "moves a stopped host left couldn't be settled", { error: error.message }))
  // The one owner of each cloud Thread's worktree here: the way back and the follow both write it through this.
  const cloudWorktrees = new CloudWorktrees()
  // And brings them back (`mako:thread-return`): a machine sends them (`mako:move-depart`).
  const cloudReturns = cloudConversations && new CloudReturns({
    folder: join(environment.dataRoot, "cloud", "returns"),
    moves: join(environment.dataRoot, "cloud", "moves"),
    git,
    account: () => late.cloud,
    threads: () => threads.store ?? undefined,
    claim: (input) => live.moves.claim(input),
    receiveRecords: (link, sessions) => {
      const installed: Record<string, ReturnType<typeof installedReading>> = {}
      for (const { harness } of sessions) installed[harness] = installedReading(harnesses.updates.restoreRuntime(harness))
      return catalog.receiveRecords(link, sessions, installed)
    },
    stageRecords: (link, sessions) => catalog.stageRecords(link, sessions),
    ready: async (input) => {
      const worktrees = workspaces.worktrees
      if (!worktrees) throw new Error("Mako's worktrees didn't open, so a Thread can't come back into one.")
      await worktrees.readyForReturn(input)
    },
    updateOffer: (harness) => harnesses.updates.restoreRuntime(harness).offer,
    cloud: cloudConversations,
    capture: async (conversationId, path) => void (await live.capture(conversationId, path)),
    step: (conversationId, move, step) => emit({ type: "thread-return-step", conversationId, move, step }),
    rememberMode: (harness, nativeId, modeId) => threads.memory?.remember(harness, nativeId, { modeId }),
    outside: join(environment.dataRoot, "cloud", "outside"),
    followed: {
      laid: async (cloudThread, path) => late.cloudFollow?.laid(cloudThread, path),
      forget: async (cloudThread) => late.cloudFollow?.forget(cloudThread),
    },
    carryHistory: async (history) => {
      const attribution = late.attribution
      if (!attribution) return false
      await attribution.carryThreadHistory(history)
      return true
    },
    worktrees: cloudWorktrees,
  })
  late.cloudReturns = cloudReturns
  // The worktree here of a Thread in the cloud follows it at each turn's end, until the person changes it here.
  late.cloudFollow = cloudConversations && new CloudFollow({
    folder: join(environment.dataRoot, "cloud", "follow"),
    moves: join(environment.dataRoot, "cloud", "moves"),
    git,
    readCheckpoint: async (cloudThread, sha256, file) => {
      const account = late.cloud
      if (!account) throw new Error("This Mac signed out of Mako Cloud.")
      await account.readCheckpoint(cloudThread, sha256, file)
    },
    callThread: (cloudThread, channel, args) => cloudConversations.callThread(cloudThread, channel, args),
    returning: (cloudThread) => late.cloudReturns?.returning(cloudThread) !== undefined,
    worktrees: cloudWorktrees,
    stopped: (cloudThread, state) => emit({ type: "thread-follow-stopped", conversations: cloudConversations.threadConversations(cloudThread).map((each) => each.conversationId), folders: state.edited?.folders ?? [], at: state.edited?.at ?? Date.now() }),
  })
  // Another device's Thread, read here from its copy while that device is off, continued in the cloud from this Mac.
  const cloudContinues = cloudConversations && new CloudContinues({
    account: () => late.cloud,
    listed: (conversationId) => cloudConversations.listedRow(conversationId),
    rows: () => cloudConversations.listedRows(),
    waiting: (session) => cloudConversations.listedWaiting(session),
    step: (conversationId, op, step) => emit({ type: "thread-continue-step", conversationId, op, step }),
  })
  // What an agent below full access asks the person, for every tool that acts for them.
  late.agentAsks = new AgentAskGate(live.asks)
  // The same three moves for an agent's `thread_move` and `mako thread move`: its own Thread, or the person's named one.
  // An agent's ask is answered on the path a harness's approval is, by whoever answers: one answer for each.
  live.asks.answering = async (conversation, ask, allow) => { await late.agentAsks?.answer(conversation, ask, allow) }
  late.threadMoves = new ThreadMoveTool({
    conversationOf: (session) => threads.store?.conversationsOf(session).at(-1),
    place: (id) => {
      if (live.session(id) && !cloudConversations?.has(id)) return "here"
      const row = cloudConversations?.listedRow(id)
      return row ? (row.runsOn.kind === "cloud" ? "cloud" : "device") : cloudConversations?.has(id) ? "cloud" : undefined
    },
    tier: (id) => sessionAccessTier(live.session(id)),
    busy: (id) => {
      const snapshot = live.snapshot(id)
      return Boolean(snapshot && (snapshot.session.status === "starting" || snapshot.session.status === "running" || snapshot.requests.some((request) => request.status === "queued" || request.status === "dispatching")))
    },
    ownWorktree: (id) => workspaces.worktrees?.threadCheckout(id) !== undefined,
    machine: config.machineAgentFd !== undefined,
    moves: () => cloudMoves && cloudReturns && cloudContinues ? {
      move: (id, move, handOff) => cloudMoves.move(id, move, handOff),
      refusal: (id) => cloudMoves.refusal(id),
      bringBack: (id, move) => cloudReturns.bringBack(id, move),
      continue: (id, op) => cloudContinues.press(id, op),
    } : undefined,
    gate: late.agentAsks,
  })
  // Rename, Archive and Restore for an agent's `thread` and `mako thread`, through the calls the app's menu makes.
  late.threadActs = new ThreadActTool({
    conversationOf: (session) => threads.store?.conversationsOf(session).at(-1),
    threadOf: (id) => threads.store?.journalPlacement(id)?.thread,
    tier: (id) => sessionAccessTier(live.session(id)),
    invoke: async (channel, args) => z.json().optional().parse(decodeRuntimeValue(await methods.invoke(channel, args))),
    gate: late.agentAsks,
  })
  late.settingsTool = new SettingsTool({
    conversationOf: (session) => threads.store?.conversationsOf(session).at(-1),
    tier: (id) => sessionAccessTier(live.session(id)),
    // Most of Settings' changes answer nothing.
    invoke: async (channel, args) => z.json().optional().parse(decodeRuntimeValue(await methods.invoke(channel, args))),
    gate: late.agentAsks,
  })
  late.harnessTool = new HarnessTool({
    conversationOf: (session) => threads.store?.conversationsOf(session).at(-1),
    tier: (id) => sessionAccessTier(live.session(id)),
    invoke: async (channel, args) => z.json().optional().parse(decodeRuntimeValue(await methods.invoke(channel, args))),
    machine: config.machineAgentFd !== undefined,
    gate: late.agentAsks,
  })
  late.automationTool = new AutomationTool({
    conversationOf: (session) => threads.store?.conversationsOf(session).at(-1),
    tier: (id) => sessionAccessTier(live.session(id)),
    invoke: async (channel, args) => z.json().optional().parse(decodeRuntimeValue(await methods.invoke(channel, args))),
    gate: late.agentAsks,
  })
  late.agentAsks.runs = {
    automation: (id, want, ask) => late.automationTool?.allowed(id, want, ask),
    harness: async (_id, want) => late.harnessTool?.allowed(want.action, want.harness),
    setting: async (_id, want) => void (await late.settingsTool?.run(want.setting)),
    move: (id, want) => late.threadMoves?.allowed(id, want),
    back: (id) => late.threadMoves?.allowedBack(id),
    rename: async (id, want) => void (await late.threadActs?.run(id, want)),
    archive: async (id, want) => void (await late.threadActs?.run(id, want)),
    restore: async (id, want) => void (await late.threadActs?.run(id, want)),
  }
  // And archives them, from here, whichever device they came from: the cloud ends them and keeps what they ran.
  const cloudArchives = cloudConversations && new CloudArchives({
    folder: join(environment.dataRoot, "cloud", "archives"),
    account: () => late.cloud,
    cloud: cloudConversations,
    step: (step) => emit({ type: "cloud-archive-step", step }),
  })
  void cloudArchives?.settle().catch((error: Error) => hostWarn("archives", "archives a stopped host left couldn't be settled", { error: error.message }))
  void cloudReturns?.settle().catch((error: Error) => hostWarn("returns", "returns a stopped host left couldn't be settled", { error: error.message }))
  // Agents at work go to the cloud when the person quits and asks, and as this Mac sleeps when they let it.
  const handOffUnavailable = async (): Promise<string | undefined> => {
    const blocked = late.cloud ? await (late.cloud.cloudBlocked?.() ?? late.cloud.id().then((id) => (id ? undefined : "signed-out" as const))).catch(() => "signed-out" as const) : "signed-out"
    if (blocked === "signed-out") return "Sign in to Mako Cloud to hand agents to the cloud."
    if (blocked === "no-cloud") return "Your Mako account doesn't have the cloud yet."
    return undefined
  }
  const cloudHandOffs = cloudMoves && new CloudHandOffs({
    file: join(environment.dataRoot, "cloud", "handoff.json"),
    working: () => workingThreads({ live, threads: threads.store ?? undefined, cloud: (id) => cloudConversations?.has(id) ?? false }),
    moves: cloudMoves,
    unavailable: handOffUnavailable,
    // A sleep or a shutdown: each Thread paused and parked here, its last changes sent, and the account told this Mac
    // went away, so it may continue them while the Mac is quiet. The quit sheet still moves them.
    goingAway: {
      flush: async (working, by) => late.readiness?.flush(working, by),
      checkpoint: async (thread) => late.readiness?.noteCheckpoint(thread),
      others: async (thread) => (await late.readiness?.noteOthers(thread)) ?? [],
      project: async (thread) => late.readiness?.noteProject(thread),
      projectFrom: async (thread) => late.readiness?.noteProjectFrom(thread),
      going: () => late.awayNotes?.going(),
      answered: () => late.awayNotes?.answered(),
      noted: async (sent) => late.readiness?.noted(sent),
      refused: async (note, threads) => late.readiness?.refused(note, threads),
      quiet: async (note, record) => {
        if (!late.cloud?.quiet) throw new Error("This Mac isn't signed in to Mako Cloud.")
        return late.cloud.quiet(note, record)
      },
      accepted: async (note, sessions) => late.awayNotes?.noted(note, sessions),
      goneQuiet: (why) => late.cloud?.leaving?.(why),
      // The account takes a note only for Sessions it lists as this Mac's and idle: read here until the paused turns are.
      rows: async () => {
        const cloud = late.cloud
        const [device, listed] = await Promise.all([cloud?.deviceId(), cloud?.sessionListings?.()])
        if (!device || !listed) throw new Error("This Mac's rows can't be read from the account now.")
        return new Map(listed.sessions.filter((row) => row.runsOn.kind === "device" && row.runsOn.deviceId === device).map((row) => [row.session, row.state]))
      },
    },
    changed: (settings) => {
      emit({ type: "handoff-settings", settings })
      void sleepHandOff?.refresh()
    },
  })
  const sleepHandOff = cloudHandOffs && onMac() ? new SleepHandOff({
    helper: () => sleepWatchHelper(environment),
    enabled: async () => (await cloudHandOffs.onSleep()) && !(await handOffUnavailable()),
    handOff: async (handOff, releaseBy) => void (await cloudHandOffs.handOff(handOff, "sleep", releaseBy)),
    woke: () => wake.notify("resume"),
  }) : undefined
  // Threads at work kept ready to move while handing off on sleep is on: a move then sends only the last seconds.
  if (cloudHandOffs && cloudMoves) {
    const readiness = new CloudReadiness({
      file: join(environment.dataRoot, "cloud", "ready.json"),
      git,
      scratch: join(environment.dataRoot, "cloud", "ready"),
      account: () => late.cloud,
      enabled: async () => (await cloudHandOffs.onSleep()) && !(await handOffUnavailable()),
      working: () => workingThreads({ live, threads: threads.store ?? undefined, cloud: (id) => cloudConversations?.has(id) ?? false }),
      revision: (conversationId) => live.held(conversationId)?.revision,
      leaving: (thread) => cloudMoves.leaving(thread),
      plan: (conversationId) => cloudMoves.readyPlan(conversationId),
      sendRecords: (link, paths) => catalog.sendRecords(link, paths),
      newCloudThread: () => `t-${randomBytes(8).toString("hex")}`,
      // Never the journal's full settle (rescans held the loop for seconds, #583), nor a partition on this thread.
      ledger: () => {
        const attribution = late.attribution
        return attribution && {
          heard: () => attribution.heard(),
          settled: () => attribution.heard(),
          track: (checkout) => attribution.track(checkout),
          head: (repository) => attribution.head(repository),
          partition: (checkout, thread) => attribution.partitionOffLoop(checkout, thread),
        }
      },
    })
    readinessOnce = readiness
    late.readiness = readiness
    shell.jobs.every("keep Threads at work ready to move", READY_EVERY_MS, () => readiness.refresh())
  }
  // This Mac kept awake while its agents work: a turn, background work or a subagent, never a wait on the person, and never a Fin that sits open.
  const keepAwake = cloudConversations && onMac() ? new KeepAwake({
    file: join(environment.dataRoot, "keep-awake.json"),
    helper: () => sleepWatchHelper(environment),
    working: () => workingThreads({ live, threads: threads.store ?? undefined, cloud: (id) => cloudConversations.has(id), ownWork: true }).length,
    serving: () => lent.count(),
    changed: (state) => emit({ type: "keep-awake", state }),
  }) : undefined
  late.keepAwake = keepAwake
  if (keepAwake) {
    void keepAwake.refresh()
    // What no batch says (a conversation closed, or gone to the cloud), and a helper to try again, within a minute.
    shell.jobs.every("keep this Mac awake while agents work", 60_000, () => keepAwake.refresh())
  }
  // The person's choice and their sign-in can change it; a minute is soon enough to start or stop listening.
  if (sleepHandOff) {
    void sleepHandOff.refresh()
    shell.jobs.every("watch whether to hand off on sleep", 60_000, () => sleepHandOff.refresh())
  }
  const workspaceAutomations = new Automations({
    launches: new AutomationLaunches(join(environment.dataRoot, "automation-launches")),
    git,
    watch: watchBackend,
    emit,
    launch: async (cwd, prompt) => {
      if (fixtureDesk) throw new AutomationNotStartedError("The fixture desk runs no automations")
      const resumable = new Set(nativeHarnesses(providerHost.nativeRunners))
      const profile = (await harnesses.profiles.all()).find((candidate) => candidate.available && resumable.has(candidate.id))
      if (!profile) throw new AutomationNotStartedError("No provider is available for this automation")
      telemetry.feature("automation.ran", profile.id)
      await runs.startFresh(profile.id, cwd, prompt, resolveHarnessTuning(profile, undefined))
    },
  })
  late.automations = workspaceAutomations
  void harnesses.accounts.completePendingRemovals().catch((error) =>
    hostWarn("accounts", "pending removals could not be read", { error: error instanceof Error ? error.message : String(error) })
  )
  trace("journals ready")
  const lifecycle = declareThreadMethods(methods, {
    threads,
    live,
    native,
    nativeStops: { token: (path) => runs.stopToken(path), abort: (path, token) => runs.abort(path, token) },
    homes: workspaces.environments,
    emit,
    archivedThread: ({ conversationId, sessionId }) => {
      control.simulators.releaseThread({ ...(conversationId && { conversation: conversationId }), ...(sessionId && { session: sessionId }) })
      if (conversationId) void late.conversations?.agents?.archived(conversationId)
    },
  })
  late.archivedHere = (conversationId) => lifecycle.archived({ kind: "live", id: conversationId })
  /** Archives a cloud Thread, or brings an archived one back here, as its window asked. */
  const archiveInCloud = async (cloudThread: string, command: ArchiveCommand): Promise<CloudArchiveOutcome> => {
    if (!cloudArchives || !cloudReturns || !cloudConversations) throw new Error("This host doesn't archive cloud Threads")
    const archived = cloudConversations.archiveOf(cloudThread)
    if (command.archived) return archived ? { kind: "archived", thread: cloudThread } : cloudArchives.archive(cloudThread, command.id, command.anyway === true)
    if (!archived) return { kind: "restored", thread: cloudThread }
    emit({ type: "cloud-archive-step", step: { thread: cloudThread, kind: "bringing" } })
    const back = await cloudReturns.restore(archived)
    return back.kind === "back" ? { kind: "restored", thread: cloudThread } : { kind: "refused", thread: cloudThread, reason: back.reason }
  }
  const workspaceMovers = openWorkspaceMovers({
    git,
    buildSlots,
    dataRoot: environment.dataRoot,
    workspaces,
    // On a cloud machine a named secret is met by its environment or by a file the account's store gave the checkout.
    hasSecret: (name) => process.env[name] !== undefined || machineCarried.some((file) => file.names.includes(name)),
    recipes,
    live,
    store,
    lifecycle,
    launch: (harness, cwd, tuning) => harnesses.profiles.resolveLaunch(harness, cwd, tuning),
    movedPaths: async (thread, from, to) => late.attribution?.movedPaths(thread, from, to),
    checkWaitMs: (harness) => harnesses.tools.mcpSources.get(harness)?.callWaitMs,
    jobs: shell.jobs,
    person: shell.machineGitHubPerson,
    pullRequestsAs: config.machineAgentFd === undefined ? undefined : () => machinePullRequestsAs(),
    emit,
    warn: (message, facts) => hostWarn("workspace", message, facts),
  })
  late.movers = workspaceMovers
  const history = threadHistoryTools({
    conversations: () => live.summaries(),
    snapshot: (id) => live.historySnapshot(id),
    store: () => threads.store,
    catalog: threads.catalog,
    bundle: { live: (conversation) => live.transcriptBundle(conversation), native: (path) => threads.catalog.transcriptArtifact(path) },
  })
  const mediaRoot = join(environment.dataRoot, "media")
  const turnMedia = new TurnMedia(mediaRoot)
  const machineArtifacts = config.machineAgentFd === undefined ? undefined : new MachineArtifacts({
    places: machineArtifactPlaces({ artifacts: controlArtifactsRoot(), recordings: controlRecordingsRoot(), media: mediaRoot }),
  })
  machineArtifacts?.schedule(shell.jobs)
  late.agentServers = await startConversationMcp(live, (bindingId, operation, signal) => control.sessions.request(bindingId, operation, signal), [
    ...workspaceMovers.agentTools,
    (server, conversationId) => registerThreadHistoryTools(server, history, conversationId),
    (server, conversationId) => registerShowTool(server, { media: turnMedia, cwd: (id) => live.session(id)?.cwd }, conversationId),
    (server, conversationId) => registerAgentTools(server, {
      invoke: async (channel, args) => AgentAnswerSchema.parse(decodeRuntimeValue(await methods.invoke(channel, args))),
      caller: () => {
        const session = threads.store?.journalPlacement(conversationId())?.session
        return session ? { kind: "agent", session } : { kind: "person" }
      },
      filled: () => ({ cwd: live.session(conversationId())?.cwd }),
    }),
    // Always as the Thread's agent: a conversation without a Session is refused, never taken for the person.
    (server, conversationId) => registerThreadTools(server, {
      invoke: async (channel, args) => ThreadMoveAnswerSchema.parse(decodeRuntimeValue(await methods.invoke(channel, args))),
      caller: () => ({ kind: "agent", session: threads.store?.journalPlacement(conversationId())?.session ?? "" }),
    }),
    (server, conversationId) => control.simulatorTools.register(server, {
      invoke: async (channel, args) => decodeRuntimeValue(await methods.invoke(channel, args)),
      caller: () => {
        const session = threads.store?.journalPlacement(conversationId())?.session
        return session ? { kind: "agent", session } : undefined
      },
    }),
  ], (conversationId, event, body) => {
    const cwd = live.session(conversationId)?.cwd
    if (!cwd) return {}
    const thread = callThreadOf(threads.store ?? undefined, conversationId, cwd, workspaces.environments?.launchedWith(conversationId), buildSlots.reading())
    return callGateAnswer(event, HookCall.safeParse(body).data, thread, conversationId)
  })
  trace("conversation tools ready")
  late.controlService = await control.startService((conversationId, bindingId) => live.authorizeAgent(conversationId, bindingId))

  const files = declareWorkspaceMethods(methods, {
    workspaces,
    movers: workspaceMovers,
    live,
    automations: workspaceAutomations,
    withHost,
    session: {
      // A conversation that moved to the cloud is the cloud's: its journal here stands aside.
      // The cloud's summary of a conversation stands in for this Mac's only when it has one: a moved conversation it
      // remembers without one would otherwise be listed by neither, and a window restoring it would take it for this Mac's.
      liveSummaries: () => {
        const cloud = cloudConversations?.summaries() ?? []
        const served = new Set(cloud.map((summary) => summary.session.id))
        return [...live.summaries().filter((summary) => !served.has(summary.session.id)), ...cloud]
      },
      archives: () => threads.archives.snapshot(),
      ready,
      withHost,
      platform: nodePlatform(),
      machine: () => machineOffer(machine),
      sourceRoot: config.development ? environment.appRoot : undefined,
      onWorkspaceChanged: (cwd) => workspaceAutomations.watch(cwd),
      elsewhere: async (conversation) => cloudConversations?.folder(conversation),
      unmadeFolder: () => machineWorkspace.unmade(),
    },
    emit,
    machine,
  })
  declareAttributionMethods(methods, () => late.attribution)
  declareMediaMethods(methods, turnMedia)
  const helperRuns = new HelperRuns(helperRunsRoot(environment.dataRoot))
  declareGitMethods(methods, { worktrees: workspaces.worktrees, withHost, git, environment, secrets, recordHelperRun: helperRuns.record, person: shell.machineGitHubPerson })
  declareHarnessMethods(methods, { harnesses, appRoot: environment.appRoot, workspace, emit })
  declareSetupMethods(
    methods,
    new SetupViews({
      recipe: async (folder) => late.movers?.appTools?.desk.setup(folder),
      ...(carriedFiles && {
        carried: {
          view: (folder) => carriedFiles.view(folder),
          decide: (folder, allowed) => carriedFiles.decide(folder, allowed ? "allowed" : "declined"),
          keep: (folder, path, keep) => carriedFiles.keep(folder, path, keep),
        },
      }),
      cloudSignIns: {
        state: async () => late.cloud?.signIns?.(),
        share: async (sharing) => {
          await methods.invoke("mako:cloud-sign-ins-share", [sharing])
        },
      },
      accounts: () => harnesses.accounts.catalog(),
      keys: () => providerHost.modelConnections.snapshot(),
      device: async () => ({ id: await late.cloud?.deviceId().catch(() => undefined), name: (await describeThisDevice(environment.version)).name }),
      label: (harness) => harnessLabel(providerHost, harness),
      borrowing: {
        local: async () => {
          const checkouts = workspaces.worktrees?.borrowing.borrowing
          const saved = fixtureDesk ? undefined : await secrets.borrowing()
          return [checkouts, saved].filter((broker) => broker !== undefined)
        },
        account: {
          snapshot: async (since) => (await late.cloud?.borrow?.snapshot(since)) ?? null,
          answer: async (ask, answer) => {
            if (!late.cloud?.borrow) throw new Error("This Mac isn't signed in to Mako.")
            const decided = await late.cloud.borrow.answer(ask, answer)
            // The person's yes to a session this Mac serves: it's served from now, before the link says so.
            if (decided && "lease" in decided) await late.lending?.lent(decided.lease)
          },
          revoke: async (grant) => {
            if (!late.cloud?.borrow) throw new Error("This Mac isn't signed in to Mako.")
            await late.cloud.borrow.revoke(grant)
          },
        },
        secretVersion: (kind, name) => (fixtureDesk ? Promise.resolve(undefined) : secrets.secretVersion(kind, name)),
        asker: (thread) => {
          const parsed = ThreadIdSchema.safeParse(thread)
          const title = parsed.success ? threads.store?.thread(parsed.data)?.title : undefined
          return title ? { thread, title, fin: false } : undefined
        },
      },
    })
  )
  declareControlMethods(methods, control, environment.appRoot, config.executable)
  declareCloudControlPreviewMethods(methods, () => cloudConversations?.controlPreviews)
  declareToolMethods(methods, { tools, control, workspace, dataRoot: environment.dataRoot, machine })
  const usage = declareUsageMethods(methods, {
    dataRoot: environment.dataRoot,
    userRoot: environment.userRoot,
    worker: new URL("./usage-worker.js", import.meta.url),
    strictStores: fixtureDesk,
  })
  const storageRoots = [environment.userRoot, environment.dataRoot]
  const makoCollectors = [new RecordRepacks(records), new LeftoverFiles(storageRoots)]
  const storage = new MakoStorage({ roots: storageRoots, collectors: () => [...harnesses.host.storage.list(), ...makoCollectors], emit })
  // The fixture desk writes no store and stands in for no one's disk.
  if (!fixtureDesk) storage.schedule(shell.jobs)
  declareStorageMethods(methods, storage)
  declareFootprintMethods(methods, () => ({ watching: watchReadings.reading(), rescans: late.attribution?.rescans() ?? null }))
  /** On a cloud machine: what a Thread arriving from a device needs (`mako:move-arrive`), and a lost machine's restore. */
  const arrival: MoveArrivalDeps | undefined = config.machineAgentFd === undefined ? undefined : {
    git,
    records: () => machineRecords(machineLink),
    workspace: () => workspaceClients.homePath(),
    workspaceProblem: () => machineWorkspace.problem,
    workspaceSettled: () => machineWorkspace.settled(),
    receive: (link, sessions, installed) => catalog.receiveRecords(link, sessions, installed),
    stage: (link, sessions) => catalog.stageRecords(link, sessions),
    installed: (harness) => installedReading(harnesses.updates.restoreRuntime(harness)),
    open: async (session) => {
      // Settled as every start's are: the harness's catalog fills what the device's settings leave out.
      const tuning = await harnesses.profiles.resolveLaunch(session.harness, session.folder, session.tuning)
      await live.start(session.harness, session.folder, {
        conversationId: session.conversationId, resume: session.nativeId, threadPath: session.path,
        ...session.modeId !== undefined && { modeId: session.modeId },
        ...tuning !== undefined && { tuning },
      })
      await live.opened(session.conversationId)
    },
    take: (handoff) => {
      const store = threads.store
      if (!store) throw new Error("This machine's Thread store isn't open.")
      store.takeArrival({ operationId: namedUuid(`mako move\0${handoff.move}\0arrive`), handoff, actor: store.person() })
    },
    // The launch settings a session's start resolves (a harness's model catalog, which OpenCode reads by starting a
    // whole server): read now, in the folder, with the session's own settings, so the hand-over's start finds them.
    warm: async (harness, folder, tuning) => {
      await harnesses.profiles.resolveLaunch(harness, folder, tuning)
    },
    signedIn: (harness) => machineSignIns?.some((install) => install.harness === harness && install.status === "installed"),
    refreshCarried: async () => shell.refreshMachineCarried?.(),
    label: (harness) => opened.harnessLabel(harness),
    scratch: join(environment.dataRoot, "moves"),
    ahead: new Map(),
    carryHistory: async (history) => {
      const attribution = late.attribution
      if (!attribution) return false
      await attribution.carryThreadHistory(history)
      return true
    },
    clone: (repository) => cloneRepository(git, repository),
  }
  /** The Thread's files outside its folder that this machine's journal ties to it, with strong evidence: what a carry takes. */
  const threadOutside = (thread: ThreadId) => late.attribution?.changes(thread).outside.filter((entry) => entry.evidence === "strong").map(({ path, access, secret }) => ({ path, access, secret })) ?? []
  const threadHistory = (thread: ThreadId) => late.attribution?.threadHistory(thread)
  /** On a cloud machine: its tracker, which saves the Thread as it changes and restores a lost machine's save. */
  const machineTracker = arrival && openMachineTracker({
    git,
    dataRoot: environment.dataRoot,
    jobs: shell.jobs,
    gateway: () => machineLink ?? undefined,
    records: (gateway) => machineRecords(gateway)!,
    workspace: () => workspaceClients.homePath(),
    live: {
      summaries: () => live.summaries(),
      activeRequest: (id) => live.activeRequest(id),
      continueTurn: (conversationId, input) => void live.continueTurn(conversationId, input),
    },
    remembered: (harness, nativeId) => threads.memory?.recall(harness, nativeId),
    store: () => threads.store ?? undefined,
    sendRecords: (link, paths) => catalog.sendRecords(link, paths),
    arrival,
    carry: { git, scratch: join(environment.dataRoot, "moves"), outside: threadOutside, history: threadHistory },
  })
  // Mako's own writes to the checkout (a person's edit through Files, a Git action): saved as a tool call's are.
  late.machineTracker = machineTracker
  const unwatchSaves = machineTracker && workspaceWrites.subscribe((write) => {
    if (write.paths.length) machineTracker?.saves.changed("Mako wrote files")
  })
  declareConversationMethods(methods, {
    conversations: opened,
    profiles: harnesses.profiles,
    threads,
    workspaces,
    movers: workspaceMovers,
    lifecycle,
    telemetry,
    files: conversationFiles,
    invoke: (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
    workspace,
    emit,
    accessMode: (harness) => accessChoices.mode(harness),
    used: (harness, settings) => {
      try {
        finDefaults.use(harness, settings)
      } catch (error) {
        hostWarn("agents", "the model the person used couldn't be kept for their Fins", { harness, error: error instanceof Error ? error.message : String(error) })
      }
    },
    ...(arrival && {
      arrival,
      departure: {
        git,
        records: () => machineRecords(machineLink),
        workspace: () => workspaceClients.homePath(),
        workspaceProblem: () => machineWorkspace.problem,
        blockers: (thread) => live.moves.settledBlockers(thread),
        threads: () => threads.store ?? undefined,
        moves: live.moves,
        native: (conversationId) => {
          const session = live.snapshot(conversationId)?.session
          return session?.harness && session.nativeId && session.nativePath ? { harness: session.harness, nativeId: session.nativeId, path: session.nativePath } : undefined
        },
        send: (link, paths) => catalog.sendRecords(link, paths),
        scratch: join(environment.dataRoot, "moves"),
        outside: threadOutside,
        history: threadHistory,
      },
    }),
  })
  declareThreadMoveMethods(methods, () => late.threadMoves)
  declareThreadActMethods(methods, () => late.threadActs)
  declareSettingsMethods(methods, () => late.settingsTool)
  declareHarnessToolMethods(methods, () => late.harnessTool)
  declareAutomationToolMethods(methods, () => late.automationTool)
  declareAgentAskMethods(methods, () => late.agentAsks)
  const application: Application = declareApplicationMethods(methods, {
    live,
    native,
    nativeRuns: { lifecycleWork: () => runs.lifecycleWork(), abort: (path, token) => runs.abort(path, token) },
    admission,
    updates: appUpdates,
    wake,
    leaving: (source) => {
      hostLog("host", "leaving", { source })
      return machineLeaving(source, {
        handOffs: cloudHandOffs || undefined,
        enabled: async () => cloudHandOffs ? (await cloudHandOffs.onSleep()) && !(await handOffUnavailable()) : false,
        quiet: (why) => late.cloud?.leaving?.(why),
      })
    },
    jobs: shell.jobs,
    subscribed: shell.subscribed,
    emit,
    clients: () => web()?.clients() ?? [],
    finish: (action, install) => {
      install?.()
      void owner.lifecycle.stop({ kind: "request", action })
    },
    crashes,
    logPath: owner.logPath,
  })
  opened.share((event) => {
    sessions.event("event", event)
    if (!shell.closing()) web()?.conversationEvent(event)
  })

  const plugins = fixtureDesk ? null : watchPluginChanges(environment.dataRoot, emit)
  const builds = config.development ? watchOwnBuild(devHostBuildDirectories(environment.appRoot), emit) : []
  appUpdates.start()
  trace("updates ready")
  catalog.start()
  trace("catalog starting")
  // The last host's readings paint first; this host's own run a few seconds
  // behind startup, and hourly for the public versions.
  await harnesses.updates.load()
  // A machine reads its harnesses' versions as it warms (`warm`), before its image's snapshot: the next reading is due
  // in an hour, not seconds into a copy's first start.
  if (!fixtureDesk) harnesses.updates.start(shell.jobs, config.machineAgentFd !== undefined ? { firstAfterMs: 60 * 60_000 } : {})
  void ready().then((pool) => workspaceAutomations.watch(pool.active.workspace))
  void telemetry.started(shell.jobs, performance.now())

  // One pre-drain phase for every owner that can wait on a process, a peer or the network.
  // Local stores stay open until both these cancellations and the calls using them have settled.
  const outside = {
    "provider connection checks": async () => { await Promise.all(providerHost.connections.list().map((connection) => connection.stop?.())) },
    "account sign-ins": () => harnesses.logins.stop(),
    "native starts": () => runs.stop(),
    "profile discovery": () => harnesses.profiles.stop(),
    "provider discovery": () => providerHost.discovery.stop(),
    "live conversations": () => opened.stop(),
    "Git commands": () => git.close(),
    "application updates": () => application.dispose(),
    "cloud continuations": () => cloudContinues?.close(),
    "cloud calls": () => late.cloud?.stop(),
    "terminal calls": () => shell.terminals.current()?.dispose(),
    "plugin calls": () => plugins?.close(),
    "builds": () => { for (const build of builds) build.close() },
    "browser and computer calls": () => control.stop(),
    "file calls": () => files.stop(),
    "workspace automations": () => workspaceAutomations.stop(),
    "harness updates": () => harnesses.updates.stop(),
    "catalog calls": () => catalog.stop(),
  } satisfies Record<string, () => void | Promise<void>>
  for (const [name, cancel] of Object.entries(outside)) shell.stopping.register(name, cancel)

  return {
    route: async (channel, args) => {
      // A window whose folder is a conversation's on its machine reads and changes it there, and is told what only
      // this Mac can do.
      const tab = workspaceClients.opened(hostClient())?.active
      const elsewhere = tab?.elsewhere
      if (tab && elsewhere) {
        const refusal = elsewhereRefusal(channel, elsewhere.where)
        if (refusal) throw new Error(refusal)
        if (answeredElsewhere(channel, args, tab.workspace)) {
          const answered = await elsewhere.call(channel, args)
          // Its Thread came back: the folder is this Mac's again, and this host answers it.
          if (answered !== "here") return { handled: true, value: answered.value }
        }
      }
      if (channel === "mako:thread-archive" && cloudArchives && cloudConversations && cloudReturns) {
        // A cloud Thread's archive is its own object's, never a key here: archived or restored there, for every device.
        // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-archive`'s schema before routing it.
        const [command] = args as [ArchiveCommand]
        const identity = lifecycle.identity(command.target)
        const cloudThread = await cloudConversations.cloudThreadOf(identity)
        if (cloudThread) {
          const cloud = await archiveInCloud(cloudThread, command)
          return { handled: true, value: encodeRuntimeValue({ ...threads.archives.snapshot(), cloud } satisfies ArchiveAnswer) }
        }
        // Another device's Session is archived by that device: its list drops it everywhere, and nothing here keeps it.
        if (identity.conversationId && (await cloudConversations.archiveOnOwner(identity.conversationId, command)))
          return { handled: true, value: encodeRuntimeValue(threads.archives.snapshot() satisfies ArchiveAnswer) }
      }
      if (channel === "mako:thread-return" && cloudReturns) {
        // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-return`'s schema before routing it.
        const [conversationId, move, options] = args as [string, string, ThreadReturnOptions | undefined]
        return { handled: true, value: encodeRuntimeValue(await cloudReturns.bringBack(conversationId, move, options)) }
      }
      if (channel === "mako:thread-harness-check" && cloudMoves && harnessCheck) {
        // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-harness-check`'s schema before routing it.
        const [conversationId] = args as [string]
        const away = await cloudReturns?.harnessesAway(conversationId)
        return { handled: true, value: encodeRuntimeValue(away ? await harnessCheck.check(away.map((harness) => ({ harness }))) : await cloudMoves.harnessCheck(conversationId)) }
      }
      if (cloudContinues) {
        if (channel === "mako:thread-continue-offer") {
          // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-continue-offer`'s schema before routing it.
          const [conversationId] = args as [string]
          return { handled: true, value: encodeRuntimeValue(await cloudContinues.offer(conversationId)) }
        }
        if (channel === "mako:thread-continue") {
          // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-continue`'s schema before routing it.
          const [conversationId, op] = args as [string, string]
          return { handled: true, value: encodeRuntimeValue(await cloudContinues.press(conversationId, op)) }
        }
        if (channel === "mako:continue-readings") return { handled: true, value: encodeRuntimeValue(cloudContinues.readings()) }
      }
      if (keepAwake) {
        if (channel === "mako:keep-awake") return { handled: true, value: encodeRuntimeValue(await keepAwake.state()) }
        if (channel === "mako:keep-awake-set") {
          // SAFETY: the dispatcher parsed this call's arguments with `mako:keep-awake-set`'s schema before routing it.
          const [change] = args as [Partial<KeepAwakeSettings>]
          return { handled: true, value: encodeRuntimeValue(await keepAwake.set(change)) }
        }
      }
      if (channel === "mako:thread-move" && cloudMoves) {
        // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-move`'s schema before routing it.
        const [conversationId, move, handOff] = args as [string, string, ThreadHandOff | undefined]
        late.agentAsks?.retire(conversationId, "move")
        return { handled: true, value: encodeRuntimeValue(await cloudMoves.move(conversationId, move, handOff)) }
      }
      if (cloudHandOffs) {
        if (channel === "mako:handoff-candidates") return { handled: true, value: encodeRuntimeValue(await cloudHandOffs.candidates()) }
        if (channel === "mako:handoff-settings") return { handled: true, value: encodeRuntimeValue(await cloudHandOffs.settings()) }
        if (channel === "mako:handoff-settings-set") {
          // SAFETY: the dispatcher parsed this call's arguments with `mako:handoff-settings-set`'s schema before routing it.
          const [onSleep] = args as [boolean]
          return { handled: true, value: encodeRuntimeValue(await cloudHandOffs.setOnSleep(onSleep)) }
        }
        if (channel === "mako:handoff-away-held") return { handled: true, value: encodeRuntimeValue(heldConversations(late.awayNotes?.held() ?? [])) }
        if (channel === "mako:handoff-run-here") {
          // SAFETY: the dispatcher parsed this call's arguments with `mako:handoff-run-here`'s schema before routing it.
          const [conversationId] = args as [string]
          const thread = threads.store?.journalPlacement(conversationId)?.thread
          const sessions = thread ? (threads.store?.threadSessions(thread) ?? []).map((each) => each.session) : []
          return { handled: true, value: encodeRuntimeValue((await late.awayNotes?.runHere(sessions)) ?? 0) }
        }
        if (channel === "mako:handoff") {
          // SAFETY: the dispatcher parsed this call's arguments with `mako:handoff`'s schema before routing it.
          const [handOff, why] = args as [string, "quit"]
          return { handled: true, value: encodeRuntimeValue(await cloudHandOffs.handOff(handOff, why)) }
        }
      }
      const cloud = await cloudConversations?.route(channel, args)
      return cloud?.handled ? cloud : opened.route(channel, args)
    },
    presentHistory: (value) => opened.history.present(value),
    file: (request, client = "web") => withHostClient(client, () => readWindowFile(request, withHost, renditions, owned)),
    signedFile: (request) => withHostClient("gateway:files", () => readSignedFile(request, renditions, owned)),
    disconnected: (client) => {
      shell.terminals.current()?.release(client)
      void workspaceClients.release(client)
    },
    desktop: (request, response) => control.desktop.attach(request, response),
    /**
     * On a cloud machine, before it says it's ready: every heavy package a start loads, and each harness's version,
     * which runs its binary. A snapshot taken after, as the machine image's is, wakes with all of it loaded: modules
     * in the host's memory, binaries in the page cache. A copy's start loaded them cold, a second or more each.
     */
    warm: async () => {
      const loads = Object.entries(heavy).filter(([key]) => key !== "keyring").map(([, lazy]) => lazy.load("warm the machine").then(() => lazy.name))
      const loaded = (await Promise.allSettled(loads)).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      await harnesses.updates.refresh().catch(() => undefined)
      // And every harness's MCP servers, two listed by running their CLIs. Not the harnesses' binaries whole: a copy
      // restores memory as it's touched, and one harness's handshake on a copy of an image that held every binary took
      // 1.4 to 3.0 s, against 0.4 to 2.6 s on one that didn't (2026-10-20).
      await tools.mcp.discover(homedir()).catch(() => undefined)
      return [...loaded, "harness versions", "MCP servers"]
    },
    installCloudSignIns: async (signIns, place) => {
      const installed = await installCloudSignIns(providerHost.accountCapabilities, signIns, place)
      machineSignIns = installed
      // What each harness can run as just changed: Settings and new Threads read it again, once no start is waiting.
      // A start reads its own harness's profile under its new sign-in itself. On a machine, sign-ins come as it
      // enrols, just before its first start, and every harness's discovery at once doubled that start (2026-10-20).
      void shell.foreground.idle().then(() => harnesses.profiles.all(true)).catch(() => undefined)
      return installed
    },
    prefetchStart: async (harness) => {
      // Beside the harness's own: what every start loads into the host first, Mako's MCP servers.
      void late.agentServers?.warm().catch((error: Error) => hostWarn("machine", "Mako's MCP servers weren't warmed", { error: error.message }))
      return harnesses.host.liveDrivers.runAhead(harness, (await harnesses.tools.account(harness)).env, homedir())
    },
    prefetchSignedIn: async (harness) => harnesses.host.liveDrivers.signedInAhead(harness, (await harnesses.tools.account(harness)).env),
    /**
     * Every harness's MCP servers as a start in `path` reads them. Codex and Grok list theirs by running their CLIs,
     * 1.5 to 3.5 s on a copy (2026-10-20); a copy of a base made after this finds the listing in its host's memory,
     * kept while nothing either CLI reads has changed.
     */
    prepareFolder: async (path) => {
      await tools.mcp.discover(path)
    },
    machineLinked: async (link) => {
      machineLink = link
      await catalog.syncRecords(machineRecords(link) ?? null)
    },
    restoreMachineSave: async (link, generation) => machineTracker?.restore(link, generation),
    machineSaves: machineTracker && {
      working: (busy) => machineTracker?.saves.working(busy),
      settle: (why) => machineTracker?.saves.settle(why) ?? Promise.resolve(),
    },
    machineArtifacts,
    machineWorkspaceFailed: (problem, reason) => machineWorkspace.failed(problem, reason),
    machineCarriedFiles: (files) => {
      machineCarried = files
    },
    openMachineWorkspace: async (path) => {
      await workspaceClients.home(path)
      await workspaceAutomations.watch(path)
      machineWorkspace.opened(path)
    },
    media: controlVideoMedia(control.previews),
    activeWork: () => application.lifecycle.snapshot().work.length > 0,
    work: () => application.lifecycle.snapshot().work,
    sessions,
    lifecycleBlocked: () => application.lifecycle.blocked,
    async stop() {
      // A stop that runs long says where it is and what it waits on, so a host killed for it leaves the reason logged.
      let step = "waiting for a handoff under way"
      // A shutdown's handoff goes on as the system stops the host: what it still sends to the cloud, its hold at most.
      await cloudHandOffs?.underWay(Date.now() + SHUTDOWN_HOLD_MS)
      step = "closing the record of changes"
      const slow = STOP_SLOW_MS.map((ms) => setTimeout(() => hostWarn("lifecycle", "stopping is slow", { ms, step, on: shell.work.openWork?.().join(", ") || "no named work" }), ms))
      try {
        jobs.stop()
        machineTracker?.saves.stop()
        unwatchSaves?.()
        unfollowEffects?.()
        unfollowBounds?.()
        const callsDrained = methods.close()
        const outsideDrained = shell.stopping.stop()
        void outsideDrained.catch(() => {})
        await late.attribution?.close().catch((error: Error) => hostWarn("attribution", "the journal did not close cleanly", { error: error.message }))
        wake.stop()
        repositories.stop()
        sleepHandOff?.stop()
        keepAwake?.stop()
        step = "waiting for the calls under way and the providers' drains"
        await Promise.all([callsDrained, outsideDrained, telemetry.close(), usage.close()])
        // Deliver their stopping answers before the socket's generic reconnect farewell.
        await new Promise<void>((resolve) => setImmediate(resolve))
        shell.closeSocket()
        step = "closing the conversations"
        cloudConversations?.dispose()
        late.agentServers?.close()
        threads.close()
        workspaces.close()
        conversationFiles.close()
        turnMedia.close()
        void workspaceClients.dispose()
        // What an owner left running ends with the host rather than outliving it; children that exited while stopping
        // have left the registry by now.
        step = "ending what providers left running"
        await children.end()
        for (const stop of unfollow) stop()
        step = "writing what it kept"
        await Promise.all([unknown.flush(), mismatches.flush()])
      } finally {
        for (const timer of slow) clearTimeout(timer)
      }
      hostLog("lifecycle", "stopped")
    },
  }
}

/** Where a cloud machine's Thread's session records are kept at the gateway, as the machine reaches them. */
function machineRecords(link: MachineGatewayLink | null): RecordsLink | undefined {
  if (!link) return undefined
  const records = new URL(`/v1/machines/${encodeURIComponent(link.machine)}/records`, link.gatewayUrl).toString()
  return { id: records, base: records, authorization: `Bearer ${link.credential}` }
}

/**
 * Answers "is the host I am talking to current?" without guessing: in dev,
 * the moment a rebuild of this host lands on disk, every window says so. The
 * renderer hot-reloads through Vite; the host cannot, and pretending
 * otherwise is how stale builds get debugged for an hour.
 */
function watchOwnBuild(directories: readonly string[], emit: (event: HostEvent) => void): FSWatcher[] {
  let told = false
  const rebuilt = (_change: string, file: string | null) => {
    if (told || !file?.endsWith(".js")) return
    told = true
    setTimeout(() => emit({ type: "notice", level: "info", message: "Mako's engine was rebuilt — run Restart Mako from the palette to load it." }), 500)
  }
  return directories.flatMap((directory) => {
    try {
      return [watch(directory, { recursive: true }, rebuilt)]
    } catch (error) {
      hostWarn("host", "own build not watched", { directory, error: error instanceof Error ? error.message : String(error) })
      return []
    }
  })
}

