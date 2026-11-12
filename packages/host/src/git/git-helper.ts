import { ChildProcess, type SpawnOptions, type spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import type { ProcessRunner } from "@mako/git/process-runner"
import { sendToChild } from "@mako/sessions/child-input"
import { errorMessage } from "../base/error-message.js"
import { headlessNodeExecutable } from "../base/headless-node.js"
import { hostFork } from "../base/host-command.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { HelperSaysSchema, type HelperAsk, type HelperSays } from "./git-helper-protocol.js"

type Runner = Pick<ProcessRunner, "spawn" | "close">
type Signal = Extract<HelperAsk, { t: "close" }>["signal"]
/** What a `ChildProcess` holds of its process that `HelperChild` sets as the helper says it. */
type ChildField = Readable | Writable | null | readonly (Readable | Writable | null)[] | number | string | undefined

/** After the helper ends, Git spawns directly for this long, doubling to `RETRY_MAX_MS` while it keeps ending. */
const RETRY_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/**
 * One `git` process the helper runs, as the host's `Git` sees a child of its own: `stdout` and `stderr` say `data`,
 * `stdin` takes what Git writes, and the child says `error` and `close` with Node's code and signal, in the order the
 * helper heard them. It's a `ChildProcess` that was never spawned here: nothing else of one is read by `Git.run`, and
 * its stop is the helper's (`GitHelper.close`).
 */
class HelperChild extends ChildProcess {
  closed = false
  readonly #out = new Readable({ read() {} })
  readonly #err = new Readable({ read() {} })
  readonly #ended: Promise<void>
  #end!: () => void
  /** A stop the host asked for, settled once the helper has reaped its group (`closed`), as the runner's `close` is. */
  #stopping: { done: Promise<void>; settle: (error?: string) => void } | undefined

  readonly id: number

  constructor(id: number, send: (ask: HelperAsk) => void, piped: boolean) {
    super()
    this.id = id
    this.#ended = new Promise((resolve) => { this.#end = resolve })
    const stdin = piped ? new Writable({
      write: (chunk: Buffer, _encoding, done) => { send({ t: "stdin", id, chunk }); done() },
      final: (done) => { send({ t: "stdin-end", id }); done() },
    }) : null
    // A `ChildProcess` declares these its own; this one's are the helper's process's, as it says them.
    this.#set("stdin", stdin)
    this.#set("stdout", this.#out)
    this.#set("stderr", this.#err)
    this.#set("stdio", [stdin, this.#out, this.#err])
  }

  #set(key: "stdin" | "stdout" | "stderr" | "stdio" | "pid" | "exitCode" | "signalCode", value: ChildField): void {
    Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: true })
  }

  ended(): Promise<void> {
    return this.#ended
  }

  /** Waits for the stop asked for: the helper's word that the group is gone, and the end it said before or after. */
  stopping(): Promise<void> {
    if (!this.#stopping) {
      let settle!: (error?: string) => void
      const acknowledged = new Promise<void>((resolve, reject) => { settle = (error) => (error === undefined ? resolve() : reject(new Error(error))) })
      this.#stopping = { done: Promise.all([acknowledged, this.#ended]).then(() => {}), settle }
    }
    return this.#stopping.done
  }

  hear(said: HelperSays): void {
    if (said.t === "spawned") this.#set("pid", said.pid || undefined)
    else if (said.t === "out") this.#out.push(Buffer.from(said.chunk.buffer, said.chunk.byteOffset, said.chunk.byteLength))
    else if (said.t === "err") this.#err.push(Buffer.from(said.chunk.buffer, said.chunk.byteOffset, said.chunk.byteLength))
    else if (said.t === "error") this.emit("error", Object.assign(new Error(said.message), { code: said.code, errno: said.errno, syscall: said.syscall, path: said.path }))
    else if (said.t === "close") this.finish(said.code, said.signal)
    else this.#stopping?.settle(said.error)
  }

  finish(code: number | null, signal: string | null): void {
    if (this.closed) return
    this.closed = true
    this.#set("exitCode", code)
    this.#set("signalCode", signal)
    this.#out.push(null)
    this.#err.push(null)
    this.emit("exit", code, signal)
    this.emit("close", code, signal)
    this.#end()
  }

  /** The helper is gone: a stop asked for is as done as it will be. */
  abandon(): void {
    this.#stopping?.settle()
  }
}

/**
 * The host's `git` processes through one long-lived child (`git-helper-main.ts`), so its own thread pays no fork and
 * exec for each: about 0.5 ms of the host's thread a run when it spawns them itself, 0.07 ms through the helper, and
 * its worst loop gap 15–17 ms against 6–7 ms (loop-holds' measure, 300 runs on a 300 MB heap). `Git` runs as it does
 * on a child of its own: its output, its exit code, an error starting it, its stop on a cancel, a timeout or too much
 * output, and its trace are what they were. The helper starts on the first `git`, through `hostFork`, so the host's
 * stop ends it and every process it runs. A command it can't carry (stdio other than Git's own) and every command
 * while it's down go to `direct`, the host's own spawn; one that dies fails what it was running, as a killed `git`
 * would, kills their process groups, and is started again after a pause.
 */
export class GitHelper {
  readonly #direct: Runner
  readonly #entry: string
  #child: ChildProcess | undefined
  readonly #running = new Map<number, HelperChild>()
  #next = 0
  #retryAt = 0
  #retryMs = RETRY_MS
  #stopped = false

