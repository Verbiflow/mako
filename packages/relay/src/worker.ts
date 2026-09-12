import { randomUUID } from "node:crypto"
import { RelayEventSequencer } from "./events.js"
import type {
  RelayCanonicalEvent,
  RelayCompletion,
  RelayControl,
  RelayEventBatch,
  RelayEventEnvelope,
  RelayLease,
  RelayLeaseRequest,
  RelayPresentation,
  WorkerHeartbeat,
} from "./schema.js"

export interface RelayExecution {
  /** The project directory the work ran in, remembered for the remote thread. */
  cwd?: string
  effort?: string
  fast?: boolean
  harness: string
  model?: string
  presentation?: RelayPresentation
  result: string
  status: "done" | "failed" | "stopped"
  threadPath?: string
}

export interface RelayExecutionContext {
  signal: AbortSignal
  emit: (event: RelayCanonicalEvent) => void
}

export interface RelayExecutor {
  execute(
    lease: RelayLease,
    context: RelayExecutionContext
  ): Promise<RelayExecution>
  control?(lease: RelayLease, control: RelayControl): Promise<void>
}

export interface RelayTransport {
  lease(
    request: RelayLeaseRequest,
    signal: AbortSignal
  ): Promise<RelayLease | null>
  renew(lease: RelayLease, request: RelayLeaseRequest): Promise<string>
  sendEvents(batch: RelayEventBatch): Promise<void>
  control(lease: RelayLease, deviceId: string): Promise<RelayControl | null>
  complete(completion: RelayCompletion): Promise<void>
}

/** Where in the loop something happened; every failure names its phase. */
export type RelayWorkerPhase =
  | "stopped"
  | "polling"
  | "waiting"
  | "executing"
  | "completing"
  | "backoff"

export type RelayWorkerFailurePhase =
  | "lease"
  | "renew"
  | "control"
  | "events"
  | "execute"
  | "complete"

export interface RelayWorkerFailure {
  at: string
  phase: RelayWorkerFailurePhase
  message: string
}

/**
 * Everything a host needs to say what the relay is doing without reading the
 * loop: the worker used to swallow every error and the desk could only show
 * that the backend's health endpoint answered.
 */
export interface RelayWorkerStatus {
  phase: RelayWorkerPhase
  deviceId: string
  startedAt: string | null
  lastPollAt: string | null
  lastLeaseAt: string | null
  lastCompletionAt: string | null
  nextPollAt: string | null
  consecutiveFailures: number
  jobsCompleted: number
  currentJob: { jobId: string; startedAt: string; kind: string } | null
  lastFailure: RelayWorkerFailure | null
}

/** The host's part of a heartbeat; the worker adds generation and activity. */
export type RelayHostHeartbeat = Omit<
  WorkerHeartbeat,
  "generation" | "startedAt" | "activity" | "currentJobId"
>

export interface HeadlessRelayWorkerOptions {
  /** Read on every lease and renewal, so host state (the workspace) is current. */
  heartbeat: () => RelayHostHeartbeat
  visibilityTimeoutSeconds?: number
  idleDelay?: (emptyPolls: number, sinceWorkMs: number | null) => number
  controlIntervalMs?: number
  renewIntervalMs?: number
  eventFlushMs?: number
  onStatus?: (status: RelayWorkerStatus) => void
  onFailure?: (failure: RelayWorkerFailure, boundary: RelayFailureBoundary) => void
}

/** The caught value at a worker boundary, unparsed until a consumer reads it. */
export interface RelayFailureBoundary {
  error: unknown
}

/** A follow-up usually lands within a couple of minutes of an answer. */
export const RELAY_ACTIVE_WINDOW_MS = 2 * 60_000
export const RELAY_ACTIVE_POLL_MS = 1_000
export const RELAY_IDLE_POLL_MAX_MS = 15_000
/** Well inside the gateway's 45-second presence window. */
export const RELAY_RENEW_INTERVAL_MS = 20_000
const FAILURE_BACKOFF_MS = 5_000
const FAILURE_BACKOFF_MAX_MS = 60_000

/**
 * Poll quickly while a conversation is active, back off while nothing
 * happens. A durable queue has no push channel, so this is the latency knob.
 */
