import type { MethodTable } from "@mako/host/base/methods"
import { clearCrashes, crashesDir, listCrashes, record } from "@mako/host/base/crash"
import { hostLogPath } from "@mako/host/base/host-log"
import { installApplicationIpc, type ApplicationDependencies } from "../ipc/application.js"
import type { WakeWatch } from "@mako/host/base/wake"

export type Application = ReturnType<typeof installApplicationIpc>

export interface ApplicationMethodsDeps extends ApplicationDependencies {
  wake: WakeWatch
}

/** The host's own lifecycle, its updates and its crashes. */
export function declareApplicationMethods(methods: MethodTable, deps: ApplicationMethodsDeps): Application {
  const application = installApplicationIpc(methods, deps)
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
