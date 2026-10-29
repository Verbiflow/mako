import { randomBytes } from "node:crypto"
import { recipesOverHttp } from "@mako/protocol/recipes-http"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { encodeRuntimeValue } from "./contracts/runtime-value.js"
import { githubRepositoryUrl, type ThreadHandOff, type ThreadReturnOptions } from "./contracts/cloud-threads.js"
import { watch, type FSWatcher } from "node:fs"
import { writeFile } from "node:fs/promises"
import { mediaExecutable } from "@mako/control-runtime/media"
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
import { SessionIdSchema, type ThreadId } from "./contracts/thread-identity.js"
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
import { cloneRepository, MediaRenditions, readSignedFile, readWindowFile, WorkspaceClients, Automations, childBackend, watchTree, watchOutsideGitDir, ConversationFiles, ArtifactPreviews, checkoutConversations, threadEnvironmentInstructions, openWorkspaces, openWorkspaceMovers, declareWorkspaceMethods, RecipeAccounts, CloudCarriedFiles, declareCarriedFilesMethods, readProjectRecipe, answeredElsewhere, elsewhereRefusal, type HostPool, type AgentHost, type WorkspaceMovers } from "./workspaces/index.js"
import { hostClient, withHostClient } from "./base/host-client.js"
import { ProviderChildren, readMakoProcesses } from "./base/provider-children.js"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { makoRecords, streamsRoot } from "@mako/sessions/record-streams"
import { makoViews, type ThreadRef } from "@mako/sessions"
import { unreadCounts } from "@mako/sessions/unread-index"
import { watchWake } from "./base/wake.js"
import { declareTelemetryMethods, declareCloudAccountMethods, type CloudAccount, type MachineGatewayLink, MachineWorkspace, declareUsageMethods, HelperRuns, helperRunsRoot, spendWatch } from "./usage/index.js"
import { resolveHarnessTuning, nativeHarnesses, createHarnessHost, threadHarnesses, openHarnesses, declareHarnessMethods, liveToolEffects, liveCallBounds, installCloudSignIns, CloudSignInSync, type CloudSignInPlace, type PrefetchOutcome } from "./harnesses/index.js"
import type { CloudSignIn, CloudSignInInstall } from "./contracts/cloud-sign-ins.js"
import type { CarriedFile } from "./contracts/machine-agent.js"
import { machineOffer, presentMachine, processMachine } from "./base/machine.js"
import { hostPlatform, nodePlatform, onMac } from "./base/platform.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import { openThreads, declareThreadMethods, declareUnreadRecordMethods } from "./threads/index.js"
import { ControlResidency, controlLine, openControl, declareControlMethods, controlVideoMedia, type ControlService } from "./control/index.js"
import type { MediaHandler } from "@mako/protocol"
import { workspaceWrites } from "./base/workspace-writes.js"
import { openConversations, openMachineTracker, type MachineTracker, type MoveArrivalDeps, declareConversationMethods, declareCloudControlPreviewMethods, CloudArchives, CloudConversations, CloudFollow, CloudHandOffs, CloudWorktrees, CloudMoves, CloudReadiness, CloudReturns, HarnessCheck, READY_EVERY_MS, folderRepository, namedUuid, SleepHandOff, sleepWatchHelper, workingThreads, ownedSessions, REPORT_WORK, SessionPublisher, SessionUploads, declareSyncMethods, CloudTurnOnFollower, declareTurnOnMethods, TURN_ON_POLL_MS, readBackfill, windowStart, installedReading, registerThreadHistoryTools, threadHistoryTools, type Conversations } from "./conversations/index.js"
import { openTools, startConversationMcp, watchPluginChanges, declareToolMethods, type ConversationMcp } from "./tools/index.js"
import { declareGitMethods, hostGit } from "./git/index.js"
import { declareMediaMethods, registerShowTool, TurnMedia } from "./media/index.js"
import { SHOW_MEDIA_LINE } from "@mako/sessions/turn-media"
import type { TerminalClients } from "./terminals/index.js"
import { declareApplicationMethods, Updates, type Application } from "./application/index.js"
import { devHostBuildDirectories } from "./base/dev-host-build.js"
import type { HostOwner } from "./create-host.js"

type WebHost = Awaited<ReturnType<typeof startWebHost>>

/** How often held messages are checked for their time; a wake lands at most this late. */
const HELD_WAKE_TICK_MS = 15_000

