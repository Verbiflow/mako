import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, open, readFile, rename, stat, writeFile, type FileHandle } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { appDataFor } from "./host-environment.js"
import { headlessNodeExecutable } from "./headless-node.js"
import { HOST_LOG_MAX_BYTES } from "./host-log.js"
import { ensurePrivateDirectory } from "./private-directory.js"
import { probeRuntime, settleRuntime } from "./runtime-connection.js"
import { nodePlatform } from "./platform.js"

/** A host that exits during launch may be losing a race to another launcher's host. */
const EXITED_GRACE_MS = 5_000

/** Where Electron keeps every app's data on this platform, as `app.getPath("appData")` says. */
export function appDataFolder(env: NodeJS.ProcessEnv = process.env): string {
  return appDataFor(nodePlatform(), homedir(), env)
}

/** The profile a fixture desk launched from the checkout at `root` runs on. */
export function fixtureProfile(root: string, env: NodeJS.ProcessEnv): string {
  return env.MAKO_PROFILE || `fixture-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`
}

const FIXTURE_CHECKOUT = "fixture-checkout"

/** Notes in a fixture desk's data which checkout launched it, so a profile whose checkout is gone can be told from one in use. */
export async function noteFixtureCheckout(dataRoot: string, root: string): Promise<void> {
  await writeFile(join(dataRoot, FIXTURE_CHECKOUT), root, { mode: 0o600 })
}

/** The checkout that last launched the fixture desk with this data, when it noted one. */
export async function fixtureCheckout(dataRoot: string): Promise<string | undefined> {
  return readFile(join(dataRoot, FIXTURE_CHECKOUT), "utf8").then((text) => text.trim() || undefined, () => undefined)
}

export function runtimeDataRoot(appData: string, env: NodeJS.ProcessEnv): string {
  if (env.MAKO_DATA_ROOT) return resolve(env.MAKO_DATA_ROOT)
  const profile = env.MAKO_PROFILE
  if (profile && !/^[a-zA-Z0-9_.-]{1,80}$/.test(profile)) throw new Error("Invalid Mako sandbox profile name")
  return join(appData, profile ? `mako-${profile}` : "mako")
}

export function runtimeLocation(dataRoot: string) {
  const identity = createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 16)
  const directory = join(tmpdir(), `mako-host-${identity}`)
  return { directory, socket: join(directory, "host.sock") }
}

/**
 * Where a detached host's stdout and stderr go. host.log only opens partway
 * through startup and loses writes to a hard exit; this keeps what comes
 * before it, and native crashes it never sees.
 */
export function runtimeOutputPath(dataRoot: string): string {
  return join(resolve(dataRoot), "logs", "host-output.log")
}

async function openRuntimeOutput(path: string): Promise<FileHandle | null> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const size = await stat(path).then((entry) => entry.size, () => 0)
    if (size > HOST_LOG_MAX_BYTES) await rename(path, `${path}.1`)
    const handle = await open(path, "a")
    await handle.write(`--- ${new Date().toISOString()} host launch\n`)
    return handle
  } catch {
    return null
  }
}

export interface RuntimeLaunch {
  dataRoot: string
  /** Electron's own executable, whichever runtime the host gets. */
  executable: string
  /** The checkout for a development build; nothing for the packaged app. */
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * How a host starts. Electron's main process by default; with
 * `MAKO_HOST_RUNTIME=node`, Electron's Helper in Node mode runs the same
 * entry, with no windows and no Electron API (`host-shell.ts`). The host
 * learns Electron's executable either way, to record how to start it again.
 */
export interface HostCommand {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function hostCommand(input: Pick<RuntimeLaunch, "executable" | "args" | "env">): HostCommand {
  const env: NodeJS.ProcessEnv = { ...input.env, MAKO_HOST_EXECUTABLE: input.executable }
  delete env.ELECTRON_RUN_AS_NODE
  if (input.env.MAKO_HOST_RUNTIME !== "node") return { executable: input.executable, args: input.args, env }
  // A packaged app's code is its bundle's app.asar, which Electron's Node mode reads as a folder.
  const appRoot = input.args[0] ?? join(dirname(input.executable), "..", "Resources", "app.asar")
  return {
    executable: headlessNodeExecutable(input.executable),
    args: [join(appRoot, "dist-electron", "entry.js")],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  }
}

export async function ensureRuntime(input: RuntimeLaunch) {
  const location = runtimeLocation(input.dataRoot)
  await ensurePrivateDirectory(location.directory, "Mako host")
  // A host that is quitting still holds the profile lock; wait for it to leave
  // rather than start a second host into it or report its farewell as a failure.
  const existing = await settleRuntime(location.socket)
  if (existing.state === "ready") return { ...location, info: existing.info }
  if (existing.state === "closing")
    throw new Error("The shared Mako host is still shutting down and owns this profile. Try again once it has left. No isolated replacement was started.")
  const outputPath = runtimeOutputPath(input.dataRoot)
  const output = await openRuntimeOutput(outputPath)
  let child: ReturnType<typeof spawn>
  const command = hostCommand(input)
  try {
    child = spawn(command.executable, command.args, {
      cwd: input.cwd, detached: true, stdio: output ? ["ignore", output.fd, output.fd] : "ignore",
      env: { ...command.env, MAKO_HOST_ONLY: "1", MAKO_DATA_ROOT: input.dataRoot, MAKO_WEB_SOCKET: location.socket, MAKO_WEB_ONLY: "1" },
    })
  } finally {
    await output?.close().catch(() => undefined)
  }
  let launchError: Error | undefined
  let exitedAt: number | undefined
  let exit = ""
  child.once("error", (error) => { launchError = error })
  child.once("exit", (code, signal) => { exitedAt = Date.now(); exit = signal ?? `exit ${code}` })
  child.unref()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && (exitedAt === undefined || Date.now() < exitedAt + EXITED_GRACE_MS)) {
    // A socket that resets while the new host binds is "not ready yet", not a launch failure.
    const probe = await probeRuntime(location.socket)
    if (probe.state === "ready") return { ...location, info: probe.info }
    if (launchError) throw launchError
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const logs = `See ${join(dirname(outputPath), "host.log")} and ${outputPath}.`
  if (exitedAt !== undefined)
    throw new Error(`The shared Mako host (pid ${child.pid}) quit during startup (${exit}). ${logs} No isolated replacement was started.`)
  throw new Error(`The shared Mako host (pid ${child.pid}) did not become ready within 30 seconds. ${logs} No isolated replacement was started.`)
}
