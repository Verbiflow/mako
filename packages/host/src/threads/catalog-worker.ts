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
import { attachmentReaders } from "./attachment-readers.js"

const catalogWorkerData = z.object({
  port: z.instanceof(MessagePort),
  cachePath: z.string().min(1),
  archivePath: z.string().min(1),
  recordsPath: z.string().min(1),
  viewsPath: z.string().min(1),
  /** The host's installed readings, which stamp a write heard as it lands. */
  runtimeReadings: z.string().min(1).optional(),
  readOnly: z.boolean(),
  /** Takes every session in the rail into the record store (never a read-only catalog's, nor an isolated host's). */
  backfill: z.boolean(),
  /** The host's user root: where readers keep the command outputs they read and find the stores Mako places (Cursor's SDK agents). */
  userRoot: z.string().min(1),
  /** Runs a large record's decode as Node in a child process: Electron's Helper inside the app. */
  decodeExecutable: z.string().min(1),
  /** How this build stamps a store format it sets (`storeWriter`). */
  writer: z.string().min(1).optional(),
  /** Where every reader's stores are (`attachmentReaders`), for the backfill's sweep of Mako's attachment files; none, none swept. */
  profiles: z.object({ appData: z.string().min(1), app: z.string().min(1), dataRoot: z.string().min(1), sessionMemory: z.string().min(1), home: z.string().min(1) }).optional(),
})

export type CatalogWorkerData = z.infer<typeof catalogWorkerData>

export type CatalogWorkerMessage =
  | { type: "listening"; sessions: number; prepareMs: number }
  | { type: "failed"; message: string }
  /** A line for the host's log: the record store's backfill reports its passes. */
  | { type: "log"; message: string; fields: Record<string, string | number | boolean | null> }

async function main(): Promise<void> {
  if (!parentPort) throw new Error("The catalog worker needs a parent")
  const parent = parentPort
  const post = (message: CatalogWorkerMessage) => parent.postMessage(message)
  const data = catalogWorkerData.safeParse(workerData)
  if (!data.success) {
    post({ type: "failed", message: "The catalog worker was started without its port and paths" })
    return
  }
  const profiles = data.data.profiles
  const catalog = defaultCatalog({
    cachePath: data.data.cachePath,
    archivePath: data.data.archivePath,
    recordsPath: data.data.recordsPath,
    viewsPath: data.data.viewsPath,
    ...data.data.runtimeReadings && { runtimeReadings: data.data.runtimeReadings },
    readOnly: data.data.readOnly,
    // Off the host's main thread, so the worker takes every session in the rail into the record store.
    backfill: data.data.backfill,
    userRoot: data.data.userRoot,
    log: (message, fields) => post({ type: "log", message, fields }),
    decodeExecutable: data.data.decodeExecutable,
    ...data.data.writer && { writer: data.data.writer },
    ...profiles && { attachmentReaders: () => attachmentReaders(profiles) },
  })
  const started = performance.now()
  try {
    await catalog.prepare()
    const discovery = catalog.scan().then((refs) => {
      catalog.startWatching()
      return refs
    })
    // The worker's heap is bounded by its resource limits, not by the
    // daemon's user-wide RSS guard.
    const server = serveCatalogOnPort(catalog, data.data.port, { memoryGuard: false, discovery })
    server.onClose(() => void catalog.stop())
    void discovery.catch(() => server.close())
    post({
      type: "listening",
      sessions: catalog.count,
      prepareMs: Math.round(performance.now() - started),
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
