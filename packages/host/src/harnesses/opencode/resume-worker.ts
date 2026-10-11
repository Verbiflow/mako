import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { openCodeHistorySealed, openCodeStoreHolds, readOpenCodeResumeRecord } from "./resume-store.js"

const input = z.discriminatedUnion("read", [
  z.object({ read: z.enum(["record", "holds"]), path: z.string(), nativeId: z.string(), strictStores: z.boolean() }),
  z.object({ read: z.literal("sealed"), path: z.string(), nativeId: z.string(), runId: z.string(), steers: z.number().int().nonnegative(), strictStores: z.boolean() }),
]).parse(workerData)
const stores = new NativeStores(input.strictStores)
parentPort?.postMessage(input.read === "holds"
  ? { kind: "holds", holds: openCodeStoreHolds(stores, input.path, input.nativeId) }
  : input.read === "sealed"
    ? { kind: "sealed", sealed: openCodeHistorySealed(stores, input.path, input.nativeId, input.runId, input.steers) }
    : readOpenCodeResumeRecord(stores, input.path, input.nativeId))
