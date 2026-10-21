import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { readOpenCodeAgents } from "./agent-store.js"

const input = z.object({ paths: z.array(z.string()), strictStores: z.boolean() }).parse(workerData)
const Read = z.object({ nativeId: z.string() })
const stores = new NativeStores(input.strictStores)
const port = parentPort
if (!port) throw new Error("OpenCode observation requires a parent worker port")
port.on("message", (message) => {
  try { port.postMessage({ kind: "observed", agents: readOpenCodeAgents(stores, input.paths, Read.parse(message).nativeId) }) }
  catch { port.postMessage({ kind: "unavailable" }) }
})
