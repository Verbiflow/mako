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
    error: z.string().optional(),
  }),
})

export function claudeDiscoveryControl(stream: DiscoveryStream) {
  let sequence = 0
  return async (request: JsonObject) => {
    const id = `mako-discovery-${++sequence}`
    const reply = await stream.request(
      { type: "control_request", request_id: id, request },
      (message) => {
        const parsed = ControlResponseSchema.safeParse(message)
        return parsed.success && parsed.data.response.request_id === id ? parsed.data.response : undefined
      }
    )
    if (reply.subtype !== "success")
      throw new Error(reply.error ?? "Claude discovery request was rejected")
    return reply.response ?? {}
  }
}

const SettingsResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    response: EffectiveSettingsSchema,
  }),
})
/**
 * Why Claude Code refused to switch to a model it listed, in the picker's
 * words, or undefined when only its check with Anthropic's API failed
 * ("Couldn't confirm model …, try again"): that one passes on a later try
 * and says nothing about the model. Its own text names settings Mako
 * doesn't expose (`behavesAs`, `/model`), so that refusal is restated and
 * any other is shown as it came.
 */
export function claudeModelRefusal(message: string): string | undefined {
  if (message.includes("isn't described by this version's model catalog"))
    return "This version of Claude Code doesn't support it yet. Update Claude Code to use it."
  if (message.startsWith("Couldn't confirm model")) return undefined
  return message
}

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
