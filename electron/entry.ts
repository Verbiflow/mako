import { enableMainCompileCache } from "@mako/host/base/compile-cache"
import { forgetStartingRepository } from "@mako/git/environment"

if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-entry]", process.type === "browser" ? "client" : "host")
if (process.type === "browser") {
  // Electron's main process is always a client: the person's desktop, the agent views app a host starts, or on Windows
  // the power helper a host runs. The host never runs here. Whichever it is forgets the repository it was started in
  // before it loads anything.
  forgetStartingRepository()
  if (process.platform === "win32" && process.argv.includes("--keep-awake")) {
    // Windows's power helper, which the host runs while agents work (`keep-awake-electron.ts`): no client, no window.
    const { runKeepAwakeHelper } = await import("./keep-awake-electron.js")
    runKeepAwakeHelper()
  } else {
    const { app } = await import("electron")
    const status = enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? app.getPath("userData"))
    if (status.startsWith("failed")) console.warn("[mako-entry] compile cache", status)
    await import("./client-main.js")
  }
} else {
  // Electron's Helper in Node mode, or plain Node: `mako-host`, with no
  // Electron loaded (`scripts/check-host-electron.mjs`).
  await import("@mako/host/mako-host")
}
