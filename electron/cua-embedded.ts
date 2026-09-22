import { spawn, type ChildProcess } from "node:child_process"
import { access, chmod, mkdir, readdir, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { hostLog } from "./host-log.js"
import { trackProviderPid, untrackProviderPid } from "./provider-children.js"

/**
 * The embedded native driver, one per host.
 *
 * Cua's embedding contract requires the host to spawn the daemon directly:
 * LaunchServices breaks the macOS responsibility chain and gives the driver
 * a second TCC identity. A direct 0.28.0 daemon used to activate for about
 * 200 ms while constructing its cursor overlay. The documented
 * `--no-overlay` daemon flag removes that UI path; 20 ms sampling on
 * 2026-09-14 observed only the user's original frontmost pid during startup.
 * The host therefore keeps a real child handle, inherits Mako's grants, and
 * tears the exact process down without pgrep.
 */
interface Daemon {
  pid: number
  socket: string
  executable: string
  child: ChildProcess
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
  return current.child.exitCode === null
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
    CUA_DRIVER_REQUIRE_FOCUSED_TARGET: "1",
  }
  // Cua's documented daemon API disables the overlay at construction. Hiding
  // a session cursor after startup still left the installed 0.28.0 build
  // awaiting its glide before semantic AX actions; --no-overlay removes that
  // render path entirely and keeps background control visually quiet.
  const args = ["serve", "--embedded", "--no-overlay", "--socket", socket]
  const started = await spawnDirect(command, socket, args, {
    ...env,
    ...driverEnv,
  })
  daemon = started
  trackProviderPid({
    pid: started.pid,
    executable: started.executable,
    kind: "cua-driver",
    owner: "embedded",
  })
  hostLog("computer", "driver started", {
    pid: started.pid,
    route: "spawn",
    executable: started.executable,
  })
  return started.socket
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
  running.child.kill("SIGTERM")
  void unlink(running.socket).catch(() => undefined)
}
