import { randomBytes } from "node:crypto"
import type { RuntimeListing } from "@mako/protocol/thread-listing"
import { recipesOverHttp } from "@mako/protocol/recipes-http"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { encodeRuntimeValue } from "./contracts/runtime-value.js"
import { githubRepositoryUrl, type ThreadHandOff } from "./contracts/cloud-threads.js"
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
import { cloudUrl } from "./base/build-identity.js"
import { NativeUnknown } from "./base/native-unknown.js"
import { StreamMismatches } from "./base/stream-mismatches.js"
import type { HostChannel } from "./contracts/host-call-inputs.js"
import { detachedSecrets, type HostSecretStore } from "./base/host-secrets.js"
import { declareAttributionMethods, harnessStores, openAttribution, type Attribution } from "./attribution/index.js"
import { resolveFilePreview, workspacePreviewPath, fileResponse, localFile, WorkspaceClients, Automations, childBackend, watchTree, watchOutsideGitDir, ConversationFiles, ArtifactPreviews, checkoutConversations, threadEnvironmentInstructions, openWorkspaces, openWorkspaceMovers, declareWorkspaceMethods, RecipeAccounts, answeredElsewhere, elsewhereRefusal, type HostPool, type AgentHost, type WorkspaceMovers } from "./workspaces/index.js"
import { hostClient, withHostClient } from "./base/host-client.js"
import { ProviderChildren, readMakoProcesses } from "./base/provider-children.js"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { makoRecords, streamsRoot } from "@mako/sessions/record-streams"
import { makoViews } from "@mako/sessions"
import { unreadCounts } from "@mako/sessions/unread-index"
import { watchWake } from "./base/wake.js"
import { declareTelemetryMethods, declareCloudAccountMethods, type CloudAccount, type MachineGatewayLink, MachineWorkspace, declareUsageMethods, HelperRuns, helperRunsRoot, spendWatch } from "./usage/index.js"
import { resolveHarnessTuning, nativeHarnesses, createHarnessHost, threadHarnesses, openHarnesses, declareHarnessMethods, liveToolEffects, installCloudSignIns, CloudSignInSync, type CloudSignInPlace, type PrefetchOutcome } from "./harnesses/index.js"
import type { CloudSignIn, CloudSignInInstall } from "./contracts/cloud-sign-ins.js"
import { machineOffer, presentMachine, processMachine } from "./base/machine.js"
import { hostPlatform, nodePlatform, onMac } from "./base/platform.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import { openThreads, declareThreadMethods, declareUnreadRecordMethods } from "./threads/index.js"
import { ControlResidency, controlLine, openControl, declareControlMethods, controlVideoMedia, type ControlService } from "./control/index.js"
import type { MediaHandler } from "@mako/protocol"
import { openConversations, declareConversationMethods, declareCloudControlPreviewMethods, CloudConversations, CloudHandOffs, CloudMoves, CloudReadiness, CloudReturns, READY_EVERY_MS, folderRepository, namedUuid, SleepHandOff, sleepWatchHelper, workingThreads, runtimeListing, installedReading, registerThreadHistoryTools, threadHistoryTools, type Conversations } from "./conversations/index.js"
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
  /** On a cloud machine: asks its agent to make the Thread's folder again, false where it can't be asked. */
  retryMachineWorkspace?(): boolean
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
  /** On a cloud machine: why its agent couldn't make the Thread's folder, for whatever needs it to say. */
  machineWorkspaceFailed(problem: string): void
  /** On a cloud machine: the live video of its previews its Threads' clients watch. */
  media: MediaHandler
  /**
   * On a cloud machine: the gateway it works through, as its agent linked it. Its records are kept in step with its
   * Thread's there (`ThreadCatalog.syncRecords`), and its project's recipe with the account's (`RecipeAccounts`).
   */
  machineLinked(link: MachineGatewayLink | null): Promise<void>
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
  /** On a cloud machine: its conversations, as the account's list shows them on every device. */
  listing(): RuntimeListing
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
  /** On a cloud machine, the gateway it's linked through; a laptop has none and reaches the account as itself. */
  let machineLink: MachineGatewayLink | null = null
  /** On a cloud machine: the Thread's folder its agent makes, asked for again by a move that finds it unmade. */
  const machineWorkspace = new MachineWorkspace(() => shell.retryMachineWorkspace?.() ?? false)
  /** On a cloud machine: the account's sign-ins as last installed here; undefined until the agent gave a set. */
  let machineSignIns: readonly CloudSignInInstall[] | undefined
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
  // Every host's record of the agents it starts, found through the session ledger, this host's own root always.
  const makoProcesses = () => readMakoProcesses([environment.dataRoot, ...threads.memory?.hostDataRoots() ?? []])
  const harnesses = openHarnesses({ host: providerHost, appRoot: environment.appRoot, catalog, live: () => late.conversations?.live, emit, jobs: shell.jobs, subscribed: shell.subscribed, makoProcesses })
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
        // Every tab showing that conversation's folder reads its Git again, on the machine.
        changed: (conversationId) => {
          for (const tab of workspaceClients.everyTab()) tab.elsewhereChanged(conversationId)
        },
        threads: () => threads.store ?? undefined,
        returning: (cloudThread) => late.cloudReturns?.returning(cloudThread) ?? false,
      })
  late.cloudConversations = cloudConversations
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
    mcpSnapshot: (cwd) => tools.mcp.discover(cwd),
    tools: (bindingId, conversationId) => residency.tools(bindingId, conversationId),
    controlInstructions: (bindingId, conversationId) => {
      const launched = workspaces.environments?.launchedWith(conversationId)
      if (launched) void workspaces.processes?.touch(launched.app).catch(() => {})
      const session = control.sessions.get(bindingId)
      return [session && controlLine(session), launched && threadEnvironmentInstructions(launched), ...(workspaces.worktrees?.notices(conversationId) ?? [])].filter((line) => line !== undefined)
    },
    revokeTools: (bindingId, conversationId) => residency.revoke(bindingId, conversationId),
    suspendTools: (bindingId, conversationId) => residency.suspend(bindingId, conversationId),
    settled: (id) => {
      late.movers?.moves.settled(id)
      late.movers?.leaves.settled(id)
    },
    admission,
  })
  late.conversations = opened
  const { live, runs, native } = opened
  /** Filled once the handoffs exist: the cloud Thread each Thread at work keeps ready, which its move takes. */
  let readinessOnce: CloudReadiness | undefined
  // A person's Mac moves its Threads to the cloud (`mako:thread-move`); a machine takes them (`mako:move-arrive`).
  const cloudMoves = cloudConversations && new CloudMoves({
    folder: join(environment.dataRoot, "cloud", "moves"),
    git,
    account: () => late.cloud,
    threads: () => threads.store ?? undefined,
    moves: live.moves,
    snapshot: (id) => live.snapshot(id),
    checkout: (id) => workspaces.worktrees?.threadCheckout(id),
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
  })
  void cloudMoves?.settle().catch((error: Error) => hostWarn("moves", "moves a stopped host left couldn't be settled", { error: error.message }))
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
    updateOffer: (harness) => harnesses.updates.restoreRuntime(harness).offer,
    cloud: cloudConversations,
    capture: async (conversationId, path) => void (await live.capture(conversationId, path)),
    step: (conversationId, move, step) => emit({ type: "thread-return-step", conversationId, move, step }),
  })
  late.cloudReturns = cloudReturns
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
  const workspaceMovers = openWorkspaceMovers({
    git,
    dataRoot: environment.dataRoot,
    workspaces,
    hasSecret: (name) => process.env[name] !== undefined,
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
  const helperRuns = new HelperRuns(helperRunsRoot(environment.dataRoot))
  declareGitMethods(methods, { worktrees: workspaces.worktrees, withHost, git, environment, secrets, recordHelperRun: helperRuns.record })
  declareHarnessMethods(methods, { harnesses, appRoot: environment.appRoot, workspace, emit })
  declareControlMethods(methods, control, environment.appRoot, config.executable)
  declareCloudControlPreviewMethods(methods, () => cloudConversations?.controlPreviews)
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
    ...(config.machineAgentFd !== undefined && {
      arrival: {
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
        label: (harness) => opened.harnessLabel(harness),
        scratch: join(environment.dataRoot, "moves"),
        ahead: new Map(),
      },
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
        if (answeredElsewhere(channel, args, tab.workspace)) return { handled: true, value: await elsewhere.call(channel, args) }
      }
      if (channel === "mako:thread-return" && cloudReturns) {
        // SAFETY: the dispatcher parsed this call's arguments with `mako:thread-return`'s schema before routing it.
        const [conversationId, move] = args as [string, string]
        return { handled: true, value: encodeRuntimeValue(await cloudReturns.bringBack(conversationId, move)) }
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
    machineWorkspaceFailed: (problem) => machineWorkspace.failed(problem),
    openMachineWorkspace: async (path) => {
      await workspaceClients.home(path)
      await workspaceAutomations.watch(path)
      machineWorkspace.opened(path)
    },
    media: controlVideoMedia(control.previews),
    activeWork: () => application.lifecycle.snapshot().work.length > 0,
    work: () => application.lifecycle.snapshot().work,
    listing: () => runtimeListing(late.conversations?.live.summaries() ?? [], application.lifecycle.snapshot().work),
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
      void workspaceClients.dispose()
      // Children that exited while stopping have left the registry by now.
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
