import { spawn } from "node:child_process"
import { existsSync, readlinkSync } from "node:fs"
import { availableParallelism } from "node:os"
import { delimiter, join } from "node:path"
import { Readable } from "node:stream"
import { forgetStartingRepository } from "./environment.js"
import { GitError } from "./errors.js"

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

let runtime: GitRuntime = {}

/** Set once by the host: how background work yields, and where traces go. */
export function configureGit(next: GitRuntime): void {
  runtime = next
}

/**
 * The Git binary itself. On macOS `/usr/bin/git` is a shim that looks up the
 * developer tools on every run: 12 ms a call against 4.6 ms for the binary it
 * finds. The tools `xcode-select` chose are a symlink away, so resolving
 * them spawns nothing. A Git earlier on PATH (Homebrew's) is used as is.
 */
function resolveGit(): string {
  if (process.platform !== "darwin") return "git"
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

let resolved: string | undefined
export function gitExecutable(): string {
  resolved ??= resolveGit()
  return resolved
}

let baseEnv: NodeJS.ProcessEnv | undefined
/** The environment every Git process starts with. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  if (!baseEnv) {
    baseEnv = { ...process.env }
    forgetStartingRepository(baseEnv)
    // Never wait on a password prompt nobody can see; English messages are what `classify` reads.
    baseEnv.GIT_TERMINAL_PROMPT = "0"
    baseEnv.LC_MESSAGES = "C"
  }
  return baseEnv
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
  /** Below foreground work, through the host's `background` hook. */
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

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const STDERR_BYTES = 64 * 1024

/** Reads at once, across every repository; more only queue behind the disk. */
const READ_SLOTS = 6
let readsRunning = 0
const readsWaiting: Array<() => void> = []
const running = new Set<{ command: string; cwd: string; started: number }>()

/** The `git` processes running now and the reads waiting for a slot, for `git:doctor`. */
export interface GitActivity {
  running: { command: string; cwd: string; ms: number }[]
  queued: number
}

export function gitActivity(): GitActivity {
  const now = performance.now()
  return {
    running: [...running].map((live) => ({ command: live.command, cwd: live.cwd, ms: Math.round(now - live.started) })),
    queued: readsWaiting.length,
  }
}

async function readSlot(): Promise<() => void> {
  if (readsRunning >= READ_SLOTS) await new Promise<void>((resolve) => readsWaiting.push(resolve))
  readsRunning += 1
  let released = false
  return () => {
    if (released) return
    released = true
    readsRunning -= 1
    readsWaiting.shift()?.()
  }
}

/** Runs one `git` command. A failure is a `GitError`; cancelling rejects with the signal's reason. */
export async function run(options: RunOptions): Promise<RunResult> {
  options.signal?.throwIfAborted()
  const queued = performance.now()
  const release = options.read ? await readSlot() : undefined
  try {
    options.signal?.throwIfAborted()
    return await execute(options, performance.now() - queued)
  } finally {
    release?.()
  }
}

function execute(options: RunOptions, queuedMs: number): Promise<RunResult> {
  const args = options.read ? ["--no-optional-locks", ...options.args] : [...options.args]
  const [command, argv] = options.background && runtime.background ? runtime.background(gitExecutable(), args) : [gitExecutable(), args]
  const env = options.env ? { ...gitEnvironment(), ...options.env } : gitEnvironment()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const started = performance.now()
  const subcommand = options.args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""

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
      if (!runtime.trace) return
      const trace: GitTrace = { command: subcommand, args: options.args, cwd: options.cwd, queuedMs, ms: performance.now() - started, code, bytes, outcome }
      if (code !== 0 && errorBytes > 0) trace.stderr = Buffer.concat(errors).toString("utf8", 0, Math.min(errorBytes, 500)).trim()
      runtime.trace(trace)
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

/** Runs a command and returns its output as trimmed text. */
export async function text(options: RunOptions): Promise<string> {
  return (await run(options)).stdout.toString("utf8").trim()
}

/** Whether a command exits 0; any failure is `false`. */
export function succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
  return run({ cwd, args }).then(() => true, () => false)
}

let version: Promise<[number, number]> | undefined
/** Git's version, read once. */
export function gitVersion(): Promise<[number, number]> {
  version ??= text({ cwd: process.cwd(), args: ["version"] }).then((output): [number, number] => {
    const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(output) ?? []).slice(1).map(Number)
    return [major, minor]
  }, (): [number, number] => [0, 0])
  return version
}

export async function gitAtLeast(major: number, minor: number): Promise<boolean> {
  const [actualMajor, actualMinor] = await gitVersion()
  return actualMajor > major || (actualMajor === major && actualMinor >= minor)
}

/**
 * The shorthand most callers want: trimmed text, failing on any exit but 0,
 * and on output past 16 MB rather than cutting it. `background` runs below
 * foreground work (see `configureGit`).
 */
export async function git(cwd: string, args: readonly string[], background = false): Promise<string> {
  const result = await run({ cwd, args, background, maxBytes: 16 * 1024 * 1024 })
  if (result.truncated) throw new GitError({ message: `git ${args[0] ?? ""} wrote more than 16 MB.`, command: args[0], code: result.code })
  return result.stdout.toString("utf8").trim()
}

/**
 * Git's parallel checkout. APFS spends extra workers on contention past four;
 * Linux filesystems keep gaining to about eight (50,000 files: one worker
 * 10-20 s, these 2-5 s, for about the same CPU).
 */
const CHECKOUT_WORKERS = Math.min(process.platform === "darwin" ? 4 : 8, availableParallelism())
export const PARALLEL_CHECKOUT = ["-c", `checkout.workers=${CHECKOUT_WORKERS}`, "-c", "checkout.thresholdForParallelism=100"]

/** Whether this Git has `merge-tree --write-tree` (2.38 and later), which merges without touching a checkout. */
export function mergesWithoutCheckout(): Promise<boolean> {
  return gitAtLeast(2, 38)
}
