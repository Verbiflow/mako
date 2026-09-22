import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { readOpenCodeResumeRecord } from "./resume-store.js"

const input = z.object({ path: z.string(), nativeId: z.string() }).parse(workerData)
parentPort?.postMessage(readOpenCodeResumeRecord(input.path, input.nativeId))
