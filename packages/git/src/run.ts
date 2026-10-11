import { spawn } from "node:child_process"
import { existsSync, readlinkSync } from "node:fs"
import { availableParallelism } from "node:os"
import { delimiter, join } from "node:path"
import { Readable } from "node:stream"
import { forgetStartingRepository } from "./environment.js"
import { GitError } from "./errors.js"
import { Repositories } from "./open.js"
import { onMac } from "./platform.js"
import type { Repository } from "./repository.js"

/** One finished `git` process, for logs and `MAKO_GIT_TRACE`. */
export interface GitTrace {
  command: string
  args: readonly string[]
  cwd: string
  /** Spent waiting for a read slot before the process started. */
  queuedMs: number
  ms: number
  code: number | null
  bytes: number
  outcome: "ok" | "failed" | "timeout" | "cancelled" | "truncated"
  /** The start of Git's error output, when it wrote any and didn't exit 0. */
  stderr?: string
}

export interface GitRuntime {
  /** Runs a background command below foreground work, such as `nice -n 19`. */
  background?: (command: string, args: readonly string[]) => [string, string[]]
  trace?: (trace: GitTrace) => void
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
}

/** The repositories one `Git` holds open, for `git:doctor`. */
export interface OpenRepositories {
  open: number
  previewBytes: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const STDERR_BYTES = 64 * 1024
/** Reads at once, across every repository; more only queue behind the disk. */
const READ_SLOTS = 6

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
  readonly #runtime: GitRuntime
  readonly #repositories: Repositories
  readonly #readsWaiting: Array<() => void> = []
  readonly #running = new Set<{ command: string; cwd: string; started: number }>()
  #readsRunning = 0
  #executable: string | undefined
  #environment: NodeJS.ProcessEnv | undefined
  #version: Promise<[number, number]> | undefined

  constructor(runtime: GitRuntime = {}) {
    this.#runtime = runtime
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

  /** Runs one `git` command. A failure is a `GitError`; cancelling rejects with the signal's reason. */
  async run(options: RunOptions): Promise<RunResult> {
    options.signal?.throwIfAborted()
    const queued = performance.now()
    const release = options.read ? await this.#readSlot() : undefined
    try {
      options.signal?.throwIfAborted()
      return await this.#execute(options, performance.now() - queued)
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
    const result = await this.run({ cwd, args, background, maxBytes: 16 * 1024 * 1024 })
    if (result.truncated) throw new GitError({ message: `git ${args[0] ?? ""} wrote more than 16 MB.`, command: args[0], code: result.code })
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
      queued: this.#readsWaiting.length,
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
  close(): void {
    this.#repositories.close()
  }

  async #readSlot(): Promise<() => void> {
    if (this.#readsRunning >= READ_SLOTS) await new Promise<void>((resolve) => this.#readsWaiting.push(resolve))
    this.#readsRunning += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#readsRunning -= 1
      this.#readsWaiting.shift()?.()
    }
  }

  #execute(options: RunOptions, queuedMs: number): Promise<RunResult> {
    const args = options.read ? ["--no-optional-locks", ...options.args] : [...options.args]
    const { background, trace } = this.#runtime
    const [command, argv] = options.background && background ? background(this.executable, args) : [this.executable, args]
    const env = options.env ? { ...this.environment(), ...options.env } : this.environment()
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const started = performance.now()
    const subcommand = options.args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""
    const running = this.#running

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, argv, { cwd: options.cwd, env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true })
      const live = { command: subcommand, cwd: options.cwd, started }
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
        const traced: GitTrace = { command: subcommand, args: options.args, cwd: options.cwd, queuedMs, ms: performance.now() - started, code, bytes, outcome }
        if (code !== 0 && errorBytes > 0) traced.stderr = Buffer.concat(errors).toString("utf8", 0, Math.min(errorBytes, 500)).trim()
        trace(traced)
      }
      const fail = (error: Error, outcome: GitTrace["outcome"], code: number | null) => {
        if (settled) return
        settled = true
        finish(outcome, code)
        reject(error)
      }
      const cancel = () => {
        ended = "cancelled"
        child.kill("SIGTERM")
      }
      const timer = setTimeout(() => {
        ended = "timeout"
        child.kill("SIGTERM")
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      options.signal?.addEventListener("abort", cancel, { once: true })

      child.stdout!.on("data", (chunk: Buffer) => {
        if (truncated) return
        const room = maxBytes - bytes
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room))
          bytes = maxBytes
          truncated = true
          child.kill("SIGTERM")
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
            child.kill("SIGTERM")
            fail(error, "failed", null)
          })
          options.input.pipe(child.stdin)
        } else child.stdin.end(options.input)
      }
      child.on("close", (code) => {
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
      })
    })
  }
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
