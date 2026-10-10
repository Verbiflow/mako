import { z } from "zod"
import { HOST_CLOSED_CODE, HOST_RESTARTING_CODE, RuntimeDisconnectedError } from "./host-connection.js"
import { FIXTURE_REFUSED_CODE, FixtureDeskRefusedError } from "./fixture-desk-policy.js"

export const RuntimeArgsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("value"), value: z.json() }),
])).max(32)
export const RuntimeCallSchema = z.object({
  channel: z.string().regex(/^mako:[a-z0-9-]+$/),
  args: RuntimeArgsSchema,
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
  /** Preview reads accept the viewers' device-pixel box; older hosts refuse a fourth argument. */
  previewSizing: z.literal(true).optional(),
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
export type RuntimeReply = z.infer<typeof RuntimeReplySchema>
export type RuntimeValue = Extract<RuntimeReply, { ok: true }>["value"]

/** One call's identity through every hop: the client, the gateway, the runtime and the host's log lines. */
export const CORRELATION_HEADER = "x-mako-correlation-id"
export const CorrelationIdSchema = z.string().regex(/^[\w=-]{1,128}$/)

/**
 * The bytes every transport sends for a call: a top-level `undefined` is an absent slot, and
 * anything else goes through JSON, so `undefined` inside a value is dropped and a BigInt or a
 * cycle throws here, before anything is sent.
 */
export function encodeRuntimeCall(channel: string, args: readonly unknown[], attempt = 1): RuntimeCall {
  const encoded = JSON.stringify({
    channel,
    args: args.map((value) => value === undefined ? { kind: "absent" } : { kind: "value", value }),
    attempt: attempt > 1 ? attempt : undefined,
  })
  return RuntimeCallSchema.parse(JSON.parse(encoded))
}

export function decodeRuntimeArgs(call: RuntimeCall): unknown[] {
  return call.args.map((arg) => arg.kind === "absent" ? undefined : arg.value)
}

/** What a call's caller sees: the value, or the same typed error whichever transport carried it. */
export function runtimeReplyValue(reply: RuntimeReply): RuntimeValue {
  if (reply.ok) return reply.value
  if (reply.code === "owner-unavailable") throw new RuntimeDisconnectedError(reply.unconfirmed ?? true, reply.conversationId)
  if (reply.code === HOST_RESTARTING_CODE) throw new RuntimeDisconnectedError(true)
  if (reply.code === HOST_CLOSED_CODE) throw new RuntimeDisconnectedError(false)
  throw new Error(reply.error)
}

/** The reply for a call whose handler threw, keeping whether it was delivered. */
export function runtimeFailure(cause: unknown): RuntimeReply {
  const reply: RuntimeReply = { ok: false, error: cause instanceof Error ? cause.message : "Mako host request failed" }
  if (cause instanceof RuntimeDisconnectedError) {
    reply.code = cause.conversationId ? "owner-unavailable" : cause.unconfirmed ? HOST_RESTARTING_CODE : HOST_CLOSED_CODE
    reply.unconfirmed = cause.unconfirmed
    reply.conversationId = cause.conversationId
  }
  if (cause instanceof FixtureDeskRefusedError) reply.code = FIXTURE_REFUSED_CODE
  return reply
}
