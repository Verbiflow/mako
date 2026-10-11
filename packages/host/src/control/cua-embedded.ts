import { spawn, type ChildProcess } from "node:child_process"
import { access, chmod, mkdir, readdir, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { hostLog } from "../base/host-log.js"
import { trackProviderChild, untrackProviderPid } from "../base/provider-children.js"
import { createPrivateControlSocket } from "@mako/control-runtime/desktop"
import { onMac } from "../base/platform.js"

/**
 * The embedded native driver, one per host (`CuaEmbedded`).
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
  endpoint: Awaited<ReturnType<typeof createPrivateControlSocket>>
  args: string[]
  env: NodeJS.ProcessEnv
}

const SOCKET_WAIT_MS = 10_000
const SOCKET_POLL_MS = 50
const RESTART_WINDOW_MS = 60_000
const RESTARTS_PER_WINDOW = 3

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
 * socket whose owner no longer runs is unlinked before this host adds its own,
 * with the held-input journal its driver keeps beside it.
 */
async function sweepStaleSockets(stateDir: string): Promise<void> {
  const names = await readdir(stateDir).catch((): string[] => [])
  for (const name of names) {
    const match = /^embedded-(\d+)\.(sock|log|sock\.held-input)$/.exec(name)
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

/**
 * Mako's embedded driver daemon: `ensure` starts it, or returns the running
 * one's socket, and an unexpected exit is replaced on the same socket.
 */
export class CuaEmbedded {
  #daemon: Daemon | null = null
  #starting: Promise<string | null> | null = null
  #stderr = ""
  readonly #restarts: number[] = []
  /** Bumped by every `stop`, so a restart that finishes after one is ended. */
  #stops = 0

  ensure(
    stateDir: string,
    hostBundleId: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<string | null> {
    if (!onMac()) return Promise.resolve(null)
    const daemon = this.#daemon
    if (daemon && daemon.child.exitCode === null) return Promise.resolve(daemon.socket)
    if (daemon) this.#forget(daemon)
    this.#starting ??= this.#start(stateDir, hostBundleId, env).finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  socket(): string | null {
    return this.#daemon?.socket ?? null
  }

  /** The daemon's pid, for tests that sample what is frontmost while it starts. */
  pid(): number | null {
    return this.#daemon?.pid ?? null
  }

  stop(): void {
    this.#stops++
    const running = this.#daemon
    if (!running) return
    this.#daemon = null
    untrackProviderPid(running.pid)
    running.child.kill("SIGTERM")
    void running.endpoint.close().catch(() => undefined)
  }

  /**
   * Running task sessions were given this daemon's socket path and reconnect
   * their driver process to it, so an unexpected exit is replaced on the same
   * endpoint. A daemon that keeps exiting is left down until the next
   * `ensure`.
   */
  #restart(
    current: Daemon,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const now = Date.now()
    const restarts = this.#restarts
    while (restarts.length && now - restarts[0]! > RESTART_WINDOW_MS)
      restarts.shift()
    if (restarts.length >= RESTARTS_PER_WINDOW) {
      hostLog("computer", "driver exited; restart budget spent", {
        pid: current.pid,
        code,
        signal,
      })
      this.#forget(current)
      return
    }
    restarts.push(now)
    this.#daemon = null
    untrackProviderPid(current.pid)
    hostLog("computer", "driver exited; restarting", {
      pid: current.pid,
      code,
      signal,
    })
    const generation = this.#stops
    const starting = (this.#starting ??= (async () => {
      await unlink(current.socket).catch(() => undefined)
      const next = await this.#spawn(
        current.executable,
        current.endpoint,
        current.args,
        current.env
      )
      if (generation !== this.#stops) {
        next.child.kill("SIGTERM")
        void next.endpoint.close().catch(() => undefined)
        return null
      }
      this.#daemon = next
      hostLog("computer", "driver restarted", { pid: next.pid })
      return next.socket
    })().finally(() => {
      this.#starting = null
    }))
    void starting.catch(() => undefined)
  }

  #forget(current: Daemon): void {
    if (this.#daemon !== current) return
    this.#daemon = null
    untrackProviderPid(current.pid)
    void current.endpoint.close().catch(() => undefined)
  }

  async #start(
    stateDir: string,
    hostBundleId: string,
    env: NodeJS.ProcessEnv
  ): Promise<string | null> {
    const command = await executable("cua-driver", env)
    if (!command) return null
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await chmod(stateDir, 0o700)
    await sweepStaleSockets(stateDir)
    const endpoint = await createPrivateControlSocket(
      stateDir,
      `embedded-${process.pid}.sock`
    )
    const socket = endpoint.path
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
    const started = await this.#spawn(command, endpoint, args, {
      ...env,
      ...driverEnv,
    })
    this.#daemon = started
    hostLog("computer", "driver started", {
      pid: started.pid,
      route: "spawn",
      executable: started.executable,
    })
    return started.socket
  }

  async #spawn(
    command: string,
    endpoint: Awaited<ReturnType<typeof createPrivateControlSocket>>,
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<Daemon> {
    const socket = endpoint.path
    this.#stderr = ""
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    })
    trackProviderChild(child, { kind: "cua-driver", owner: "embedded" })
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-8_000)
    })
    let spawnFailure: string | null = null
    child.once("error", (error) => {
      spawnFailure = error.message
    })
    const current: Daemon = {
      pid: child.pid ?? 0,
      socket,
      executable: command,
      child,
      endpoint,
      args,
      env,
    }
    child.once("exit", (code, signal) => {
      if (this.#daemon === current) this.#restart(current, code, signal)
    })
    try {
      await waitForSocket(
        socket,
        () =>
          spawnFailure ??
          (child.exitCode === null
            ? null
            : this.#stderr.trim() ||
              `Embedded CUA Driver exited with ${child.exitCode}`)
      )
    } catch (error) {
      child.kill("SIGTERM")
      await endpoint.close()
      throw error
    }
    return current
  }
}
