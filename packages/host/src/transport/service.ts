import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, open, readFile, rename, stat, writeFile, type FileHandle } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { appDataFor } from "../base/host-environment.js"
import { headlessNodeExecutable } from "../base/headless-node.js"
import { HOST_LOG_MAX_BYTES } from "../base/host-log.js"
import { HOST_NODE_OPTIONS } from "../base/process-warnings.js"
import { ensurePrivateDirectory } from "../base/private-directory.js"
import { probeRuntime, settleRuntime } from "./connection.js"
import { nodePlatform, onWindows } from "../base/platform.js"
import { publishedHostPipe, runtimeIdentity, windowsRuntimeDirectory } from "./pipe.js"

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

/** A desktop client's own folder beside the host's data: its renderer storage and `logs/desktop.log`. */
export function clientRoot(dataRoot: string, client: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(client)) throw new Error("Invalid Mako client identity")
  return `${dataRoot}-ui-${client}`
}

/** The agent views app's client identity, so its storage and log stay apart from the person's desktop. */
export const AGENT_VIEWS_CLIENT = "agent-views"

/** How long a host started has to answer on its socket before its start is a failure (`HostLaunchFailedError`). */
export const HOST_START_WINDOW_MS = 30_000

/**
 * Where the host for `dataRoot` lives: a folder of its own, private to the user, and the socket its clients reach it
 * on. On macOS and Linux that is `host.sock` in a folder of the temp directory; on Windows the named pipe its host
 * published for this start in a folder of the user's local app data (`pipe.ts` says why), read each time it's asked.
 */
export function runtimeLocation(dataRoot: string) {
  const identity = runtimeIdentity(dataRoot)
  if (onWindows()) {
    const directory = windowsRuntimeDirectory(identity)
    return { directory, socket: publishedHostPipe(directory, identity) }
  }
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
  /** Mako's desktop executable (Electron), or plain Node where there is no desktop. */
  executable: string
  /** The checkout for a development build; nothing for the packaged app. */
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * How a host starts: always as Node. On a Mac that is Electron's Helper in
 * Node mode, which shows no Dock icon and loads no Electron API; elsewhere
 * plain Node. The host learns the executable, to record how to start it
 * again and to start the agent views app with it.
 */
export interface HostCommand {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function hostCommand(input: Pick<RuntimeLaunch, "executable" | "args" | "env">): HostCommand {
  // A packaged app's code is its bundle's app.asar, which Electron's Node mode reads as a folder, and its host the
  // bundle of it (scripts/bundle-main.mjs); a checkout's is what tsc emits, which it rebuilds while it runs.
  // A Mac bundle's code is in `Contents/Resources` beside `Contents/MacOS`; a Windows install's in `resources` beside `Mako.exe`.
  const resources = nodePlatform() === "win32" ? join(dirname(input.executable), "resources") : join(dirname(input.executable), "..", "Resources")
  const entry = input.args[0] ? join(input.args[0], "dist-electron", "entry.js") : join(resources, "app.asar", "dist-electron", "host", "entry.js")
  return {
    executable: headlessNodeExecutable(input.executable),
    args: [...HOST_NODE_OPTIONS, entry],
    env: { ...input.env, MAKO_HOST_EXECUTABLE: input.executable, ELECTRON_RUN_AS_NODE: "1" },
  }
}

/**
 * The host that owns the profile is still on its way out (`closing` past `settleRuntime`'s wait): a caller waits and
 * asks again, never starting another host into its lock, and never says it can't be reached. A slow quit, an update
 * or a restart's old host looks like this for a while.
 */
export class HostLeavingError extends Error {}

/**
 * No host could be had: the one this call launched quit during startup, or wasn't ready within its 30 seconds. The
 * one failure that says there's no host to reach (a window's `gone`).
 */
export class HostLaunchFailedError extends Error {}

export async function ensureRuntime(input: RuntimeLaunch) {
  let location = runtimeLocation(input.dataRoot)
  await ensurePrivateDirectory(location.directory, "Mako host")
  // A host that is quitting still holds the profile lock; wait for it to leave
  // rather than start a second host into it or report its farewell as a failure.
  const existing = await settleRuntime(location.socket)
  if (existing.state === "ready") return { ...location, info: existing.info }
  if (existing.state === "closing")
    throw new HostLeavingError("The shared Mako host is still shutting down and owns this profile. Try again once it has left. No isolated replacement was started.")
  const outputPath = runtimeOutputPath(input.dataRoot)
  const output = await openRuntimeOutput(outputPath)
  let child: ReturnType<typeof spawn>
  const command = hostCommand(input)
  try {
    child = spawn(command.executable, command.args, {
      cwd: input.cwd, detached: true, stdio: output ? ["ignore", output.fd, output.fd] : "ignore",
      env: { ...command.env, MAKO_DATA_ROOT: input.dataRoot, MAKO_WEB_SOCKET: location.socket },
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
  const deadline = Date.now() + HOST_START_WINDOW_MS
  while (Date.now() < deadline && (exitedAt === undefined || Date.now() < exitedAt + EXITED_GRACE_MS)) {
    // A socket that resets while the new host binds is "not ready yet", not a launch failure. On Windows the host
    // publishes a pipe of its own for this start once it listens: where it is is read again each time.
    location = runtimeLocation(input.dataRoot)
    const probe = await probeRuntime(location.socket)
    if (probe.state === "ready") return { ...location, info: probe.info }
    if (launchError) throw launchError
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const logs = `See ${join(dirname(outputPath), "host.log")} and ${outputPath}.`
  if (exitedAt !== undefined)
    throw new HostLaunchFailedError(`The shared Mako host (pid ${child.pid}) quit during startup (${exit}). ${logs} No isolated replacement was started.`)
  throw new HostLaunchFailedError(`The shared Mako host (pid ${child.pid}) did not become ready within 30 seconds. ${logs} No isolated replacement was started.`)
}
