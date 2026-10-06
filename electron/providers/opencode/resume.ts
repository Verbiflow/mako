import { Worker } from "node:worker_threads"
import { z } from "zod"
import { inspectNativeSession } from "../../native-continuation.js"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import { openCodeProcessProbe } from "./process-probe.js"
import { openCodeRecordLocator, type OpenCodeResumeRecord } from "./resume-store.js"

const recordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available"), checkpoint: z.string(), generation: z.literal("v2") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])

const holdsSchema = z.object({ kind: z.literal("holds"), holds: z.boolean() })

const unavailable: OpenCodeResumeRecord = { kind: "unavailable", reason: "The OpenCode recovery reader did not complete. Retry after the native store is available." }

function readInWorker<T>(workerData: { path: string; nativeId: string; read: "record" | "holds" }, schema: z.ZodType<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const worker = new Worker(new URL("./resume-worker.js", import.meta.url), {
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), 6_000)
    worker.once("message", (value) => {
      const parsed = schema.safeParse(value)
      finish(parsed.success ? parsed.data : fallback)
    })
    worker.once("error", () => finish(fallback))
    worker.once("exit", () => finish(fallback))
  })
}

export const readOpenCodeRecord = async (binding: ProviderBinding): Promise<OpenCodeResumeRecord> => {
  const target = binding.path ? openCodeRecordLocator(binding.path) : null
  if (!binding.path || !target || target.nativeId !== binding.nativeId)
    return { kind: "unavailable", reason: "The saved OpenCode source does not match its native session ID." }
  return readInWorker({ path: binding.path, nativeId: target.nativeId, read: "record" }, recordSchema, unavailable)
}

/** Whether the store this locator names holds the session's row, pending inputs or not. */
export async function openCodeStoreHoldsSession(path: string, nativeId: string): Promise<boolean> {
  const target = openCodeRecordLocator(path)
  if (!target || target.nativeId !== nativeId) return false
  const read = await readInWorker({ path, nativeId, read: "holds" }, holdsSchema, { kind: "holds", holds: false })
  return read.holds
}

export async function openCodeCheckpoint(path: string): Promise<string | undefined> {
  const target = openCodeRecordLocator(path)
  if (!target) return undefined
  const record = await readOpenCodeRecord({ id: "checkpoint", provider: "opencode", path, nativeId: target.nativeId, includesBase: false, coveredBlocks: 0 })
  return record.kind === "available" ? record.checkpoint : undefined
}

export function inspectOpenCodeSession(binding: ProviderBinding) {
  return inspectNativeSession(binding, openCodeProcessProbe, readOpenCodeRecord)
}
