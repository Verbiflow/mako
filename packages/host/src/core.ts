import { watch, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { hostLabel, type HostConfig } from "./host-config.js"
import type { HostMethods, RoutedCall, startWebHost } from "./transport/index.js"
import type { HostJobs, JobDemand } from "./base/host-jobs.js"
import type { Foreground } from "./base/foreground.js"
import { heavy } from "./base/heavy-packages.js"
import type { HostWork } from "./base/event-loop.js"
import { Admission } from "./base/admission.js"
import type { Domain } from "./base/host-domains.js"
import { hostLog, hostWarn, logsRoot } from "./base/host-log.js"
import { NativeUnknown } from "./base/native-unknown.js"
import { StreamMismatches } from "./base/stream-mismatches.js"
import type { HostChannel } from "./contracts/host-call-inputs.js"
import { detachedSecrets, type HostSecretStore } from "./base/host-secrets.js"
import { declareAttributionMethods, harnessStores, openAttribution, type Attribution } from "./attribution/index.js"
import { resolveFilePreview, workspacePreviewPath, fileResponse, localFile, WorkspaceClients, Automations, childBackend, watchTree, watchOutsideGitDir, ConversationFiles, ArtifactPreviews, checkoutConversations, threadEnvironmentInstructions, openWorkspaces, openWorkspaceMovers, declareWorkspaceMethods, type HostPool, type AgentHost, type WorkspaceMovers } from "./workspaces/index.js"
import { hostClient, withHostClient } from "./base/host-client.js"
import { ProviderChildren } from "./base/provider-children.js"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { makoRecords, streamsRoot } from "@mako/sessions/record-streams"
import { makoViews } from "@mako/sessions"
import { unreadCounts } from "@mako/sessions/unread-index"
import { watchWake } from "./base/wake.js"
import { declareTelemetryMethods, declareCloudAccountMethods, type CloudAccount, declareUsageMethods, HelperRuns, helperRunsRoot, spendWatch } from "./usage/index.js"
import { resolveHarnessTuning, nativeHarnesses, createHarnessHost, threadHarnesses, openHarnesses, declareHarnessMethods, liveToolEffects, installCloudSignIns, CloudSignInSync, type CloudSignInPlace, type PrefetchOutcome } from "./harnesses/index.js"
import type { CloudSignIn, CloudSignInInstall } from "./contracts/cloud-sign-ins.js"
import { machineOffer, presentMachine, processMachine } from "./base/machine.js"
import { nodePlatform } from "./base/platform.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import { openThreads, declareThreadMethods, declareUnreadRecordMethods } from "./threads/index.js"
import { controlLine, openControl, declareControlMethods, type ControlService } from "./control/index.js"
import { openConversations, declareConversationMethods, CloudConversations, folderRepository, registerThreadHistoryTools, threadHistoryTools, type Conversations } from "./conversations/index.js"
import { openTools, startConversationMcp, watchPluginChanges, declareToolMethods, type ConversationMcp } from "./tools/index.js"
import { declareGitMethods, hostGit } from "./git/index.js"
import type { TerminalClients } from "./terminals/index.js"
import { declareApplicationMethods, Updates, type Application } from "./application/index.js"
import { devHostBuildDirectories } from "./base/dev-host-build.js"
import type { HostOwner } from "./create-host.js"

type WebHost = Awaited<ReturnType<typeof startWebHost>>

/** What the host gives its core: the socket, the method table, and the domains that load on their own. */
export interface CoreShell {
  config: HostConfig
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
  file(request: Request, client?: string): Promise<Response>
  disconnected(client: string): void
  desktop: NonNullable<Parameters<typeof startWebHost>[7]>
  /** On a cloud machine: the sign-ins its agent was given, written where each harness reads them. */
  installCloudSignIns(signIns: readonly CloudSignIn[], place: CloudSignInPlace): Promise<CloudSignInInstall[]>
  /** On a cloud machine: loads what every start loads, before its image's snapshot; answers what it loaded. */
  warm(): Promise<string[]>
  /** On a cloud machine: the folder its agent prepared, where every client's tabs open. */
  openMachineWorkspace(path: string): Promise<void>
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
  lifecycleBlocked(): boolean
  /** Everything the core holds, released in order, with the socket and the terminals. */
  stop(): Promise<void>
}

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
  automations?: Automations
  updates?: Updates
  attribution?: Attribution
}

