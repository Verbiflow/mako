import { z } from "zod"

/**
 * How a build before `not-saved` reads a saved request: `reason` against the seven reasons it knew, the whole journal
 * refused for any other (measured on main a8314eb8: `journal.read` threw a ZodError and the conversation wouldn't open).
 * A journal this build writes must still parse here.
 */
const OLDER_REASONS = ["stopped", "host-quit", "host-crashed", "connection-lost", "provider-exited", "signed-out", "handed-off"] as const
export const OlderRequestSchema = z.object({
  interruption: z.object({ reason: z.enum(OLDER_REASONS), at: z.number() }).optional(),
  continues: z.object({ requestId: z.string(), reason: z.enum(OLDER_REASONS), auto: z.boolean() }).optional(),
})
