import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { createHarnessHost, usageHarnesses } from "@mako/host/harnesses"
import { UsageLedger } from "@mako/host/usage/ledger"
import { usageSummary } from "@mako/host/usage/summary"
import { UsageWorkerDataSchema, type UsageWorkerReply } from "@mako/host/usage/worker-contract"

const port = parentPort
if (!port) throw new Error("Usage history requires a worker port")
const data = UsageWorkerDataSchema.parse(workerData)
const ledger = new UsageLedger(data.ledgerPath)
const harnesses = usageHarnesses(createHarnessHost())
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
      })
      reply = { type: "summary", summary }
    } catch (error) {
      reply = { type: "error", error: error instanceof Error ? error.message : String(error) }
    }
    port.postMessage(reply)
  })
})
port.on("close", () => ledger.close())