export function relayIdleDelay(
  emptyPolls: number,
  sinceWorkMs: number | null
): number {
  if (sinceWorkMs !== null && sinceWorkMs < RELAY_ACTIVE_WINDOW_MS)
    return RELAY_ACTIVE_POLL_MS
  return Math.min(1_500 * 2 ** emptyPolls, RELAY_IDLE_POLL_MAX_MS)
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

function errorMessage({ error }: RelayFailureBoundary): string {
  return error instanceof Error ? error.message : String(error)
}


export class HeadlessRelayWorker {
  #controller: AbortController | null = null
  #running: Promise<void> | null = null
  readonly #sequencer: RelayEventSequencer
  /** New on every worker instance, so a restart is visible to the gateway. */
  readonly #generation = randomUUID()
  #status: RelayWorkerStatus
  #lastWorkAt: number | null = null

  constructor(
    readonly transport: RelayTransport,
    readonly executor: RelayExecutor,
    readonly options: HeadlessRelayWorkerOptions
  ) {
    const { deviceId } = options.heartbeat()
    this.#sequencer = new RelayEventSequencer(deviceId)
    this.#status = {
      phase: "stopped",
      deviceId,
      startedAt: null,
      lastPollAt: null,
      lastLeaseAt: null,
      lastCompletionAt: null,
      nextPollAt: null,
      consecutiveFailures: 0,
      jobsCompleted: 0,
      currentJob: null,
      lastFailure: null,
    }
  }

  status(): RelayWorkerStatus {
    return this.#status
  }

  start(): void {
    if (this.#running) return
    this.#controller = new AbortController()
    this.#update({ phase: "polling", startedAt: new Date().toISOString() })
    this.#running = this.#loop(this.#controller.signal).finally(() => {
      this.#controller = null
      this.#running = null
      this.#update({ phase: "stopped", currentJob: null, nextPollAt: null })
    })
  }

  async stop(): Promise<void> {
    this.#controller?.abort()
    await this.#running
  }

  /** Presence plus sanitized activity; the gateway answers `status` from it. */
  heartbeat(): WorkerHeartbeat {
    const { currentJob, consecutiveFailures, startedAt } = this.#status
    const heartbeat: WorkerHeartbeat = {
      ...this.options.heartbeat(),
      generation: this.#generation,
      activity: currentJob
        ? "busy"
        : consecutiveFailures >= 3
          ? "failing"
          : "idle",
    }
    if (startedAt) heartbeat.startedAt = startedAt
    if (currentJob) heartbeat.currentJobId = currentJob.jobId
    return heartbeat
  }

  #leaseRequest(): RelayLeaseRequest {
    return {
      ...this.heartbeat(),
      visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds ?? 300,
    }
  }

  async runOnce(signal = new AbortController().signal): Promise<boolean> {
    const request = this.#leaseRequest()
    this.#update({ phase: "polling", nextPollAt: null })
    const lease = await this.transport.lease(request, signal)
    this.#update({ lastPollAt: new Date().toISOString() })
    if (!lease || signal.aborted) return false
    await this.#execute(lease, request, signal)
    return true
  }

  #update(patch: Partial<RelayWorkerStatus>): void {
    this.#status = { ...this.#status, ...patch }
    this.options.onStatus?.(this.#status)
  }

  #fail(phase: RelayWorkerFailurePhase, boundary: RelayFailureBoundary): void {
    const failure: RelayWorkerFailure = {
      at: new Date().toISOString(),
      phase,
      message: errorMessage(boundary),
    }
    this.#update({ lastFailure: failure })
    this.options.onFailure?.(failure, boundary)
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let emptyPolls = 0
    while (!signal.aborted) {
      let worked = false
      try {
        worked = await this.runOnce(signal)
        emptyPolls = worked ? 0 : Math.min(emptyPolls + 1, 4)
        this.#update({ consecutiveFailures: 0 })
      } catch (error) {
        if (signal.aborted) break
        const failures = this.#status.consecutiveFailures + 1
        this.#fail("lease", { error })
        const wait = Math.min(
          FAILURE_BACKOFF_MS * 2 ** (failures - 1),
          FAILURE_BACKOFF_MAX_MS
        )
        this.#update({
          phase: "backoff",
          consecutiveFailures: failures,
          nextPollAt: new Date(Date.now() + wait).toISOString(),
        })
        await delay(wait, signal)
        continue
      }
      if (signal.aborted) break
      const sinceWork =
        this.#lastWorkAt === null ? null : Date.now() - this.#lastWorkAt
      const wait =
        this.options.idleDelay?.(emptyPolls, sinceWork) ??
        relayIdleDelay(emptyPolls, sinceWork)
      this.#update({
        phase: "waiting",
        nextPollAt: new Date(Date.now() + wait).toISOString(),
      })
      await delay(wait, signal)
    }
  }

  async #execute(
    lease: RelayLease,
    request: RelayLeaseRequest,
    workerSignal: AbortSignal
  ): Promise<void> {
    const startedAt = new Date().toISOString()
    this.#lastWorkAt = Date.now()
    this.#update({
      phase: "executing",
      lastLeaseAt: startedAt,
      currentJob: { jobId: lease.jobId, startedAt, kind: lease.payload.kind },
    })
    const turn = new AbortController()
    const stop = () => turn.abort()
    workerSignal.addEventListener("abort", stop, { once: true })
    let popReceipt = lease.popReceipt
    let renewal = Promise.resolve()
    let controls = Promise.resolve()
    let events = Promise.resolve()
    let eventFailure = false
    let pending: RelayEventEnvelope[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      if (pending.length === 0 || eventFailure) return
      const sending = pending
      pending = []
      events = events
        .then(() =>
          this.transport.sendEvents({
            deviceId: request.deviceId,
            jobId: lease.jobId,
            cursor: sending.at(-1)?.cursor,
            events: sending,
          })
        )
        .catch((error) => {
          eventFailure = true
          this.#fail("events", { error })
        })
    }

    const emit = (event: RelayCanonicalEvent) => {
      pending.push(this.#sequencer.next(lease.jobId, event))
      if (pending.length >= 50) flush()
      else flushTimer ??= setTimeout(flush, this.options.eventFlushMs ?? 250)
    }

    emit({ kind: "lifecycle", status: "starting" })
    // Renewal doubles as the heartbeat while a job runs: a busy worker sends
    // no lease requests, and the gateway's presence window is 45 seconds.
    const renewTimer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          popReceipt = await this.transport.renew(
            { ...lease, popReceipt },
            this.#leaseRequest()
          )
        })
        .catch((error) => {
          this.#fail("renew", { error })
          turn.abort()
        })
    }, this.options.renewIntervalMs ?? RELAY_RENEW_INTERVAL_MS)
    const controlTimer = setInterval(() => {
      controls = controls
        .then(async () => {
          const control = await this.transport.control(lease, request.deviceId)
          if (control?.kind === "stop") turn.abort()
          else if (control) await this.executor.control?.(lease, control)
        })
        .catch((error) => this.#fail("control", { error }))
    }, this.options.controlIntervalMs ?? 2_000)

    let execution: RelayExecution
    try {
      execution = await this.executor.execute(lease, {
        signal: turn.signal,
        emit,
      })
    } catch (error) {
      this.#fail("execute", { error })
      execution = {
        harness: lease.payload.selection.harness ?? request.defaultHarness,
        result: errorMessage({ error }),
        status: turn.signal.aborted ? "stopped" : "failed",
      }
    } finally {
      clearInterval(renewTimer)
      clearInterval(controlTimer)
      workerSignal.removeEventListener("abort", stop)
      flush()
      await Promise.all([renewal, controls, events])
    }

    emit({
      kind: "lifecycle",
      status:
        execution.status === "done"
          ? "completed"
          : execution.status === "stopped"
            ? "stopped"
            : "failed",
    })
    flush()
    await events
    this.#update({ phase: "completing" })
    try {
      await this.#completeWithRetry({
        cwd: execution.cwd,
        deviceId: request.deviceId,
        effort: execution.effort,
        fast: execution.fast,
        harness: execution.harness,
        jobId: lease.jobId,
        messageId: lease.messageId,
        model: execution.model,
        popReceipt,
        presentation: execution.presentation,
        progressFailed: eventFailure,
        result: execution.result,
        status: execution.status,
        threadPath: execution.threadPath,
      })
    } finally {
      this.#lastWorkAt = Date.now()
      this.#update({
        currentJob: null,
        lastCompletionAt: new Date().toISOString(),
        jobsCompleted: this.#status.jobsCompleted + 1,
      })
    }
  }

  async #completeWithRetry(completion: RelayCompletion): Promise<void> {
    let last: RelayFailureBoundary | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.transport.complete(completion)
        return
      } catch (error) {
        last = { error }
        this.#fail("complete", last)
      }
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, FAILURE_BACKOFF_MS))
    }
    throw last?.error instanceof Error
      ? last.error
      : new Error(last ? errorMessage(last) : "Relay completion failed")
  }
}

export function createWorkerId(): string {
  return randomUUID()
}
