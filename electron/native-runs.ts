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

import type { Admission } from "@mako/host/base/admission"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import type { ThreadRef } from "@mako/sessions"
import type { SessionSettings } from "@mako/sessions/settings"
import { type AccountLaunch, type AccountHold, type ProviderHost, dropUncarried, type NativeCommand, type NativeRunOptions, type NativeRunner } from "@mako/host/harnesses"
import { resumable, type ResumeVerdict } from "@mako/host/contracts/conversation-control"
import { reconnectRefusal } from "./live-transfers.js"
import { hostLog, hostWarn } from "@mako/host/base/host-log"
import { launchContext } from "@mako/host/base/execution-context"
import type { ExecutionContext } from "@mako/host/contracts/execution-context"
import { ExecutionCredentialSchema } from "@mako/host/contracts/execution-context"
import { drainOwnedWork, ownedWorkCompletion } from "@mako/host/base/owned-work"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { ThreadRunState } from "@mako/host/contracts/conversation-session"
import {
  environmentForExecutable,
  resolveExecutable,
} from "@mako/host/base/executable"

export type FreshOptions = NativeRunOptions

export interface NativeRunResult {
  state: ThreadRunState
  text: string
}

interface OwnedSessionClaim {
  releaseSession?: () => void
  releaseError?: Error
}
interface Run extends OwnedSessionClaim {
  settled: Promise<void>
  settle(): void
  cwd: string
  token: string
  child: ChildProcess
  completed?: Promise<NativeRunResult>
  outputSubscribers: Set<(chunk: string) => void>
  resolve: (result: NativeRunResult) => void
  state: ThreadRunState
  stdout: string
  /** Released when the process closes, so its account can be removed. */
  accountHold?: AccountHold
}

interface Preparation extends OwnedSessionClaim {
  work: LifecycleWork
  settled: Promise<void>
  cancelled?: boolean
}
const MAX_REMEMBERED_RUNS = 600

export interface NativeRunHooks {
  /** Same assessment owner as live reconnect; evaluated after preparing the actual launch environment. */
  assessResume?(ref: ThreadRef): Promise<ResumeVerdict>
  /** Atomic cooperating-host ownership claim; release when the native process settles. */
  claimSession?(ref: ThreadRef): () => void
  /** A reply to `ref` is about to run with exactly these settings. */
  prepared?(ref: ThreadRef, settings: SessionSettings): void
  /** Whether the host takes new work; closed while it stops its agents to quit, restart or install. */
  admission?: Admission
}

/** The settings a prepared command line carries, without the run's own fields. */
export function preparedSettings(options: NativeRunOptions): SessionSettings {
  const settings: SessionSettings = {}
  if (options.model) settings.model = options.model
  if (options.options && Object.keys(options.options).length) settings.options = options.options
  return settings
}

/** This host's headless runs, one writer per native session, each reporting as `thread-run` events. */
export class NativeRuns {
  private readonly runs = new Map<string, Run>()
  private readonly preparing = new Map<string, Preparation>()
  /**
   * Fresh runs are keyed by a synthetic path — there is no session file until
   * the CLI creates one — and the session itself arrives in the catalog through
   * the watcher, like any other session anything starts on this machine.
   */
  private freshCounter = 0
  private closing = false
  private stopping: Promise<void> | undefined
  private readonly host: Pick<ProviderHost, "nativeRunners" | "accounts" | "accountCapabilities">
  private readonly emit: (event: HostEvent) => void
  private readonly hooks: NativeRunHooks

  constructor(
    host: Pick<ProviderHost, "nativeRunners" | "accounts" | "accountCapabilities">,
    emit: (event: HostEvent) => void,
    hooks: NativeRunHooks = {},
  ) {
    this.host = host
    this.emit = emit
    this.hooks = hooks
  }

  state(path: string): ThreadRunState | null {
    return this.runs.get(path)?.state ?? null
  }

