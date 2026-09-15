import { execFile, spawn, type ChildProcess } from "node:child_process"
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { hostLog } from "./host-log.js"
import { trackProviderPid, untrackProviderPid } from "./provider-children.js"

const run = promisify(execFile)

/**
 * The embedded native driver, one per host.
 *
 * How it is launched decides whether the user loses focus. A direct
 * `spawn` of the driver's executable made it the frontmost application for
 * about a fifth of a second every time a host started it (sampled 60 ms
 * apart on 2026-09-14: `Mako:3067` → `cua-driver:39603` → `Mako:3067`),
 * which is exactly the "takes my desktop" the driver was blamed for. The
 * driver's own CLI launches its bundle through LaunchServices, so the host
 * does the same: `/usr/bin/open -g -n -a CuaDriver.app --args serve …`,
 * where `-g` keeps the new process behind the user's window. `open` returns
 * at once and owns no child, so the daemon's pid is discovered from its
 * command line once the socket answers, recorded in
 * `runtime/provider-children.json` for the next host to reap, and signalled
 * by pid on stop. An executable outside an application bundle (a fixture
 * script) is still spawned directly.
 */
interface Daemon {
  pid: number
  socket: string
  executable: string
  /** Present only for the direct spawn route. */
  child?: ChildProcess
  /** Where `open` connected the daemon's stderr. */
  log?: string
}

let daemon: Daemon | null = null
let starting: Promise<string | null> | null = null
let stderr = ""

const SOCKET_WAIT_MS = 10_000
const SOCKET_POLL_MS = 50

async function executable(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const candidates = isAbsolute(command)
    ? [command]
    : [
        ...(env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command)),
        join(homedir(), ".local", "bin", command),
        "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/** The `.app` an executable belongs to, when it is inside one. */
export function bundleOf(path: string): string | null {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(path)
  return match ? match[1] : null
}

function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    const finish = (available: boolean) => {
      socket.destroy()
      resolve(available)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Each host names its driver socket after its own pid; a host that died
 * without its shutdown path leaves that file behind. Dozens accumulate. A
 * socket whose owner no longer runs is unlinked before this host adds its own.
 */
async function sweepStaleSockets(stateDir: string): Promise<void> {
  const names = await readdir(stateDir).catch((): string[] => [])
  for (const name of names) {
    const match = /^embedded-(\d+)\.(sock|log)$/.exec(name)
    if (!match) continue
    const owner = Number(match[1])
    if (owner === process.pid) continue
    if (alive(owner)) continue
    await unlink(join(stateDir, name)).catch(() => undefined)
  }
}

async function waitForSocket(
  path: string,
  exited: () => string | null
): Promise<void> {
  const deadline = Date.now() + SOCKET_WAIT_MS
  while (Date.now() < deadline) {
    const failure = exited()
    if (failure !== null) throw new Error(failure)
    if (await probe(path)) return
    await new Promise((resolve) => setTimeout(resolve, SOCKET_POLL_MS))
  }
  throw new Error("Embedded CUA Driver did not open its private socket")
}

/** The daemon `open` started for this socket, found by its own command line. */
async function discoverPid(socket: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      "pgrep",
      ["-f", "--", `serve --embedded --socket ${socket}`],
      { timeout: 2_000, maxBuffer: 4_096 }
    )
    const pids = stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return pids[0] ?? null
  } catch {
    return null
  }
}

export function ensureCuaEmbedded(
  stateDir: string,
  hostBundleId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null)
  if (daemon && daemonRuns(daemon)) return Promise.resolve(daemon.socket)
  if (daemon) forget(daemon)
  starting ??= start(stateDir, hostBundleId, env).finally(() => {
    starting = null
  })
  return starting
}

function daemonRuns(current: Daemon): boolean {
  return current.child ? current.child.exitCode === null : alive(current.pid)
}

function forget(current: Daemon): void {
  if (daemon !== current) return
  daemon = null
  untrackProviderPid(current.pid)
  void unlink(current.socket).catch(() => undefined)
}

