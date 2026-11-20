import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

const TelemetrySettings = z.object({
  env: z.record(z.string(), z.string()).optional(), otelHeadersHelper: z.string().optional(),
  policyHelper: z.object({ path: z.string() }).optional(),
})

// Preserve all existing monitoring and explicit opt-outs. Do not tee private
// telemetry through Mako or change the destination/protocol a user selected.
export function hasClaudeTelemetryConfiguration(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(key => env[key] !== undefined && (
    key.startsWith("OTEL_") || key.startsWith("ANT_OTEL_") ||
    key.startsWith("CLAUDE_CODE_OTEL_") || key === "BETA_TRACING_ENDPOINT" ||
    key === "CLAUDE_CODE_ENABLE_TELEMETRY" || key === "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA" ||
    key === "ENABLE_BETA_TRACING_DETAILED" || key === "DISABLE_TELEMETRY" ||
    key === "DO_NOT_TRACK" || key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
  ))
}

export function hasClaudeTelemetrySettings(settings: Settings): boolean {
  return Boolean(settings.otelHeadersHelper || settings.policyHelper || hasClaudeTelemetryConfiguration(settings.env ?? {}))
}

export function claudeTelemetryOptionsCompatible(options: Options): boolean {
  const settings = TelemetrySettings.safeParse(options.settings ?? {})
  return !options.pathToClaudeCodeExecutable &&
    !hasClaudeTelemetryConfiguration(options.env ?? process.env) &&
    settings.success && !hasClaudeTelemetrySettings(settings.data) &&
    (!options.managedSettings || !hasClaudeTelemetrySettings(options.managedSettings))
}
