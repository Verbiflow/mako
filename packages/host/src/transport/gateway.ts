import { z } from "zod"
import { COMPACT_LIVE_FORM, MAX_EVENT_BYTES, WHOLE_LIVE_FORM, serveRuntime, type Actor, type ConnectionCredential, type Operation, type Reply, type RuntimeLink, type RuntimeOptions, type ServedRuntime } from "@mako/protocol"
import { fromHostOperation, hostFailure, hostOperations, hostSuccess } from "../contracts/host-operations.js"
import { runtimeEventRouting, runtimeFailure, type RuntimeFailure } from "../contracts/runtime.js"
import { encodeRuntimeEvent, payloadFor, runtimeEventLine, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { HostInvoke } from "./server.js"

/** Reads that take longer than this are logged even when tracing is off. */
const SLOW_MS = 1_000

export type GatewayHostOptions = {
  runtimeId: string
  build: string
  /** The host's own dispatcher, the one its socket uses. */
  invoke: HostInvoke
  /** Every operation is logged; otherwise reads are logged only when slow or failed. */
  trace?: boolean
  /** Renews the link's token in the link before it's due: a device's runtime does, a machine's doesn't need to. */
  credential?: ConnectionCredential
  /** The Threads it ran on its last link, claimed again so the gateway keeps them with it, with the events it still owes them. */
  threads?: RuntimeOptions["threads"]
  /** Sees every frame after enrolment, before the runtime acts on it. */
  onFrame?: RuntimeOptions["onFrame"]
  /** The live streams its Threads' clients watch; without it, every watch ends at once. */
  media?: RuntimeOptions["media"]
  /** Whether another device watches one of its conversations (`RuntimeOptions.watch`). */
  watch?: RuntimeOptions["watch"]
  /** Requests to its Threads' apps from the account's other devices (`RuntimeOptions.ports`); without it, each is refused. */
  ports?: RuntimeOptions["ports"]
  /** SSH from the person's editor to its machine's SSH server (`RuntimeOptions.ssh`); without it, each is refused. */
  ssh?: RuntimeOptions["ssh"]
}

/**
 * Who a remote caller is to the host: an owner key for its terminals, drafts and previews, apart
 * from every local window's.
 */
export function gatewayClientId(actor: Actor): string {
  return actor.kind === "client" ? `gateway:${actor.client}:${actor.deviceId}` : `gateway:runtime:${actor.runtimeId}`
}

/**
 * Serves this host's calls to a gateway as a runtime. Each operation runs through the same
 * `invoke` as the socket, so its arguments are checked by the same schemas, a fixture desk refuses
 * the same calls, and every line the host logs while running it carries its correlation ID. The
 * reply carries the value as `invoke` encoded it, unread.
 */
export function serveHostThroughGateway(link: RuntimeLink, options: GatewayHostOptions): Promise<ServedRuntime> {
  const trace = options.trace ?? process.env.MAKO_GATEWAY_TRACE === "1"
  const handle = async (operation: Operation): Promise<Reply> => {
    const started = Date.now()
    const request = fromHostOperation(operation)
    if (request.kind === "refused") {
      hostWarn("gateway", "refused operation", { op: operation.op, correlationId: operation.correlationId, problem: request.problem.type })
      return { v: operation.v, id: operation.id, ok: false, problem: request.problem }
    }
    const client = gatewayClientId(operation.actor)
    let reply: Reply
    let failure: RuntimeFailure | undefined
    try {
      reply = hostSuccess(operation.id, await options.invoke(request.channel, request.args, client, request.history, operation.correlationId))
    } catch (error) {
      failure = runtimeFailure(error)
      reply = hostFailure(operation.id, operation.correlationId, failure)
    }
    const ms = Date.now() - started
    const replay = hostOperations.get(operation.op)?.replay
    const fields = {
      op: operation.op,
      correlationId: operation.correlationId,
      attempt: operation.attempt,
      client,
      outcome: failure ? (failure.code ?? "failed") : "ok",
      ms,
    }
    if (failure) hostWarn("gateway", "operation failed", { ...fields, error: failure.error })
    else if (trace || replay !== "read" || operation.attempt > 1 || ms >= SLOW_MS) hostLog("gateway", "operation", fields)
    return reply
  }
  const runtime: RuntimeOptions = { runtimeId: options.runtimeId, build: options.build, handle }
  if (options.credential) runtime.credential = options.credential
  if (options.threads) runtime.threads = options.threads
  if (options.onFrame) runtime.onFrame = options.onFrame
  if (options.media) runtime.media = options.media
  if (options.watch) runtime.watch = options.watch
  if (options.ports) runtime.ports = options.ports
  if (options.ssh) runtime.ssh = options.ssh
  return serveRuntime(link, runtime)
}

const LiveBatchIdentity = z.object({ batch: z.object({ id: z.string(), revision: z.number(), epoch: z.string().optional() }) })

/**
 * The notice that a live batch's conversation changed, at its revision, in place of the batch: what a reader that
 * can't take the batch whole gets, and answers by reading the conversation again. Null for anything but a live batch.
 */
export function historyChangedNotice(event: RuntimeEvent): RuntimeEvent | null {
  if (runtimeEventRouting(event).type !== "live-batch") return null
  const live = LiveBatchIdentity.safeParse(JSON.parse(event.payload))
  return live.success ? encodeRuntimeEvent({ type: "live-batch", batch: { ...live.data.batch, updates: [], historyChanged: true } }) : null
}

/**
 * An event's line as it goes out through the gateway, which carries nothing over `MAX_EVENT_BYTES`: whole when it fits;
 * a live batch that doesn't becomes the notice that its conversation's history changed (`reread`), which every reader
 * answers by reading it again; anything else that doesn't fit doesn't go (`too-large`). A cloud Thread's events and a
 * watched conversation's live updates both go out through this, so neither closes the link with one too large.
 */
export function gatewayEventLine(channel: RuntimeEventChannel, event: RuntimeEvent, maxBytes = MAX_EVENT_BYTES):
  { fit: "whole" | "reread"; text: string } | { fit: "too-large"; type: string | undefined; bytes: number } {
  // A batch heard in the compact form only has no whole line: a reader of the whole form reads its conversation again.
  const whole = payloadFor(event, WHOLE_LIVE_FORM) !== undefined
  const text = runtimeEventLine(channel, event).slice(0, -1)
  if (whole && fits(text, maxBytes)) return { fit: "whole", text }
  const notice = historyChangedNotice(event)
  if (!notice) return { fit: "too-large", type: runtimeEventRouting(event).type, bytes: Buffer.byteLength(text) }
  return { fit: "reread", text: runtimeEventLine(channel, notice).slice(0, -1) }
}

/**
 * An event's line in the compact live form as it goes out through the gateway: its compact payload alone, read by its
 * first characters (`readEventLine`). Undefined when it has none, or none under `MAX_EVENT_BYTES`: its whole line goes.
 */
export function gatewayCompactLine(event: RuntimeEvent, maxBytes = MAX_EVENT_BYTES): string | undefined {
  const text = event.compact ?? (event.form === COMPACT_LIVE_FORM ? event.payload : undefined)
  return text !== undefined && fits(text, maxBytes) ? text : undefined
}

/** Whether `text` is within `maxBytes` in UTF-8. A character is at most three bytes: most lines are measured without encoding them. */
function fits(text: string, maxBytes: number): boolean {
  return text.length * 3 <= maxBytes || Buffer.byteLength(text) <= maxBytes
}
