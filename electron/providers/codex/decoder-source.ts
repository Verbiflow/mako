import { z } from "zod"
import type { JsonObject, JsonValue } from "../../codex-app-json.js"
import { parseThreadResponse } from "../../codex-app-parse.js"
import { decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionState } from "../../contracts/providers-acp.js"
import type { ProviderDecoderSource } from "../decoder-source.js"
import {
  CODEX_DECODED_NOTIFICATIONS,
  CODEX_SILENT_NOTIFICATIONS,
  CodexDecoder,
  type CodexDecoded,
} from "./decoder.js"

/**
 * Recorded Codex messages are app-server notifications as they arrived,
 * `{ method, params }`, or `{ replay }` holding a `thread/resume` result
 * whose turns Mako replays as the transcript the session already had.
 */
const RecordedSchema = z.union([
  z.object({ method: z.string(), params: z.record(z.string(), z.json()).default({}) }),
  z.object({ replay: z.json() }),
])

const SessionSchema = z.object({
  threadId: z.string().nullish(),
  title: z.string().optional(),
})

export const REPLAY_KIND = "(thread/resume replay)"

export const codexDecoderSource: ProviderDecoderSource = {
  provider: "codex",
  decoded: new Set([...CODEX_DECODED_NOTIFICATIONS, REPLAY_KIND]),
  silent: CODEX_SILENT_NOTIFICATIONS,
  kind(message) {
    const recorded = RecordedSchema.safeParse(message)
    if (!recorded.success) return "(unreadable)"
    return "method" in recorded.data ? recorded.data.method : REPLAY_KIND
  },
  open(session) {
    const known = SessionSchema.safeParse(session)
    const state: Pick<LiveSessionState, "title" | "usage"> = {}
    if (known.data?.title !== undefined) state.title = known.data.title
    const decoder = new CodexDecoder({ threadId: known.data?.threadId ?? null, state })
    // The live driver folds each state patch into the session the decoder reads.
    const settle = (out: CodexDecoded[]) => {
      for (const item of out) if (item.kind === "state") Object.assign(state, item.patch)
      return out
    }
    return {
      decode(message: JsonValue) {
        const recorded = RecordedSchema.safeParse(message)
        if (!recorded.success) return [decoded.unknown("(unreadable)", message, "unreadable")]
        if ("method" in recorded.data) {
          const params: JsonObject = recorded.data.params
          return settle(decoder.decode({ method: recorded.data.method, params }))
        }
        const thread = parseThreadResponse(recorded.data.replay)
        if (!thread.valid) return [decoded.unknown(REPLAY_KIND, recorded.data.replay, "unreadable")]
        return settle(decoder.replay(thread.value.thread.turns ?? []))
      },
    }
  },
}
