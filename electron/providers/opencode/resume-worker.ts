import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { openCodeHistorySealed, openCodeStoreHolds, readOpenCodeResumeRecord } from "./resume-store.js"

const input = z.discriminatedUnion("read", [
  z.object({ read: z.enum(["record", "holds"]), path: z.string(), nativeId: z.string() }),
  z.object({ read: z.literal("sealed"), path: z.string(), nativeId: z.string(), runId: z.string(), steers: z.number().int().nonnegative() }),
]).parse(workerData)
parentPort?.postMessage(input.read === "holds"
  ? { kind: "holds", holds: openCodeStoreHolds(input.path, input.nativeId) }
  : input.read === "sealed"
    ? { kind: "sealed", sealed: openCodeHistorySealed(input.path, input.nativeId, input.runId, input.steers) }
    : readOpenCodeResumeRecord(input.path, input.nativeId))
