/**
 * Continue a thread with its own harness.
 *
 * The other half of continuation: "Continue here" hands a conversation to
 * this app's agent, and this hands the user's next message back to the CLI
 * that owns the session — Codex, Claude Code, Cursor, Grok — headlessly, in
 * the thread's working directory.
 *
 * There is deliberately no stream parsing here. Every one of these CLIs
 * writes its native session store as it works, the catalog is already
 * watching those stores, and the open viewer is already tailing the file —
 * so the transcript arrives through the same path it would if the user had
 * run the CLI in a terminal. The driver's whole job is to start the process,
 * say whether it is running, and carry the exit status. That is what keeps a
 * new harness's driver at five lines instead of five hundred.
 *
 * Every CLI runs with its own auto-approval flag. That is what continuing a
 * session non-interactively *is* — there is no one at the prompt to approve
 * tool calls — and it matches how these agents are run on this machine. The
 * arguments are one table below, on purpose: the security posture of this
 * file should be readable in ten seconds.
 */

import { assertLifecycleAdmission } from "./application-lifecycle.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import type { ThreadRef } from "@mako/sessions"
import type { SessionSettings } from "@mako/sessions/settings"
import { accountEnv, switchSuggestion } from "./accounts.js"
import { providerHost } from "./providers/index.js"
import {
  dropUncarried,
  type NativeCommand,
  type NativeRunOptions,
  type NativeRunner,
} from "./providers/native-runner.js"
import { hostWarn } from "./host-log.js"
import type { HostEvent, ThreadRunState } from "./shared.js"
import {
  environmentForExecutable,
  resolveExecutable,
} from "./executable.js"

export type FreshOptions = NativeRunOptions

function availableNativeRunners() {
  return providerHost.nativeRunners
    .list()
    .filter(
      (runner) => runner.available()
    )
}

export function resumableHarnesses(): string[] {
  return availableNativeRunners().map((runner) => runner.provider)
}

export function freshHarnesses(): string[] {
  return availableNativeRunners().map((runner) => runner.provider)
}

export interface NativeRunResult {
  state: ThreadRunState
  text: string
}

interface Run {
  cwd: string
  token: string
  child: ChildProcess
  completed?: Promise<NativeRunResult>
  outputSubscribers: Set<(chunk: string) => void>
  resolve: (result: NativeRunResult) => void
  state: ThreadRunState
  stdout: string
}

const runs = new Map<string, Run>()
const preparingRuns = new Map<string, LifecycleWork>()
const MAX_REMEMBERED_RUNS = 600
let emit: (event: HostEvent) => void = () => {}

export interface NativeRunHooks {
  /** A reply to `ref` is about to run with exactly these settings. */
  prepared?(ref: ThreadRef, settings: SessionSettings): void
}
let hooks: NativeRunHooks = {}

export function bindDrivers(send: (event: HostEvent) => void, runHooks: NativeRunHooks = {}): void {
  emit = send
  hooks = runHooks
}

/** The settings a prepared command line carries, without the run's own fields. */
export function preparedSettings(options: NativeRunOptions): SessionSettings {
  const settings: SessionSettings = {}
  if (options.model) settings.model = options.model
  if (options.options && Object.keys(options.options).length) settings.options = options.options
  return settings
}

export function threadRun(path: string): ThreadRunState | null {
  return runs.get(path)?.state ?? null
}

export async function waitForNativeRun(
  path: string,
  timeoutMs = 2 * 60 * 60 * 1000
): Promise<NativeRunResult> {
  const run = runs.get(path)
  const completed = run?.completed
  if (!run || !completed) throw new Error(`No captured native run exists for ${path}`)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    run.child.kill("SIGTERM")
  }, timeoutMs)
  try {
    const result = await completed
    return timedOut
      ? {
          state: {
            ...result.state,
            status: "failed",
            error: "The local harness exceeded its two hour Slack limit",
          },
          text: result.text,
        }
      : result
  } finally {
    clearTimeout(timer)
    run.completed = undefined
    run.stdout = ""
  }
}

export function subscribeNativeRunOutput(
  path: string,
  subscriber: (chunk: string) => void
): () => void {
  const run = runs.get(path)
  if (!run?.completed) throw new Error(`No captured native run exists for ${path}`)
  run.outputSubscribers.add(subscriber)
  if (run.stdout) subscriber(run.stdout)
  return () => run.outputSubscribers.delete(subscriber)
}

/**
 * Send one message to the harness that owns this thread.
 *
 * One run per thread at a time — a session file being appended to by two
 * processes is corruption, not concurrency. The returned state is also
 * pushed as events as it changes.
 */
export async function resumeNative(
  ref: ThreadRef,
  prompt: string,
  tuning?: FreshOptions
): Promise<ThreadRunState> {
  if (ref.resumeUnavailable) throw new Error(ref.resumeUnavailable)
  const existing = runs.get(ref.path)
  if (existing && existing.state.status === "running") throw new Error("This native session already has an active writer")

  const runner = providerHost.nativeRunners.get(ref.harness)
  if (!runner)
    throw new Error(`Sessions from ${ref.harness} cannot be resumed here`)
  const options = { ...tuning, nativePath: ref.path }
  return launch(
    ref.path,
    ref.harness,
    ref.cwd,
    runner,
    options,
    (prepared, env) => {
      hooks.prepared?.(ref, preparedSettings(prepared))
      return runner.resume(ref.nativeId, prompt, prepared, env)
    },
    tuning?.captureOutput ?? false
  )
}

/**
 * Start a fresh headless session on another harness, opened with a handoff.
 *
 * The run is keyed by a synthetic path — there is no session file until the
 * CLI creates one — and the session itself arrives in the catalog through
 * the watcher, like any other session anything starts on this machine.
 */
