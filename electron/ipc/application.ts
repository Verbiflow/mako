import { WindowShutdown } from "../window-shutdown.js"
import { ApplicationLifecycle } from "../application-lifecycle.js"
import type { Admission } from "@mako/host/base/admission"
import {
  LifecycleCommandSchema,
  type LifecycleCommand,
  type LifecycleAction,
  type LifecycleWork,
} from "@mako/host/contracts/app-lifecycle"
import type { Updates } from "../updates.js"
import type { LiveConversations } from "../live-conversations.js"
import type { NativeRequests } from "../native-requests.js"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { abortNative, nativeLifecycleWork } from "../drivers.js"
import { hostClient } from "@mako/host/base/host-client"
import type { MethodTable } from "@mako/host/base/methods"

interface ApplicationDependencies {
  live: LiveConversations
  native: NativeRequests
  /** Closed while the lifecycle stops the host's agents. */
  admission: Admission
  updates: Updates
  emit(event: HostEvent): void
  clients(): string[]
  finish(action: LifecycleAction, install?: () => void): void
}

export function installApplicationIpc(methods: MethodTable, dependencies: ApplicationDependencies) {
  const { updates } = dependencies
  const shutdown = new WindowShutdown()
  const work = (): LifecycleWork[] => [
    ...dependencies.live.lifecycleWork(),
    ...nativeLifecycleWork(),
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
  const lifecycle = new ApplicationLifecycle({
    work,
    ready(action) {
      if (action === "install") updates.assertReady()
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
    changed: (state) =>
      dependencies.emit({ type: "application-lifecycle", lifecycle: state }),
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
  const timer = setInterval(() => {
    void lifecycle.tick()
  }, 1000)
  timer.unref()
  return {
    lifecycle,
    dispose() {
      clearInterval(timer)
    },
  }
}