async function start(
  stateDir: string,
  hostBundleId: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const command = await executable("cua-driver", env)
  if (!command) return null
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  await sweepStaleSockets(stateDir)
  const socket = join(stateDir, `embedded-${process.pid}.sock`)
  await unlink(socket).catch(() => undefined)
  const driverEnv = {
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId,
    CUA_DRIVER_PERMISSION_MODE: "standard",
    // The driver posts every tool call to PostHog by default (seen as HTTP
    // work in the daemon during each action). Mako's embedded daemon is
    // Mako's process and reports nothing about the user's computer use to a
    // third party; the user's own CLI keeps its own preference.
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  }
  const args = ["serve", "--embedded", "--socket", socket]
  const bundle = bundleOf(await realpath(command).catch(() => command))
  const started = bundle
    ? await launchBundle(bundle, command, socket, args, driverEnv, stateDir)
    : await spawnDirect(command, socket, args, { ...env, ...driverEnv })
  daemon = started
  trackProviderPid({
    pid: started.pid,
    executable: started.executable,
    kind: "cua-driver",
    owner: "embedded",
  })
  hostLog("computer", "driver started", {
    pid: started.pid,
    route: bundle ? "open -g" : "spawn",
    executable: started.executable,
  })
  return started.socket
}

/** LaunchServices starts the bundle behind the user's window; nothing is activated. */
async function launchBundle(
  bundle: string,
  executablePath: string,
  socket: string,
  args: string[],
  driverEnv: Record<string, string>,
  stateDir: string
): Promise<Daemon> {
  const log = join(stateDir, `embedded-${process.pid}.log`)
  await unlink(log).catch(() => undefined)
  const openArgs = [
    "-g",
    "-n",
    "-a",
    bundle,
    ...Object.entries(driverEnv).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--stderr",
    log,
    "--args",
    ...args,
  ]
  try {
    await run("/usr/bin/open", openArgs, { timeout: 15_000, maxBuffer: 16_384 })
  } catch (error) {
    throw new Error(
      `Embedded CUA Driver could not be launched: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  let pid: number | null = null
  try {
    await waitForSocket(socket, () => null)
    pid = await discoverPid(socket)
    if (pid === null)
      throw new Error(
        "Embedded CUA Driver answered on its socket but its process was not found"
      )
  } catch (error) {
    const tail = (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .slice(-8_000)
    const found = pid ?? (await discoverPid(socket))
    if (found !== null) process.kill(found, "SIGTERM")
    await unlink(socket).catch(() => undefined)
    throw new Error(
      tail ||
        (error instanceof Error ? error.message : "Embedded CUA Driver failed"),
      { cause: error }
    )
  }
  return { pid, socket, executable: executablePath, log }
}

async function spawnDirect(
  command: string,
  socket: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<Daemon> {
  stderr = ""
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000)
  })
  const current: Daemon = {
    pid: child.pid ?? 0,
    socket,
    executable: command,
    child,
  }
  child.once("exit", () => {
    if (daemon === current) forget(current)
  })
  try {
    await waitForSocket(socket, () =>
      child.exitCode === null
        ? null
        : stderr.trim() || `Embedded CUA Driver exited with ${child.exitCode}`
    )
  } catch (error) {
    child.kill("SIGTERM")
    await unlink(socket).catch(() => undefined)
    throw error
  }
  return current
}

export function cuaEmbeddedSocket(): string | null {
  return daemon ? daemon.socket : null
}

/** The daemon's pid, for tests that sample what is frontmost while it starts. */
export function cuaEmbeddedPid(): number | null {
  return daemon ? daemon.pid : null
}

export function stopCuaEmbedded(): void {
  const running = daemon
  if (!running) return
  daemon = null
  untrackProviderPid(running.pid)
  if (running.child) running.child.kill("SIGTERM")
  else if (alive(running.pid)) {
    try {
      process.kill(running.pid, "SIGTERM")
    } catch {
      // Gone between the check and the signal.
    }
  }
  void unlink(running.socket).catch(() => undefined)
}