let freshCounter = 0

export async function startFresh(
  harness: string,
  cwd: string | undefined,
  prompt: string,
  options: FreshOptions = {}
): Promise<ThreadRunState> {
  const runner = providerHost.nativeRunners.get(harness)
  if (!runner)
    throw new Error(`A new ${harness} session cannot be started from here`)
  return launch(
    `fresh:${harness}:${++freshCounter}`,
    harness,
    cwd,
    runner,
    options,
    (prepared, env) => runner.fresh(prompt, prepared, env),
    options.captureOutput ?? false
  )
}

async function launch(
  key: string,
  harness: string,
  workingDir: string | undefined,
  runner: NativeRunner,
  options: NativeRunOptions,
  build: (options: NativeRunOptions, env: NodeJS.ProcessEnv) => NativeCommand | Promise<NativeCommand>,
  captureOutput: boolean
): Promise<ThreadRunState> {
  const cwd = workingDir && existsSync(workingDir) ? workingDir : homedir()
  // The selected account decides who pays for this run, and what the
  // command line may name: the model list Cursor's CLI accepts is the
  // account's own.
  assertLifecycleAdmission()
  preparingRuns.set(key, { id: `preparing:${key}`, token: key, title: "Starting a native agent", provider: harness, cwd, status: "finishing", stoppable: false })
  let env: NodeJS.ProcessEnv
  let command: string
  let args: string[]
  let commandEnv: Record<string, string> | undefined
  try {
    env = await accountEnv(harness, process.env)
    const prepared = runner.prepare
      ? await runner.prepare(options, env)
      : dropUncarried(options, runner.carries)
    // A setting the command line cannot carry is said out loud, never
    // silently left behind: the ACP transport would have applied it.
    if (prepared.dropped.length) {
      const named = prepared.dropped.join(", ")
      hostWarn("native", "settings dropped", { harness, key, dropped: named })
      emit({
        type: "notice",
        level: "info",
        message: `This ${harness} reply runs without ${named}: its command line cannot carry ${prepared.dropped.length === 1 ? "it" : "them"}.`,
      })
    }
    ;({ command, args, env: commandEnv } = await build(prepared.options, env))
  } finally {
    preparingRuns.delete(key)
  }
  if (commandEnv) env = { ...env, ...commandEnv }
  const executable = resolveExecutable(command, env)
  if (!executable) throw new Error(`${harness} is not installed`)
  assertLifecycleAdmission()
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: environmentForExecutable(executable, env),
  })

  const state: ThreadRunState = { path: key, harness, status: "running" }
  let resolveRun: (result: NativeRunResult) => void = () => {}
  const completed = captureOutput
    ? new Promise<NativeRunResult>((resolve) => {
        resolveRun = resolve
      })
    : undefined
  const run: Run = {
    cwd,
    token: randomUUID(),
    child,
    completed,
    outputSubscribers: new Set(),
    resolve: resolveRun,
    state,
    stdout: "",
  }
  runs.set(key, run)
  push(state)

  // The moment someone spends from an account is the moment its headroom is
  // worth a look. Suggest, never switch: money moves are the user's.
  if (providerHost.accountCapabilities.get(harness)?.mode === "selectable") {
    void switchSuggestion(harness)
      .then((message) => {
        if (message) emit({ type: "notice", level: "info", message })
      })
      .catch(() => {})
  }

  // Keep the tail of stderr: when a CLI fails it says why there, and "exit
  // code 1" with no words is the worst message this feature could show.
  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  if (captureOutput) {
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      run.stdout = (run.stdout + text).slice(-1024 * 1024)
      for (const subscriber of run.outputSubscribers) subscriber(text)
    })
  } else {
    child.stdout?.resume()
  }

  child.on("error", (error) => {
    finish(run, {
      status: "failed",
      error: error.message.includes("ENOENT")
        ? `${command} is not installed`
        : error.message,
    })
  })
  child.on("exit", (code, signal) => {
    if (run.state.status !== "running") return
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      finish(run, { status: "stopped" })
    } else if (code === 0) {
      finish(run, { status: "done" })
    } else {
      finish(run, {
        status: "failed",
        error: lastLine(stderr) || `${command} exited with code ${code}`,
      })
    }
  })

  return state
}

export function nativeLifecycleWork(): LifecycleWork[] {
  return [...preparingRuns.values(), ...[...runs.values()].filter((run) => run.state.status === "running").map((run): LifecycleWork => ({ id: `native:${run.state.path}`, token: run.token, provider: run.state.harness, title: "Native agent", cwd: run.cwd, status: "running", stoppable: true }))]
}

export function nativeStopToken(path: string): string | null {
  const run = runs.get(path)
  return run?.state.status === "running" ? run.token : null
}

export function abortNative(path: string, expectedToken?: string): void {
  const run = runs.get(path)
  if (run && run.state.status === "running" && (expectedToken === undefined || expectedToken === run.token)) run.child.kill("SIGTERM")
}

export function stopDrivers(): void {
  for (const run of runs.values()) {
    if (run.state.status === "running") run.child.kill("SIGTERM")
  }
}

function finish(run: Run, next: Partial<ThreadRunState>): void {
  run.state = { ...run.state, ...next }
  runs.delete(run.state.path)
  runs.set(run.state.path, run)
  while (runs.size > MAX_REMEMBERED_RUNS) {
    let removed = false
    for (const [path, entry] of runs) {
      if (entry.state.status === "running") continue
      runs.delete(path)
      removed = true
      break
    }
    if (!removed) break
  }
  push(run.state)
  run.resolve({ state: run.state, text: run.stdout.trim() })
  run.outputSubscribers.clear()
}

function push(state: ThreadRunState): void {
  emit({ type: "thread-run", run: state })
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}
