import { parentPort, workerData } from "node:worker_threads"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { createHarnessHost, detachedHarnessContext, usageHarnesses } from "./harnesses/index.js"
import { UsageLedger, UsageWorkerDataSchema, usageSummary, type UsageWorkerReply } from "./usage/index.js"

const port = parentPort
if (!port) throw new Error("Usage history requires a worker port")
const data = UsageWorkerDataSchema.parse(workerData)
const ledger = new UsageLedger(data.ledgerPath)
const harnesses = usageHarnesses(createHarnessHost(detachedHarnessContext(new NativeStores(data.strictStores))))
const request = z.object({ type: z.literal("read") })
let pending = Promise.resolve()
port.on("message", raw => {
  request.parse(raw)
  pending = pending.then(async () => {
    let reply: UsageWorkerReply
    try {
      const summary = await usageSummary(harnesses, data.sessionsRoot, data.homeRoot, data.conversationsRoot, {
        ledger,
        env: data.env,
        now: data.now,
        helperRuns: data.helperRuns,
      })
      reply = { type: "summary", summary }
    } catch (error) {
      reply = { type: "error", error: error instanceof Error ? error.message : String(error) }
    }
    port.postMessage(reply)
  })
})
port.on("close", () => ledger.close())
