import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { AcpDecoder } from "../acp-decoder.js"
import { decoded, decodedNotices, type Decoded } from "../contracts/native-decoding.js"
import type { AcpAsk, ProviderAcpSource } from "./acp-source.js"
import type { DecoderEffect, ProviderDecoderSource } from "./decoder-source.js"

/**
 * An ACP agent's decoder, offered to Mako's tools: the same `AcpDecoder` the
 * live client runs, over recorded messages. A recorded message is
 * `{ method, params }` for a notification and `{ request, params }` for a
 * request the agent waits on. Its kind is `session/update/<kind>` for an
 * update and the method otherwise.
 *
 * Vendor notifications go through the provider's `decodeNotification`, as
 * the live client reads them: their notices become the markers and activity
 * the window draws, and one the provider does not know stays unknown.
 */
const DECODED_UPDATES = ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call",
  "tool_call_update", "plan", "current_mode_update", "config_option_update", "session_info_update"]
const SILENT_UPDATES = ["usage_update", "available_commands_update"]
const PERMISSION = "session/request_permission"

const JsonObjectSchema = z.record(z.string(), z.json())
const RecordedSchema = z.union([
  z.object({ method: z.string(), params: JsonObjectSchema }),
  z.object({ request: z.string(), params: JsonObjectSchema }),
])
const NotificationSchema = z.looseObject({ sessionId: z.string(), update: z.looseObject({ sessionUpdate: z.string() }) })
const PermissionSchema = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(z.looseObject({ optionId: z.string(), name: z.string(), kind: z.string() })),
})
const SessionSchema = z.object({ settings: z.object({ model: z.string().optional() }).optional() })

export interface AcpAskEffect extends DecoderEffect {
  type: "ask"
  ask: AcpAsk
}

const ask = (value: AcpAsk): Decoded<AcpAskEffect> => decoded.effect({ type: "ask", ask: value })

export function acpDecoderSource(source: ProviderAcpSource): ProviderDecoderSource {
  const vendor = (message: z.infer<typeof RecordedSchema>) =>
    "method" in message && message.method !== "session/update" ? source.decodeNotification?.(message.method, message.params) : undefined
  const kind = (message: z.infer<typeof RecordedSchema>) => {
    if ("request" in message) return message.request
    if (message.method !== "session/update") return vendor(message)?.kind ?? message.method
    return `session/update/${NotificationSchema.safeParse(message.params).data?.update.sessionUpdate ?? "(none)"}`
  }
  return {
    provider: source.provider,
    decoded: new Set([...DECODED_UPDATES.map((update) => `session/update/${update}`), PERMISSION, ...(source.requests?.methods ?? [])]),
    silent: new Set(SILENT_UPDATES.map((update) => `session/update/${update}`)),
    kind(message) {
      const recorded = RecordedSchema.safeParse(message)
      return recorded.success ? kind(recorded.data) : "(unreadable)"
    },
    declares(message) {
      const recorded = RecordedSchema.safeParse(message)
      const notices = recorded.success ? vendor(recorded.data)?.notices : undefined
      return notices === undefined ? undefined : notices.length ? "decoded" : "silent"
    },
    open(session) {
      const settings = SessionSchema.safeParse(session).data?.settings
      const decoder = new AcpDecoder(source, () => settings)
      return {
        decode(message): Decoded<DecoderEffect>[] {
          const recorded = RecordedSchema.safeParse(message)
          if (!recorded.success) return [decoded.unknown("(unreadable)", message, "unreadable")]
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
            const notified = vendor(recorded.data)
            if (!notified?.notices) return [decoded.unknown(notified?.kind ?? recorded.data.method, message)]
            return [...decodedNotices(notified.notices, notified.id), ...notified.state ? [decoded.state(notified.state)] : []]
          }
          const notification = NotificationSchema.safeParse(recorded.data.params)
          // SAFETY: as above; the SDK admitted this update before it was recorded.
          return notification.success ? decoder.update(notification.data as SessionNotification) : [decoded.unknown(kind(recorded.data), message, "unreadable")]
        },
      }
    },
  }
}
