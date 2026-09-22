import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { preview } from "vite"
import { runtimeDataRoot, runtimeLocation } from "../dist-electron/runtime-service.js"
import { probeRuntime } from "../dist-electron/runtime-connection.js"
import { webHostProxy } from "./web-dev-proxy.mjs"

// The production browser desk is another client of the installed host. It
// never launches a development backend or exposes the private RPCs publicly.
const appData = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
  : process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
  : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
const { socket } = runtimeLocation(runtimeDataRoot(appData, process.env))
if ((await probeRuntime(socket)).state !== "ready") throw new Error("Open Mako before starting its web client.")
const server = await preview({
  configFile: false,
  root: resolve(import.meta.dirname, ".."),
  plugins: [webHostProxy(socket)],
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
})
server.printUrls()
