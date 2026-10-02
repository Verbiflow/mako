import type { OpenCodeEvent } from "@opencode/client"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../../codex-app-json.js"
import type { AccessTier } from "../../contracts/access.js"
import type { Decoded } from "../../contracts/native-decoding.js"
import type { ProviderDecoderSource } from "../decoder-source.js"
import { OPENCODE_DECODED, OPENCODE_QUIET_CONTENT, OpenCodeDecoder, type OpenCodeEffect } from "./decoder.js"
import { OPENCODE_IGNORED } from "./notices.js"

const RecordedEvent = z.looseObject({ type: z.string(), data: z.record(z.string(), z.unknown()) })
const Session = z.object({ root: z.string(), cwd: z.string(), launchAccess: z.string(), contextSize: z.number().nullable() })

/** `rpc.*` events are the API's own bookkeeping, counted as one kind. */
function kind(message: JsonValue): string {
  const parsed = RecordedEvent.safeParse(message)
  if (!parsed.success) return "unreadable"
  return parsed.data.type.startsWith("rpc.") ? "rpc" : parsed.data.type
}

/**
 * Recorded OpenCode events, decoded as the driver decodes them live. The
 * recording's header names the root session, its folder and the context
 * window the catalog gave the selected model.
 */
export const openCodeDecoderSource: ProviderDecoderSource = {
  provider: "opencode",
  decoded: OPENCODE_DECODED,
  // Shell events carry no content but count background work.
  silent: new Set([...OPENCODE_IGNORED, ...OPENCODE_QUIET_CONTENT, "rpc"].filter((kind) => !OPENCODE_DECODED.has(kind))),
  kind,
  open(session: JsonObject) {
    const header = Session.parse(session)
    const decoder = new OpenCodeDecoder(header.root, header.cwd, {
      // SAFETY: the driver wrote its launch access tier into the header.
      launchAccess: header.launchAccess as AccessTier,
      contextSize: () => header.contextSize ?? undefined,
    })
    return {
      decode(message): Decoded<OpenCodeEffect>[] {
        const event = RecordedEvent.safeParse(message)
        if (!event.success) return [{ kind: "unknown", type: kind(message), reason: "unreadable", raw: message }]
        // SAFETY: a recording holds the events the driver received, as received.
        return decoder.decode(event.data as OpenCodeEvent)
      },
    }
  },
}
