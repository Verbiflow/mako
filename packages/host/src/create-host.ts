import { rmSync } from "node:fs"
import { lstat, mkdir, unlink } from "node:fs/promises"
import { basename, dirname } from "node:path"
import type { HostConfig } from "./host-config.js"
import { HostMethods, runtimeInfo, startWebHost } from "./transport/index.js"
import { HostJobs, type JobDemand } from "./base/host-jobs.js"
import { HostDomains, hostDomainOptions, type Domain } from "./base/host-domains.js"
import { EventLoopWatch } from "./base/event-loop.js"
import type { HostLifecycle } from "./base/host-lifecycle.js"
import { hostLog } from "./base/host-log.js"
import { RUNTIME_PROTOCOL, type RuntimeInfo } from "./contracts/runtime.js"
import { hostChannelDomain, hostChannels, type HostChannel } from "./contracts/host-call-inputs.js"
import { isClientCall, socketCalls } from "./contracts/client-calls.js"
import { hostSecretStore, type SecretKeyHandover } from "./base/host-secrets.js"
import type { CrashReports } from "./base/crash.js"
import { IdleShutdown, PROFILE_HOST_IDLE_MS, activeHostLeases } from "./base/host-idle.js"
import type { TerminalClients } from "./terminals/index.js"
import type { Core } from "./core.js"

/** What runs the host: the process it belongs to. */
export interface HostOwner {
  /** The process's lifecycle, which stops the host once for a client, a signal or idleness. */
  lifecycle: Pick<HostLifecycle, "stop" | "running">
  /** The process's crash reports, which its handlers write and the host lists. */
  crashes: CrashReports
  /** Where the process keeps the lines the host logs. */
  logPath: string
}

export interface Host {
  /** Listens on the socket, then loads the domains every window uses. */
  start(): Promise<void>
  /** Everything the host holds, released once, in order. */
  stop(): Promise<void>
  /** The method table, for a caller in this process. */
  methods: HostMethods
  /** The host's recurring work, by name. */
  jobs: HostJobs
  /** The host's domains and how each loaded. */
  domains: HostDomains
  /** Its event loop, watched while it works. */
  loop: EventLoopWatch
}

/** The domains of packages/host/src the core builds together; each window uses them first. */
const CORE = ["threads", "conversations", "harnesses", "workspaces", "tools", "control", "git", "usage", "application"]

/**
 * The core's domains in the order they build on each other, each imported on
 * its own turn of the event loop before the core opens. Compiling and running
 * a module graph holds the loop, and the core's whole graph at once held it
 * for 170 ms, while `/health` and every other request waited. Importing does
 * nothing (`check-host-pure-import.mjs`), so this order only decides when
 * each module's code is read, never what it does.
 */
const CORE_IMPORTS = [
  () => import("./application/index.js"),
  () => import("./git/index.js"),
  () => import("./usage/index.js"),
  () => import("./control/index.js"),
  () => import("./tools/index.js"),
  () => import("./threads/index.js"),
  () => import("./workspaces/index.js"),
  () => import("./harnesses/index.js"),
  () => import("./conversations/index.js"),
]

/** How long a call waits for the domain that declares it before it fails. */
const DOMAIN_WAIT_MS = 30_000

/**
 * One host: its socket, its method table and its domains. The socket listens
 * first, having loaded only the transport; the domains a window uses load
 * right after, and the rest at their first call. A call to a domain that's
 * still loading waits for it. The host keeps no state outside what it builds
 * here, so a test can build one beside another.
 */
