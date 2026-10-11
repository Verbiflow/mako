import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { Worker } from "node:worker_threads"
import { z } from "zod"
import { inspectNativeSession } from "../native-continuation.js"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import type { NativeForkSource } from "../live-driver.js"
import type { ProviderProcessProbe } from "../../threads/index.js"
import { openCodeRecordLocator, type OpenCodeResumeRecord } from "./resume-store.js"

const recordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available"), checkpoint: z.string(), generation: z.literal("v2") }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])

const holdsSchema = z.object({ kind: z.literal("holds"), holds: z.boolean() })

const unavailable: OpenCodeResumeRecord = { kind: "unavailable", reason: "The OpenCode recovery reader did not complete. Retry after the native store is available." }

const sealedSchema = z.object({ kind: z.literal("sealed"), sealed: z.boolean() })

type WorkerRead =
  | { read: "record" | "holds"; path: string; nativeId: string }
  | { read: "sealed"; path: string; nativeId: string; runId: string; steers: number }

/** Reads in a worker that opens OpenCode's store as `stores` would. */
function readInWorker<T>(stores: NativeStores, read: WorkerRead, schema: z.ZodType<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const worker = new Worker(new URL("./resume-worker.js", import.meta.url), {
      workerData: { ...read, strictStores: stores.strict },
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

export async function readOpenCodeRecord(stores: NativeStores, binding: ProviderBinding): Promise<OpenCodeResumeRecord> {
  const target = binding.path ? openCodeRecordLocator(binding.path) : null
  if (!binding.path || !target || target.nativeId !== binding.nativeId)
    return { kind: "unavailable", reason: "The saved OpenCode source does not match its native session ID." }
  return readInWorker(stores, { path: binding.path, nativeId: target.nativeId, read: "record" }, recordSchema, unavailable)
}

/** Whether the store this locator names holds the session's row, pending inputs or not. */
export async function openCodeStoreHoldsSession(stores: NativeStores, path: string, nativeId: string): Promise<boolean> {
  const target = openCodeRecordLocator(path)
  if (!target || target.nativeId !== nativeId) return false
  const read = await readInWorker(stores, { path, nativeId, read: "holds" }, holdsSchema, { kind: "holds", holds: false })
  return read.holds
}

/** Why OpenCode can't fork this session itself, when its history holds reasoning Console sealed to it. */
export async function openCodeForkDeclined(stores: NativeStores, source: NativeForkSource): Promise<string | undefined> {
  if (!source.path) return undefined
  const read = await readInWorker(stores, { read: "sealed", path: source.path, nativeId: source.nativeId, runId: source.runId, steers: source.steers ?? 0 }, sealedSchema, { kind: "sealed", sealed: false })
  return read.sealed
    ? "OpenCode Console ties this session's reasoning to the session itself and refuses it in a copy, so OpenCode's own fork would fail on the first message."
    : undefined
}

export async function openCodeCheckpoint(stores: NativeStores, path: string): Promise<string | undefined> {
  const target = openCodeRecordLocator(path)
  if (!target) return undefined
  const record = await readOpenCodeRecord(stores, { id: "checkpoint", provider: "opencode", path, nativeId: target.nativeId, includesBase: false, coveredBlocks: 0 })
  return record.kind === "available" ? record.checkpoint : undefined
}

export function inspectOpenCodeSession(stores: NativeStores, binding: ProviderBinding, probe: ProviderProcessProbe) {
  return inspectNativeSession(binding, probe, (record) => readOpenCodeRecord(stores, record))
}
