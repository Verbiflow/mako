import { watch, rmSync, type FSWatcher } from "node:fs"
import { lstat, mkdir, unlink } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { hostLabel, type HostConfig } from "./host-config.js"
import { HostMethods, runtimeInfo, startWebHost } from "./transport/index.js"
import { HostJobs } from "./base/host-jobs.js"
import { Admission } from "./base/admission.js"
import type { HostLifecycle } from "./base/host-lifecycle.js"
import { flushHostLog, hostLog, hostWarn } from "./base/host-log.js"
import { RUNTIME_PROTOCOL, type RuntimeInfo } from "./contracts/runtime.js"
import { hostChannels } from "./contracts/host-call-inputs.js"
import { socketCalls } from "./contracts/client-calls.js"
import { hostSecretKeyHandover } from "./base/host-secrets.js"
import { resolveFilePreview, workspacePreviewPath, fileResponse, localFile, WorkspaceClients, Automations, childBackend, ConversationFiles, ArtifactPreviews, threadEnvironmentInstructions, openWorkspaces, openWorkspaceMovers, declareWorkspaceMethods, type HostPool, type AgentHost, type WorkspaceMovers } from "./workspaces/index.js"
import { hostClient, withHostClient } from "./base/host-client.js"
import { IdleShutdown, PROFILE_HOST_IDLE_MS, activeHostLeases } from "./base/host-idle.js"
import { installProviderChildren } from "./base/provider-children.js"
import { closeRepositories } from "@mako/git"
import { watchWake } from "./base/wake.js"
import { declareTelemetryMethods, declareCloudAccountMethods, type CloudAccount, declareUsageMethods, spendWatch } from "./usage/index.js"
import { resolveHarnessTuning, nativeHarnesses, createHarnessHost, threadHarnesses, openHarnesses, declareHarnessMethods } from "./harnesses/index.js"
import { machineOffer, hostMachine } from "./base/machine.js"
import { nodePlatform } from "./base/platform.js"
import type { HostEvent } from "./contracts/host-events-boot.js"
import { openThreads, declareThreadMethods } from "./threads/index.js"
import { controlLine, openControl, declareControlMethods, type ControlService } from "./control/index.js"
import { openConversations, declareConversationMethods, type Conversations } from "./conversations/index.js"
import { openTools, startConversationMcp, watchPluginChanges, declareToolMethods, type ConversationMcp } from "./tools/index.js"
import { declareGitMethods } from "./git/index.js"
import { openTerminals, declareTerminalMethods } from "./terminals/index.js"
import { declareApplicationMethods, devHostBuildDirectories, Updates, type Application } from "./application/index.js"

/** What runs the host: the process's lifecycle, which stops it once for a client, a signal or idleness. */
export type HostOwner = Pick<HostLifecycle, "stop" | "running">

export interface Host {
  /** Builds every domain in dependency order, then listens on the socket. */
  start(): Promise<void>
  /** Everything the host holds, released once, in order. */
  stop(): Promise<void>
  /** The method table, for a caller in this process. */
  methods: HostMethods
  /** The host's recurring work, by name. */
  jobs: HostJobs
}

const trace = (stage: string) => {
  if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-runtime]", stage)
}

/**
 * One host: its domains, its method table and its socket. It keeps no state
 * outside what it builds here, so a test can build one beside another.
 */
