import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { JsonValue } from "../../codex-app-json.js"
import { decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionState } from "../../contracts/providers-acp.js"
import type { ProviderDecoderSource } from "../decoder-source.js"
import { ClaudeDecoder } from "./decoder.js"
import { CLAUDE_DECODED_KINDS, CLAUDE_SILENT_KINDS } from "./sdk-message-kinds.js"

/**
 * Claude's decoder, offered to Mako's tools. A recorded message is one SDK
 * message as the driver's query yielded it; its kind is its `type`, or
 * `system/<subtype>`. Subagent tasks (`system/task_*`) are drawn by the
 * driver's `ClaudeAgents`, so they decode to nothing here.
 */
const MessageSchema = z.looseObject({ type: z.string(), subtype: z.string().optional() })
const SessionSchema = z.object({ settings: z.object({ model: z.string().nullish() }).optional() })

function kind(message: z.infer<typeof MessageSchema>): string {
  return message.type === "system" ? `system/${message.subtype ?? "(none)"}` : message.type
}

export const claudeDecoderSource: ProviderDecoderSource = {
  provider: "claude",
  decoded: CLAUDE_DECODED_KINDS,
  silent: CLAUDE_SILENT_KINDS,
  kind(message) {
    const recorded = MessageSchema.safeParse(message)
    return recorded.success ? kind(recorded.data) : "(unreadable)"
  },
  open(session) {
    const model = SessionSchema.safeParse(session).data?.settings?.model
    const state: Pick<LiveSessionState, "currentMode" | "usage" | "settings" | "commands" | "backgroundTasks"> =
      model ? { currentMode: null, settings: { model } } : { currentMode: null }
    // A retry's time is its delay from zero, so a recorded session decodes the same every time.
    const decoder = new ClaudeDecoder({ state }, () => 0)
    return {
      decode(message: JsonValue) {
        const recorded = MessageSchema.safeParse(message)
        if (!recorded.success) return [decoded.unknown("(unreadable)", message, "unreadable")]
        // SAFETY: a capture records each message exactly as the SDK's query yielded it.
        const out = decoder.decode(recorded.data as SDKMessage)
        // The live driver folds each state patch into the session the decoder reads.
        for (const item of out) if (item.kind === "state") Object.assign(state, item.patch)
        return out
      },
      prompted: () => decoder.startTurn(),
    }
  },
}
