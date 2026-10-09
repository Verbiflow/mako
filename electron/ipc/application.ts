import { WindowShutdown } from "../window-shutdown.js"
import {
  ApplicationLifecycle,
  bindLifecycleAdmission,
} from "../application-lifecycle.js"
import {
  LifecycleCommandSchema,
  type LifecycleCommand,
  type LifecycleAction,
  type LifecycleWork,
} from "../contracts/app-lifecycle.js"
import {
  assertUpdateReady,
  buildUpdate,
  installationState,
  prepareUpdateInstall,
  selectUpdateSource,
  updateBuilding,
} from "../updates.js"
import type { LiveConversations } from "../live-conversations.js"
import type { NativeRequests } from "../native-requests.js"
import type { HostEvent } from "../shared.js"
import { abortNative, nativeLifecycleWork } from "../drivers.js"
import { hostClient } from "../host-client.js"
import { registerIpc as handle } from "./register.js"

interface ApplicationDependencies {
  live: LiveConversations
  native: NativeRequests
  emit(event: HostEvent): void
  clients(): string[]
  finish(action: LifecycleAction, install?: () => void): void
}

export function installApplicationIpc(dependencies: ApplicationDependencies) {
  const shutdown = new WindowShutdown()
  const work = (): LifecycleWork[] => [
    ...dependencies.live.lifecycleWork(),
    ...nativeLifecycleWork(),
    ...dependencies.native.lifecycleWork(),
    ...(updateBuilding()
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
  const lifecycle = new ApplicationLifecycle({
    work,
    ready(action) {
      if (action === "install") assertUpdateReady()
    },
    async stop(reviewed) {
      dependencies.native.pauseQueued()
      for (const item of reviewed)
        if (item.id.startsWith("native:"))
          abortNative(item.id.slice(7), item.token)
      await dependencies.live.closeForExit(
        reviewed.filter((item) => !item.id.includes(":")).map((item) => item.id)
      )
      const deadline = Date.now() + 30_000
      while (work().length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100))
    },
    async apply(action) {
      const installer =
        action === "install" ? await prepareUpdateInstall() : null
      try {
        await dependencies.live.closeForExit()
        await closeClients(action)
      } catch (error) {
        installer?.cancel()
        throw error
      }
      dependencies.finish(action, installer?.install)
    },
    changed: (state) =>
      dependencies.emit({ type: "application-lifecycle", lifecycle: state }),
  })
  bindLifecycleAdmission(() => lifecycle.blocked)
  handle("mako:lifecycle-state", () => lifecycle.snapshot())
  handle("mako:lifecycle-command", (_event, command: LifecycleCommand) =>
    lifecycle.command(LifecycleCommandSchema.parse(command))
  )
  handle("mako:shutdown-ack", (_event, requestId: string) => {
    if (!shutdown.acknowledge(requestId, hostClient()))
      throw new Error("The shutdown request is no longer active.")
  })
  handle("mako:installation-state", () => installationState())
  handle("mako:select-update-source", (_event, path: string) => {
    if (
      lifecycle.snapshot().operation.kind !== "idle" &&
      lifecycle.snapshot().operation.kind !== "error"
    )
      throw new Error(
        "Cancel the pending operation before changing update sources."
      )
    return selectUpdateSource(path)
  })
  handle("mako:build-update", () => {
    if (
      lifecycle.snapshot().operation.kind !== "idle" &&
      lifecycle.snapshot().operation.kind !== "error"
    )
      throw new Error(
        "Cancel the pending operation before starting another build."
      )
    buildUpdate()
  })
  const timer = setInterval(() => {
    void lifecycle.tick()
  }, 1000)
  timer.unref()
  return {
    lifecycle,
    dispose() {
      clearInterval(timer)
      bindLifecycleAdmission(() => false)
    },
  }
}