/** What the host gives its core: the socket, the method table, and the domains that load on their own. */
export interface CoreShell {
  config: HostConfig
  /** On a cloud machine: asks its agent to make the Thread's folder again, false where it can't be asked. */
  retryMachineWorkspace?(): boolean
  /** On a cloud machine: asks its agent to place the project's carried files from the account's store again, and waits. */
  refreshMachineCarried?(): Promise<void>
  owner: HostOwner
  methods: HostMethods
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
  machineWorkspaceFailed(problem: string): void
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
  movers?: WorkspaceMovers
  agentServers?: ConversationMcp
  controlService?: ControlService
  cloud?: CloudAccount
  cloudConversations?: CloudConversations
  cloudReturns?: CloudReturns
  /** The worktrees here of Threads that run in the cloud, following them at each turn's end. */
  cloudFollow?: CloudFollow
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
  /** Turning the cloud on, as one line: told when what it reads changes. */
  turnOn?: CloudTurnOnFollower
}

export async function openCore(shell: CoreShell): Promise<Core> {
  const { config, owner, methods, jobs, secrets } = shell
  const { environment, fixtureDesk } = config
  const { crashes } = owner
  const web = () => shell.web()
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
  /** On a cloud machine: the Thread's folder its agent makes, asked for again by a move that finds it unmade. */
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
    if (event.type === "threads" || event.type === "thread-ref") late.conversations?.live.discoverNativePaths()
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
    // A conversation another device watches goes to it as it changes (`SessionPublisher`), and its row may change.
    late.sessions?.own(event)
    // A Session archived here leaves the account's list on every device: its owner's word is the one that counts.
    if (event.type === "thread-archives") late.sessions?.changed()
    // The account and the agents' sign-ins say each change here; turning the cloud on reads them again then.
    if (event.type === "cloud-account" || event.type === "cloud-sign-ins") void late.turnOn?.changed()
    web()?.event(event, client)
  }
  const previews = new ArtifactPreviews(() => providerHost.artifactPreviews.list())
  const conversationFiles = new ConversationFiles(git, previews)
  const watchBackend = childBackend()
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
  const control = openControl(config, machine, shell.jobs, emit, () => late.updates?.desktopChanged())
  const appUpdates = new Updates({
    environment,
    git,
    emit,
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
  const conversationsIn = (path: string, status: (value: string) => boolean) => (late.conversations?.live.summaries() ?? [])
    .filter(({ session }) => status(session.status) && (session.cwd === path || session.cwd.startsWith(`${path}/`)))
    .map(({ session }) => `“${session.title || "Untitled conversation"}”`)
  // A terminal daemon outlives the host, so a folder's shells are asked of it even before a window opens a terminal.
  const shellsIn = async (path: string) => (await (await shell.terminals.load("a folder's open shells")).runningShells().catch(() => []))
    .filter((terminal) => terminal.cwd === path || terminal.cwd.startsWith(`${path}/`))
    .map((terminal) => `the terminal “${terminal.title}”`)
  const workspaces = openWorkspaces({
    git,
    dataRoot: environment.dataRoot,
    recipes,
    // A recipe runs as its place says: a cloud machine's host is started by the machine's agent.
    where: { place: config.machineAgentFd === undefined ? "local" : "cloud", platform: onMac() ? "mac" : hostPlatform() === "linux" ? "linux" : "other" },
    readOnly: fixtureDesk,
    store,
    jobs,
    emit,
    inUse: async (path) => [...conversationsIn(path, (status) => status !== "closed"), ...await shellsIn(path)],
    working: async (path) => conversationsIn(path, (status) => status === "running"),
    conversations: checkoutConversations({
      summaries: () => late.conversations?.live.summaries() ?? [],
      relocation: (id) => late.conversations?.live.relocation(id) ?? { kind: "never", reason: "isn't open" },
      relocate: async (id, cwd) => late.conversations?.live.relocate(id, cwd),
    }, shellsIn),
    cleanup: (path) => late.movers?.appTools?.cleanup(path),
    ledger: () => late.attribution,
  })
  // Who changed what in every checkout a Thread works in. It catches up on its own, after the host is up.
  const unfollowEffects = fixtureDesk ? undefined : liveToolEffects.subscribe((reported) => late.attribution?.effects(reported.conversation, reported.call))
  const unfollowBounds = fixtureDesk ? undefined : liveCallBounds.subscribe((bounds) => late.attribution?.bounds(bounds))
  if (!fixtureDesk) void openAttribution({
    dataRoot: environment.dataRoot,
    userRoot: environment.userRoot,
    defaultDataRoot: environment.defaultDataRoot,
    label: environment.profile ? `${environment.appName} (${environment.profile})` : environment.appName,
    git,
    watch: (root, changed, gone, dropped) => watchTree(git, watchBackend, root, changed, gone, dropped),
    history: workspaces.fileHistory,
    watchGitDir: (folder, moved) => watchOutsideGitDir(folder, moved),
    jobs,
    stores: () => harnessStores(catalog.list().map((ref) => ref.path)),
    children: catalog.childSource,
    catalogued: () => catalog.list(),
    running: () => catalog.activity(),
    placement: (conversation) => store?.journalPlacement(conversation),
    session: (conversation) => {
      const live = late.conversations?.live
      const session = live?.session(conversation)
      return session && { cwd: session.cwd, harness: session.harness, record: live?.snapshot(conversation)?.threadPath ?? undefined }
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
    web()?.terminal({ type: "wake" })
    late.cloud?.wake()
    late.cloudConversations?.wake()
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
  const sessions = new SessionPublisher({
    rows: () => {
      const live = late.conversations?.live
      const store = threads.store
      // Until the catalog's first discovery is in, its rows would say this Mac has no sessions but Mako's own.
      if (!live || !store || !catalog.ready()) return undefined
      const activity = catalog.activity()
      return ownedSessions({
        summaries: () => live.summaries(),
        native: () => (windowRows ??= catalog.recent(windowStart(Date.now()))),
        activity: (path) => activity[path],
        work: () => application.lifecycle.snapshot().work,
        waitingOn: (id) => live.waitingOn(id),
        hidden: () => new Set(threads.archives.snapshot().keys),
        lastMoved: (id, revision) => live.lastMoved(id, revision),
        placement: (id) => store.journalPlacement(id),
        executions: (ids) => store.executionsOf(ids),
        titles: (ids) => store.titlesOf(ids),
        now: Date.now,
      })
    },
    // A change goes to the account within a fraction of a second, on the link this Mac serves then, named as the tick's
    // job is. A cloud machine's link is its machine runtime's, reported on its own tick.
    ...config.machineAgentFd === undefined && { reportNow: () => late.cloud?.reportSessions?.(), work: shell.work },
  })
  catalog.subscribe((event) => {
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
  // One reporter a link: a cloud machine's link is its machine runtime's, whose tick reports on it. This job, with the
  // account's link (none there), would make each second's report look like a new link's and work the list out again.
  if (config.machineAgentFd === undefined) shell.jobs.every(REPORT_WORK, 1_000, () => late.cloud?.reportSessions?.())
  // The heap, watched so a host filling up says who with while it still can: an out-of-memory report has no
  // JavaScript stack. The line names what memory holds and who read it in; the whole readout goes beside the log.
  const heap = new HeapWatch(readHeap, (change, level, reading) => {
    const memory = late.conversations?.live.residency().memory
    const mb = (bytes: number | undefined) => Math.round((bytes ?? 0) / 1_048_576)
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
  }
  declareSyncMethods(methods, uploads)
  late.cloud = declareCloudAccountMethods(methods, {
    sessions,
    signedFiles: (request) => withHostClient("gateway:files", () => readSignedFile(request, renditions)),
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
        takeWaiting: async (message) => {
          const store = threads.store
          const live = late.conversations?.live
          if (!store || !live || !catalog.ready()) return "later"
          const session = SessionIdSchema.safeParse(message.session)
          if (!session.success) return "not-mine"
          const execution = store.execution(session.data)
          if (execution && execution.state !== "here") return "not-mine"
          if (!live.summaries().some((summary) => summary.session.id === message.conversation)) {
            // A session a terminal ran, which Mako here hasn't opened: opened as the conversation the list named.
            const ref = (windowRows ??= catalog.recent(windowStart(Date.now()))).find((row) => row.sessionId === message.session)
            if (!ref) return "not-mine"
            await methods.invoke("mako:live-capture", [message.conversation, ref.path])
          }
          await methods.invoke("mako:live-prompt", [message.conversation, message.id, message.text, [], undefined])
          return "taken"
        },
        // Another device's Session while that device is off: read from the copy it keeps in the account.
        copies: {
          page: async (device, harness, nativeId, before, limit) => {
            const cloud = late.cloud
            return cloud ? catalog.copyPage(await cloud.deviceRecords(device), harness, nativeId, before, limit) : null
          },
          entry: async (device, harness, nativeId, id) => {
            const cloud = late.cloud
            return cloud ? catalog.copyEntry(await cloud.deviceRecords(device), harness, nativeId, id) : null
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
    streams,
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
    mcpSnapshot: (cwd) => tools.mcp.discover(cwd),
    tools: (bindingId, conversationId) => residency.tools(bindingId, conversationId),
    controlInstructions: (bindingId, conversationId) => {
      const launched = workspaces.environments?.launchedWith(conversationId)
      if (launched) void workspaces.processes?.touch(launched.app).catch(() => {})
      const session = control.sessions.get(bindingId)
      // A harness without instructions of its own hears how media reaches the person here (`makoInstructions`).
      const harness = late.conversations?.live.session(conversationId)?.harness
      const media = harness && !harnesses.host.liveDrivers.get(harness)?.makoInstructions ? SHOW_MEDIA_LINE : undefined
      return [session && controlLine(session), launched && threadEnvironmentInstructions(launched), media, ...(workspaces.worktrees?.notices(conversationId) ?? []), ...(late.cloudReturns?.notices(conversationId) ?? [])].filter((line) => line !== undefined)
    },
    revokeTools: (bindingId, conversationId) => residency.revoke(bindingId, conversationId),
    rewindWriters: (paths, since) => late.attribution?.rewindWriters(paths, since),
    suspendTools: (bindingId, conversationId) => residency.suspend(bindingId, conversationId),
    settled: (id) => {
      late.movers?.moves.settled(id)
      late.movers?.leaves.settled(id)
    },
    // Each turn's changes, counted by the attribution journal once it opens.
    turnLedger: () => {
      const attribution = late.attribution
      return attribution && {
        placement: (conversation) => threads.store?.journalPlacement(conversation),
        flushed: () => attribution.settled(),
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
  const { live, runs, native } = opened
  // A message held until a time (a usage limit's reset) sends itself within a tick of it, across restarts.
  jobs.every("held-wakes", HELD_WAKE_TICK_MS, () => void live.wakeDue(), { firstAfterMs: 2_000 })
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
  const cloudMoves = cloudConversations && new CloudMoves({
    folder: join(environment.dataRoot, "cloud", "moves"),
    git,
    account: () => late.cloud,
    threads: () => threads.store ?? undefined,
    moves: live.moves,
    snapshot: (id) => live.snapshot(id),
    checkout: (id) => workspaces.worktrees?.threadCheckout(id),
    // A Thread in the main checkout goes onto its own branch first, as the person's "Move to its own branch" does, its
    // companions following; its agent isn't told, since nothing starts a turn on the way to the cloud.
    ownBranch: async (id) => {
      const movers = late.movers
      const worktreeMoves = movers?.worktreeMoves
      if (!movers || !worktreeMoves) throw new Error("Worktrees need the Thread store, which didn't open.")
      const { moved, following } = await movers.moves.moveNow(id, () => worktreeMoves.carry(id, { lead: true, tell: false }))
      await following
      return moved.session.id
    },
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
    step: (conversationId, move, step) => emit({ type: "thread-move-step", conversationId, move, step }),
    newCloudThread: () => `t-${randomBytes(8).toString("hex")}`,
    ready: { take: (thread, folder, repository) => readinessOnce?.take(thread, folder, repository) ?? Promise.resolve(undefined) },
    carried: async (folder, why) => void (await carriedFiles?.sync(folder, why)),
    harnesses: harnessCheck,
  })
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
      leaving: (thread) => cloudMoves.leaving(thread),
      plan: (conversationId) => cloudMoves.readyPlan(conversationId),
      sendRecords: (link, paths) => catalog.sendRecords(link, paths),
      newCloudThread: () => `t-${randomBytes(8).toString("hex")}`,
    })
    readinessOnce = readiness
    shell.jobs.every("keep Threads at work ready to move", READY_EVERY_MS, () => readiness.refresh())
  }
  // The person's choice and their sign-in can change it; a minute is soon enough to start or stop listening.
  if (sleepHandOff) {
    void sleepHandOff.refresh()
    shell.jobs.every("watch whether to hand off on sleep", 60_000, () => sleepHandOff.refresh())
  }
  const workspaceAutomations = new Automations({
    git,
    watch: watchBackend,
    emit,
    launch: async (cwd, prompt) => {
      if (fixtureDesk) throw new Error("The fixture desk runs no automations")
      const resumable = new Set(nativeHarnesses(providerHost.nativeRunners))
      const profile = (await harnesses.profiles.all()).find((candidate) => candidate.available && resumable.has(candidate.id))
      if (!profile) throw new Error("No provider is available for this automation")
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
    emit,
    warn: (message, facts) => hostWarn("workspace", message, facts),
  })
  late.movers = workspaceMovers
  const history = threadHistoryTools({
    conversations: () => live.summaries(),
    snapshot: (id) => live.historySnapshot(id),
    store: () => threads.store,
    catalog: threads.catalog,
  })
  const turnMedia = new TurnMedia(join(environment.dataRoot, "media"))
  late.agentServers = await startConversationMcp(live, (bindingId, operation, signal) => control.sessions.request(bindingId, operation, signal), [
    ...workspaceMovers.agentTools,
    (server, conversationId) => registerThreadHistoryTools(server, history, conversationId),
    (server, conversationId) => registerShowTool(server, { media: turnMedia, cwd: (id) => live.session(id)?.cwd }, conversationId),
  ])
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
      liveSummaries: () => [...live.summaries().filter((summary) => !cloudConversations?.has(summary.session.id)), ...(cloudConversations?.summaries() ?? [])],
      archives: () => threads.archives.snapshot(),
      ready,
      withHost,
      platform: nodePlatform(),
      machine: () => machineOffer(machine),
      sourceRoot: config.development ? environment.appRoot : undefined,
      onWorkspaceChanged: (cwd) => workspaceAutomations.watch(cwd),
      elsewhere: async (conversation) => cloudConversations?.folder(conversation),
    },
    emit,
    machine,
  })
  declareAttributionMethods(methods, () => late.attribution)
  declareMediaMethods(methods, turnMedia)
  const helperRuns = new HelperRuns(helperRunsRoot(environment.dataRoot))
  declareGitMethods(methods, { worktrees: workspaces.worktrees, withHost, git, environment, secrets, recordHelperRun: helperRuns.record })
  declareHarnessMethods(methods, { harnesses, appRoot: environment.appRoot, workspace, emit })
  declareControlMethods(methods, control, environment.appRoot, config.executable)
  declareCloudControlPreviewMethods(methods, () => cloudConversations?.controlPreviews)
  declareToolMethods(methods, { tools, control, workspace, dataRoot: environment.dataRoot, machine })
  const usage = declareUsageMethods(methods, {
    dataRoot: environment.dataRoot,
    userRoot: environment.userRoot,
    worker: new URL("./usage-worker.js", import.meta.url),
    strictStores: fixtureDesk,
  })
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
  const application: Application = declareApplicationMethods(methods, {
    live,
    native,
    nativeRuns: { lifecycleWork: () => runs.lifecycleWork(), abort: (path, token) => runs.abort(path, token) },
    admission,
    updates: appUpdates,
    wake,
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
      if (channel === "mako:thread-move" && cloudMoves) {
        // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-move`'s schema before routing it.
        const [conversationId, move, handOff] = args as [string, string, ThreadHandOff | undefined]
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
    file: (request, client = "web") => withHostClient(client, () => readWindowFile(request, withHost, renditions)),
    signedFile: (request) => withHostClient("gateway:files", () => readSignedFile(request, renditions)),
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
    machineWorkspaceFailed: (problem) => machineWorkspace.failed(problem),
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
      jobs.stop()
      machineTracker?.saves.stop()
      unwatchSaves?.()
      unfollowEffects?.()
      unfollowBounds?.()
      await late.attribution?.close().catch((error: Error) => hostWarn("attribution", "the journal did not close cleanly", { error: error.message }))
      const callsDrained = methods.close()
      // The native launcher closes its own admission before anything it uses goes.
      const providersDrained = Promise.all([runs.stop(), harnesses.profiles.stop(), providerHost.discovery.stop()])
      void providersDrained.catch(() => {})
      git.close()
      application.dispose()
      shell.closeSocket()
      wake.stop()
      sleepHandOff?.stop()
      late.cloud?.stop()
      shell.terminals.current()?.dispose()
      plugins?.close()
      for (const build of builds) build.close()
      control.stop()
      files.stop()
      workspaceAutomations.stop()
      harnesses.updates.stop()
      catalog.stop()
      await Promise.all([callsDrained, providersDrained, telemetry.close(), usage.close()])
      await opened.stop()
      cloudConversations?.dispose()
      late.agentServers?.close()
      threads.close()
      workspaces.close()
      turnMedia.close()
      void workspaceClients.dispose()
      // What an owner left running ends with the host rather than outliving it; children that exited while stopping
      // have left the registry by now.
      await children.end()
      for (const stop of unfollow) stop()
      await Promise.all([unknown.flush(), mismatches.flush()])
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
