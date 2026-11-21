import { hostCommand, hostSpawn } from "../base/host-command.js"
import { endChildInput } from "@mako/sessions/child-input"
import type { ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { access, chmod, mkdir, readdir, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { hostLog } from "../base/host-log.js"
import { trackProviderChild, untrackProviderPid } from "../base/provider-children.js"
import { createPrivateControlSocket, linuxDesktop, videoHelperExecutable } from "@mako/control-runtime/desktop"
<<<<<<< origin/main
import { findExecutable, resolveExecutable, trustedProgram } from "../base/executable.js"
=======
import { daemonAnswers } from "@mako/control-runtime/host"
import { findExecutable } from "../base/executable.js"
import { parseCuaDriverVersion } from "./cua-driver-version.js"
>>>>>>> ca37ac0030788f271e2305a48c10ca1b2471b625
import { onMac, onWindows } from "../base/platform.js"

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
 *
 * On a Linux desktop the same daemon drives the session it was started in:
 * X11 directly (XTest, XComposite, EWMH, AT-SPI), and Wayland through what
 * the compositor offers (portals and libei on GNOME and KDE, wlroots'
 * protocols on Sway and its kin), which the driver enables only when asked
 * (`CUA_DRIVER_RS_ENABLE_WAYLAND`). A Linux machine with no display has no
 * desktop to drive and starts none.
 */
interface Daemon {
  pid: number
  socket: string
  executable: string
  child: ChildProcess
  endpoint: Endpoint
  args: string[]
  env: NodeJS.ProcessEnv
  /** The key the daemon proves itself with on every connection (Windows); none where its socket is a private file. */
  key: string | undefined
  /** Settles when the daemon's process has exited. */
  exited: Promise<void>
}

/**
 * The environment the embedded daemon starts with: the host's, less every variable that configures the driver
 * (`CUA_DRIVER_*`, `CUA_TELEMETRY_ENABLED`), then what the host itself sets. A person's own driver settings are for
 * their own driver: `CUA_DRIVER_RS_MCP_HTTP_PORT` or `CUA_DRIVER_ENVELOPE_HTTP_PORT` inherited here would open a
 * loopback TCP listener beside the daemon's private endpoint, and a policy or permission variable would change what
 * Mako's daemon allows.
 */
export function driverEnvironment(inherited: NodeJS.ProcessEnv, own: Record<string, string>): NodeJS.ProcessEnv {
  const kept = Object.entries(inherited).filter(([name]) => !/^CUA_DRIVER_/i.test(name) && name.toUpperCase() !== "CUA_TELEMETRY_ENABLED")
  return { ...Object.fromEntries(kept), ...own }
}

/** Where the daemon listens: a private Unix socket, or on Windows a named pipe the daemon creates with a current-user ACL. */
interface Endpoint {
  path: string
  close(): Promise<void>
}

/**
 * What a daemon that replaces `current` is started with. On Windows that is a pipe name and a key of its own: the
 * old ones were known to the daemon that exited, and a name or key that is never used twice is worth nothing to
 * whoever learned it. A Unix daemon returns to its private socket file.
 */
async function replacement(current: Daemon): Promise<Pick<Daemon, "endpoint" | "args" | "env">> {
  if (!onWindows()) return current
  const endpoint = await daemonEndpoint("")
  return {
    endpoint,
    args: current.args.map((argument) => (argument === current.socket ? endpoint.path : argument)),
    env: { ...current.env, ...(current.key && { CUA_DRIVER_EMBEDDED_HOST_KEY: randomBytes(32).toString("hex") }) },
  }
}

async function daemonEndpoint(stateDir: string): Promise<Endpoint> {
  // A pipe is no file: it goes when the daemon does, so there is nothing to sweep or unlink. The 128 random bits keep
  // another process from guessing the name; one that takes it first makes the daemon fail to create it (it asks for
  // the first instance) and exit, which the host sees. The daemon's ACL admits this user only, and told this host's
  // pid it serves no other process (`docs/local-control-windows.md`, "The driver's own pipe").
  if (onWindows())
    return { path: `\\\\.\\pipe\\mako-cua-${process.pid}-${randomBytes(16).toString("hex")}`, close: () => Promise.resolve() }
  const endpoint = await createPrivateControlSocket(stateDir, `embedded-${process.pid}.sock`)
  await unlink(endpoint.path).catch(() => undefined)
  return endpoint
}

/**
 * SIGTERM lets a Unix daemon release held input and clean up. Windows has no signal to send, only termination, so
 * there the daemon is asked by closing its stdin (its parent-liveness pipe), and terminated if it is still running
 * two seconds later.
 */
function stopDaemon(child: ChildProcess): void {
  if (!onWindows()) {
    child.kill("SIGTERM")
    return
  }
  endChildInput(child)
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }, 2_000)
  timer.unref()
  child.once("exit", () => clearTimeout(timer))
}

