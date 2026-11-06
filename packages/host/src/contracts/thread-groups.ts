import { z } from "zod"
import { SessionOriginSchema } from "./thread-execution.js"
import { SessionIdSchema, ThreadIdSchema } from "./thread-identity.js"

/**
 * A Thread with more than one Session, as a window draws it: its Sessions in
 * tab order. A Thread with one Session has no group, because its row is
 * already the whole Thread.
 */
export const ThreadGroupSchema = z.object({
  id: ThreadIdSchema,
  sessions: z
    .array(
      z.object({
        id: SessionIdSchema,
        origin: SessionOriginSchema,
        /** False for a `+` Session whose first send has not started a conversation yet. */
        started: z.boolean(),
        /** The Session a fork was forked from. */
        forkOf: SessionIdSchema.optional(),
      })
    )
    .min(2),
})
export type ThreadGroup = z.infer<typeof ThreadGroupSchema>