export function createHost(config: HostConfig, owner: HostOwner): Host {
  const { environment, fixtureDesk } = config
  const jobs = new HostJobs()
  const admission = new Admission()
  const providerHost = createHarnessHost()
  /** Set when stopping begins; events stop going out from then on. */
  let closing = false
  // Made during `start`, in this order; reached before then only through `?.`, as a caller that came early.
  let web: Awaited<ReturnType<typeof startWebHost>> | undefined
  let conversations: Conversations | undefined
  let movers: WorkspaceMovers | undefined
  let agentServers: ConversationMcp | undefined
  let controlService: ControlService | undefined
  let cloud: CloudAccount | undefined
  let application: Application | undefined
  let updates: Updates | undefined
  let automations: Automations | undefined
  let stopping: (() => Promise<void>) | undefined

  const methods = new HostMethods({
    fixtureDesk,
    route: async (channel, args) => conversations ? conversations.route(channel, args) : { handled: false },
    presentHistory: (value) => conversations ? conversations.history.present(value) : value,
  })
  const spent = spendWatch((id) => conversations?.live.session(id)?.harness, (harness) => providerHost.accounts.usage.spent(harness))
  function emit(event: HostEvent, client?: string): void {
    if (closing) return
    const limits = spent(event)
    if (limits) emit(limits)
    if (event.type === "threads" || event.type === "thread-ref") conversations?.live.discoverNativePaths()
    if (event.type === "thread-run" && event.run.status !== "running") conversations?.native.ready(event.run.path)
    // Git status is recomputed after every turn and on focus, which is exactly
    // when HEAD could have moved — so the commit trigger rides on it rather than
    // running a watcher of its own.
    // Selecting a child repository is not a commit in the parent workspace.
    if (event.type === "git" && !event.git.repositories?.length) automations?.noticeHead(event.git.head)
    web?.event(event, client)
  }
  const previews = new ArtifactPreviews(() => providerHost.artifactPreviews.list())
  const conversationFiles = new ConversationFiles(previews)
  const watch = childBackend()
  const workspaceClients = new WorkspaceClients(emit, { previews, watch })
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

  async function start(): Promise<void> {
    trace("host ready")
    // Agents an earlier host left running are ended before this one starts any.
    const children = installProviderChildren(environment.dataRoot)
    await children.reap().catch((error) => {
      hostWarn("children", "reap failed", { error: error instanceof Error ? error.message : String(error) })
    })
    const threads = openThreads({
      dataRoot: environment.dataRoot,
      appData: environment.appData,
      readOnly: fixtureDesk,
      ledger: {
        pid: process.pid,
        startedAt: Math.round(performance.timeOrigin),
        label: hostLabel(config),
        socket: config.socket,
        launch: {
          dataRoot: environment.dataRoot, executable: config.executable,
          args: environment.packaged ? [] : [environment.appRoot], cwd: process.cwd(), profile: environment.profile,
        },
      },
      harnesses: threadHarnesses(providerHost),
      readFile: (cwd, path, dataDir) => conversationFiles.read(cwd, path, dataDir),
      emit,
    })
    const { catalog, store } = threads
    const control = openControl(config, emit, () => updates?.desktopChanged())
    updates = new Updates({
      environment,
      emit,
      desktop: {
        state: () => control.desktop.update(),
        check: () => control.desktop.ask("update-check", {}),
        install: () => control.desktop.ask("update-install", {}).then(() => {}),
      },
    })
    const harnesses = openHarnesses({ host: providerHost, appRoot: environment.appRoot, catalog, live: () => conversations?.live, emit })
    const tools = openTools(harnesses.tools)
    const conversationsIn = (path: string, status: (value: string) => boolean) => (conversations?.live.summaries() ?? [])
      .filter(({ session }) => status(session.status) && (session.cwd === path || session.cwd.startsWith(`${path}/`)))
      .map(({ session }) => `“${session.title || "Untitled conversation"}”`)
    const terminals = openTerminals(environment.dataRoot, (event, client) => web?.terminal(event, client))
    const workspaces = openWorkspaces({
      dataRoot: environment.dataRoot,
      readOnly: fixtureDesk,
      store,
      jobs,
      emit,
      inUse: async (path) => {
        const shells = (await terminals.runningShells().catch(() => []))
          .filter((shell) => shell.cwd === path || shell.cwd.startsWith(`${path}/`))
          .map((shell) => `the terminal “${shell.title}”`)
        return [...conversationsIn(path, (status) => status !== "closed"), ...shells]
      },
      working: async (path) => conversationsIn(path, (status) => status === "running"),
      cleanup: (path) => movers?.appTools?.cleanup(path),
    })
    const wake = watchWake((source) => {
      hostLog("host", "woke", { source })
      web?.terminal({ type: "wake" })
      cloud?.wake()
    })
    const telemetry = await declareTelemetryMethods(methods, {
      fixture: fixtureDesk,
      token: () => cloud?.token() ?? Promise.resolve(undefined),
      account: () => cloud?.id() ?? Promise.resolve(undefined),
      attended: () => (web?.clients().length ?? 0) > 0,
      inventory: async () => ({
        harnesses: (await harnesses.profiles.all()).filter((profile) => profile.available).map((profile) => profile.id),
        runtimes: harnesses.updates.snapshot(),
        threads: catalog.list().length,
      }),
    })
    cloud = declareCloudAccountMethods(methods, {
      emit,
      fixture: fixtureDesk,
      signedIn: () => void telemetry.signedIn(),
      request: (call) => telemetry.cloudRequest(call),
    })
    /** Each reason is told once per host; every failed start is still logged. */
    const controlUnavailableNotices = new Set<string>()
    conversations = await openConversations({
      environment,
      threads,
      harnesses,
      workspaces,
      telemetry,
      emit,
      mcpSnapshot: (cwd) => tools.mcp.discover(cwd),
      tools: async (bindingId, conversationId) => {
        const minted = agentServers?.mint(bindingId, conversationId)
        if (!minted) return undefined
        const browser = controlService?.mint(conversationId, bindingId)
        const started = await control.sessions.startOptional(bindingId, browser, async (reason) => {
          await controlService?.revoke(conversationId, bindingId)
          if (reason === "failed") emit({ type: "notice", level: "error", message: "Local Control stopped unexpectedly. Its browser access has ended; start a new task before continuing control." })
        })
        if ("launch" in started) return { ...minted, control: started.launch }
        await controlService?.revoke(conversationId, bindingId)
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
        return [session && controlLine(session), launched && threadEnvironmentInstructions(launched)].filter((line) => line !== undefined)
      },
      revokeTools: async (bindingId, conversationId) => {
        agentServers?.revoke(bindingId, conversationId)
        await controlService?.revoke(conversationId, bindingId)
        await control.sessions.stop(bindingId)
      },
      settled: (id) => movers?.moves.settled(id),
      admission,
    })
    const { live, runs, native } = conversations
    const workspaceAutomations = new Automations({
      watch,
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
    automations = workspaceAutomations
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
    movers = openWorkspaceMovers({
      dataRoot: environment.dataRoot,
      workspaces,
      live,
      store,
      lifecycle,
      launch: (harness, cwd, tuning) => harnesses.profiles.resolveLaunch(harness, cwd, tuning),
      checkWaitMs: (harness) => harnesses.tools.mcpSources.get(harness)?.callWaitMs,
      emit,
      warn: (message, facts) => hostWarn("workspace", message, facts),
    })
    agentServers = await startConversationMcp(live, (bindingId, operation, signal) => control.sessions.request(bindingId, operation, signal), movers.agentTools)
    trace("conversation tools ready")
    controlService = await control.startService((conversationId, bindingId) => live.authorizeAgent(conversationId, bindingId))

    const files = declareWorkspaceMethods(methods, {
      workspaces,
      movers,
      live,
      automations: workspaceAutomations,
      withHost,
      session: {
        liveSummaries: () => live.summaries(),
        archives: () => threads.archives.snapshot(),
        ready,
        withHost,
        platform: nodePlatform(),
        machine: () => machineOffer(hostMachine()),
        sourceRoot: config.development ? environment.appRoot : undefined,
        onWorkspaceChanged: (cwd) => workspaceAutomations.watch(cwd),
      },
      emit,
    })
    declareGitMethods(methods, { worktrees: workspaces.worktrees, withHost })
    declareHarnessMethods(methods, { harnesses, appRoot: environment.appRoot, workspace, emit })
    declareControlMethods(methods, control, environment.appRoot, config.executable)
    declareToolMethods(methods, { tools, control, workspace })
    declareTerminalMethods(methods, terminals)
    const usage = declareUsageMethods(methods, {
      dataRoot: environment.dataRoot,
      worker: new URL("./usage-worker.js", import.meta.url),
    })
    declareConversationMethods(methods, {
      conversations,
      profiles: harnesses.profiles,
      threads,
      workspaces,
      movers,
      lifecycle,
      telemetry,
      files: conversationFiles,
      invoke: (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
      workspace,
      emit,
    })
    application = declareApplicationMethods(methods, {
      live,
      native,
      nativeRuns: { lifecycleWork: () => runs.lifecycleWork(), abort: (path, token) => runs.abort(path, token) },
      admission,
      updates,
      wake,
      emit,
      clients: () => web?.clients() ?? [],
      finish: (action, install) => {
        install?.()
        void owner.stop({ kind: "request", action })
      },
    })
    const undeclared = methods.undeclared()
    if (undeclared.length) throw new Error(`No domain declares ${undeclared.join(", ")}`)
    conversations.share((event) => {
      if (!closing) web?.conversationEvent(event)
    })

    web = await listen(config, methods, {
      file: (request, client = "web") => withHostClient(client, () => readFilePreview(request, withHost)),
      disconnected: (client) => {
        terminals.release(client)
        void workspaceClients.release(client)
      },
      desktop: (request, response) => control.desktop.attach(request, response),
    })
    trace("host listening")
    if (environment.profile) watchProfileHostIdle()
    const plugins = fixtureDesk ? null : watchPluginChanges(emit)
    const builds = config.development ? watchOwnBuild(devHostBuildDirectories(environment.appRoot), emit) : []
    updates.start()
    trace("updates ready")
    catalog.start()
    trace("catalog starting")
    // The last host's readings paint first; this host's own run a few seconds
    // behind startup, and hourly for the public versions.
    await harnesses.updates.load()
    if (!fixtureDesk) harnesses.updates.start()
    void ready().then((live) => workspaceAutomations.watch(live.active.workspace))
    void telemetry.started(performance.now())

    stopping = async () => {
      closing = true
      jobs.stop()
      const callsDrained = methods.close()
      // The native launcher closes its own admission before anything it uses goes.
      const providersDrained = Promise.all([runs.stop(), harnesses.profiles.stop()])
      void providersDrained.catch(() => {})
      closeRepositories()
      application?.dispose()
      web?.close()
      // The runtime directory is this host's alone; leaving it behind is how
      // fifty of them piled up in the temp folder.
      try {
        rmSync(dirname(config.socket), { recursive: true, force: true })
      } catch {
        /* best effort */
      }
      wake.stop()
      cloud?.stop()
      terminals.dispose()
      plugins?.close()
      for (const build of builds) build.close()
      control.stop()
      files.stop()
      workspaceAutomations.stop()
      harnesses.updates.stop()
      catalog.stop()
      await Promise.all([callsDrained, providersDrained, telemetry.close(), usage.close()])
      await conversations?.stop()
      agentServers?.close()
      threads.close()
      workspaces.close()
      void workspaceClients.dispose()
      hostLog("lifecycle", "stopped")
      await flushHostLog()
    }
  }

  function hasActiveWork(): boolean {
    return application
      ? application.lifecycle.snapshot().work.length > 0
      : Boolean(
          conversations?.live.hasActiveWork() ||
          conversations?.native.list().some((request) => request.status === "dispatching" || request.status === "queued")
        )
  }

  /**
   * A profile host (dev, sandbox, test) stops itself soon after nothing holds
   * it: no client, no launcher lease, no work. The installed app's host on the
   * default profile never does: it is the product and outlives every window.
   * What holds it is logged whenever that changes, so a host that stays up says
   * why.
   */
  function watchProfileHostIdle(): void {
    let leases = 0
    let held: string | null = null
    const holds = () => {
      const clients = web?.clients().length ?? 0
      const reasons = [
        !owner.running() && "stopping",
        application?.lifecycle.blocked && "lifecycle blocked",
        hasActiveWork() && "active work",
        clients > 0 && `${clients} client${clients === 1 ? "" : "s"}`,
        leases > 0 && `${leases} launcher lease${leases === 1 ? "" : "s"}`,
      ].filter(Boolean)
      const now = reasons.join(", ") || "nothing"
      if (now !== held) {
        held = now
        hostLog("lifecycle", "idle watch", { holds: now })
      }
      return reasons.length > 0
    }
    const idle = new IdleShutdown({
      idleMs: PROFILE_HOST_IDLE_MS,
      now: () => Date.now(),
      busy: holds,
      quit: () => {
        hostLog("lifecycle", "idle; stopping", { profile: environment.profile, idleSeconds: PROFILE_HOST_IDLE_MS / 1000 })
        void owner.stop({ kind: "idle" })
      },
    })
    jobs.every("profile host idle watch", 5_000, async () => {
      leases = (await activeHostLeases(dirname(config.socket))).length
      idle.tick()
    })
  }

  return {
    start,
    async stop() {
      if (stopping) await stopping()
      else {
        closing = true
        jobs.stop()
        await methods.close()
      }
    },
    methods,
    jobs,
  }
}

interface ListenHandlers {
  file(request: Request, client?: string): Promise<Response>
  disconnected(client: string): void
  desktop: Parameters<typeof startWebHost>[7]
}

/** The private socket every client reaches this host on, once a stale one is cleared away. */
async function listen(config: HostConfig, methods: HostMethods, handlers: ListenHandlers) {
  const { socket, environment } = config
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  const stale = await lstat(socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (stale) {
    if (!stale.isSocket() || (process.getuid && stale.uid !== process.getuid()) || (await runtimeInfo(socket)))
      throw new Error("The shared host socket is already owned")
    await unlink(socket)
  }
  const runtime: RuntimeInfo = {
    protocol: RUNTIME_PROTOCOL,
    instanceId: crypto.randomUUID(),
    storageScope: basename(dirname(socket)),
    pid: process.pid,
    version: environment.version,
    devBuild: config.development?.build,
    methods: socketCalls(hostChannels),
    previewSizing: true,
  }
  if (config.fixtureDesk) runtime.fixture = true
  return startWebHost(
    socket,
    (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
    handlers.file,
    handlers.disconnected,
    runtime,
    (args, client) => methods.invokePreview(args, client),
    config.fixtureDesk ? undefined : hostSecretKeyHandover(),
    handlers.desktop
  )
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
