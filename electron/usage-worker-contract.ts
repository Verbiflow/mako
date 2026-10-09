import { z } from "zod"
import { UsageSummarySchema } from "./contracts/automations-usage-updates.js"

export const UsageWorkerDataSchema = z.object({
  ledgerPath: z.string().min(1),
  sessionsRoot: z.string().min(1),
  homeRoot: z.string().min(1),
  conversationsRoot: z.string().optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
  now: z.number().optional(),
})
export type UsageWorkerData = z.infer<typeof UsageWorkerDataSchema>

export const UsageWorkerReplySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("summary"), summary: UsageSummarySchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
])
export type UsageWorkerReply = z.infer<typeof UsageWorkerReplySchema>
