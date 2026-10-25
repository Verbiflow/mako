import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { AcpDecoder } from "./acp-decoder.js"
import { AcpModelWindow, acpNotificationUsage, acpUsageReading } from "./acp-usage.js"
import { SessionUsage, type UsageObservation } from "./session-usage.js"
import { manualCompaction } from "@mako/sessions/events"
import { decoded, decodedNotices, type Decoded } from "../contracts/native-decoding.js"
import type { AcpAsk, ProviderAcpSource } from "./acp-source.js"
import { RecordedObjectSchema, type DecoderEffect, type ProviderDecoderSource } from "./decoder-source.js"

/**
 * An ACP agent's decoder, offered to Mako's tools: the same `AcpDecoder` the
 * live client runs, over recorded messages. A recorded message is
 * `{ method, params }` for a notification, `{ request, params }` for a
 * request the agent waits on and `{ response, result }` for the reply that
 * opened the session. Its kind is `session/update/<kind>` for an update and
 * the method otherwise.
 *
 * Vendor notifications go through the provider's `decodeNotification`, as
 * the live client reads them: their notices become the markers and activity
 * the window draws, and one the provider does not know stays unknown. Their
 * spend, ACP's `usage_update` and the window a model list names reach a
 * meter of the session's own, whose readings are the usage the window would show.
 */
const DECODED_UPDATES = ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call",
  "tool_call_update", "plan", "current_mode_update", "config_option_update", "session_info_update", "usage_update"]
const SILENT_UPDATES = ["available_commands_update"]
const PERMISSION = "session/request_permission"
const OPENINGS = ["session/new", "session/load"] as const

const RecordedSchema = z.union([
  z.object({ method: z.string(), params: RecordedObjectSchema }),
  z.object({ request: z.string(), params: RecordedObjectSchema }),
  z.object({ response: z.enum(OPENINGS), result: RecordedObjectSchema }),
])
const NotificationSchema = z.looseObject({ sessionId: z.string(), update: z.looseObject({ sessionUpdate: z.string() }) })
const PermissionSchema = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.string() })),
})
/** Undefined for a recording with no session, rather than a failed `safeParse`, which builds an `Error`. */
const SessionSchema = z.object({ settings: z.object({ model: z.string().optional() }).optional() }).optional().catch(undefined)

export interface AcpAskEffect extends DecoderEffect {
  type: "ask"
  ask: AcpAsk
}

const ask = (value: AcpAsk): Decoded<AcpAskEffect> => decoded.effect({ type: "ask", ask: value })

