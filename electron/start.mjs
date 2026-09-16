import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createServer } from "vite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { ensureRuntime, runtimeDataRoot } from "../dist-electron/runtime-service.js"
import { holdHostLease } from "../dist-electron/host-idle.js"
import { join } from "node:path"
import { webHostProxy } from "./web-dev-proxy.mjs"
import { manualDevUpdates } from "./dev-updates.mjs"
import { buildPreload } from "../scripts/build-preload.mjs"
import { createHash } from "node:crypto"
import { publishDevRendererRegistration } from "../dist-electron/dev-renderer-registration.js"

// ORCA: Electron-based hosts leak this. If it stays set, Electron boots as Node
// and `require("electron")` is the npm stub instead of the real API.
delete process.env.ELECTRON_RUN_AS_NODE

/** The host asks to come back on the current build with this exit code. */
const RELAUNCH_EXIT_CODE = 75

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const web = process.argv.includes("--web")
const hot = process.argv.includes("--hot")
// Development gets its own host by default. Sharing the installed app's host
// means every "Restart Mako" here drops the calls of the desk you actually use,
// and every install there closes this one. `--shared` opts back in on purpose.
const shared = process.argv.includes("--shared")
// Provider processes inside the installed app inherit these. If they leak into
// this launcher, `npm run dev` attaches to that app instead of the `dev` profile.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (!shared && env.MAKO_HOST_ONLY === "1") {
  for (const key of ["MAKO_DATA_ROOT", "MAKO_HOST_ONLY", "MAKO_STANDALONE", "MAKO_WEB_SOCKET", "MAKO_WEB_ONLY", "MAKO_CLIENT_ID", "VITE_DEV_SERVER_URL"])
    delete env[key]
}
const profile = env.MAKO_PROFILE || (process.argv.includes("--sandbox") ? `sandbox-${createHash("sha256").update(root).digest("hex").slice(0, 8)}` : shared ? undefined : "dev")
const appData = process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
const dataRoot = runtimeDataRoot(appData, { ...env, MAKO_PROFILE: profile })
const runtime = await ensureRuntime({ dataRoot, executable: electronPath, args: [root], cwd: root, env: { ...env, MAKO_PROFILE: profile } })
const socket = runtime.socket
// A profile host stops itself once nothing has used it for a while. This
// launcher is a user, even between page loads, so it holds a lease keyed by
// its own pid; a crashed launcher's lease expires with it.
const releaseLease = profile ? await holdHostLease(runtime.directory) : null
const cacheDirectory = await mkdtemp(join(tmpdir(), "mako-vite-"))
const server = await createServer({
  cacheDir: cacheDirectory,
  define: { "import.meta.env.MAKO_MANUAL_RELOAD": JSON.stringify(!hot), "import.meta.env.MAKO_SHARED_RUNTIME": "true", "import.meta.env.MAKO_CLIENT_PROFILE": JSON.stringify(profile ?? ""), "import.meta.env.MAKO_SOURCE_ROOT": JSON.stringify(root) },
  plugins: [webHostProxy(socket), ...(!hot ? [manualDevUpdates()] : [])],
  root,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
})
await server.listen()
server.printUrls()
const url = server.resolvedUrls?.local[0]
if (!url) {
  await server.close()
  await rm(cacheDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  throw new Error("Vite did not expose a local development URL")
}
const removeDevRendererRegistration = publishDevRendererRegistration(
  runtime.directory,
  {
    profile: profile ?? "default",
    sourceRoot: root,
    url,
  }
)

// The renderer hot-reloads through Vite; the host cannot. Keeping the host
// compiler running means an edit under electron/ is on disk by the time the
// window says "rebuilt", and Restart Mako loads it without leaving the desk.
const compiler = spawn(
  process.execPath,
  [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.electron.json",
    "--watch",
    "--preserveWatchOutput",
  ],
  { stdio: "inherit", cwd: root }
)
// The preload is one bundled script (renderers are sandboxed); rebuild it too.
const stopPreloadBuild = await buildPreload({ watch: true })

const hostEnvironment = {
  ...env,
  VITE_DEV_SERVER_URL: url,
  MAKO_PROFILE: profile,
  MAKO_DATA_ROOT: dataRoot,
  MAKO_WEB_SOCKET: socket,
  MAKO_WEB_ONLY: web ? "1" : "0",
}
console.log(`[mako-client] ${profile ? `Profile ${profile}` : "Installed app's shared host"} · host ${runtime.info.pid} · ${hot ? "automatic hot updates" : "manual reload"} · ${url}`)
let child
let stopping = false

function launch() {
  child = spawn(electronPath, ["."], {
    stdio: "inherit",
    cwd: root,
    env: hostEnvironment,
  })
  child.on("exit", (code, signal) => {
    if (code === RELAUNCH_EXIT_CODE && !stopping) {
      launch()
      return
    }
    void stop(signal ? 1 : (code ?? 0))
  })
}

async function stop(code, signal) {
  if (stopping) return
  stopping = true
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal ?? "SIGTERM")
  }
  if (compiler.exitCode === null && compiler.signalCode === null) {
    compiler.kill("SIGTERM")
  }
  await stopPreloadBuild()
  await server.close()
  removeDevRendererRegistration()
  await releaseLease?.()
  await rm(cacheDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  process.exitCode = code
}

if (!web) launch()
process.once("SIGINT", () => void stop(130, "SIGINT"))
process.once("SIGTERM", () => void stop(143, "SIGTERM"))
