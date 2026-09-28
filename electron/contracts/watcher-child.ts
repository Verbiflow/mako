import { z } from "zod"

/** What the host asks of the watcher child. Ids are the host's and never reused. */
export const WatcherRequestSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id: z.number().int(), root: z.string(), ignore: z.array(z.string()) }),
  z.object({ t: z.literal("unsub"), id: z.number().int() }),
])
export type WatcherRequest = z.infer<typeof WatcherRequestSchema>

export const WatchEventSchema = z.object({ path: z.string(), type: z.enum(["create", "update", "delete"]) })
export type WatchEvent = z.infer<typeof WatchEventSchema>

export const WatcherReplySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready"), id: z.number().int() }),
  z.object({ t: z.literal("failed"), id: z.number().int(), message: z.string() }),
  z.object({ t: z.literal("events"), id: z.number().int(), events: z.array(WatchEventSchema) }),
  z.object({ t: z.literal("dropped"), id: z.number().int() }),
  /** Whether the child's own canary is heard: false once it misses twice running, true when it's heard again. */
  z.object({ t: z.literal("delivery"), ok: z.boolean() }),
])
export type WatcherReply = z.infer<typeof WatcherReplySchema>

/** `MAKO_WATCHER_CANARY_TEST`, for tests only: a shorter beat, and a canary that hears nothing while `deafWhile` exists. */
export const CanaryTestSchema = z.object({
  everyMs: z.number().int().positive().optional(),
  withinMs: z.number().int().positive().optional(),
  deafWhile: z.string().optional(),
})
export type CanaryTest = z.infer<typeof CanaryTestSchema>