export function createHost(config: HostConfig, owner: HostOwner): Host {
  const { environment, fixtureDesk } = config
  const loop = new EventLoopWatch()
  const jobs = new HostJobs(loop)
  const subscribed = jobs.demand("a client is subscribed")
  const domains = new HostDomains(hostDomainOptions(), loop)
  const secrets = hostSecretStore(environment)
  let web: Awaited<ReturnType<typeof startWebHost>> | undefined
  let closing = false
  let socketClosed = false
  let stopped: Promise<void> | undefined

  const methods = new HostMethods({
    fixtureDesk,
    route: async (channel, args) => core.current()?.route(channel, args) ?? { handled: false },
    presentHistory: (value) => core.current()?.presentHistory(value) ?? value,
    breadcrumb: (note) => owner.crashes.breadcrumb(note),
    declaring: (channel) => declaring(channel),
    work: loop,
  })
  const terminals: Domain<TerminalClients> = domains.declare("terminals", {
    load: "on-demand",
    covers: ["terminals"],
    open: async () => {
      const { declareTerminalMethods, openTerminals } = await import("./terminals/index.js")
      const clients = openTerminals(environment, (event, client) => web?.terminal(event, client))
      declareTerminalMethods(methods, clients)
      return declared(clients, ["terminals"])
    },
  })
  const core: Domain<Core> = domains.declare("core", {
    load: "after-listen",
    covers: CORE,
    open: async () => {
      // A host stopping while the core imports leaves at the next domain: nothing is built until openCore.
      const stillStarting = () => {
        if (closing) throw new Error("The host stopped before its core loaded")
      }
      for (const load of CORE_IMPORTS) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        stillStarting()
        await load()
      }
      stillStarting()
      const { openCore } = await import("./core.js")
      const opened = await openCore({
        config, owner, methods, jobs, subscribed, secrets, terminals,
        web: () => web,
        closing: () => closing,
        closeSocket,
      })
      return declared(opened, CORE)
    },
  })
  const uncovered = [...new Set(hostChannels.flatMap((channel) => {
    const folder = hostChannelDomain(channel)
    return !isClientCall(channel) && (!folder || !domains.covering(folder)) ? [folder ?? channel] : []
  }))]
  if (uncovered.length) throw new Error(`No domain covers ${uncovered.join(", ")}, which declare host methods`)

  /** A domain's methods are all declared once it has loaded. */
  function declared<Service>(service: Service, covers: readonly string[]): Service {
    const missing = methods.undeclared().filter((channel) => covers.includes(hostChannelDomain(channel) ?? ""))
    if (missing.length) throw new Error(`Its methods ${missing.join(", ")} aren't declared`)
    return service
  }

  async function declaring(channel: HostChannel): Promise<void> {
    const folder = hostChannelDomain(channel)
    const name = folder ? domains.covering(folder) : undefined
    if (!name) throw new Error(`No domain declares ${channel}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Mako's ${name} domain is still loading after ${DOMAIN_WAIT_MS / 1000} s`)), DOMAIN_WAIT_MS)
      timer.unref()
    })
    try {
      await Promise.race([domains.load(name, channel), limit])
    } finally {
      clearTimeout(timer)
    }
  }

  function closeSocket(): void {
    if (socketClosed) return
    socketClosed = true
    web?.close()
    // The runtime directory is this host's alone; leaving it behind is how
    // fifty of them piled up in the temp folder.
    try {
      rmSync(dirname(config.socket), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  async function start(): Promise<void> {
    domains.accountModules()
    web = await listen(config, methods, fixtureDesk ? undefined : secrets.handover, { domains, jobs, subscribed, loop }, {
      file: async (request, client) => {
        const done = loop.begin("a file preview")
        try {
          return await (await core.load("a file preview")).file(request, client)
        } finally {
          done()
        }
      },
      disconnected: (client) => core.current()?.disconnected(client) ?? terminals.current()?.release(client),
      desktop: (request, response) => {
        void core.load("the desktop channel").then((loaded) => loaded.desktop(request, response), () => {
          if (!response.headersSent) response.writeHead(503).end()
        })
      },
    })
    trace("host listening")
    if (environment.profile) watchProfileHostIdle()
    void domains.afterListen().catch((error: Error) => {
      if (closing) return
      console.error(`Mako's host couldn't start: ${error.message}`)
      void owner.lifecycle.stop({ kind: "failed", error: error.stack ?? error.message })
    })
  }

  async function stop(): Promise<void> {
    closing = true
    try {
      // A core still loading is stopped once it has, so nothing it starts outlives the host.
      const loaded = await core.started()?.catch(() => undefined)
      if (loaded) return await loaded.stop()
      jobs.stop()
      const drained = methods.close()
      closeSocket()
      terminals.current()?.dispose()
      await drained
      hostLog("lifecycle", "stopped")
    } finally {
      loop.stop()
    }
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
      const loaded = core.current()
      const reasons = [
        !owner.lifecycle.running() && "stopping",
        !loaded && "starting",
        loaded?.lifecycleBlocked() && "lifecycle blocked",
        loaded?.activeWork() && "active work",
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
        void owner.lifecycle.stop({ kind: "idle" })
      },
    })
    jobs.every("profile host idle watch", 5_000, async () => {
      leases = (await activeHostLeases(dirname(config.socket))).length
      idle.tick()
    })
  }

  return {
    start,
    stop: () => (stopped ??= stop()),
    methods,
    jobs,
    domains,
    loop,
  }
}

const trace = (stage: string) => {
  if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-runtime]", stage)
}

interface ListenHandlers {
  file(request: Request, client?: string): Promise<Response>
  disconnected(client: string): void
  desktop: Parameters<typeof startWebHost>[7]
}

interface ListenParts {
  domains: HostDomains
  jobs: HostJobs
  subscribed: JobDemand
  loop: EventLoopWatch
}

/**
 * The private socket every client reaches this host on, once a stale one is
 * cleared away. Each event it sends keeps the event loop watched a moment,
 * since that's when an agent's output is decoded and a terminal's drawn.
 */
async function listen(config: HostConfig, methods: HostMethods, handover: SecretKeyHandover | undefined, { domains, jobs, subscribed, loop }: ListenParts, handlers: ListenHandlers) {
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
  const web = await startWebHost(
    socket,
    (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
    handlers.file,
    handlers.disconnected,
    () => ({ ...runtime, domains: domains.snapshot(), jobs: jobs.list(), eventLoop: loop.snapshot() }),
    (args, client) => methods.invokePreview(args, client),
    handover,
    handlers.desktop,
    jobs,
    subscribed
  )
  return {
    ...web,
    event: (...args: Parameters<typeof web.event>) => {
      loop.touch()
      web.event(...args)
    },
    conversationEvent: (...args: Parameters<typeof web.conversationEvent>) => {
      loop.touch()
      web.conversationEvent(...args)
    },
    terminal: (...args: Parameters<typeof web.terminal>) => {
      loop.touch()
      web.terminal(...args)
    },
  }
}
