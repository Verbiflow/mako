import type { MethodTable } from "@mako/host/base/methods"
import type { Updates } from "../updates.js"
import { clearCrashes, crashesDir, listCrashes, record } from "@mako/host/base/crash"
import { hostLogPath } from "@mako/host/base/host-log"
import { installApplicationIpc } from "../ipc/application.js"
import { installSessionIpc, type SessionIpcContext } from "../ipc/session.js"
import type { LiveConversations } from "../live-conversations.js"
import type { NativeRequests } from "../native-requests.js"
import type { WakeWatch } from "@mako/host/base/wake"
import type { Admission } from "@mako/host/base/admission"
import type { LifecycleAction } from "@mako/host/contracts/app-lifecycle"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"

export type Application = ReturnType<typeof installApplicationIpc>

export interface ApplicationMethodsDeps {
  session: SessionIpcContext
  live: LiveConversations
  native: NativeRequests
  admission: Admission
  updates: Updates
  wake: WakeWatch
  clients(): string[]
  /** Stops this host for a client's quit, restart or update, once its work allows. */
  finish(action: LifecycleAction, install?: () => void): void
  emit(event: HostEvent): void
}

/** What a client loads first, the host's own lifecycle, its updates and its crashes. */
export function declareApplicationMethods(methods: MethodTable, deps: ApplicationMethodsDeps): Application {
  installSessionIpc(methods, deps.session)
  const application = installApplicationIpc(methods, {
    live: deps.live,
    native: deps.native,
    admission: deps.admission,
    updates: deps.updates,
    emit: deps.emit,
    clients: deps.clients,
    finish: deps.finish,
  })
  methods.handle("mako:update-state", () => deps.updates.state())
  methods.handle("mako:check-updates", () => deps.updates.check())
  methods.handle("mako:install-update", () => application.lifecycle.command({ kind: "wait", action: "install" }))
  methods.handle("mako:relaunch", () => application.lifecycle.command({ kind: "wait", action: "restart" }))
  /** The desktop app heard the Mac resume or the screen unlock. */
  methods.handle("mako:machine-woke", (source: "resume" | "unlock-screen") => {
    deps.wake.notify(source)
  })
  methods.handle("mako:crashes", () => listCrashes())
  methods.handle("mako:crashes-dir", () => crashesDir())
  methods.handle("mako:host-log-path", () => hostLogPath() ?? "")
  methods.handle("mako:clear-crashes", () => clearCrashes())
  methods.handle("mako:report-crash", (kind: "renderer-error" | "renderer-rejection", payload: { message: string; stack?: string; source?: string }) => {
    const error = new Error(payload.message)
    error.stack = payload.stack
    record(kind, error, payload.source)
  })
  return application
}
