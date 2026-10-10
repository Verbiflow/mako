import { parentPort } from "node:worker_threads"
import { z } from "zod"
import { codexQuestionHistory } from "./question-history.js"

const input = z.object({ id: z.number().int(), path: z.string().min(1), nativeId: z.string().min(1) })
const port = parentPort
if (!port) throw new Error("Native question reader requires a worker port")
let pending = Promise.resolve()
port.on("message", (raw) => {
  const request = input.parse(raw)
  pending = pending.then(async () => {
    try {
      const entries = await codexQuestionHistory({ path: request.path, nativeId: request.nativeId })
      port.postMessage({ id: request.id, entries })
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
