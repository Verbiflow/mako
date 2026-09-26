import { z } from "zod"
import { HOST_CLOSED_CODE, HOST_RESTARTING_CODE } from "./host-connection.js"
import { FIXTURE_REFUSED_CODE } from "./fixture-desk-policy.js"

export const RuntimeCallSchema = z.object({
  channel: z.string().regex(/^mako:[a-z0-9-]+$/),
  args: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absent") }),
    z.object({ kind: z.literal("value"), value: z.json() }),
  ])).max(32),
  /** 2 when a client re-issues a call the host dropped; the host records the replay. Absent on a first attempt. */
  attempt: z.number().int().min(1).max(8).optional(),
}).strict()
export type RuntimeCall = z.infer<typeof RuntimeCallSchema>
export const RUNTIME_PROTOCOL = 1
export const RuntimeInfoSchema = z.object({
  protocol: z.literal(RUNTIME_PROTOCOL),
  instanceId: z.string().uuid(),
  /** Stable local host identity for browser pending-message storage. */
  storageScope: z.string().optional(),
  pid: z.number().int().positive(),
  version: z.string(),
  /** Executable content loaded by a development host; absent on older/packaged hosts. */
  devBuild: z.string().optional(),
  /** A fixture desk host: every client is limited to the fixture allowlist. */
  fixture: z.literal(true).optional(),
  methods: z.array(z.string()),
})
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>
export const RuntimePacketSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("ready"), runtime: RuntimeInfoSchema.optional() }),
  z.object({ channel: z.literal("event"), payload: z.json() }),
  z.object({ channel: z.literal("terminal"), payload: z.json() }),
])
export const RuntimeReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json().optional() }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.enum([HOST_RESTARTING_CODE, HOST_CLOSED_CODE, "owner-unavailable", FIXTURE_REFUSED_CODE]).optional(), unconfirmed: z.boolean().optional(), conversationId: z.string().optional() }),
])
