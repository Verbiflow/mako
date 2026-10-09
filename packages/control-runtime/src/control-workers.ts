import { fork, type ChildProcess, type Serializable } from "node:child_process"
import type { Server, Socket } from "node:net"
import { fileURLToPath } from "node:url"
import { ControlFault } from "@mako/control/control"
import { controlSessionBuild, type SessionDescriptor } from "./control-session-protocol.js"
import { DesktopWorkerReplySchema, type DesktopSessionConfig, type DesktopWorkerReply } from "./desktop-session-config.js"

/** What a worker inherits: no credentials, which reach it in its `bind`. */
const INHERITED = [
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TEMP", "TMP", "TZ",
  "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY", "GDK_BACKEND", "QT_QPA_PLATFORM",
  "MAKO_CONTROL_MEDIA_ROOT", "MAKO_CONTROL_ASYNC_GUARD",
]

export interface ControlWorkerOptions {
  executable?: string
  env?: NodeJS.ProcessEnv
  startupMs?: number
  onSpawn?: (child: ChildProcess) => void
}

/** One worker process: loaded and waiting, then serving one task's session. */
export class ControlWorker {
  readonly exited: Promise<"stopped" | "failed">
  /** Resolves with the build of the code it loaded. */
  readonly loaded: Promise<string>
  private readonly child: ChildProcess
  private readonly startupMs: number
  private stopping: Promise<void> | undefined
  private gone = false

  constructor(options: ControlWorkerOptions = {}) {
    const supplied = options.env ?? process.env
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" }
    for (const key of INHERITED) if (supplied[key] !== undefined) env[key] = supplied[key]
    this.startupMs = options.startupMs ?? 20_000
    this.child = fork(fileURLToPath(new URL("./desktop-session-worker.js", import.meta.url)), [], {
      execPath: options.executable ?? process.execPath,
      execArgv: [],
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    // Never echo driver/page contents or launch credentials into provider logs.
    this.child.stderr?.resume()
    this.exited = new Promise((resolve) => {
      const done = (code: number | null) => {
        this.gone = true
        resolve(code === 0 ? "stopped" : "failed")
      }
      this.child.once("exit", done)
      this.child.once("error", () => done(null))
    })
    this.loaded = this.until("loaded", (reply) => reply.kind === "loaded" ? reply.build : undefined)
    void this.loaded.catch(() => this.stop())
    options.onSpawn?.(this.child)
  }

  get pid(): number | undefined {
    return this.gone ? undefined : this.child.pid
  }

  /**
   * Serve one task's session on a listener this process made, which the
   * worker accepts on from now on. Refused before anything is sent when the
   * worker loaded other code than the session's clients speak.
   */
  async bind(config: DesktopSessionConfig, descriptor: SessionDescriptor, directory: string, listener: Server): Promise<void> {
    if ((await this.loaded) !== descriptor.build)
      throw new ControlFault(
        "incompatible-session",
        "Local Control is off for this task: this Mako host is older than the Local Control code on disk. Restart Mako to load it; no action was dispatched.",
        "not-dispatched"
      )
    const ready = this.until("ready", (reply) => reply.kind === "ready" || undefined)
    this.child.send({ kind: "bind", config, descriptor, directory }, listener, (error) => {
      if (error) void this.stop()
    })
    await ready
  }

  /** A connection that reached this process first; the worker answers it, or `orElse` when it can't. */
  hand(connection: Socket, orElse: (connection: Socket) => void): void {
    if (this.gone || !this.child.connected) return orElse(connection)
    this.child.send({ kind: "connection" }, connection, (error) => {
      if (error) orElse(connection)
    })
  }

  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      if (!this.gone && this.child.connected) this.child.send({ kind: "stop" }, () => {})
      const deadline = setTimeout(() => this.child.kill("SIGKILL"), 17_000)
      try {
        await this.exited
      } finally {
        clearTimeout(deadline)
      }
    })())
  }

  /** The first reply `pick` accepts; a failure, an exit or the deadline rejects. */
  private until<T>(what: string, pick: (reply: DesktopWorkerReply) => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Local Control worker didn't report ${what} in time`)), this.startupMs)
      const received = (raw: Serializable) => {
        const reply = DesktopWorkerReplySchema.safeParse(raw)
        if (!reply.success) return
        if (reply.data.kind === "failed") return fail(new Error("Local Control session startup failed"))
        const value = pick(reply.data)
        if (value === undefined) return
        settle()
        resolve(value)
      }
      const settle = () => {
        clearTimeout(timer)
        this.child.off("message", received)
      }
      const fail = (error: Error) => {
        settle()
        reject(error)
      }
      this.child.on("message", received)
      void this.exited.then(() => fail(new Error("Local Control worker exited before becoming ready")))
    })
  }
}

/**
 * Where tasks get their workers. The first task that uses the computer waits
 * for one to load; from then on one loaded spare waits for the next, refilled
 * after each is taken and stopped after `quietMs` without one being taken.
 */
export class ControlWorkers {
  private spare: ControlWorker | undefined
  private quiet: NodeJS.Timeout | undefined
  private closed = false
  private outdated = false
  private readonly options: ControlWorkerOptions & { spare: boolean; quietMs: number }

  constructor(options: ControlWorkerOptions & { spare?: boolean; quietMs?: number } = {}) {
    this.options = { ...options, spare: options.spare ?? true, quietMs: options.quietMs ?? 10 * 60_000 }
  }

  /**
   * The code on disk is newer than this process's: a worker loaded it. New
   * tasks go without Local Control until a restart.
   */
  get stale(): boolean {
    return this.outdated
  }

  /** The spare's process, while one is loaded or loading. */
  get sparePid(): number | undefined {
    return this.spare?.pid
  }

  take(): ControlWorker {
    if (this.closed) throw new Error("Local Control supervisor is closing")
    const worker = this.spare ?? this.spawn()
    this.spare = undefined
    if (this.options.spare) {
      void worker.loaded.then(() => this.refill(), () => {})
      clearTimeout(this.quiet)
      this.quiet = setTimeout(() => {
        const idle = this.spare
        this.spare = undefined
        this.quiet = undefined
        void idle?.stop()
      }, this.options.quietMs)
      this.quiet.unref()
    }
    return worker
  }

  close(): Promise<void> {
    this.closed = true
    clearTimeout(this.quiet)
    const spare = this.spare
    this.spare = undefined
    return spare ? spare.stop() : Promise.resolve()
  }

  private refill(): void {
    if (this.closed || this.outdated || this.spare || !this.quiet) return
    const spare = this.spawn()
    this.spare = spare
    void spare.exited.then(() => {
      if (this.spare === spare) this.spare = undefined
    })
  }

  private spawn(): ControlWorker {
    const worker = new ControlWorker(this.options)
    void Promise.all([worker.loaded, controlSessionBuild()]).then(([loaded, own]) => {
      if (loaded === own) return
      this.outdated = true
      if (this.spare === worker) {
        this.spare = undefined
        void worker.stop()
      }
    }, () => {})
    return worker
  }
}
