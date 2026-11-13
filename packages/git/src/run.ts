import type { spawn, ChildProcess } from "node:child_process"
import { processRunner, type ProcessRunner } from "./process-runner.js"
import { existsSync, readlinkSync } from "node:fs"
import { availableParallelism } from "node:os"
import { delimiter, join } from "node:path"
import { Readable } from "node:stream"
import { forgetStartingRepository } from "./environment.js"
import { GitError } from "./errors.js"
import { Repositories } from "./open.js"
import { onMac } from "./platform.js"
import type { Repository } from "./repository.js"
import { commonDirOf, REF_LOCK_WAIT, subcommandOf, writesShared } from "./shared-writes.js"

/** One finished `git` process, for logs and `MAKO_GIT_TRACE`. */
export interface GitTrace {
  command: string
  args: readonly string[]
  cwd: string
  /** Spent waiting for a read slot, or for the repository's earlier writes, before the process started. */
  queuedMs: number
  /** It wrote what every checkout of the repository shares (`writesShared`), in the repository's turn. */
  write: boolean
  /** For a write, the folder the repository's checkouts share (`commonDirOf`), whose turn it took. */
  repository?: string
  ms: number
  code: number | null
  bytes: number
  outcome: "ok" | "failed" | "timeout" | "cancelled" | "truncated" | "unknown"
  /** The start of Git's error output, when it wrote any and didn't exit 0. */
  stderr?: string
}

export interface GitRuntime {
  /** The owner supplies process ownership; standalone Git uses its own group runner. */
  processes?: Pick<ProcessRunner, "spawn" | "close">
  /** The owner stopped: cancel running commands and refuse queued or new ones. */
  signal?: AbortSignal
  /** Runs a background command below foreground work, such as `nice -n 19`. */
  background?: (command: string, args: readonly string[]) => [string, string[]]
  trace?: (trace: GitTrace) => void
  /** How long a write waits for its repository's earlier writes; `WRITE_TURN_WAIT_MS` unless a test shortens it. */
  writeTurnWaitMs?: number
}

export interface RunOptions {
  cwd: string
  args: readonly string[]
  /** What Git reads on stdin; a stream is piped as it arrives. */
  input?: string | Buffer | Readable
  /** Added to Git's environment; an undefined value leaves the variable unset. */
  env?: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  timeoutMs?: number
  /** Stop reading output past this many bytes and say so in `truncated`. */
  maxBytes?: number
  /** Exit codes that answer rather than fail, such as 1 from `diff --quiet`. */
  codes?: readonly number[]
  /** Below foreground work, through the runtime's `background` hook. */
  background?: boolean
  /**
   * Reads take no locks, so Git never refreshes the index under an agent's
   * own `git add`, and they share a bounded pool.
   */
  read?: boolean
  /**
   * A read nobody waits on as it's made (a summary a window polls): it takes a slot only while no other read waits,
   * and leaves `FOREGROUND_SLOTS` for them, so a send's checkpoint never queues behind a pass of a hundred worktrees.
   */
  idle?: boolean
}

export interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
  truncated: boolean
}

/** The `git` processes running now and the reads waiting for a slot, for `git:doctor`. */
export interface GitActivity {
  running: { command: string; cwd: string; ms: number }[]
  queued: number
  /** Writes waiting for their repository's earlier writes to finish. */
  writesQueued: number
}

/** The repositories one `Git` holds open, for `git:doctor`. */
export interface OpenRepositories {
  open: number
  previewBytes: number
}

const DEFAULT_TIMEOUT_MS = 120_000
/**
 * At most this long a write waits for its repository's earlier writes before it fails: each of them is bounded by its
 * own timeout, but a line of them would hold a start for minutes.
 */
export const WRITE_TURN_WAIT_MS = 60_000
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const STDERR_BYTES = 64 * 1024
/** Reads at once, across every repository; more only queue behind the disk. */
const READ_SLOTS = 6
/** Of `READ_SLOTS`, those an idle read never takes: a read someone waits on starts at once. */
const FOREGROUND_SLOTS = 2

