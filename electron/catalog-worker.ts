/**
 * The thread catalog on its own thread.
 *
 * Every native store is read here — JSONL tails, Cursor's blob folds, the
 * SQLite databases Devin, OpenCode and Cursor keep — so a pathological store
 * (a multi-gigabyte tool result, a locked database) can stall this thread and
 * nothing else. The host speaks to it in the sync daemon's own frame
 * protocol, which `threads.ts` already consumes for the detached daemon, over
 * a `MessageChannel` port the host hands in with the worker data. A port
 * delivers a frame whole: a 7 MB thread arrives as one message instead of
 * some nine hundred 8 KiB reads of a Unix socket, each of which woke the
 * host's Chromium-integrated event loop.
 */

import { MessagePort, parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { defaultCatalog, serveCatalogOnPort } from "@mako/sessions"

const catalogWorkerData = z.object({
  port: z.instanceof(MessagePort),
  cachePath: z.string().min(1),
  archivePath: z.string().min(1),
})

export type CatalogWorkerData = z.infer<typeof catalogWorkerData>

export type CatalogWorkerMessage =
  | { type: "listening"; sessions: number; scanMs: number }
  | { type: "failed"; message: string }

async function main(): Promise<void> {
  if (!parentPort) throw new Error("The catalog worker needs a parent")
  const parent = parentPort
  const post = (message: CatalogWorkerMessage) => parent.postMessage(message)
  const data = catalogWorkerData.safeParse(workerData)
  if (!data.success) {
    post({ type: "failed", message: "The catalog worker was started without its port and paths" })
    return
  }
  const catalog = defaultCatalog({
    cachePath: data.data.cachePath,
    archivePath: data.data.archivePath,
  })
  const started = performance.now()
  try {
    const refs = await catalog.scan()
    catalog.startWatching()
    // The worker's heap is bounded by its resource limits, not by the
    // daemon's user-wide RSS guard.
    const server = serveCatalogOnPort(catalog, data.data.port, { memoryGuard: false })
    server.onClose(() => void catalog.stop())
    post({
      type: "listening",
      sessions: refs.length,
      scanMs: Math.round(performance.now() - started),
    })
  } catch (error) {
    await catalog.stop()
    post({
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

void main()
