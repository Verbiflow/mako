import { ChildProcess, type SpawnOptions, type spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { GitError } from "@mako/git"
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
/** A helper that hasn't said a `git` started this long after it was asked is wedged (stopped, blocked, its IPC jammed). */
const SPAWN_WATCH_MS = 5_000
/** Nor one that hasn't said a `git` ended this long after a stop was asked: the runner's own stop takes at most 5 s. */
const CLOSE_WATCH_MS = 8_000
const FolderSchema = z.string()

/** A watch that fires later than this past its time fired after the host's own loop was held, not the helper. */
const WATCH_LATE_MS = 1_000
/** A `git` the helper started, lost with it, is waited for this long before its result is said unknown. */
const ORPHAN_WAIT_MS = 60_000

/**
 * One `git` process the helper runs, as the host's `Git` sees a child of its own: `stdout` and `stderr` say `data`,
 * `stdin` takes what Git writes, and the child says `error` and `close` with Node's code and signal, in the order the
 * helper heard them. It's a `ChildProcess` that was never spawned here: nothing else of one is read by `Git.run`, and
 * its stop is the helper's (`GitHelper.close`).
 *
 * It is made as an `EventEmitter` with `ChildProcess`'s prototype after its own, never through `ChildProcess`'s
 * constructor: that one makes a native process handle, which a child never spawned can't close, and which holds its
 * owner from the host's roots for the host's life. Under bench:host-load's sends on 2026-11-12 the host held 25,673
 * finished `git` runs that way, and 1.1 GB of live heap, after 80 sends. Every method of a `ChildProcess` checks for
 * its handle before using one, so with none they do nothing, as they did for this child before.
 */
class HelperChild extends EventEmitter {
  /** The `git`'s pid once the helper says it started (`#set`), as a `ChildProcess`'s is. */
  declare readonly pid: number | undefined
  closed = false
  /** `Git.run` asked it stopped (a timeout, a cancel, too much output). */
  stopAsked = false
  /** Its helper was lost while it ran, under this pid: it's followed from here. */
  orphan = false
  /** A watch on the helper for this process (`GitHelper.#watch`). */
  watch: ReturnType<typeof setTimeout> | undefined
  /** The subcommand, for what's said of it. */
  readonly command: string
  /** The helper that runs it: only that helper's loss is its. */
  readonly owner: ChildProcess
  readonly #out = new Readable({ read() {} })
  readonly #err = new Readable({ read() {} })
  readonly #ended: Promise<void>
  #end!: () => void
  /** A stop the host asked for, settled once the helper has reaped its group (`closed`), as the runner's `close` is. */
  #stopping: { done: Promise<void>; settle: (error?: string) => void } | undefined

  readonly id: number

  constructor(id: number, command: string, owner: ChildProcess, send: (ask: HelperAsk) => void, piped: boolean) {
    super()
    // What `ChildProcess`'s constructor would have set, which `Git.run` reads until the helper says otherwise.
    this.#set("exitCode", null)
    this.#set("signalCode", null)
    Object.defineProperty(this, "killed", { value: false, writable: true, configurable: true, enumerable: true })
    this.id = id
    this.command = command
    this.owner = owner
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

  /** It ends as `error` says, which `Git.run` passes on as it is. */
  fail(error: GitError): void {
    if (this.closed) return
    this.emit("error", error)
    this.finish(null, null)
  }
}

// `instanceof ChildProcess` and its methods, through its prototype, with none of its constructor's handle.
Object.setPrototypeOf(HelperChild.prototype, ChildProcess.prototype)

/** A helper's child as the `ChildProcess` its prototype makes it, which is what the runner's `spawn` answers. */
function asChildProcess(child: HelperChild): ChildProcess {
  if (!(child instanceof ChildProcess)) throw new Error("A Git helper's child must be a ChildProcess")
  return child
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
  /** Why a helper let go of was lost, said when it closes. */
  readonly #lostWhy = new WeakMap<ChildProcess, string>()

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

  /** The helper's process while it runs, for diagnostics and tests. */
  pid(): number | undefined {
    return this.#child?.pid
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
      this.#lost(child, "Mako's Git helper stopped")
    }
  }

  private spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const stdio = Array.isArray(options.stdio) ? options.stdio : undefined
    const stdin = stdio?.[0]
    // A folder given as a path; one given as a URL, or none, goes to the host's own spawn.
    const cwd = FolderSchema.safeParse(options.cwd).data
    const carried = stdio?.length === 3 && (stdin === "ignore" || stdin === "pipe") && stdio[1] === "pipe" && stdio[2] === "pipe" &&
      !options.detached && options.shell === undefined
    const helper = carried && cwd !== undefined ? this.#helper() : undefined
    if (!helper || cwd === undefined) return this.#direct.spawn(file, args, options)
    const id = (this.#next += 1)
    const send = (ask: HelperAsk) => { sendToChild(helper, ask).catch(() => {}) }
    const command = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""
    const child = new HelperChild(id, command, helper, send, stdin === "pipe")
    this.#running.set(id, child)
    this.#busy(helper)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[key] = value
    send({ t: "spawn", id, file, args: [...args], cwd, env, stdin: stdin === "pipe" ? "pipe" : "ignore" })
    this.#watch(child, "that it started", SPAWN_WATCH_MS)
    return asChildProcess(child)
  }

  private close(child: ChildProcess, first?: NodeJS.Signals | number): Promise<void> {
    if (!(child instanceof HelperChild)) return this.#direct.close(child, first)
    if (child.closed) return Promise.resolve()
    child.stopAsked = true
    // Lost with its helper: stopped from here, as the host's runner stops a child of its own.
    if (child.orphan) {
      void this.#stopOrphan(child)
      return child.ended()
    }
    const helper = this.#child
    const signal: Signal = first === "SIGKILL" || first === "SIGINT" || first === "SIGHUP" ? first : undefined
    const stopped = child.stopping()
    if (helper) {
      sendToChild(helper, { t: "close", id: child.id, ...(signal && { signal }) } satisfies HelperAsk).catch(() => child.abandon())
      this.#watch(child, "that it stopped", CLOSE_WATCH_MS)
    } else child.abandon()
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
      if (said.data.t === "spawned" || said.data.t === "close" || said.data.t === "closed") {
        clearTimeout(running.watch)
        running.watch = undefined
      }
      running.hear(said.data)
      if (said.data.t === "close") {
        this.#running.delete(said.data.id)
        // A git that ran to its end: the helper works, so its next fall is waited out from the start again.
        this.#retryMs = RETRY_MS
        if (!this.#running.size) child.channel?.unref()
      }
    })
    // What it ran is settled once it's closed: after its exit, what it had said before it went has all been read, so
    // a `git` it started and said so of is followed, never taken for one that didn't start.
    child.once("close", (code, signal) => {
      const why = this.#lostWhy.get(child) ?? `it ended (${signal ?? `code ${code}`})`
      this.#lostWhy.delete(child)
      if (this.#child === child) {
        this.#child = undefined
        this.#down(why)
      }
      this.#lost(child, why)
    })
    child.once("error", (error) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#lostWhy.set(child, `it failed: ${error.message}`)
      this.#down(`it failed: ${error.message}`)
      void this.#direct.close(child).catch(() => {})
    })
    hostLog("git", "helper started", { pid: child.pid ?? 0 })
    return child
  }

  #busy(helper: ChildProcess): void {
    helper.channel?.ref()
  }

  /** Waits `ms` for the helper to say `what` of `child`; a helper that doesn't is wedged. */
  #watch(child: HelperChild, what: string, ms: number, again = true): void {
    clearTimeout(child.watch)
    const due = performance.now() + ms
    child.watch = setTimeout(() => {
      // A watch that fires late fired after a held loop: the helper's word may be waiting, unread, behind it. It's given
      // the same time again, once, so a healthy helper is never taken for wedged because the host's own loop stalled.
      if (again && performance.now() - due > WATCH_LATE_MS) {
        hostLog("git", "a helper watch fired late; it waits once more", { command: child.command, lateMs: Math.round(performance.now() - due) })
        return this.#watch(child, what, ms, false)
      }
      this.#wedged(`it didn't say ${what} of git ${child.command} within ${ms} ms`)
    }, ms)
    child.watch.unref?.()
  }

  /**
   * The helper is alive and says nothing (stopped, blocked, its IPC jammed): every `git` sent to it would wait for
   * good, and the read slots with them. It's killed, its own group only (each `git` it started has one of its own and
   * is followed as one lost with it), and Git spawns directly.
   */
  #wedged(why: string): void {
    const helper = this.#child
    if (!helper) return
    this.#child = undefined
    this.#lostWhy.set(helper, `it stopped answering: ${why}`)
    this.#down(`it stopped answering: ${why}`)
    // What it ran is settled when it has closed (its `close` above), once what it had said before is read.
    if (helper.pid) {
      try { process.kill(-helper.pid, "SIGKILL") } catch { /* gone already */ }
    }
    void this.#direct.close(helper, "SIGKILL").catch(() => {})
  }

  /** The helper is gone: Git spawns directly until it's tried again. What it ran is settled as it closes (`#lost`). */
  #down(why: string): void {
    if (this.#stopped) return
    this.#retryAt = Date.now() + this.#retryMs
    hostWarn("git", "helper down; Git spawns directly for now", { why, retryInMs: this.#retryMs, running: this.#running.size })
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS)
  }

  /**
   * What the helper ran when it was lost. A `git` it never started fails, nothing having run, and may be tried again.
   * One it started is never killed for it, since a write cut short leaves its work half done (and `index.lock`
   * behind): it's waited for, its group followed by its pid, and its result said unknown once that's gone or after
   * `ORPHAN_WAIT_MS`, so nobody takes a write that landed for one that failed. A stop `Git.run` asks of it, then or
   * later, stops it from here, as the host's runner stops a child of its own.
   */
  #lost(helper: ChildProcess, why: string): void {
    for (const [id, child] of this.#running) {
      if (child.owner !== helper) continue
      this.#running.delete(id)
      clearTimeout(child.watch)
      child.watch = undefined
      child.abandon()
      if (!child.pid) {
        hostLog("git", "a git the helper was lost before starting failed", { id, command: child.command, why })
        child.fail(new GitError({ kind: "failed", command: child.command, message: `git ${child.command} didn't start: Mako's Git helper was lost first (${why}). Nothing ran.` }))
        continue
      }
      child.orphan = true
      hostLog("git", "a git the helper started is followed without it", { id, command: child.command, pid: child.pid, why })
      void (child.stopAsked ? this.#stopOrphan(child) : this.#awaitOrphan(child, why))
    }
  }

  /** A `git` lost with its helper, left to end on its own: its result is said unknown once it's gone, or after the wait. */
  async #awaitOrphan(child: HelperChild, why: string): Promise<void> {
    const pid = child.pid!
    const deadline = Date.now() + ORPHAN_WAIT_MS
    while (groupAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (child.stopAsked || child.closed) return
    }
    const ended = !groupAlive(pid)
    hostLog("git", "a git the helper started ended without it; its result isn't known", { command: child.command, pid, ended, why })
    child.fail(new GitError({
      kind: "unknown",
      command: child.command,
      message: `Mako's Git helper was lost while git ${child.command} ran (${why}). It ${ended ? "ended on its own" : `was still running after ${ORPHAN_WAIT_MS / 1000} s`}, and whether it did what it was asked isn't known: read the repository before trying it again.`,
    }))
  }

  /** Stops a `git` lost with its helper as the host's runner stops its own: its group signalled, then killed, then gone. */
  async #stopOrphan(child: HelperChild): Promise<void> {
    const pid = child.pid!
    signalGroup(pid, "SIGTERM")
    const began = Date.now()
    while (groupAlive(pid) && Date.now() - began < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (Date.now() - began >= 100) signalGroup(pid, "SIGKILL")
    }
    child.finish(null, "SIGTERM")
  }
}

/** Whether any process of group `pid` is left. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch { /* gone already */ }
}

function defaultEntry(): string {
  const compiled = fileURLToPath(new URL("./git-helper-main.js", import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}
