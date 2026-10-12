import { enableMainCompileCache } from "@mako/host/base/compile-cache"
import { forgetStartingRepository } from "@mako/git/environment"

if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-entry]", process.type === "browser" ? "client" : "host")
if (process.type === "browser") {
  // Electron's main process is always a client: the person's desktop, or the
  // agent views app a host starts. The host never runs here.
  forgetStartingRepository()
  const { app } = await import("electron")
  const status = enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? app.getPath("userData"))
  if (status.startsWith("failed")) console.warn("[mako-entry] compile cache", status)
  await import("./client-main.js")
} else {
  // Electron's Helper in Node mode, or plain Node: `mako-host`, with no
  // Electron loaded (`scripts/check-host-electron.mjs`).
  await import("@mako/host/mako-host")
}