  async wait(path: string, timeoutMs = 2 * 60 * 60 * 1000): Promise<NativeRunResult> {
    const run = this.runs.get(path)
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
        ? { state: { ...result.state, status: "failed", error: "The local harness ran past its two-hour limit" }, text: result.text }
        : result
    } finally {
      clearTimeout(timer)
      run.completed = undefined
      run.stdout = ""
    }
  }

  subscribeOutput(path: string, subscriber: (chunk: string) => void): () => void {
    const run = this.runs.get(path)
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
  async resume(ref: ThreadRef, prompt: string, tuning?: FreshOptions): Promise<ThreadRunState> {
    if (ref.resumeUnavailable) throw new Error(ref.resumeUnavailable)
    const existing = this.runs.get(ref.path)
    if (existing && (existing.state.status === "running" || existing.releaseSession)) throw new Error("This native session already has an active writer or retained ownership")
    const runner = this.host.nativeRunners.get(ref.harness)
    if (!runner) throw new Error(`Sessions from ${ref.harness} cannot be resumed here`)
    const options = { ...tuning, nativePath: ref.path }
    return this.launch(ref.path, ref.harness, ref.cwd, runner, options, (prepared, env) => runner.resume(ref.nativeId, prompt, prepared, env), tuning?.captureOutput ?? false, ref)
  }

  /** Start a fresh headless session on another harness, opened with a handoff. */
  async startFresh(harness: string, cwd: string | undefined, prompt: string, options: FreshOptions = {}): Promise<ThreadRunState> {
    const runner = this.host.nativeRunners.get(harness)
    if (!runner) throw new Error(`A new ${harness} session cannot be started from here`)
    return this.launch(`fresh:${harness}:${++this.freshCounter}`, harness, cwd, runner, options, (prepared, env) => runner.fresh(prompt, prepared, env), options.captureOutput ?? false)
  }

  lifecycleWork(): LifecycleWork[] {
    return [...this.preparing.values()].map(entry => ({ ...entry.work, stoppable: !entry.cancelled && !entry.releaseError })).concat([...this.runs.values()]
      .filter(run => run.state.status === "running" || Boolean(run.releaseSession))
      .map((run): LifecycleWork => ({ id: `native:${run.state.path}`, token: run.token, provider: run.state.harness, title: "Native agent", cwd: run.cwd, status: run.state.status === "running" ? "running" : "finishing", stoppable: !run.releaseError })))
  }

  stopToken(path: string): string | null {
    const preparing = this.preparing.get(path)
    if (preparing && !preparing.cancelled && !preparing.releaseError) return preparing.work.token
    const run = this.runs.get(path)
    return run?.state.status === "running" ? run.token : null
  }

  abort(path: string, expectedToken?: string): void {
    const preparing = this.preparing.get(path)
    if (preparing && (expectedToken === undefined || expectedToken === preparing.work.token)) {
      preparing.cancelled = true
      return
    }
    const run = this.runs.get(path)
    if (run && run.state.status === "running" && (expectedToken === undefined || expectedToken === run.token)) run.child.kill("SIGTERM")
  }

  stop(timeoutMs = 30_000): Promise<void> {
    this.closing = true
    if (this.stopping) return this.stopping
    const owned = [...this.runs.values()]
    const preparing = [...this.preparing.entries()]
    const startedAt = performance.now()
    hostLog("native", "shutdown drain started", { running: owned.filter(run => run.state.status === "running").length, preparing: preparing.length, retained: owned.filter(run => run.releaseError).length })
    for (const [key, entry] of preparing) {
      if (!entry.releaseError) continue
      releaseOwnership(entry, entry.work.provider, key)
      if (!entry.releaseSession && this.preparing.get(key) === entry) this.preparing.delete(key)
    }
    for (const run of owned)
      if (run.state.status === "running") run.child.kill("SIGTERM")
      else if (run.releaseSession) releaseOwnership(run, run.state.harness, run.state.path)
    const pending = preparing.map(([, entry]) => entry.settled).concat(owned.map(run => run.settled))
    const drain = drainOwnedWork(pending, timeoutMs, "Native shutdown did not complete.").then(() => {
      if (owned.some(run => run.releaseSession) || preparing.some(([, entry]) => entry.releaseSession))
        throw new Error("Native session ownership could not be released. The ledger must remain open.")
      hostLog("native", "shutdown drain completed", { elapsedMs: performance.now() - startedAt, runs: owned.length, preparing: preparing.length })
    }).catch(error => {
      hostWarn("native", "shutdown drain refused", { elapsedMs: performance.now() - startedAt, running: owned.filter(run => run.state.status === "running").length, retained: owned.filter(run => run.releaseSession).length, preparing: this.preparing.size })
      throw error
    }).finally(() => { if (this.stopping === drain) this.stopping = undefined })
    this.stopping = drain
    return drain
  }

  private assertAdmission(): void {
    if (this.closing) throw new Error("Mako's native launcher is shutting down. Your prompt was not sent.")
    this.hooks.admission?.assert()
  }

  private async launch(
    key: string,
    harness: string,
    workingDir: string | undefined,
    runner: NativeRunner,
    options: NativeRunOptions,
    build: (options: NativeRunOptions, env: NodeJS.ProcessEnv) => NativeCommand | Promise<NativeCommand>,
    captureOutput: boolean,
    ref?: ThreadRef
  ): Promise<ThreadRunState> {
    const { hooks } = this
    const cwd = workingDir && existsSync(workingDir) ? workingDir : homedir()
    // The selected account decides who pays for this run, and what the
    // command line may name: Cursor's model list is the account's own.
    this.assertAdmission()
    // Reserve before the first await. Concurrent native replies must not build or spawn a second writer.
    if (this.preparing.has(key) || this.runs.get(key)?.state.status === "running" || this.runs.get(key)?.releaseSession)
      throw new Error("This native session already has an active or preparing writer")
    const preparing = ownedWorkCompletion()
    const preparation: Preparation = { work: { id: `native:${key}`, token: randomUUID(), title: "Starting a native agent", provider: harness, cwd, status: "finishing", stoppable: true }, settled: preparing.promise }
    this.preparing.set(key, preparation)
    const assertPreparation = () => {
      this.assertAdmission()
      if (preparation.cancelled || this.preparing.get(key) !== preparation)
        throw new Error("Native startup was cancelled. Your prompt was not sent.")
    }
    let accountHold: AccountHold | undefined
    const failedPreparation = () => {
      accountHold?.release()
      releaseOwnership(preparation, harness, key)
      if (!preparation.releaseSession && this.preparing.get(key) === preparation) this.preparing.delete(key)
      preparing.resolve()
    }
    let env: NodeJS.ProcessEnv
    let command: string
    let args: string[]
    let commandEnv: Record<string, string> | undefined
    let releaseSession: (() => void) | undefined
    let executionContext: ExecutionContext
    let accountLaunch: AccountLaunch
    try {
      const launch = await this.host.accounts.launch(harness, process.env, { holder: { kind: "run" } })
      accountLaunch = launch
      accountHold = launch.hold
      assertPreparation()
      const resolved = runner.launchCredentials.kind === "resolved"
        ? await runner.launchCredentials.resolve(launch.env)
        : undefined
      assertPreparation()
      env = { ...(resolved?.env ?? launch.env) }
      executionContext = launchContext(runner.transport, {
        kind: "unavailable", reason: "This headless transport has not reported the executing native identity.",
      }, launch.account)
      if (resolved) executionContext.credential = ExecutionCredentialSchema.parse(resolved.credential)
      else if (runner.launchCredentials.kind === "unavailable")
        executionContext.credential = { kind: "unavailable", reason: runner.launchCredentials.reason }
      const prepared = runner.prepare
        ? await runner.prepare(options, env)
        : dropUncarried(options, runner.carries)
      assertPreparation()
      // A setting the command line cannot carry is said out loud, never
      // silently left behind: the ACP transport would have applied it.
      if (prepared.dropped.length) {
        const named = prepared.dropped.join(", ")
        hostWarn("native", "settings dropped", { harness, key, dropped: named })
        this.emit({
          type: "notice",
          level: "info",
          message: `This ${harness} reply runs without ${named}: its command line cannot carry ${prepared.dropped.length === 1 ? "it" : "them"}.`,
        })
      }
      ;({ command, args, env: commandEnv } = await build(prepared.options, env))
      assertPreparation()
      if (ref) {
        const verdict = await hooks.assessResume?.(ref)
        assertPreparation()
        if (!verdict || !resumable(verdict)) throw new Error(reconnectRefusal(verdict))
        if (!hooks.claimSession) throw new Error("Native session ownership is unavailable. Retry after the host reconnects.")
        releaseSession = hooks.claimSession(ref)
        preparation.releaseSession = releaseSession
        hooks.prepared?.(ref, preparedSettings(prepared.options))
        assertPreparation()
      }
      hostLog("native", "launch context prepared", { harness, key, account: launch.account.name, transport: runner.transport, credentialSource: executionContext.credential?.kind === "configured" ? executionContext.credential.source : "unverified", operation: ref ? "resume" : "fresh" })
    } catch (error) {
      failedPreparation()
      throw error
    }
    let executable: string | null
    let child: ChildProcess
    try {
      if (commandEnv) env = { ...env, ...commandEnv }
      executable = resolveExecutable(command, env)
      if (!executable) throw new Error(`${harness} is not installed`)
      await this.host.accounts.assertLaunch(harness, accountLaunch)
      assertPreparation()
      child = spawn(executable, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: environmentForExecutable(executable, env),
      })
    } catch (error) {
      failedPreparation()
      throw error
    }

    executionContext.executable = executable
    const state: ThreadRunState = { path: key, harness, status: "running", executionContext }
    const settled = ownedWorkCompletion()
    let resolveRun: (result: NativeRunResult) => void = () => {}
    const completed = captureOutput
      ? new Promise<NativeRunResult>((resolve) => {
          resolveRun = resolve
        })
      : undefined
    const run: Run = {
      settled: settled.promise,
      settle: () => settled.resolve(),
      cwd,
      token: randomUUID(),
      child,
      completed,
      outputSubscribers: new Set(),
      resolve: resolveRun,
      state,
      stdout: "",
      releaseSession,
      accountHold,
    }
    this.runs.set(key, run)
    preparation.releaseSession = undefined
    if (this.preparing.get(key) === preparation) this.preparing.delete(key)
    preparing.resolve()
    this.push(state)

    // The moment someone spends from an account is the moment its headroom is
    // worth a look. Suggest, never switch: money moves are the user's.
    if (this.host.accountCapabilities.get(harness)?.mode === "selectable") {
      void this.host.accounts.switchSuggestion(harness)
        .then((message) => {
          if (message) this.emit({ type: "notice", level: "info", message })
        })
        .catch(() => {})
    }

    // Keep the tail of stderr: when a CLI fails it says why there, and "exit
    // code 1" with no words is the worst message this feature could show.
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    if (captureOutput) {
      child.stdout?.setEncoding("utf8")
      child.stdout?.on("data", (text: string) => {
        run.stdout = (run.stdout + text).slice(-1024 * 1024)
        for (const subscriber of run.outputSubscribers) subscriber(text)
      })
    } else {
      child.stdout?.resume()
    }

    let processError: Error | undefined
    child.on("error", (error) => { processError = error })
    // Exit is not output/child cleanup: a descendant can still hold these
    // pipes. Retain this exact claim until close drains them, including spawn
    // errors. Never admit a replacement using the leader's exit alone.
    child.once("close", (code, signal) => {
      if (run.state.status !== "running") return
      if (processError) {
        this.finish(run, {
          status: "failed",
          error: processError.message.includes("ENOENT") ? `${command} is not installed` : processError.message,
        })
      } else if (signal === "SIGTERM" || signal === "SIGKILL") {
        this.finish(run, { status: "stopped" })
      } else if (code === 0) {
        this.finish(run, { status: "done" })
      } else {
        this.finish(run, {
          status: "failed",
          error: lastLine(stderr) || `${command} exited with code ${code}`,
        })
      }
    })

    return state
  }

  private finish(run: Run, next: Partial<ThreadRunState>): void {
    if (run.state.status !== "running") return
    run.accountHold?.release()
    releaseOwnership(run, run.state.harness, run.state.path)
    run.state = { ...run.state, ...next }
    if (run.releaseError) run.state = { ...run.state, status: "failed", error: "The native process closed, but session ownership could not be released." }
    run.settle()
    run.resolve({ state: run.state, text: run.stdout.trim() })
    run.outputSubscribers.clear()
    // A late event owns only this launch, never a later run at the same path.
    const { runs } = this
    if (runs.get(run.state.path) !== run) return
    runs.delete(run.state.path)
    runs.set(run.state.path, run)
    while (runs.size > MAX_REMEMBERED_RUNS) {
      let removed = false
      for (const [path, entry] of runs) {
        if (entry.state.status === "running" || entry.releaseSession) continue
        runs.delete(path)
        removed = true
        break
      }
      if (!removed) break
    }
    this.push(run.state)
  }

  private push(state: ThreadRunState): void {
    this.emit({ type: "thread-run", run: state })
  }
}

function releaseOwnership(run: OwnedSessionClaim, harness: string, path: string): void {
  try {
    run.releaseSession?.()
    run.releaseSession = undefined
    run.releaseError = undefined
  } catch (error) {
    run.releaseError = error instanceof Error ? error : new Error("Native ownership release failed")
    hostWarn("native", "ownership release failed", { harness, path, error: run.releaseError.name })
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}