export async function openCore(shell: CoreShell): Promise<Core> {
  const { config, owner, methods, jobs, secrets } = shell
  const { environment, fixtureDesk } = config
  const { crashes } = owner
  const web = () => shell.web()
  const git = hostGit(config.gitTrace ?? false)
  const admission = new Admission()
  const machine = processMachine()
  const streams = streamsRoot(makoRecords())
  const providerHost = createHarnessHost({
    dataRoot: environment.dataRoot,
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
    if (event.type === "live-batch") late.attribution?.live(event.batch)
    web()?.event(event, client)
  }
  const previews = new ArtifactPreviews(() => providerHost.artifactPreviews.list())
  const conversationFiles = new ConversationFiles(git, previews)
  const watchBackend = childBackend()
  const workspaceClients = new WorkspaceClients(emit, { git, previews, watch: watchBackend })
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
    readFile: (cwd, path, dataDir) => conversationFiles.read(cwd, path, dataDir),
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
  const harnesses = openHarnesses({ host: providerHost, appRoot: environment.appRoot, catalog, live: () => late.conversations?.live, emit, jobs: shell.jobs, subscribed: shell.subscribed })
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
    else late.attribution = attribution
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
    unread: () => unreadCounts({ views: makoViews(), records: makoRecords() }).groups,
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
  declareUnreadRecordMethods(methods, { views: makoViews(), records: makoRecords(), live: () => unknown.kinds(), since: Date.now(), streams })
  late.cloud = declareCloudAccountMethods(methods, {
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
      })
  late.cloudConversations = cloudConversations
  void cloudConversations?.start().catch((error: Error) => hostWarn("cloud-conversations", "couldn't follow the cloud conversations", { error: error.message }))
  /** Each reason is told once per host; every failed start is still logged. */
  const controlUnavailableNotices = new Set<string>()
  const opened = await openConversations({
    streams,
    environment,
    git,
    threads,
    harnesses,
    workspaces,
    telemetry,
    emit,
    foreground: shell.foreground,
    mcpSnapshot: (cwd) => tools.mcp.discover(cwd),
    tools: async (bindingId, conversationId) => {
      const minted = late.agentServers?.mint(bindingId, conversationId)
      if (!minted) return undefined
      const browser = late.controlService?.mint(conversationId, bindingId)
      const started = await control.sessions.startOptional(bindingId, browser, async (reason) => {
        await late.controlService?.revoke(conversationId, bindingId)
        if (reason === "failed") emit({ type: "notice", level: "error", message: "Local Control stopped unexpectedly. Its browser access has ended; start a new task before continuing control." })
      })
      if ("launch" in started) return { ...minted, control: started.launch }
      await late.controlService?.revoke(conversationId, bindingId)
      if (!controlUnavailableNotices.has(started.unavailable)) {
        controlUnavailableNotices.add(started.unavailable)
        emit({ type: "notice", level: "error", message: started.unavailable })
      }
      return minted
    },
    controlInstructions: (bindingId, conversationId) => {
      const launched = workspaces.environments?.launchedWith(conversationId)
      if (launched) void workspaces.processes?.touch(launched.app).catch(() => {})
      const session = control.sessions.get(bindingId)
      return [session && controlLine(session), launched && threadEnvironmentInstructions(launched), ...(workspaces.worktrees?.notices(conversationId) ?? [])].filter((line) => line !== undefined)
    },
    revokeTools: async (bindingId, conversationId) => {
      late.agentServers?.revoke(bindingId, conversationId)
      await late.controlService?.revoke(conversationId, bindingId)
      await control.sessions.stop(bindingId)
    },
    settled: (id) => {
      late.movers?.moves.settled(id)
      late.movers?.leaves.settled(id)
    },
    admission,
  })
  late.conversations = opened
  const { live, runs, native } = opened
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
  const workspaceMovers = openWorkspaceMovers({
    git,
    dataRoot: environment.dataRoot,
    workspaces,
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
  late.agentServers = await startConversationMcp(live, (bindingId, operation, signal) => control.sessions.request(bindingId, operation, signal), [
    ...workspaceMovers.agentTools,
    (server, conversationId) => registerThreadHistoryTools(server, history, conversationId),
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
      liveSummaries: () => [...live.summaries(), ...(cloudConversations?.summaries() ?? [])],
      archives: () => threads.archives.snapshot(),
      ready,
      withHost,
      platform: nodePlatform(),
      machine: () => machineOffer(machine),
      sourceRoot: config.development ? environment.appRoot : undefined,
      onWorkspaceChanged: (cwd) => workspaceAutomations.watch(cwd),
    },
    emit,
    machine,
  })
  declareAttributionMethods(methods, () => late.attribution)
  const helperRuns = new HelperRuns(helperRunsRoot(environment.dataRoot))
  declareGitMethods(methods, { worktrees: workspaces.worktrees, withHost, git, environment, secrets, recordHelperRun: helperRuns.record })
  declareHarnessMethods(methods, { harnesses, appRoot: environment.appRoot, workspace, emit })
  declareControlMethods(methods, control, environment.appRoot, config.executable)
  declareToolMethods(methods, { tools, control, workspace, dataRoot: environment.dataRoot, machine })
  const usage = declareUsageMethods(methods, {
    dataRoot: environment.dataRoot,
    worker: new URL("./usage-worker.js", import.meta.url),
    strictStores: fixtureDesk,
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
      const cloud = await cloudConversations?.route(channel, args)
      return cloud?.handled ? cloud : opened.route(channel, args)
    },
    presentHistory: (value) => opened.history.present(value),
    file: (request, client = "web") => withHostClient(client, () => readFilePreview(request, withHost)),
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
      // What each harness can run as just changed: Settings and new Threads read it again, once no start is waiting.
      // A start reads its own harness's profile under its new sign-in itself. On a machine, sign-ins come as it
      // enrols, just before its first start, and every harness's discovery at once doubled that start (2026-10-20).
      void shell.foreground.idle().then(() => harnesses.profiles.all(true)).catch(() => undefined)
      return installed
    },
    prefetchStart: async (harness) => harnesses.host.liveDrivers.runAhead(harness, (await harnesses.tools.account(harness)).env, homedir()),
    prefetchSignedIn: async (harness) => harnesses.host.liveDrivers.signedInAhead(harness, (await harnesses.tools.account(harness)).env),
    /**
     * Every harness's MCP servers as a start in `path` reads them. Codex and Grok list theirs by running their CLIs,
     * 1.5 to 3.5 s on a copy (2026-10-20); a copy of a base made after this finds the listing in its host's memory,
     * kept while nothing either CLI reads has changed.
     */
    prepareFolder: async (path) => {
      await tools.mcp.discover(path)
    },
    openMachineWorkspace: async (path) => {
      await workspaceClients.home(path)
      await workspaceAutomations.watch(path)
    },
    activeWork: () => application.lifecycle.snapshot().work.length > 0,
    work: () => application.lifecycle.snapshot().work,
    lifecycleBlocked: () => application.lifecycle.blocked,
    async stop() {
      jobs.stop()
      unfollowEffects?.()
      await late.attribution?.close().catch((error: Error) => hostWarn("attribution", "the journal did not close cleanly", { error: error.message }))
      const callsDrained = methods.close()
      // The native launcher closes its own admission before anything it uses goes.
      const providersDrained = Promise.all([runs.stop(), harnesses.profiles.stop()])
      void providersDrained.catch(() => {})
      git.close()
      application.dispose()
      shell.closeSocket()
      wake.stop()
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
      void workspaceClients.dispose()
      // Children that exited while stopping have left the registry by now.
      for (const stop of unfollow) stop()
      await Promise.all([unknown.flush(), mismatches.flush()])
      hostLog("lifecycle", "stopped")
    },
  }
}

async function readFilePreview(request: Request, withHost: <T>(run: (host: AgentHost) => T | Promise<T>) => Promise<T>): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
  const artifact = resolveFilePreview(request.url)
  if (artifact) return fileResponse(await localFile(artifact, request.signal), artifact, request)
  const path = workspacePreviewPath(request.url)
  if (!path) return new Response("Not found", { status: 404 })
  try {
    return await withHost(async (host) => {
      const absolute = await host.resolvePath(path)
      return fileResponse(await localFile(absolute, request.signal), absolute, request)
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
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