/**
 * The first of Mako's driver releases that answers `prove` (`0008-windows-daemon-proof.patch`). An older driver is
 * still started on Windows, without the proof, because installed apps carry one until they update. Once every
 * supported Windows build ships `+mako.31` or later, `#start` should refuse an older driver there instead.
 */
const PROVING_RELEASE = 31

/** Whether a driver's `--version` output names a release that proves itself to its host. */
export function driverProves(versionOutput: string): boolean {
  const release = /\+mako\.(\d+)$/.exec(parseCuaDriverVersion(versionOutput) ?? "")
  return release !== null && Number(release[1]) >= PROVING_RELEASE
}

/** Asked of the executable the host itself found and is about to start, never of whatever answers on its endpoint. */
async function proves(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    // Asked as the daemon is started: without the person's own driver settings, and reporting nothing.
    const asked = driverEnvironment(env, { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" })
    return driverProves((await hostCommand(command, ["--version"], { env: asked, timeout: 8_000, windowsHide: true })).stdout)
  } catch {
    return false
  }
}

/** The video helper's whole path for the driver, where there is one (`video_helper.rs` in the driver's patch). */
function videoHelperEnvironment(): { CUA_DRIVER_VIDEO_HELPER?: string } {
  const helper = videoHelperExecutable()
  return helper && isAbsolute(helper) ? { CUA_DRIVER_VIDEO_HELPER: helper } : {}
}

const SOCKET_WAIT_MS = 10_000
const SOCKET_POLL_MS = 50
const STARTED_SETTLE_MS = 150
const RESTART_WINDOW_MS = 60_000
const RESTARTS_PER_WINDOW = 3

/**
 * The driver an installed Mako ships beside `Mako.exe` on Windows, used before any on PATH so the installed app drives
 * with the build it was released with: where it really is, and only if no other account could have put it there
 * (`trustedProgram`). Undefined elsewhere, and in a checkout.
 */
export function shippedDriver(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const host = env.MAKO_HOST_EXECUTABLE ?? process.env.MAKO_HOST_EXECUTABLE
  if (!onWindows() || !host) return undefined
  const beside = join(dirname(host), "cua-driver.exe")
  return existsSync(beside) ? trustedProgram(beside, env) : undefined
}

/** The driver this host would run: the one it ships, else the person's own on PATH. */
export function driverExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  return shippedDriver(env) ?? resolveExecutable("cua-driver", env)
}

