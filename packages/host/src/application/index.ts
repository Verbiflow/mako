import { WindowShutdown } from "./window-shutdown.js"
import { ApplicationLifecycle } from "./lifecycle.js"
import type { Admission } from "../base/admission.js"
import {
  LifecycleCommandSchema,
  type LifecycleCommand,
  type LifecycleAction,
  type LifecycleWork,
} from "../contracts/app-lifecycle.js"
import type { Updates } from "./updates.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { hostClient } from "../base/host-client.js"
import type { MethodTable } from "../base/methods.js"
import type { CrashReports } from "../base/crash.js"
import type { WakeWatch } from "../base/wake.js"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"

export { Updates, type DesktopUpdater } from "./updates.js"
export { packagedDistribution } from "./distribution.js"
export { MAKO_BUNDLE_ID, type MAKO_GRANT_SERVICES, desktopLaunchEnvironment, hostReplacementPending } from "./local-update-installer.js"

/** The live conversations, as a quit, restart or install waits for and stops them. */
export interface LiveWork {
  lifecycleWork(): LifecycleWork[]
  /** Ends these conversations, or all of them, so the host can leave. */
  closeForExit(ids?: string[]): Promise<void>
}

/** Queued replies to native sessions; none starts once the host is stopping. */
export interface NativeQueue {
  lifecycleWork(): LifecycleWork[]
  pauseQueued(): void
}

/** Headless native runs, each stopped by its id and the token it was started with. */
export interface NativeRuns {
  lifecycleWork(): LifecycleWork[]
  abort(path: string, token: string): void
}

export interface ApplicationDependencies {
  live: LiveWork
  native: NativeQueue
  nativeRuns: NativeRuns
  /** Closed while the lifecycle stops the host's agents. */
  admission: Admission
  updates: Updates
  emit(event: HostEvent): void
  clients(): string[]
  /** Stops this host for a client's quit, restart or update, once its work allows. */
  finish(action: LifecycleAction, install?: () => void): void
  wake: WakeWatch
  jobs: HostJobs
  /** On while any client is subscribed to events; the lifecycle is published only to subscribers. */
  subscribed: JobDemand
  crashes: CrashReports
  /** The process's log, which Settings → Diagnostics reveals. */
  logPath: string
}

export type Application = ReturnType<typeof declareApplicationMethods>

/** The host's own lifecycle, its updates and its crashes. */
export function declareApplicationMethods(methods: MethodTable, dependencies: ApplicationDependencies) {
  const { updates } = dependencies
  const shutdown = new WindowShutdown()
  const work = (): LifecycleWork[] => [
    ...dependencies.live.lifecycleWork(),
    ...dependencies.nativeRuns.lifecycleWork(),
    ...dependencies.native.lifecycleWork(),
    ...(updates.building
      ? [
          {
            id: "local-build",
            token: "local-build",
            title: "Preparing your update",
            provider: "",
            cwd: "",
            status: "finishing" as const,
            stoppable: false,
          },
        ]
      : []),
  ]
  const closeClients = async (action: LifecycleAction) => {
    const clients = new Set(dependencies.clients())
    await shutdown.request([...clients], (requestId) =>
      dependencies.emit({ type: "app-shutdown", requestId, action })
    )
    if (dependencies.clients().some((client) => !clients.has(client)))
      throw new Error(
        "Another Mako window opened during shutdown. Nothing was installed. Review the open windows and try again."
      )
  }
  const waiting = dependencies.jobs.demand("an operation waits for work to finish")
  const lifecycle = new ApplicationLifecycle({
    work,
    ready(action) {
      if (action === "install") updates.assertReady()
    },
    async stop(reviewed) {
      dependencies.native.pauseQueued()
      for (const item of reviewed)
        if (item.id.startsWith("native:"))
          dependencies.nativeRuns.abort(item.id.slice(7), item.token)
      await dependencies.live.closeForExit(
        reviewed.filter((item) => !item.id.includes(":")).map((item) => item.id)
      )
      const deadline = Date.now() + 30_000
      while (work().length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100))
    },
    async apply(action) {
      const installer =
        action === "install" ? await updates.prepareInstall() : null
      try {
        await dependencies.live.closeForExit()
        await closeClients(action)
      } catch (error) {
        installer?.cancel()
        throw error
      }
      dependencies.finish(action, installer?.install)
    },
    changed: (state) => {
      waiting.set(state.operation.kind === "waiting")
      dependencies.emit({ type: "application-lifecycle", lifecycle: state })
    },
  })
  dependencies.admission.follow(() => lifecycle.blocked)
  methods.handle("mako:lifecycle-state", () => lifecycle.snapshot())
  methods.handle("mako:lifecycle-command", (command: LifecycleCommand) =>
    lifecycle.command(LifecycleCommandSchema.parse(command))
  )
  methods.handle("mako:shutdown-ack", (requestId: string) => {
    if (!shutdown.acknowledge(requestId, hostClient()))
      throw new Error("The shutdown request is no longer active.")
  })
  methods.handle("mako:installation-state", () => updates.installation())
  methods.handle("mako:select-update-source", (path: string) => {
    if (
      lifecycle.snapshot().operation.kind !== "idle" &&
      lifecycle.snapshot().operation.kind !== "error"
    )
      throw new Error(
        "Cancel the pending operation before changing update sources."
      )
    return updates.selectSource(path)
  })
  methods.handle("mako:check-update-source", (force: boolean) => updates.checkSource(force))
  methods.handle("mako:build-update", () => {
    if (
      lifecycle.snapshot().operation.kind !== "idle" &&
      lifecycle.snapshot().operation.kind !== "error"
    )
      throw new Error(
        "Cancel the pending operation before starting another build."
      )
    updates.build()
  })
  methods.handle("mako:update-state", () => updates.state())
  methods.handle("mako:check-updates", () => updates.check())
  methods.handle("mako:install-update", () => lifecycle.command({ kind: "wait", action: "install" }))
  methods.handle("mako:relaunch", () => lifecycle.command({ kind: "wait", action: "restart" }))
  /** The desktop app heard the Mac resume or the screen unlock. */
  methods.handle("mako:machine-woke", (source: "resume" | "unlock-screen") => {
    dependencies.wake.notify(source)
  })
  const { crashes } = dependencies
  methods.handle("mako:crashes", () => crashes.list())
  methods.handle("mako:crashes-dir", () => crashes.directory)
  methods.handle("mako:host-log-path", () => dependencies.logPath)
  methods.handle("mako:clear-crashes", () => crashes.clear())
  methods.handle("mako:report-crash", (kind: "renderer-error" | "renderer-rejection", payload: { message: string; stack?: string; source?: string }) => {
    const error = new Error(payload.message)
    error.stack = payload.stack
    crashes.record(kind, error, payload.source)
  })
  const stopTicking = dependencies.jobs.every("publish the lifecycle and apply a waiting operation", 1000, () => lifecycle.tick(), {
    needs: [dependencies.subscribed, waiting],
  })
  return {
    lifecycle,
    dispose: stopTicking,
  }
}
