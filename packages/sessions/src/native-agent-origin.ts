import { z } from "zod"

/** Provider facts about a native agent, distinct from a Mako delegation or permission. Browser-safe wire data. */
export const NativeAgentOriginSchema = z.object({
  kind: z.enum(["agent", "internal-review", "unknown"]),
  role: z.string().optional(),
  source: z.string().optional(),
  parentNativeId: z.string().optional(),
  originator: z.string().optional(),
})
export type NativeAgentOrigin = z.infer<typeof NativeAgentOriginSchema>
