import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { openCodeStoreHolds, readOpenCodeResumeRecord } from "./resume-store.js"

const input = z.object({ path: z.string(), nativeId: z.string(), read: z.enum(["record", "holds"]) }).parse(workerData)
parentPort?.postMessage(input.read === "holds"
  ? { kind: "holds", holds: openCodeStoreHolds(input.path, input.nativeId) }
  : readOpenCodeResumeRecord(input.path, input.nativeId))
