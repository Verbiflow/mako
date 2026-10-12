import { z } from "zod"
import type { Json } from "@mako/protocol"
import { HOST_CLOSED_CODE, HOST_RESTARTING_CODE, RuntimeDisconnectedError } from "./host-connection.js"
import { FIXTURE_REFUSED_CODE, FixtureDeskRefusedError } from "./fixture-desk-policy.js"

/**
 * A value inside wire text JSON.parse just decoded, which is JSON by
 * construction, so it isn't walked a second time; its shape is checked by
 * whoever consumes it. These schemas only ever read freshly parsed text.
 */
const ParsedJson = z.custom<Json>()

export const RuntimeArgsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("value"), value: ParsedJson }),
])).max(32)
export const RuntimeCallSchema = z.object({
  channel: z.string().regex(/^mako:[a-z0-9-]+$/),
  args: RuntimeArgsSchema,
  /** 2 when a client re-issues a call the host dropped; the host records the replay. Absent on a first attempt. */
  attempt: z.number().int().min(1).max(8).optional(),
}).strict()
export type RuntimeCall = z.infer<typeof RuntimeCallSchema>
export const RUNTIME_PROTOCOL = 1
/**
 * One of the host's domains as it loads. `reason` is why it loaded: after
 * the socket listened, at start for `MAKO_HOST_LOAD=all`, or the first
 * method that needed it. Times are milliseconds since the process started.
 */
export const HostDomainSchema = z.object({
  name: z.string(),
  /** The domains of packages/host/src it builds. */
  covers: z.array(z.string()),
  load: z.enum(["after-listen", "on-demand"]),
  state: z.enum(["unloaded", "loading", "ready", "failed"]),
  reason: z.string().optional(),
  startedAt: z.number().optional(),
  loadMs: z.number().optional(),
  /** Modules that first loaded while it loaded, and their source bytes. */
  modules: z.number().int().optional(),
  sourceBytes: z.number().int().optional(),
  error: z.string().optional(),
})
export type HostDomain = z.infer<typeof HostDomainSchema>
/** One of the host's recurring jobs and how it has gone. */
export const HostJobSchema = z.object({
  name: z.string(),
  everyMs: z.number(),
  runs: z.number().int(),
  failures: z.number().int(),
  lastError: z.string().optional(),
  /** The demands it runs for; with none of them on, it's paused and holds no timer. */
  needs: z.array(z.string()).optional(),
  paused: z.boolean(),
})
export type HostJob = z.infer<typeof HostJobSchema>
/** A stretch the event loop was held, and the work named as running then; `at` is milliseconds since the epoch. */
export const LoopHoldSchema = z.object({
  at: z.number(),
  ms: z.number(),
  during: z.array(z.string()),
})
export type LoopHold = z.infer<typeof LoopHoldSchema>
/**
 * The event loop, as the host watches it while it works: the delay of each
 * check (every `resolutionMs`), holds of `heldMs` or more, and how much of
 * the time since the process started it was busy.
 */
export const EventLoopSchema = z.object({
  watching: z.boolean(),
  resolutionMs: z.number(),
  heldMs: z.number(),
  delayMs: z.object({ checks: z.number().int(), p50: z.number(), p99: z.number(), max: z.number() }),
  utilization: z.number(),
  holds: z.object({ count: z.number().int(), longest: LoopHoldSchema.optional(), recent: z.array(LoopHoldSchema) }),
})
export type EventLoop = z.infer<typeof EventLoopSchema>
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
  /** Each domain's state, in `/health` only; a call to one still loading waits for it. */
  domains: z.array(HostDomainSchema).optional(),
  /** Its recurring jobs, in `/health` only. */
  jobs: z.array(HostJobSchema).optional(),
  /** Its event loop, in `/health` only. */
  eventLoop: EventLoopSchema.optional(),
})
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>
export const RuntimePacketSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("ready"), runtime: RuntimeInfoSchema.optional() }),
  z.object({ channel: z.literal("event"), payload: ParsedJson }),
  z.object({ channel: z.literal("terminal"), payload: ParsedJson }),
])
export const RuntimeFailureSchema = z.object({ ok: z.literal(false), error: z.string(), code: z.enum([HOST_RESTARTING_CODE, HOST_CLOSED_CODE, "owner-unavailable", FIXTURE_REFUSED_CODE]).optional(), unconfirmed: z.boolean().optional(), conversationId: z.string().optional() })
/** A success's body is exactly `runtimeSuccessBody` (`runtime-value.ts`), so a reader can take its value without decoding it. */
export const RuntimeReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ParsedJson.optional() }),
  RuntimeFailureSchema,
])
export type RuntimeReply = z.infer<typeof RuntimeReplySchema>
export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>
export type RuntimeValue = Extract<RuntimeReply, { ok: true }>["value"]

/** One call's identity through every hop: the client, the gateway, the runtime and the host's log lines. */
export const CORRELATION_HEADER = "x-mako-correlation-id"
export const CorrelationIdSchema = z.string().regex(/^[\w=-]{1,128}$/)

/**
 * A call's arguments as they cross: a top-level `undefined` is an absent slot. Encoding them
 * goes through JSON, so `undefined` inside a value is dropped and a BigInt or a cycle throws
 * before anything is sent.
 */
export function runtimeArgs(args: readonly unknown[]): Array<{ kind: "absent" } | { kind: "value"; value: unknown }> {
  return args.map((value) => value === undefined ? { kind: "absent" } : { kind: "value", value })
}

/** A call as the socket carries it, encoded once; the host checks it with `RuntimeCallSchema`. */
export function encodeRuntimeCall(channel: string, args: readonly unknown[], attempt = 1): string {
  return JSON.stringify({ channel, args: runtimeArgs(args), attempt: attempt > 1 ? attempt : undefined })
}

export function decodeRuntimeArgs(args: RuntimeCall["args"]): unknown[] {
  return args.map((arg) => arg.kind === "absent" ? undefined : arg.value)
}

/** What a call's caller sees: the value, or the same typed error whichever transport carried it. */
export function runtimeReplyValue(reply: RuntimeReply): RuntimeValue {
  if (reply.ok) return reply.value
  throw runtimeFailureError(reply)
}

export function runtimeFailureError(failure: RuntimeFailure): Error {
  if (failure.code === "owner-unavailable") return new RuntimeDisconnectedError(failure.unconfirmed ?? true, failure.conversationId)
  if (failure.code === HOST_RESTARTING_CODE) return new RuntimeDisconnectedError(true)
  if (failure.code === HOST_CLOSED_CODE) return new RuntimeDisconnectedError(false)
  return new Error(failure.error)
}

/** The reply for a call whose handler threw, keeping whether it was delivered. */
export function runtimeFailure(cause: unknown): RuntimeFailure {
  const reply: RuntimeFailure = { ok: false, error: cause instanceof Error ? cause.message : "Mako host request failed" }
  if (cause instanceof RuntimeDisconnectedError) {
    reply.code = cause.conversationId ? "owner-unavailable" : cause.unconfirmed ? HOST_RESTARTING_CODE : HOST_CLOSED_CODE
    reply.unconfirmed = cause.unconfirmed
    reply.conversationId = cause.conversationId
  }
  if (cause instanceof FixtureDeskRefusedError) reply.code = FIXTURE_REFUSED_CODE
  return reply
}
