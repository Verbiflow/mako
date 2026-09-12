import type { EventEmitter } from "node:events"
import { stripVTControlCharacters } from "node:util"

/**
 * The deadline on an ACP agent's startup, measured the way a stall actually
 * shows itself: as silence.
 *
 * A fixed 20-second budget on `session/new` once killed a Grok that answered
 * `initialize` in 150 ms, created its native session, and then produced
 * nothing for 19 seconds while assembling its context; the same budget would
 * also cut off a provider that is visibly still connecting its MCP servers
 * one notification at a time. So the watch resets its deadline whenever the
 * process writes to stdout or stderr, and only a process that has said
 * nothing for `silenceMs` fails the step. A hard `totalMs` cap still bounds
 * a process that keeps chattering without ever answering, and a process that
 * exits fails the step at once with what its stderr said.
 *
 * The error names the step, how long the silence was, what the agent had
 * already finished, and whether the process is still alive, which is the
 * difference between "install is broken" and "retry".
 */
export interface StartupProcess extends EventEmitter {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
}

export interface StartupWatchOptions {
  harness: string
  /** Fail a step once the process has produced nothing for this long. */
  silenceMs?: number
  /** Fail a step that has not finished after this long, whatever it produced. */
  totalMs?: number
  /** The retained stderr tail, for the exit message. */
  stderr?: () => string
  now?: () => number
}

export interface StartupStepReport {
  name: string
  ms: number
  outcome: "done" | "silent" | "timed-out" | "exited" | "failed"
}

export const STARTUP_SILENCE_MS = 20_000
export const STARTUP_TOTAL_MS = 120_000

interface PendingStep {
  name: string
  startedAt: number
  silence: NodeJS.Timeout | null
  total: NodeJS.Timeout | null
  reject: (error: Error) => void
}

/** Structured tracing at INFO and below is narration, not a failure reason. */
const TRACE_LINE = /^\d{4}-\d\d-\d\dT\S+\s+(?:TRACE|DEBUG|INFO)\b/

export function stderrDetail(text: string): string {
  const lines = stripVTControlCharacters(text)
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !TRACE_LINE.test(line))
  return (lines[lines.length - 1] ?? "").trim().slice(0, 300)
}

export function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `exited on ${signal}`
  if (code !== null) return `exited with code ${code}`
  return "exited"
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

export class AcpStartupWatch {
  readonly steps: StartupStepReport[] = []
  private readonly harness: string
  private readonly silenceMs: number
  private readonly totalMs: number
  private readonly now: () => number
  private readonly stderrTail: () => string
  private readonly process: StartupProcess
  private lastOutputAt: number
  private lastOutputKind: "stdout" | "stderr" | null = null
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private pending: PendingStep | null = null
  private disposed = false

  private readonly onStdout = () => this.observe("stdout")
  private readonly onStderr = () => this.observe("stderr")
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.exit = { code, signal }
    const pending = this.pending
    if (!pending) return
    this.settle(pending, "exited")
    pending.reject(
      new Error(
        `${this.harness} ${exitDescription(code, signal)} during ${pending.name}${this.stderrLine()}`
      )
    )
  }

  constructor(process: StartupProcess, options: StartupWatchOptions) {
    this.process = process
    this.harness = options.harness
    this.silenceMs = options.silenceMs ?? STARTUP_SILENCE_MS
    this.totalMs = options.totalMs ?? STARTUP_TOTAL_MS
    this.now = options.now ?? Date.now
    this.stderrTail = options.stderr ?? (() => "")
    this.lastOutputAt = this.now()
    process.stdout.on("data", this.onStdout)
    process.stderr.on("data", this.onStderr)
    process.on("exit", this.onExit)
    if (process.exitCode !== null || process.signalCode !== null)
      this.exit = { code: process.exitCode, signal: process.signalCode }
  }

  /** Run one startup request under the watch. Steps run one at a time. */
  async step<Value>(name: string, work: Promise<Value>): Promise<Value> {
    if (this.pending) throw new Error(`${this.harness} startup step ${this.pending.name} is still pending`)
    if (this.disposed) throw new Error(`${this.harness} startup watch was disposed before ${name}`)
    if (this.exit)
      throw new Error(
        `${this.harness} ${exitDescription(this.exit.code, this.exit.signal)} before ${name}${this.stderrLine()}`
      )
    const startedAt = this.now()
    return new Promise<Value>((resolve, reject) => {
      const pending: PendingStep = { name, startedAt, silence: null, total: null, reject }
      this.pending = pending
      this.armSilence()
      pending.total = setTimeout(() => {
        if (this.pending !== pending) return
        this.settle(pending, "timed-out")
        reject(
          new Error(
            `${this.harness} did not finish ${name} within ${seconds(this.totalMs)}${this.describeOutput()}`
          )
        )
      }, this.totalMs)
      work.then(
        (value) => {
          if (this.pending !== pending) return
          this.settle(pending, "done")
          resolve(value)
        },
        (error: Error) => {
          if (this.pending !== pending) return
          this.settle(pending, "failed")
          reject(error)
        }
      )
    })
  }

  /** The finished steps, for a log line. */
  summary(): string {
    return this.steps.map((step) => `${step.name} ${step.outcome} ${step.ms}ms`).join(", ")
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending
    if (pending) {
      this.settle(pending, "failed")
      pending.reject(new Error(`${this.harness} startup was abandoned during ${pending.name}`))
    }
    this.process.stdout.off("data", this.onStdout)
    this.process.stderr.off("data", this.onStderr)
    this.process.off("exit", this.onExit)
  }

  private observe(kind: "stdout" | "stderr"): void {
    this.lastOutputAt = this.now()
    this.lastOutputKind = kind
    if (this.pending) this.armSilence()
  }

  private armSilence(): void {
    const pending = this.pending
    if (!pending) return
    if (pending.silence) clearTimeout(pending.silence)
    pending.silence = setTimeout(() => {
      if (this.pending !== pending) return
      const quiet = this.now() - this.lastOutputAt
      if (quiet < this.silenceMs) {
        this.armSilence()
        return
      }
      this.settle(pending, "silent")
      const finished = this.steps.filter((step) => step.outcome === "done").map((step) => step.name)
      const after = finished.length ? ` after finishing ${finished.join(" and ")}` : ""
      const alive = this.exit ? exitDescription(this.exit.code, this.exit.signal) : "process still running"
      pending.reject(
        new Error(
          `${this.harness} produced no output for ${seconds(quiet)} during ${pending.name}${after} (${alive})`
        )
      )
    }, this.silenceMs)
  }

  private settle(pending: PendingStep, outcome: StartupStepReport["outcome"]): void {
    if (pending.silence) clearTimeout(pending.silence)
    if (pending.total) clearTimeout(pending.total)
    this.steps.push({ name: pending.name, ms: Math.max(0, this.now() - pending.startedAt), outcome })
    if (this.pending === pending) this.pending = null
  }

  private describeOutput(): string {
    if (!this.lastOutputKind) return " (it produced no output at all)"
    return ` (its last ${this.lastOutputKind} output was ${seconds(this.now() - this.lastOutputAt)} ago)`
  }

  private stderrLine(): string {
    const detail = stderrDetail(this.stderrTail())
    return detail ? `: ${detail}` : ""
  }
}
