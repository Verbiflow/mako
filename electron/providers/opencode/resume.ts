import { Worker } from "node:worker_threads"
import { z } from "zod"
import { resumeVerdict } from "../../native-continuation.js"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import { openCodeProcessProbe } from "./process-probe.js"
import { openCodeRecordLocator, type OpenCodeResumeRecord } from "./resume-store.js"

const recordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available"), checkpoint: z.string(), generation: z.literal("v2") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])

const unavailable: OpenCodeResumeRecord = { kind: "unavailable", reason: "The OpenCode recovery reader did not complete. Retry after the native store is available." }

export const readOpenCodeRecord = async (binding: ProviderBinding): Promise<OpenCodeResumeRecord> => {
  const target = binding.path ? openCodeRecordLocator(binding.path) : null
  if (!target || target.nativeId !== binding.nativeId)
    return { kind: "unavailable", reason: "The saved OpenCode source does not match its native session ID." }
  return new Promise<OpenCodeResumeRecord>((resolve) => {
    const worker = new Worker(new URL("./resume-worker.js", import.meta.url), {
      workerData: { path: binding.path, nativeId: binding.nativeId },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let settled = false
    const finish = (value: OpenCodeResumeRecord) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(value)
    }
    const timer = setTimeout(() => finish(unavailable), 6_000)
    worker.once("message", (value) => {
      const parsed = recordSchema.safeParse(value)
      finish(parsed.success ? parsed.data : unavailable)
    })
    worker.once("error", () => finish(unavailable))
    worker.once("exit", () => finish(unavailable))
  })
}

export async function openCodeCheckpoint(path: string): Promise<string | undefined> {
  const target = openCodeRecordLocator(path)
  if (!target) return undefined
  const record = await readOpenCodeRecord({ id: "checkpoint", provider: "opencode", path, nativeId: target.nativeId, includesBase: false, coveredBlocks: 0 })
  return record.kind === "available" ? record.checkpoint : undefined
}

export function openCodeResumeVerdict(binding: ProviderBinding) {
  return resumeVerdict(binding, openCodeProcessProbe, readOpenCodeRecord)
}
