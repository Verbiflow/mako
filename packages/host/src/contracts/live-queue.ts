import { z } from "zod"

export const QueuedPromptEditSchema = z.object({
  requestId: z.string().uuid(),
  expectedText: z.string().max(1_000_000),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("edit"), text: z.string().max(1_000_000) }),
    z.object({ kind: z.literal("remove") }),
    z.object({ kind: z.literal("pause") }),
    z.object({ kind: z.literal("resume") }),
  ]),
})
export type QueuedPromptEdit = z.infer<typeof QueuedPromptEditSchema>
