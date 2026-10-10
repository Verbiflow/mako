import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { ProviderBinding } from "@mako/host/contracts/conversation-control"
import { NativeQuestionHistorySchema, type NativeQuestionHistory } from "@mako/host/contracts/live-questions"

const reply = z.union([
  z.object({ id: z.number().int(), entries: NativeQuestionHistorySchema }),
  z.object({ id: z.number().int(), error: z.string() }),
])

interface Request {
  resolve(value: NativeQuestionHistory): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** One lazy, bounded worker keeps native JSON parsing off the host's event loop. */
export class CodexQuestionReader {
  private worker: Worker | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private sequence = 0
  private readonly requests = new Map<number, Request>()
  private readonly reads = new Map<string, Promise<NativeQuestionHistory>>()

  read(binding: ProviderBinding): Promise<NativeQuestionHistory> {
    if (!binding.path || !binding.nativeId) return Promise.reject(new Error("The native source for this question has not been found"))
    const key = JSON.stringify([binding.path, binding.nativeId])
    const pending = this.reads.get(key)
    if (pending) return pending
    if (this.requests.size >= 32) return Promise.reject(new Error("Native question reader is busy; try again after it catches up"))
    clearTimeout(this.idle)
    const reader = this.worker ?? this.start()
    reader.ref()
    const id = ++this.sequence
    const result = new Promise<NativeQuestionHistory>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(reader, new Error("Native question history could not be read in time")), 30_000)
      this.requests.set(id, { resolve, reject, timer })
      reader.postMessage({ id, path: binding.path, nativeId: binding.nativeId })
    })
    this.reads.set(key, result)
    void result.finally(() => { if (this.reads.get(key) === result) this.reads.delete(key) }).catch(() => {})
    return result
  }

  private start(): Worker {
    const reader = new Worker(new URL("./question-worker.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 128 } })
    this.worker = reader
    reader.on("message", (raw) => {
      const parsed = reply.safeParse(raw)
      if (!parsed.success) { this.stop(reader, new Error("Native question reader returned invalid evidence")); return }
      const request = this.requests.get(parsed.data.id)
      if (!request || this.worker !== reader) return
      this.requests.delete(parsed.data.id)
      clearTimeout(request.timer)
      if ("error" in parsed.data) request.reject(new Error(parsed.data.error))
      else request.resolve(parsed.data.entries)
      if (!this.requests.size) {
        reader.unref()
        this.idle = setTimeout(() => this.stop(reader, new Error("Native question reader retired while idle")), 30_000)
        this.idle.unref()
      }
    })
    reader.once("error", error => this.stop(reader, error))
    reader.once("exit", () => this.stop(reader, new Error("Native question reader exited")))
    return reader
  }

  private stop(reader: Worker, error: Error): void {
    if (this.worker !== reader) return
    this.worker = undefined
    clearTimeout(this.idle)
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error) }
    this.requests.clear()
    this.reads.clear()
    void reader.terminate()
  }
}
