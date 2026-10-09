import { Worker } from "node:worker_threads"
import type { UsageSummary } from "./contracts/automations-usage-updates.js"
import { UsageWorkerReplySchema, type UsageWorkerData } from "./usage-worker-contract.js"

interface Pending {
  promise: Promise<UsageSummary>
  resolve(summary: UsageSummary): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Scans, SQLite writes and aggregation stay off the host, including cold history reads. */
export class UsageReader {
  private worker: Worker | undefined
  private pending: Pending | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private stopping: Promise<void> | undefined

  private readonly data: UsageWorkerData

  constructor(data: UsageWorkerData) { this.data = data }

  /** Concurrent views share one read; the next read resumes the durable ledger's cursors. */
  read(): Promise<UsageSummary> {
    if (this.closed) return Promise.reject(new Error("Usage history reader is closed"))
    if (this.pending) return this.pending.promise
    if (this.stopping) return this.stopping.then(() => this.read())
    clearTimeout(this.idle)
    let reader: Worker
    try {
      reader = this.worker ?? this.start()
    } catch (error) {
      return Promise.reject(error)
    }
    reader.ref()
    let resolve!: Pending["resolve"]
    let reject!: Pending["reject"]
    const promise = new Promise<UsageSummary>((yes, no) => { resolve = yes; reject = no })
    const timer = setTimeout(() => this.stop(reader, new Error("Usage history could not be read in time")), 120_000)
    this.pending = { promise, resolve, reject, timer }
    try { reader.postMessage({ type: "read" }) }
    catch (error) { void this.stop(reader, error instanceof Error ? error : new Error(String(error))) }
    return promise
  }

  private start(): Worker {
    const reader = new Worker(new URL("./usage-worker.js", import.meta.url), {
      workerData: this.data,
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    })
    this.worker = reader
    reader.on("message", raw => {
      if (this.worker !== reader) return
      const reply = UsageWorkerReplySchema.safeParse(raw)
      if (!reply.success) { void this.stop(reader, new Error("Usage history returned an invalid summary")); return }
      const pending = this.pending
      if (!pending) return
      this.pending = undefined
      clearTimeout(pending.timer)
      if (reply.data.type === "error") pending.reject(new Error(reply.data.error))
      else pending.resolve(reply.data.summary)
      reader.unref()
      this.idle = setTimeout(() => this.stop(reader, new Error("Usage history reader retired while idle")), 30_000)
      this.idle.unref()
    })
    reader.once("error", error => { void this.stop(reader, error) })
    reader.once("exit", () => { void this.stop(reader, new Error("Usage history reader exited")) })
    return reader
  }

  private async stop(reader: Worker, error: Error): Promise<void> {
    if (this.worker !== reader) return
    this.worker = undefined
    clearTimeout(this.idle)
    const pending = this.pending
    this.pending = undefined
    const stopped = reader.terminate().then(() => undefined)
    this.stopping = stopped
    if (pending) { clearTimeout(pending.timer); pending.reject(error) }
    try { await stopped }
    finally { if (this.stopping === stopped) this.stopping = undefined }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.worker) await this.stop(this.worker, new Error("Usage history reader is closed"))
    else await this.stopping
  }
}
