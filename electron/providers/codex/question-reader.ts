import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import { NativeQuestionHistorySchema, type NativeQuestionHistory } from "../../contracts/live-questions.js"

const reply = z.union([
  z.object({ id: z.number().int(), entries: NativeQuestionHistorySchema }),
  z.object({ id: z.number().int(), error: z.string() }),
])
let worker: Worker | undefined
let idle: ReturnType<typeof setTimeout> | undefined
let sequence = 0
const requests = new Map<number, { resolve(value: NativeQuestionHistory): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
const reads = new Map<string, Promise<NativeQuestionHistory>>()

function stop(reader: Worker, error: Error): void {
  if (worker !== reader) return
  worker = undefined
  clearTimeout(idle)
  for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error) }
  requests.clear()
  reads.clear()
  void reader.terminate()
}

/** One lazy, bounded worker keeps native JSON parsing off the host's event loop. */
export function readCodexQuestionHistory(binding: ProviderBinding): Promise<NativeQuestionHistory> {
  if (!binding.path || !binding.nativeId) return Promise.reject(new Error("The native source for this question has not been found"))
  const key = JSON.stringify([binding.path, binding.nativeId])
  const pending = reads.get(key)
  if (pending) return pending
  if (requests.size >= 32) return Promise.reject(new Error("Native question reader is busy; try again after it catches up"))
  clearTimeout(idle)
  if (!worker) {
    const reader = new Worker(new URL("./question-worker.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 128 } })
    worker = reader
    reader.on("message", (raw) => {
      const parsed = reply.safeParse(raw)
      if (!parsed.success) { stop(reader, new Error("Native question reader returned invalid evidence")); return }
      const request = requests.get(parsed.data.id)
      if (!request || worker !== reader) return
      requests.delete(parsed.data.id)
      clearTimeout(request.timer)
      if ("error" in parsed.data) request.reject(new Error(parsed.data.error))
      else request.resolve(parsed.data.entries)
      if (!requests.size) {
        reader.unref()
        idle = setTimeout(() => stop(reader, new Error("Native question reader retired while idle")), 30_000)
        idle.unref()
      }
    })
    reader.once("error", error => stop(reader, error))
    reader.once("exit", () => stop(reader, new Error("Native question reader exited")))
  }
  const reader = worker
  reader.ref()
  const id = ++sequence
  const result = new Promise<NativeQuestionHistory>((resolve, reject) => {
    const timer = setTimeout(() => stop(reader, new Error("Native question history could not be read in time")), 30_000)
    requests.set(id, { resolve, reject, timer })
    reader.postMessage({ id, path: binding.path, nativeId: binding.nativeId })
  })
  reads.set(key, result)
  void result.finally(() => { if (reads.get(key) === result) reads.delete(key) }).catch(() => {})
  return result
}
