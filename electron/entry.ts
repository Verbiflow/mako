import { enableMainCompileCache } from "./compile-cache.js"

if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-entry]", process.env.MAKO_HOST_ONLY === "1" ? "host" : "client")
const { app } = await import("electron")
const host = process.env.MAKO_HOST_ONLY === "1" || process.env.MAKO_STANDALONE === "1"
// main.ts must read the real default before applying an isolated data root.
// Setting it here makes test/profile hosts claim the installed app's Dock presence.
enableMainCompileCache(process.env.MAKO_DATA_ROOT ?? app.getPath("userData"))
if (host) {
  await import("./main.js")
} else {
  await import("./client-main.js")
}
