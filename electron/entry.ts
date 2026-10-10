import { enableMainCompileCache } from "./compile-cache.js"
import { forgetStartingRepository } from "@mako/git/environment"

forgetStartingRepository()
if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-entry]", process.type === "browser" ? "client" : "host")
if (process.type === "browser") {
  // Electron's main process is always a client: the person's desktop, or the
  // agent views app a host starts. The host never runs here.
  const { app } = await import("electron")
  enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? app.getPath("userData"))
  await import("./client-main.js")
} else {
  // Electron's Helper in Node mode, or plain Node: the host, with no Electron
  // loaded (`scripts/check-host-electron.mjs`). Its children set Node mode
  // themselves; a terminal's shell must not start Electron apps as Node.
  delete process.env.ELECTRON_RUN_AS_NODE
  const { hostEnvironment } = await import("./host-environment.js")
  enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? hostEnvironment().defaultDataRoot)
  await import("./main.js")
}
