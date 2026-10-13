import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { JsonValue } from "../../contracts/json.js"
import { decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionState } from "../../contracts/providers-acp.js"
import type { ProviderDecoderSource } from "../decoder-source.js"
import { CLAUDE_TRANSCRIPT_NOTIFICATIONS, ClaudeDecoder } from "./decoder.js"
import { CLAUDE_DECODED_KINDS, CLAUDE_SILENT_KINDS } from "./sdk-message-kinds.js"
import { TranscriptNotificationSchema } from "./transcript-tail.js"

/**
 * Claude's decoder, offered to Mako's tools. A recorded message is one SDK
 * message as the driver's query yielded it; its kind is its `type`, or
 * `system/<subtype>`. Subagent tasks (`system/task_*`) are drawn by the
 * driver's `ClaudeAgents`, so they decode to nothing here. `{ transcript }`
 * holds the task notifications the driver read from the session's
 * transcript (`ClaudeTranscriptTail`), where it read them.
 *
 * Nearly every line is an SDK message, so that is tried first and a
 * transcript read only after it fails: a failed parse builds an error,
 * which once made decoding six times slower. The kind keeps only `type`
 * and `subtype`; copying the whole message cost more than decoding it.
 */
const KindSchema = z.object({ type: z.string(), subtype: z.string().optional() })
/** A capture records each message exactly as the SDK's query yielded it, which its kind identifies. */
const SdkMessageSchema = z.custom<SDKMessage>((message) => KindSchema.safeParse(message).success)
const TranscriptRead = z.object({ transcript: z.array(TranscriptNotificationSchema) })
const SessionSchema = z.object({ settings: z.object({ model: z.string().nullish() }).optional() })

function kind(message: z.infer<typeof KindSchema>): string {
  return message.type === "system" ? `system/${message.subtype ?? "(none)"}` : message.type
}

export const claudeDecoderSource: ProviderDecoderSource = {
  provider: "claude",
  decoded: new Set([...CLAUDE_DECODED_KINDS, CLAUDE_TRANSCRIPT_NOTIFICATIONS]),
  silent: CLAUDE_SILENT_KINDS,
  kind(message) {
    const recorded = KindSchema.safeParse(message)
    if (recorded.success) return kind(recorded.data)
    return TranscriptRead.safeParse(message).success ? CLAUDE_TRANSCRIPT_NOTIFICATIONS : "(unreadable)"
  },
  open(session) {
    const model = SessionSchema.safeParse(session).data?.settings?.model
    const state: Pick<LiveSessionState, "currentMode" | "usage" | "settings" | "commands" | "backgroundTasks"> =
      model ? { currentMode: null, settings: { model } } : { currentMode: null }
    // A retry's time is its delay from zero, so a recorded session decodes the same every time.
    const decoder = new ClaudeDecoder({ state }, () => 0)
    return {
      decode(message: JsonValue) {
        const recorded = SdkMessageSchema.safeParse(message)
        if (!recorded.success) {
          const read = TranscriptRead.safeParse(message)
          return read.success ? decoder.transcript(read.data.transcript) : [decoded.unknown("(unreadable)", message, "unreadable")]
        }
        const out = decoder.decode(recorded.data)
        // The live driver folds each state patch into the session the decoder reads.
        for (const item of out) if (item.kind === "state") Object.assign(state, item.patch)
        return out
      },
      prompted: () => decoder.startTurn(),
    }
  },
}
