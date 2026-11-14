import { hostSpawn } from "../../base/host-command.js"
import type { SpawnOptions } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname } from "node:path"
import { z } from "zod"
import { hostLog, hostWarn } from "../../base/host-log.js"
import type { Run } from "./setup.js"

const READY_MS = 30_000
const READY_POLL_MS = 150
/** A child up this long had a good run, so its next exit restarts at once. */
const STABLE_MS = 60_000
const RESTART_MAX_MS = 30_000

const Recorded = z.object({ pid: z.number().int(), port: z.number().int(), entry: z.string() })

/** As much of a spawned child as a tool's server needs. */
export interface ToolChild {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): void } | null
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): void } | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  once(event: "error", listener: (error: Error) => void): void
}

export type ToolSpawn = (command: string, args: string[], options: SpawnOptions) => ToolChild

export interface ToolProcessOptions {
  /** `serve-sim`, `inspect-webkit`: for host.log and errors. */
  name: string
  /** The tool's script, run by this process's own Node. */
  entry: string
  /** Node's own flags, before the entry. */
  execArgv?: string[]
  args: (port: number) => string[]
  env: NodeJS.ProcessEnv
  /** Answers once the tool can serve. */
  ready: (origin: string) => Promise<boolean>
  /** Where the running child is recorded, so a host that crashed has its child stopped by the next. */
  stateFile: string
  run: Run
  spawn?: ToolSpawn
  /** Node to run the tool with; this process's own, as Node, by default. */
  node?: string
}

/**
 * A pinned tool's server, on a loopback port only this host knows: started on first use, restarted when it exits
 * (at once after a long run, else backing off to 30 s), and stopped with the host. Nothing outside the host is given
 * its port: every client reaches a simulator through the host's own calls.
 */
export class ToolProcess {
  readonly #options: ToolProcessOptions
  /** The child from the moment it's spawned, so a stop while it starts still stops it. */
  #child: ToolChild | undefined
  /** Set once the child serves: until then nothing is told where it is. */
  #origin: string | undefined
  #starting: Promise<string> | undefined
  /** Moved on by each stop: a start or restart begun before it ends without publishing anything. */
  #generation = 0
  #startedAt = 0
  #restartMs = 0

  constructor(options: ToolProcessOptions) {
    this.#options = options
  }

