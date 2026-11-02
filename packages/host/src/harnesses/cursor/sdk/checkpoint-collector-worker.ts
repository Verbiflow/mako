import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { collectCursorCheckpoints } from "@mako/sessions/cursor-sdk-collect"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const { stateRoot, directory, quietMs, stamp } = z.object({
  stateRoot: z.string(),
  directory: z.string(),
  quietMs: z.number(),
  stamp: z.object({ size: z.number(), mtimeMs: z.number() }).optional(),
}).parse(workerData)

// A strict host (the fixture desk) writes no store, so it runs no collector.
const stores = new NativeStores(false)
const [sweep] = collectCursorCheckpoints({
  stateRoot,
  stores,
  directories: [directory],
  quietMs,
  ...stamp && { stamps: new Map([[directory, stamp]]) },
})
parentPort?.postMessage(sweep ?? null)