export function acpDecoderSource(source: ProviderAcpSource): ProviderDecoderSource {
  /** As the live client reads a vendor notification: the session's MCP startup first, then the provider's decoder. */
  const vendor = (message: z.infer<typeof RecordedSchema>, startup = source.mcpStartup?.()) =>
    "method" in message && message.method !== "session/update"
      ? startup?.decode(message.method, message.params) ?? source.decodeNotification?.(message.method, message.params)
      : undefined
  const kind = (message: z.infer<typeof RecordedSchema>) => {
    if ("request" in message) return message.request
    if ("response" in message) return message.response
    if (message.method !== "session/update") return vendor(message)?.kind ?? message.method
    return `session/update/${NotificationSchema.safeParse(message.params).data?.update.sessionUpdate ?? "(none)"}`
  }
  return {
    provider: source.provider,
    decoded: new Set([...DECODED_UPDATES.map((update) => `session/update/${update}`), PERMISSION, ...(source.requests?.methods ?? []), ...source.modelWindow ? OPENINGS : []]),
    silent: new Set([...SILENT_UPDATES.map((update) => `session/update/${update}`), ...source.modelWindow ? [] : OPENINGS]),
    kind(message) {
      const recorded = RecordedSchema.safeParse(message)
      return recorded.success ? kind(recorded.data) : "(unreadable)"
    },
    declares(message) {
      const recorded = RecordedSchema.safeParse(message)
      const notified = recorded.success ? vendor(recorded.data) : undefined
      if (notified?.notices === undefined) return undefined
      return notified.notices.length || notified.usage?.length || (notified.models && source.modelWindow) ? "decoded" : "silent"
    },
    open(session) {
      const settings = SessionSchema.parse(session)?.settings
      const decoder = new AcpDecoder(source, () => settings)
      const startup = source.mcpStartup?.()
      const childSpend = source.childSpend?.()
      const usage = new SessionUsage()
      const models = new AcpModelWindow(source)
      // As the live client, which counts no spend before the session has its id.
      let opening = false
      // As the live client while a compaction Mako asked for runs (`live.compaction`): its marker is the person's.
      let compacting = false
      const metered = (observations: UsageObservation[]): Decoded<DecoderEffect>[] => {
        const counted = opening ? observations.filter((observation) => observation.kind !== "spent" && observation.kind !== "costSpent") : observations
        const reading = counted.length ? usage.observe(...counted) : undefined
        return reading ? [decoded.state({ usage: reading })] : []
      }
      return {
        prompted(turn) {
          compacting = turn?.compaction === true
          if (turn?.text !== undefined) decoder.sent(turn.text, turn.attachments ?? 0)
        },
        opening() {
          opening = true
        },
        opened() {
          opening = false
        },
        decode(message): Decoded<DecoderEffect>[] {
          const recorded = RecordedSchema.safeParse(message)
          if (!recorded.success) return [decoded.unknown("(unreadable)", message, "unreadable")]
          if ("response" in recorded.data) {
            opening = false
            return metered(models.opened(recorded.data.result))
          }
          if ("request" in recorded.data) {
            const type = recorded.data.request
            if (type === PERMISSION) {
              const request = PermissionSchema.safeParse(recorded.data.params)
              // SAFETY: recorded from the live stream, which the SDK's own schema admitted; the shape is checked above.
              return request.success ? [ask(decoder.permission(request.data as RequestPermissionRequest))] : [decoded.unknown(type, message, "unreadable")]
            }
            const vendor = decoder.request(type, recorded.data.params)
            if (!vendor) return [decoded.unknown(type, message, source.requests?.methods.has(type) ? "unreadable" : "unknown")]
            return [...vendor.updates.map(decoded.update), ask(vendor.ask)]
          }
          if (recorded.data.method !== "session/update") {
            const heard = vendor(recorded.data, startup)
            // As the live client: what of a child's spend the session counts, before anything else reads it.
            const notified = heard && childSpend ? { ...heard, usage: childSpend.screen(recorded.data.params, heard.usage) } : heard
            if (!notified?.notices) return [decoded.unknown(notified?.kind ?? recorded.data.method, message)]
            const notices = compacting
              ? notified.notices.map((notice) => notice.kind === "event" ? { ...notice, event: manualCompaction(notice.event) } : notice)
              : notified.notices
            return [
              ...decodedNotices(notices, notified.id),
              ...notified.state ? [decoded.state(notified.state)] : [],
              ...metered([...acpNotificationUsage(notified), ...notified.models ? models.relisted(notified.models) : []]),
            ]
          }
          const notification = NotificationSchema.safeParse(recorded.data.params)
          if (!notification.success) return [decoded.unknown(kind(recorded.data), message, "unreadable")]
          // SAFETY: as above; the SDK admitted this update before it was recorded.
          const update = notification.data as SessionNotification
          // As the live client screens them (`acp.ts`): a side answer is no part of the session, a child's spend is, and a child's content isn't.
          if (source.sideQuestions.kind === "native" && source.sideQuestions.chain?.(update)) return []
          if (update.update.sessionUpdate !== "usage_update")
            return source.agents.kind === "observed" && source.agents.child?.(update) ? [] : decoder.update(update)
          const read = acpUsageReading(source, update.update)
          return read.of === "repeat" ? [] : metered(read.observations)
        },
      }
    },
  }
}
