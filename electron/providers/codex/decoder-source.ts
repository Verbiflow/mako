import { z } from "zod"
import type { JsonObject, JsonValue } from "../../codex-app-json.js"
import { parseThreadResponse } from "../../codex-app-parse.js"
import { decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionState } from "../../contracts/providers-acp.js"
import type { ProviderDecoderSource } from "../decoder-source.js"
import {
  CODEX_DECODED_NOTIFICATIONS,
  CODEX_DECODED_REQUESTS,
  CODEX_SILENT_NOTIFICATIONS,
  CODEX_SILENT_REQUESTS,
  CodexDecoder,
  type CodexDecoded,
} from "./decoder.js"

/**
 * Recorded Codex messages are app-server notifications as they arrived,
 * `{ method, params }`; server requests, `{ request, id, params }`, and the
 * answers Mako sent them, `{ answered, result }`; or `{ replay }` holding a
 * `thread/resume` result whose turns Mako replays as the transcript the
 * session already had.
 */
const RpcId = z.union([z.string(), z.number()])
const RecordedSchema = z.union([
  z.object({ method: z.string(), params: z.record(z.string(), z.json()).default({}) }),
  z.object({ request: z.string(), id: RpcId, params: z.json() }),
  z.object({ answered: RpcId, result: z.json() }),
  z.object({ replay: z.json() }),
])

const SessionSchema = z.object({
  threadId: z.string().nullish(),
  title: z.string().optional(),
})

export const REPLAY_KIND = "(thread/resume replay)"
export const ANSWER_KIND = "(server request answer)"

export const codexDecoderSource: ProviderDecoderSource = {
  provider: "codex",
  decoded: new Set([...CODEX_DECODED_NOTIFICATIONS, ...CODEX_DECODED_REQUESTS, REPLAY_KIND, ANSWER_KIND]),
  silent: new Set([...CODEX_SILENT_NOTIFICATIONS, ...CODEX_SILENT_REQUESTS]),
  kind(message) {
    const recorded = RecordedSchema.safeParse(message)
    if (!recorded.success) return "(unreadable)"
    if ("method" in recorded.data) return recorded.data.method
    if ("request" in recorded.data) return recorded.data.request
    return "answered" in recorded.data ? ANSWER_KIND : REPLAY_KIND
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
        if ("request" in recorded.data) return decoder.request(recorded.data.id, recorded.data.request, recorded.data.params)
        if ("answered" in recorded.data) return decoder.answered(recorded.data.answered, recorded.data.result)
        const thread = parseThreadResponse(recorded.data.replay)
        if (!thread.valid) return [decoded.unknown(REPLAY_KIND, recorded.data.replay, "unreadable")]
        return settle(decoder.replay(thread.value.thread.turns ?? []))
      },
    }
  },
}
