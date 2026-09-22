import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { readOpenCodeAgents } from "./agent-store.js"

const input = z.object({ paths: z.array(z.string()), nativeId: z.string() }).parse(workerData)
const port = parentPort
if (!port) throw new Error("OpenCode observation requires a parent worker port")
port.on("message", () => {
  try { port.postMessage({ kind: "observed", agents: readOpenCodeAgents(input.paths, input.nativeId) }) }
  catch { port.postMessage({ kind: "unavailable" }) }
})