  /** The loopback origin it serves on, started if it isn't. */
  origin(): Promise<string> {
    if (this.#origin && this.#child && alive(this.#child)) return Promise.resolve(this.#origin)
    if (this.#starting) return this.#starting
    const starting: Promise<string> = this.#start(this.#generation).finally(() => {
      if (this.#starting === starting) this.#starting = undefined
    })
    this.#starting = starting
    return starting
  }

  get running(): boolean {
    return this.#child !== undefined && alive(this.#child) && this.#origin !== undefined
  }

  async #start(generation: number): Promise<string> {
    await reapRecorded(this.#options)
    const port = await freeLoopbackPort()
    if (generation !== this.#generation) throw this.#stoppedError()
    const origin = `http://127.0.0.1:${port}`
    const start: ToolSpawn = this.#options.spawn ?? hostSpawn
    const child = start(this.#options.node ?? process.execPath, [...(this.#options.execArgv ?? []), this.#options.entry, ...this.#options.args(port)], {
      env: { ...this.#options.env, ELECTRON_RUN_AS_NODE: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      // Its stdin closes when this host dies however it dies, and the tool exits with it.
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    })
    this.#child = child
    let said = ""
    const hear = (chunk: Buffer) => {
      said = `${said}${chunk.toString("utf8")}`.slice(-4_000)
    }
    child.stdout?.on("data", hear)
    child.stderr?.on("data", hear)
    const exited = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(new Error(`${this.#options.name} didn't start: ${error.message}`)))
      child.once("exit", (code, signal) => reject(new Error(`${this.#options.name} exited before it could serve (${signal ?? `exit ${code}`})${said.trim() ? `: ${lastLines(said)}` : ""}`)))
    })
    exited.catch(() => undefined)
    try {
      await Promise.race([waitReady(origin, this.#options.ready), exited])
      if (generation !== this.#generation) throw this.#stoppedError()
      child.once("exit", (code, signal) => void this.#exited(child, generation, code, signal, said))
      await mkdir(dirname(this.#options.stateFile), { recursive: true })
      await writeFile(this.#options.stateFile, `${JSON.stringify({ pid: child.pid, port, entry: this.#options.entry })}\n`)
      if (generation !== this.#generation) throw this.#stoppedError()
    } catch (error) {
      if (this.#child === child) this.#child = undefined
      child.kill("SIGTERM")
      throw generation === this.#generation ? error : this.#stoppedError()
    }
    this.#origin = origin
    this.#startedAt = Date.now()
    hostLog("simulators", "tool started", { tool: this.#options.name, pid: child.pid ?? 0, port })
    return origin
  }

  async #exited(child: ToolChild, generation: number, code: number | null, signal: NodeJS.Signals | null, said: string): Promise<void> {
    if (this.#child !== child || generation !== this.#generation) return
    this.#child = undefined
    this.#origin = undefined
    const uptime = Date.now() - this.#startedAt
    this.#restartMs = uptime >= STABLE_MS ? 0 : Math.min(RESTART_MAX_MS, this.#restartMs ? this.#restartMs * 2 : 1_000)
    hostWarn("simulators", "tool exited", { tool: this.#options.name, code: code ?? -1, signal: signal ?? "", uptimeMs: uptime, restartMs: this.#restartMs, said: lastLines(said) })
    await new Promise((resolve) => setTimeout(resolve, this.#restartMs).unref())
    if (generation === this.#generation && !this.#child) await this.origin().catch((error) => hostWarn("simulators", "tool restart failed", { tool: this.#options.name, error: error instanceof Error ? error.message : String(error) }))
  }

  /** Stops the child, running or still starting; a start in flight then fails as stopped. */
  async stop(): Promise<void> {
    this.#generation++
    const child = this.#child
    const starting = this.#starting
    this.#child = undefined
    this.#origin = undefined
    this.#starting = undefined
    if (child && alive(child)) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
      await exited
      clearTimeout(timer)
    }
    await starting?.catch(() => undefined)
    await rm(this.#options.stateFile, { force: true })
  }

  #stoppedError(): Error {
    return new Error(`${this.#options.name} was stopped while it started`)
  }
}

/** A child killed by a signal keeps a null exit code, so both say whether it has gone. */
function alive(child: ToolChild): boolean {
  return child.exitCode === null && child.signalCode === null
}

/** A child the last host recorded, stopped if it's still that tool: its PID may have been reused since. */
async function reapRecorded(options: ToolProcessOptions): Promise<void> {
  const text = await readFile(options.stateFile, "utf8").catch(() => null)
  if (text === null) return
  await rm(options.stateFile, { force: true })
  let recorded: z.infer<typeof Recorded> | undefined
  try {
    recorded = Recorded.safeParse(JSON.parse(text)).data
  } catch {
    return
  }
  if (!recorded) return
  const { stdout, code } = await options.run("/bin/ps", ["-o", "command=", "-p", String(recorded.pid)])
  if (code !== 0 || !stdout.includes(recorded.entry)) return
  hostWarn("simulators", "stopping a tool a previous host left", { tool: options.name, pid: recorded.pid, port: recorded.port })
  try {
    process.kill(recorded.pid, "SIGTERM")
  } catch {
    /* gone already */
  }
}

async function waitReady(origin: string, ready: (origin: string) => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_MS
  while (Date.now() < deadline) {
    if (await ready(origin).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  throw new Error(`It didn't answer on ${origin} within ${READY_MS / 1000} s`)
}

/** A port free on loopback now; the tool binds it a moment later, and a race lost is a start that fails and retries. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = z.object({ port: z.number() }).safeParse(server.address()).data
      server.close(() => (address ? resolve(address.port) : reject(new Error("No loopback port"))))
    })
  })
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 400)
}
