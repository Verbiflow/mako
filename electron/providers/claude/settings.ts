import { z } from "zod"
import type { DiscoveryStream } from "../profile-transport.js"
import type { JsonObject } from "../../codex-app-json.js"

// Strip every unrelated effective setting here: this response may contain secrets.
const EffectiveSettingsSchema = z.object({
  applied: z.object({ effort: z.string().nullable().optional() }),
  effective: z.object({
    fastMode: z.boolean().optional(),
    fastModePerSessionOptIn: z.boolean().optional(),
  }),
})
export const claudeDiscoveryArgs = [
  "-p",
  "--no-session-persistence",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  // Metadata probes must never invoke the user's startup/model-switch hooks.
  "--settings",
  '{"disableAllHooks":true}',
]

const ControlResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.string(),
    subtype: z.enum(["success", "error"]),
    response: z.json().optional(),
  }),
})

export function claudeDiscoveryControl(stream: DiscoveryStream) {
  let sequence = 0
  return (request: JsonObject) => {
    const id = `mako-discovery-${++sequence}`
    return stream.request(
      { type: "control_request", request_id: id, request },
      (message) => {
        const parsed = ControlResponseSchema.safeParse(message)
        if (!parsed.success || parsed.data.response.request_id !== id)
          return undefined
        if (parsed.data.response.subtype !== "success")
          throw new Error("Claude discovery request was rejected")
        return parsed.data.response.response ?? {}
      }
    )
  }
}

const SettingsResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    response: EffectiveSettingsSchema,
  }),
})
export const ClaudeEffectiveSettingsSchema = EffectiveSettingsSchema.transform(
  (settings) => {
    return {
      effort: settings.applied.effort ?? undefined,
      fast:
        settings.effective.fastMode === true &&
        settings.effective.fastModePerSessionOptIn !== true,
    }
  }
)

export const ClaudeSettingsResponseSchema = SettingsResponseSchema.transform(
  (envelope) => ClaudeEffectiveSettingsSchema.parse(envelope.response.response)
)