async function executable(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  // On Windows the host's own resolver finds it: by PATHEXT's extensions, in PATH's whole-path folders and the user's
  // own, and only where no other account could have put it (`executable-trust.ts`). Never a bare name.
  if (onWindows()) return (isAbsolute(command) ? undefined : shippedDriver(env)) ?? findExecutable(command, env)
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

function probe(path: string, key: string | undefined): Promise<boolean> {
  // With a key, only the daemon that holds it counts as listening: another process on the name answers no challenge.
  if (key) return daemonAnswers(path, { key })
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
  key: string | undefined,
  exited: () => string | null
): Promise<void> {
  const deadline = Date.now() + SOCKET_WAIT_MS
  while (Date.now() < deadline) {
    const failure = exited()
    if (failure !== null) throw new Error(failure)
    if (await probe(path, key)) return
    await new Promise((resolve) => setTimeout(resolve, SOCKET_POLL_MS))
  }
  throw new Error("Embedded CUA Driver did not open its private socket")
}

/**
 * Mako's embedded driver daemon: `ensure` starts it, or returns the running
 * one's socket, and an unexpected exit is replaced.
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
    if (!onMac() && !onWindows() && !linuxDesktop(env)) return Promise.resolve(null)
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

  /** The running daemon for the driver broker: its endpoint, the key it proves itself with, and its process's end. */
  address(): { path: string; key?: string; exited: Promise<void> } | null {
    const daemon = this.#daemon
    return daemon ? { path: daemon.socket, ...(daemon.key && { key: daemon.key }), exited: daemon.exited } : null
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
    stopDaemon(running.child)
    void running.endpoint.close().catch(() => undefined)
  }

  /**
   * An unexpected exit is replaced: on the same socket file on a Mac or Linux, and on Windows on a new pipe name
   * with a new key (`replacement`), which the driver broker reads from `ensure` and `address` when it reconnects.
   * A daemon that keeps exiting is left down until the next `ensure`.
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
      if (!onWindows()) await unlink(current.socket).catch(() => undefined)
      const { endpoint, args, env } = await replacement(current)
      const next = await this.#spawn(current.executable, endpoint, args, env)
      if (generation !== this.#stops) {
        stopDaemon(next.child)
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
    const endpoint = await daemonEndpoint(stateDir)
    const socket = endpoint.path
    // The proof is asked only on Windows, where the endpoint is a pipe whose name anyone can take, and only of a
    // driver that can give it: an older build is started as before, and the log says so.
    const key = onWindows() && (await proves(command, env)) ? randomBytes(32).toString("hex") : undefined
    if (onWindows() && !key) hostLog("computer", "driver predates the proof handshake; started without it", { executable: command })
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
      ...(linuxDesktop(env)?.session === "wayland" && { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" }),
      // A Windows pipe has no peer credentials to read the parent from: the daemon trusts this host's connections by
      // the pid it is given. And the daemon ends when this host's end of its stdin closes, so a host that is killed
      // leaves no driver behind; there is no process group to take it with the host.
      ...(onWindows() && {
        CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
        CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
        // What only this host and its daemon hold: every connection has the far end answer a challenge keyed with
        // it, so a process that took the pipe's name before the daemon could is never spoken to.
        ...(key && { CUA_DRIVER_EMBEDDED_HOST_KEY: key }),
        // A window's recording is captured and encoded by Mako's video helper, which the driver runs by this whole
        // path and never looks up itself; without it the driver refuses window video. No FFmpeg is involved.
        ...videoHelperEnvironment(),
      }),
    }
    // Cua's documented daemon API disables the overlay at construction. Hiding
    // a session cursor after startup still left the installed 0.28.0 build
    // awaiting its glide before semantic AX actions; --no-overlay removes that
    // render path entirely and keeps background control visually quiet.
    const args = ["serve", "--embedded", "--no-overlay", "--socket", socket]
    const started = await this.#spawn(command, endpoint, args, driverEnvironment(env, driverEnv))
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
    endpoint: Endpoint,
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<Daemon> {
    const socket = endpoint.path
    this.#stderr = ""
    const child = hostSpawn(command, args, {
      env,
      // Windows looks a program or file named without its folder up in the current folder too (ShellExecute, which
      // launch_app uses): the driver runs in its own folder, never in whatever folder the host was started from.
      ...(onWindows() && { cwd: dirname(command) }),
      stdio: [onWindows() ? "pipe" : "ignore", "ignore", "pipe"],
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
      key: env.CUA_DRIVER_EMBEDDED_HOST_KEY,
      exited: new Promise((resolve) => child.once("exit", () => resolve())),
    }
    child.once("exit", (code, signal) => {
      if (this.#daemon === current) this.#restart(current, code, signal)
    })
    try {
      await waitForSocket(
        socket,
        current.key,
        () =>
          spawnFailure ??
          (child.exitCode === null
            ? null
            : this.#stderr.trim() ||
              `Embedded CUA Driver exited with ${child.exitCode}`)
      )
      // Started means still running a moment after it first answered: a daemon that could not take its pipe's name
      // (another process made it first) exits at once, and whatever answered then was not it.
      if (onWindows()) await new Promise((resolve) => setTimeout(resolve, STARTED_SETTLE_MS))
      if (spawnFailure !== null || child.exitCode !== null || child.signalCode !== null)
        throw new Error(spawnFailure ?? (this.#stderr.trim() || `Embedded CUA Driver exited with ${child.exitCode ?? child.signalCode}`))
    } catch (error) {
      stopDaemon(child)
      await endpoint.close()
      throw error
    }
    return current
  }
}
