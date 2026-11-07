import { z } from "zod"

/** What happens to a replayed window (`replay-window.ts` says each). */
export const ReplayPlanSchema = z.object({
  opens: z.array(z.number()).optional(),
  attach: z.number().optional(),
  gap: z.object({ conversation: z.string(), from: z.number(), to: z.number() }).optional(),
  drift: z.object({ conversation: z.string(), at: z.number() }).optional(),
  restart: z.object({ conversation: z.string(), at: z.number() }).optional(),
  lag: z.number().optional(),
})
export type ReplayPlan = z.infer<typeof ReplayPlanSchema>

/** A packet of a recorded stream. */
export const ReplayPacketSchema = z.object({ channel: z.string().optional(), conversation: z.string().optional(), payload: z.string().optional(), rostered: z.string().optional() }).loose()

export const ReplayOpenSchema = z.object({ id: z.string(), asked: z.number(), answered: z.number(), file: z.string(), found: z.boolean().optional() })
export type ReplayOpen = z.infer<typeof ReplayOpenSchema>
