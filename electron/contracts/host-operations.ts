import {
  PROTOCOL_VERSION,
  problem,
  problemType,
  type Actor,
  type Operation,
  type Problem,
  type Reply,
  type Target,
} from "@mako/protocol"
import { z } from "zod"
import { FIXTURE_REFUSED_CODE } from "./fixture-desk-policy.js"
import { hostCallInputs } from "./host-call-inputs.js"
import { hostCallReplay, type HostCallReplay } from "./host-call-policy.js"
import { HOST_CLOSED_CODE, HOST_RESTARTING_CODE } from "./host-connection.js"
import { RuntimeArgsSchema, type RuntimeCall, type RuntimeReply } from "./runtime.js"

/**
 * Every host call is a `runtime` operation named `host.<channel>`: the gateway forwards it to the
 * runtime the caller names without reading it, and the host checks its arguments with the same
 * generated schemas as on its socket. Adding a host call needs no gateway change.
 */
const PREFIX = "host."

export type HostChannel = keyof typeof hostCallInputs
export type HostOperation = { channel: HostChannel; replay: HostCallReplay }

function isHostChannel(channel: string): channel is HostChannel {
  return Object.hasOwn(hostCallInputs, channel)
}

export function hostOperationName(channel: string): string {
  return PREFIX + channel.slice("mako:".length)
}

/** The host calls, by operation name, with what a client may do when one's answer is lost. */
export const hostOperations: ReadonlyMap<string, HostOperation> = new Map(
  Object.keys(hostCallInputs)
    .filter(isHostChannel)
    .map((channel) => [hostOperationName(channel), { channel, replay: hostCallReplay(channel) }])
)

/** A host call's input: its arguments as the socket carries them, and whether the caller pages history. */
const HostInputSchema = z.object({
  args: RuntimeArgsSchema,
  history: z.boolean().optional(),
}).strict()

export function toHostOperation(call: RuntimeCall, options: {
  id: string
  target: Target
  actor: Actor
  correlationId: string
  history?: boolean
}): Operation {
  const input: z.infer<typeof HostInputSchema> = { args: call.args }
  if (options.history) input.history = true
  return {
    v: PROTOCOL_VERSION,
    id: options.id,
    op: hostOperationName(call.channel),
    target: options.target,
    input,
    correlationId: options.correlationId,
    actor: options.actor,
    attempt: call.attempt ?? 1,
  }
}

export type HostCallRequest = { kind: "call"; call: RuntimeCall; history: boolean }
export type HostCallRefusal = { kind: "refused"; problem: Problem }

export function fromHostOperation(operation: Operation): HostCallRequest | HostCallRefusal {
  const known = hostOperations.get(operation.op)
  if (!known)
    return { kind: "refused", problem: problem("not-found", "This host has no such call", operation.correlationId, "not-applied", { status: 404, detail: operation.op }) }
  const input = HostInputSchema.safeParse(operation.input)
  if (!input.success)
    return { kind: "refused", problem: problem("bad-request", "A host call's input is its arguments", operation.correlationId, "not-applied", { status: 400, detail: z.prettifyError(input.error) }) }
  const call: RuntimeCall = { channel: known.channel, args: input.data.args }
  if (operation.attempt > 1) call.attempt = operation.attempt
  return { kind: "call", call, history: input.data.history ?? false }
}

/** The host's answer as a reply; `detail` keeps the host's own sentence, which the caller shows. */
export function toProtocolReply(id: string, correlationId: string, reply: RuntimeReply): Reply {
  if (reply.ok) {
    const success: Reply = { v: PROTOCOL_VERSION, id, ok: true }
    if (reply.value !== undefined) success.value = reply.value
    return success
  }
  const failed = (made: Problem): Reply => ({ v: PROTOCOL_VERSION, id, ok: false, problem: made })
  const detail = reply.error
  switch (reply.code) {
    case HOST_RESTARTING_CODE:
      return failed(problem("restarting", "The host restarted while running the call", correlationId, "unknown", { status: 503, detail }))
    case HOST_CLOSED_CODE:
      return failed(problem("unavailable", "The host was closing and didn't run the call", correlationId, "not-applied", { status: 503, detail }))
    case "owner-unavailable":
      return failed(problem("owner-unavailable", "The host running that conversation is unavailable", correlationId, reply.unconfirmed === false ? "not-applied" : "unknown", { status: 503, detail, conversationId: reply.conversationId }))
    case FIXTURE_REFUSED_CODE:
      return failed(problem("forbidden", "A fixture host refuses this call", correlationId, "not-applied", { status: 403, detail }))
    case undefined:
      return failed(problem("failed", "The host call failed", correlationId, "unknown", { detail }))
  }
}

/**
 * A reply as the host's own answer, so the caller sees what the socket would have given it: the
 * same value, or the same error and delivery state. A problem the gateway raised itself becomes
 * the matching disconnect when it's an outage, confirmed or not by its outcome, and an error
 * naming it otherwise.
 */
export function toRuntimeReply(reply: Reply): RuntimeReply {
  if (reply.ok) return reply.value === undefined ? { ok: true } : { ok: true, value: reply.value }
  const { problem: reason } = reply
  const error = reason.detail ?? reason.title
  switch (problemType(reason)) {
    case "failed":
      return { ok: false, error }
    case "restarting":
    case "unavailable":
      return reason.outcome === "unknown"
        ? { ok: false, error, code: HOST_RESTARTING_CODE, unconfirmed: true }
        : { ok: false, error, code: HOST_CLOSED_CODE, unconfirmed: false }
    case "owner-unavailable": {
      const lost: RuntimeReply = { ok: false, error, code: "owner-unavailable", unconfirmed: reason.outcome === "unknown" }
      if (reason.conversationId !== undefined) lost.conversationId = reason.conversationId
      return lost
    }
    case "forbidden":
      return { ok: false, error, code: FIXTURE_REFUSED_CODE }
    default:
      return { ok: false, error: reason.detail ? `${reason.title}: ${reason.detail}` : reason.title }
  }
}
