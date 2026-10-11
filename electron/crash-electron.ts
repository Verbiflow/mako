import { app, crashReporter } from "electron"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { NativeCrashes } from "@mako/host/base/crash"

/** An Electron process's native failures: Crashpad's dumps on this machine, and its child processes that died. */
export const electronNativeCrashes: NativeCrashes = (root, crashes) => {
  const dumps = join(root, "Crashpad")
  mkdirSync(dumps, { recursive: true })
  app.setPath("crashDumps", dumps)
  crashReporter.start({ uploadToServer: false })
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return
    crashes.record("child-gone", new Error(`${details.type} exited: ${details.reason} (exit ${details.exitCode})`))
  })
}
