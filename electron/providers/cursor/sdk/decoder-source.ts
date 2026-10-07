import { cursorUnfinishedToolNote } from "@mako/sessions/cursor-sdk-content"
import type { JsonObject, JsonValue } from "../../../codex-app-json.js"
import type { Decoded } from "../../../contracts/native-decoding.js"
import type { LiveSessionState } from "../../../shared.js"
import type { ProviderDecoderSource } from "../../decoder-source.js"
import { CursorDecoder, type CursorEffect } from "./decoder.js"
import { SdkEventSchema } from "./wire.js"

/** Child events the decoder turns into something the user sees or the session reads. */
const DECODED = new Set([
  "message/system",
  "message/assistant",
  "message/thinking",
  "message/tool_call",
  "message/task",
  "message/usage",
  "delta/text-delta",
  "delta/thinking-delta",
  "delta/shell-output",
  "delta/summary-started",
  "delta/summary-completed",
  "delta/unhandled",
  "result",
])
/** Known and deliberately shown as nothing: the prompt's echo, bookkeeping, and the child's own logs. */
const SILENT = new Set([
  "message/user",
  "message/status",
  "message/request",
  "delta/thinking-completed",
  "delta/turn-ended",
  "log",
  "login-url",
])

function kind(message: JsonValue): string {
  const parsed = SdkEventSchema.safeParse(message)
  if (!parsed.success) return "unreadable"
  const event = parsed.data
  switch (event.event) {
    case "message":
      return `message/${event.message.type}`
    case "delta":
      return `delta/${event.delta.type}`
    default:
      return event.event
  }
}

/**
 * Recorded Cursor child events, decoded as the driver decodes them live. A
 * recording has no driver to say when a turn starts, so a line for a new
 * turn starts one, and its `result` ends it.
 */
export const cursorDecoderSource: ProviderDecoderSource = {
  provider: "cursor",
  decoded: DECODED,
  silent: SILENT,
  kind,
  open(session: JsonObject) {
    let state: Pick<LiveSessionState, "settings"> = {
      // SAFETY: a recording's header holds the session's settings as the driver wrote them.
      settings: session.settings as LiveSessionState["settings"],
    }
    const decoder = new CursorDecoder({ models: [], get state() { return state } })
    let turn: string | undefined
    return {
      decode(message): Decoded<CursorEffect>[] {
        const parsed = SdkEventSchema.safeParse(message)
        if (!parsed.success) return [{ kind: "unknown", type: kind(message), reason: "unreadable", raw: message }]
        const event = parsed.data
        if (event.event === "log" || event.event === "login-url") return []
        if (event.turn !== turn) {
          turn = event.turn
          decoder.startTurn(turn)
        }
        if (event.event === "result")
          return decoder.finish(event.result.status, cursorUnfinishedToolNote(event.result.status, event.result.error?.message), event.result.settled)
        const decoded = decoder.decode(event)
        for (const item of decoded) if (item.kind === "state" && item.patch.settings) state = { settings: item.patch.settings }
        return decoded
      },
    }
  },
}