/**
 * Git's parallel checkout. APFS spends extra workers on contention past four;
 * Linux filesystems keep gaining to about eight (50,000 files: one worker
 * 10-20 s, these 2-5 s, for about the same CPU).
 */
const CHECKOUT_WORKERS = Math.min(onMac() ? 4 : 8, availableParallelism())
export const PARALLEL_CHECKOUT = ["-c", `checkout.workers=${CHECKOUT_WORKERS}`, "-c", "checkout.thresholdForParallelism=100"]

/**
 * Every `git` process one owner runs, and the repositories it keeps open.
 * Reads share one bounded pool, each finished process goes to the runtime's
 * `trace`, and every caller asking about the same working tree shares one
 * `Repository`. A host makes one; two in a process share nothing.
 */
export class Git {
  readonly processes: Pick<ProcessRunner, "spawn" | "close">
  readonly #children = new Set<ChildProcess>()
  readonly #runtime: GitRuntime
  readonly #repositories: Repositories
  readonly #readsWaiting: Array<() => void> = []
  /** Idle reads waiting: each starts once no other read waits and a slot past `FOREGROUND_SLOTS` is free. */
  readonly #idleWaiting: Array<() => void> = []
  readonly #running = new Set<{ command: string; cwd: string; started: number; repository?: string }>()
  /** Each repository's last write asked for, by the folder its checkouts share: the next one starts once it ends. */
  readonly #writes = new Map<string, Promise<void>>()
  #writesWaiting = 0
  readonly #writeTurnWaitMs: number
  #readsRunning = 0
  #executable: string | undefined
  #environment: NodeJS.ProcessEnv | undefined
  #version: Promise<[number, number]> | undefined

  constructor(runtime: GitRuntime = {}) {
    this.#runtime = runtime
    this.#writeTurnWaitMs = runtime.writeTurnWaitMs ?? WRITE_TURN_WAIT_MS
    this.processes = trackProcesses(runtime.processes ?? processRunner, runtime.signal, this.#children)
    this.#repositories = new Repositories(this)
  }

  /**
   * The Git binary itself. On macOS `/usr/bin/git` is a shim that looks up the
   * developer tools on every run: 12 ms a call against 4.6 ms for the binary it
   * finds. The tools `xcode-select` chose are a symlink away, so resolving
   * them spawns nothing. A Git earlier on PATH (Homebrew's) is used as is.
   */
  get executable(): string {
    this.#executable ??= resolveGit()
    return this.#executable
  }

  /** The environment every Git process starts with: the process's when first asked, without a starting repository. */
  environment(): NodeJS.ProcessEnv {
    if (!this.#environment) {
      const env = { ...process.env }
      forgetStartingRepository(env)
      // Never wait on a password prompt nobody can see; English messages are what `classify` reads.
      env.GIT_TERMINAL_PROMPT = "0"
      env.LC_MESSAGES = "C"
      this.#environment = env
    }
    return this.#environment
  }

  /**
   * Runs one `git` command. A failure is a `GitError`; cancelling rejects with the signal's reason. A write to what
   * every checkout of a repository shares (its refs, its worktrees, its configuration: `writesShared`) waits for the
   * writes asked for before it in that repository, wherever they run, and then for a ref lock another program holds
   * (`REF_LOCK_WAIT`): two of Mako's own never meet at a lock.
   */
  async run(options: RunOptions): Promise<RunResult> {
    const owner = this.#runtime.signal
    if (owner) options = { ...options, signal: options.signal ? AbortSignal.any([owner, options.signal]) : owner }
    options.signal?.throwIfAborted()
    const queued = performance.now()
    const repository = !options.read && writesShared(options.args) ? commonDirOf(options.cwd) : undefined
    const release = options.read ? await this.#readSlot(options.idle === true) : repository ? await this.#writeTurn(repository, options) : undefined
    try {
      options.signal?.throwIfAborted()
      return await this.#execute(options, performance.now() - queued, repository)
    } finally {
      release?.()
    }
  }

  /** Runs a command and returns its output as trimmed text. */
  async text(options: RunOptions): Promise<string> {
    return (await this.run(options)).stdout.toString("utf8").trim()
  }

  /** Whether a command exits 0; any failure is `false`. */
  succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
    return this.run({ cwd, args }).then(() => true, () => false)
  }

