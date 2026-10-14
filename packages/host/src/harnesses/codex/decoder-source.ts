import { z } from "zod"
import type { JsonObject, JsonValue } from "../../contracts/json.js"
import { decoded } from "../../contracts/native-decoding.js"
import type { LiveSessionState } from "../../contracts/providers-acp.js"
import { RecordedObjectSchema, RecordedValueSchema, type ProviderDecoderSource } from "../decoder-source.js"
import {
  CODEX_DECODED_NOTIFICATIONS,
  CODEX_ROLLOUT_RECORDS,
  CODEX_SILENT_NOTIFICATIONS,
  CODEX_SILENT_REQUESTS,
  CodexDecoder,
  type CodexDecoded,
} from "./decoder.js"

/**
 * Recorded Codex messages are app-server notifications as they arrived,
 * `{ method, params }`; `{ records }`, the rollout records the driver read
 * before the next one (`CodexRolloutTail`), each with its byte range in the
 * rollout; server requests, `{ request, id, params }`, and the answers Mako
 * sent them, `{ answered, result }`, which the transport handles; and
 * `{ replay }`, a `thread/resume` result, which names no turns because Mako
 * resumes with `excludeTurns`: saved history draws them.
 */
const RpcId = z.union([z.string(), z.number()])
const RolloutRecordSchema = z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), record: RecordedObjectSchema })
const RecordedSchema = z.union([
  z.object({ method: z.string(), params: RecordedObjectSchema.default({}) }),
  z.object({ records: z.array(RolloutRecordSchema) }),
  z.object({ request: z.string(), id: RpcId, params: RecordedValueSchema }),
  z.object({ answered: RpcId, result: RecordedValueSchema }),
  z.object({ replay: RecordedValueSchema }),
])

const SessionSchema = z.object({
  threadId: z.string().nullish(),
  title: z.string().optional(),
})

export const REPLAY_KIND = "(thread/resume replay)"
export const ANSWER_KIND = "(server request answer)"

export const codexDecoderSource: ProviderDecoderSource = {
  provider: "codex",
  decoded: new Set([...CODEX_DECODED_NOTIFICATIONS, CODEX_ROLLOUT_RECORDS]),
  silent: new Set([...CODEX_SILENT_NOTIFICATIONS, ...CODEX_SILENT_REQUESTS, REPLAY_KIND, ANSWER_KIND]),
  kind(message) {
    const recorded = RecordedSchema.safeParse(message)
    if (!recorded.success) return "(unreadable)"
    if ("method" in recorded.data) return recorded.data.method
    if ("records" in recorded.data) return CODEX_ROLLOUT_RECORDS
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
      prompted: () => decoder.expectTurn(),
      decode(message: JsonValue) {
        const recorded = RecordedSchema.safeParse(message)
        if (!recorded.success) return [decoded.unknown("(unreadable)", message, "unreadable")]
        if ("method" in recorded.data) {
          const params: JsonObject = recorded.data.params
          return settle(decoder.decode({ method: recorded.data.method, params }))
        }
        if ("records" in recorded.data) return settle(decoder.records(recorded.data.records.map((read) => read.record)))
        return []
      },
    }
  },
}