  constructor(direct: Runner, entry = defaultEntry()) {
    this.#direct = direct
    this.#entry = entry
  }

  /** What `Git` spawns and closes its processes with. */
  runner(): Runner {
    // SAFETY: `Git.run` reads only what `HelperChild` gives of a child (its streams, events, codes and pid); a spawn
    // the helper can't carry gets a real child from `direct`.
    const launch = ((file: string, args: readonly string[], options: SpawnOptions) => this.spawn(file, args, options)) as typeof spawn
    return { spawn: launch, close: (child, first) => this.close(child, first) }
  }

  /** Ends the helper and everything it runs. */
  async stop(): Promise<void> {
    this.#stopped = true
    const child = this.#child
    this.#child = undefined
    if (child) {
      // Held while it ends, so whoever stops it waits for it. The runner's stop signals its group, and it ends every
      // git it runs first (`git-helper-main.ts`); a disconnect first left Node never saying the child closed.
      child.ref()
      await this.#direct.close(child).catch(() => {})
    }
    this.#lost("Mako's Git helper stopped")
  }

  private spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const stdio = Array.isArray(options.stdio) ? options.stdio : undefined
    const stdin = stdio?.[0]
    const { cwd } = options
    const carried = stdio?.length === 3 && (stdin === "ignore" || stdin === "pipe") && stdio[1] === "pipe" && stdio[2] === "pipe" &&
      !options.detached && options.shell === undefined
    const helper = carried && cwd !== undefined && !(cwd instanceof URL) ? this.#helper() : undefined
    if (!helper || cwd === undefined || cwd instanceof URL) return this.#direct.spawn(file, args, options)
    const id = (this.#next += 1)
    const send = (ask: HelperAsk) => { sendToChild(helper, ask).catch(() => {}) }
    const child = new HelperChild(id, send, stdin === "pipe")
    this.#running.set(id, child)
    this.#busy(helper)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[key] = value
    send({ t: "spawn", id, file, args: [...args], cwd, env, stdin: stdin === "pipe" ? "pipe" : "ignore" })
    return child
  }

  private close(child: ChildProcess, first?: NodeJS.Signals | number): Promise<void> {
    if (!(child instanceof HelperChild)) return this.#direct.close(child, first)
    if (child.closed) return Promise.resolve()
    const helper = this.#child
    const signal: Signal = first === "SIGKILL" || first === "SIGINT" || first === "SIGHUP" ? first : undefined
    const stopped = child.stopping()
    if (helper) sendToChild(helper, { t: "close", id: child.id, ...(signal && { signal }) } satisfies HelperAsk).catch(() => child.abandon())
    else child.abandon()
    return stopped
  }

  /** The helper, started on first use; undefined while it's down and waiting to be tried again, or stopped. */
  #helper(): ChildProcess | undefined {
    if (this.#child) return this.#child
    if (this.#stopped || Date.now() < this.#retryAt) return undefined
    let child: ChildProcess
    try {
      child = hostFork(this.#entry, [], {
        execPath: headlessNodeExecutable(),
        // Under tsx (tests, development scripts) the child needs its loader to run TypeScript.
        execArgv: this.#entry.endsWith(".ts") ? process.execArgv : [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
      })
    } catch (error) {
      this.#down(`it could not start: ${errorMessage({ error })}`)
      return undefined
    }
    this.#child = child
    // It never keeps a process alive by itself: only while it runs a `git` someone waits on (`#busy`).
    child.unref()
    child.channel?.unref()
    child.on("message", (raw) => {
      const said = HelperSaysSchema.safeParse(raw)
      if (!said.success) return
      const running = this.#running.get(said.data.id)
      if (!running) return
      running.hear(said.data)
      if (said.data.t === "close") {
        this.#running.delete(said.data.id)
        // A git that ran to its end: the helper works, so its next fall is waited out from the start again.
        this.#retryMs = RETRY_MS
        if (!this.#running.size) child.channel?.unref()
      }
    })
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#down(`it ended (${signal ?? `code ${code}`})`)
    })
    child.once("error", (error) => {
      if (this.#child !== child) return
      this.#child = undefined
      void this.#direct.close(child).catch(() => {})
      this.#down(`it failed: ${error.message}`)
    })
    hostLog("git", "helper started", { pid: child.pid ?? 0 })
    return child
  }

  #busy(helper: ChildProcess): void {
    helper.channel?.ref()
  }

  /** The helper is gone: what it ran ends as killed, and Git spawns directly until it's tried again. */
  #down(why: string): void {
    if (!this.#stopped) {
      this.#retryAt = Date.now() + this.#retryMs
      hostWarn("git", "helper down; Git spawns directly for now", { why, retryInMs: this.#retryMs, running: this.#running.size })
      this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS)
    }
    this.#lost(why)
  }

  /** Every `git` the helper ran ends as one killed: its group, which the helper made, is killed from here too. */
  #lost(why: string): void {
    for (const [id, child] of this.#running) {
      this.#running.delete(id)
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL") } catch { /* gone already */ }
      }
      hostLog("git", "a git the helper ran ended with it", { id, pid: child.pid ?? 0, why })
      child.finish(null, "SIGKILL")
      child.abandon()
    }
  }
}

function defaultEntry(): string {
  const compiled = fileURLToPath(new URL("./git-helper-main.js", import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}