  /**
   * The shorthand most callers want: trimmed text, failing on any exit but 0,
   * and on output past 16 MB rather than cutting it. `background` runs below
   * foreground work.
   */
  async output(cwd: string, args: readonly string[], background = false): Promise<string> {
    return this.#output({ cwd, args, background })
  }

  /** `output` for a read: it waits for one of the read slots and never refreshes the index. */
  readOutput(cwd: string, args: readonly string[]): Promise<string> {
    return this.#output({ cwd, args, read: true })
  }

  /** `readOutput` for a read nobody waits on as it's made: behind every other read (`idle`). */
  idleOutput(cwd: string, args: readonly string[]): Promise<string> {
    return this.#output({ cwd, args, read: true, idle: true })
  }

  async #output(options: RunOptions): Promise<string> {
    const result = await this.run({ ...options, maxBytes: 16 * 1024 * 1024 })
    if (result.truncated) throw new GitError({ message: `git ${options.args[0] ?? ""} wrote more than 16 MB.`, command: options.args[0], code: result.code })
    return result.stdout.toString("utf8").trim()
  }

  /** Git's version, read once. */
  version(): Promise<[number, number]> {
    this.#version ??= this.text({ cwd: process.cwd(), args: ["version"] }).then((output): [number, number] => {
      const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(output) ?? []).slice(1).map(Number)
      return [major, minor]
    }, (): [number, number] => [0, 0])
    return this.#version
  }

  async atLeast(major: number, minor: number): Promise<boolean> {
    const [actualMajor, actualMinor] = await this.version()
    return actualMajor > major || (actualMajor === major && actualMinor >= minor)
  }

  /** Whether this Git has `merge-tree --write-tree` (2.38 and later), which merges without touching a checkout. */
  mergesWithoutCheckout(): Promise<boolean> {
    return this.atLeast(2, 38)
  }

  activity(): GitActivity {
    const now = performance.now()
    return {
      running: [...this.#running].map((live) => ({ command: live.command, cwd: live.cwd, ms: Math.round(now - live.started) })),
      queued: this.#readsWaiting.length + this.#idleWaiting.length,
      writesQueued: this.#writesWaiting,
    }
  }

  /**
   * The repository `cwd` is in, or null outside one. Every caller asking about
   * the same working tree shares one `Repository`, so its status, previews and
   * write queue are one. After the first answer for a folder, this resolves
   * without starting Git.
   */
  openRepository(cwd: string, signal?: AbortSignal): Promise<Repository | null> {
    return this.#repositories.open(cwd, signal)
  }

  /**
   * The repository `cwd` is in when it is already open, without waiting. A
   * write started through it joins the repository's queue in the same tick,
   * so writes keep the order they were asked for in.
   */
  knownRepository(cwd: string): Repository | undefined {
    return this.#repositories.known(cwd)
  }

  /** How many repositories are open and the bytes their previews hold. */
  repositories(): OpenRepositories {
    return { open: this.#repositories.size, previewBytes: this.#repositories.previewBytes }
  }

  /** Closes what nobody watches, is using, or asked for lately. */
  sweep(now = Date.now()): void {
    this.#repositories.sweep(now)
  }

  /** Ends every repository's helper process, for an owner that is stopping. */
  async close(): Promise<void> {
    this.#repositories.close()
    await Promise.all([...this.#children].map((child) => this.processes.close(child)))
  }

  async #readSlot(idle: boolean): Promise<() => void> {
    if (idle ? this.#readsRunning >= READ_SLOTS - FOREGROUND_SLOTS || this.#readsWaiting.length > 0 || this.#idleWaiting.length > 0 : this.#readsRunning >= READ_SLOTS)
      await new Promise<void>((resolve) => (idle ? this.#idleWaiting : this.#readsWaiting).push(resolve))
    this.#readsRunning += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#readsRunning -= 1
      this.#nextRead()
    }
  }

  /**
   * The repository's turn to write, after every write asked for before in it; the returned call ends it. One that
   * waits past `WRITE_TURN_WAIT_MS` fails, naming what held the repository, and its place in the line passes on, so
   * the writes behind it never wait on it.
   */
  async #writeTurn(repository: string, options: RunOptions): Promise<() => void> {
    const before = this.#writes.get(repository)
    let end!: () => void
    const turn = new Promise<void>((resolve) => (end = resolve))
    const last = (before ?? Promise.resolve()).then(() => turn)
    this.#writes.set(repository, last)
    const done = () => {
      end()
      if (this.#writes.get(repository) === last) this.#writes.delete(repository)
    }
    if (!before) return done
    this.#writesWaiting += 1
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<"waited">((resolve) => { timer = setTimeout(() => resolve("waited"), this.#writeTurnWaitMs) })
    try {
      if ((await Promise.race([before.then(() => "turn" as const), waited])) === "waited") {
        done()
        const holding = [...this.#running].find((live) => live.repository === repository)
        throw new GitError({
          kind: "timeout",
          command: subcommandOf(options.args).command,
          message: `git ${subcommandOf(options.args).command} waited ${(this.#writeTurnWaitMs / 1000).toFixed(this.#writeTurnWaitMs < 10_000 ? 1 : 0)} s for the repository's earlier writes${holding ? `, behind git ${holding.command} in ${holding.cwd}` : ""}.`,
        })
      }
      return done
    } finally {
      clearTimeout(timer)
      this.#writesWaiting -= 1
    }
  }

  /** A slot came free: the oldest read someone waits on takes it, else the oldest idle one if it leaves the reserve. */
  #nextRead(): void {
    const next = this.#readsWaiting.shift()
    if (next) return next()
    if (this.#readsRunning < READ_SLOTS - FOREGROUND_SLOTS) this.#idleWaiting.shift()?.()
  }

  #execute(options: RunOptions, queuedMs: number, repository: string | undefined): Promise<RunResult> {
    const args = options.read ? ["--no-optional-locks", ...options.args] : [...REF_LOCK_WAIT, ...options.args]
    const { background, trace } = this.#runtime
    const [command, argv] = options.background && background ? background(this.executable, args) : [this.executable, args]
    const env = options.env ? { ...this.environment(), ...options.env } : this.environment()
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const started = performance.now()
    const subcommand = options.args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""
    const running = this.#running

    return new Promise<RunResult>((resolve, reject) => {
      const child = this.processes.spawn(command, argv, { cwd: options.cwd, env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true })
      const live = { command: subcommand, cwd: options.cwd, started, ...(repository && { repository }) }
      running.add(live)
      const chunks: Buffer[] = []
      let bytes = 0
      let truncated = false
      const errors: Buffer[] = []
      let errorBytes = 0
      let ended: "timeout" | "cancelled" | undefined
      let settled = false

      const finish = (outcome: GitTrace["outcome"], code: number | null) => {
        running.delete(live)
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", cancel)
        if (!trace) return
        const traced: GitTrace = { command: subcommand, args: options.args, cwd: options.cwd, queuedMs, write: repository !== undefined, ...(repository && { repository }), ms: performance.now() - started, code, bytes, outcome }
        if (code !== 0 && errorBytes > 0) traced.stderr = Buffer.concat(errors).toString("utf8", 0, Math.min(errorBytes, 500)).trim()
        trace(traced)
      }
      const fail = (error: Error, outcome: GitTrace["outcome"], code: number | null) => {
        if (settled) return
        settled = true
        finish(outcome, code)
        reject(error)
      }
      const stopChild = () => { void this.processes.close(child).catch((error: Error) => fail(error, "failed", null)) }
      const cancel = () => {
        ended = "cancelled"
        stopChild()
      }
      const timer = setTimeout(() => {
        ended = "timeout"
        stopChild()
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      options.signal?.addEventListener("abort", cancel, { once: true })

      child.stdout!.on("data", (chunk: Buffer) => {
        if (truncated) return
        const room = maxBytes - bytes
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room))
          bytes = maxBytes
          truncated = true
          stopChild()
          return
        }
        chunks.push(chunk)
        bytes += chunk.length
      })
      child.stderr!.on("data", (chunk: Buffer) => {
        if (errorBytes >= STDERR_BYTES) return
        errors.push(chunk)
        errorBytes += chunk.length
      })
      child.on("error", (error: NodeJS.ErrnoException) => {
        // A runner that ran the process elsewhere says itself how it went (the host's helper, lost under it).
        if (error instanceof GitError) return fail(error, error.kind === "unknown" ? "unknown" : "failed", null)
        // Spawning in a folder that's gone fails the same way as a missing binary.
        const failure = error.code !== "ENOENT"
          ? new GitError({ message: `Git could not start: ${error.message}`, command: subcommand, cause: error })
          : existsSync(options.cwd)
            ? new GitError({ kind: "missing", message: "Git isn't installed, or Mako can't find it. Install Git and try again.", command: subcommand, cause: error })
            : new GitError({ kind: "not_repository", message: `${options.cwd} no longer exists.`, command: subcommand, cause: error })
        fail(failure, "failed", null)
      })
      if (options.input !== undefined && child.stdin) {
        // A command that exits before reading all of its input closes the pipe; its exit code says what happened.
        child.stdin.on("error", () => {})
        if (options.input instanceof Readable) {
          options.input.on("error", (error) => {
            void this.processes.close(child).then(() => fail(error, "failed", null), (cleanup: Error) => fail(cleanup, "failed", null))
          })
          options.input.pipe(child.stdin)
        } else child.stdin.end(options.input)
      }
      child.on("close", (code) => { void this.processes.close(child).then(() => {
        if (settled) return
        const stderr = Buffer.concat(errors).toString("utf8")
        if (ended === "cancelled") return fail(options.signal?.reason ?? new DOMException("Cancelled", "AbortError"), "cancelled", code)
        if (ended === "timeout") return fail(new GitError({ kind: "timeout", message: `git ${subcommand} took too long and was stopped.`, stderr, command: subcommand, code }), "timeout", code)
        const stdout = Buffer.concat(chunks, bytes)
        if (truncated) {
          settled = true
          finish("truncated", code)
          return resolve({ code: code ?? 0, stdout, stderr, truncated })
        }
        if (code !== 0 && !(code !== null && options.codes?.includes(code)))
          return fail(new GitError({ stderr, command: subcommand, code }), "failed", code)
        settled = true
        finish("ok", code)
        resolve({ code: code ?? 0, stdout, stderr, truncated })
      }, (error: Error) => fail(error, "failed", code)) })
    })
  }
}

function trackProcesses(runner: Pick<ProcessRunner, "spawn" | "close">, signal: AbortSignal | undefined, children: Set<ChildProcess>): Pick<ProcessRunner, "spawn" | "close"> {
  // SAFETY: the injected runner receives the same arguments and returns the same child for every stdio overload.
  const launch = ((...args: Parameters<typeof spawn>) => {
    signal?.throwIfAborted()
    const child = runner.spawn(...args)
    children.add(child)
    child.once("close", () => { void runner.close(child).then(() => children.delete(child), () => {}) })
    return child
  }) as typeof spawn
  return { spawn: launch, close: (child) => runner.close(child) }
}

function resolveGit(): string {
  if (!onMac()) return "git"
  const first = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path))
  if (first && first !== "/usr/bin/git") return first
  const developer = process.env.DEVELOPER_DIR || (() => {
    try {
      return readlinkSync("/var/db/xcode_select_link")
    } catch {
      return "/Library/Developer/CommandLineTools"
    }
  })()
  const tools = join(developer, "usr", "bin", "git")
  return existsSync(tools) ? tools : first ?? "git"
}
