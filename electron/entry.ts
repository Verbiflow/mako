import { enableMainCompileCache } from "./compile-cache.js"
import { forgetStartingRepository } from "@mako/git/environment"

forgetStartingRepository()
if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-entry]", process.env.MAKO_HOST_ONLY === "1" ? "host" : "client")
const host = process.env.MAKO_HOST_ONLY === "1" || process.env.MAKO_STANDALONE === "1"
if (process.type === "browser") {
  const { app } = await import("electron")
  // main.ts must read the real default before applying an isolated data root.
  // Setting it here makes test/profile hosts claim the installed app's Dock presence.
  enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? app.getPath("userData"))
  if (host) {
    await import("./main.js")
  } else {
    await import("./client-main.js")
  }
} else {
  // Electron's Helper in Node mode, or plain Node: only the host runs here, and
  // Electron isn't loaded (`host-shell.ts`). Its children set Node mode
  // themselves; a terminal's shell must not start Electron apps as Node.
  if (!host) throw new Error("Mako's desktop app needs Electron; under Node only the host runs (MAKO_HOST_ONLY=1).")
  delete process.env.ELECTRON_RUN_AS_NODE
  const { hostEnvironment } = await import("./host-environment.js")
  enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? hostEnvironment().defaultDataRoot)
  await import("./main.js")
}
