import { z } from "zod"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import type { JsonObject } from "../../codex-app-json.js"
import type { AcpMcpStartupDecoder, AcpNotificationDecoding } from "../acp-source.js"

/**
 * How devin 3000.10.23 reports its MCP servers starting, recorded 2026-10-01
 * over ACP with one working server, one that exits during the handshake and
 * one whose command does not exist. Everything is `_cognition.ai/output`:
 * each server logs on its own channel (`MCP: <name>`), `info` while it
 * connects, and a failure is said twice at `warn`, once there and once on the
 * shared `MCP` channel:
 *
 *   MCP: missing  "MCP server 'missing' connection failed: cannot find binary path"
 *   MCP           "Failed to connect to MCP server 'missing' for description: cannot find binary path"
 *
 * Lines said before the session exists carry an empty `sessionId` (`null` in
 * some builds).
 */
const Output = z.object({
  sessionId: z.string().nullish(),
  channel: z.string().nullish(),
  message: z.string(),
  level: z.string().nullish(),
})

const FAILURES: readonly [RegExp, (reason: string) => string][] = [
  [/^MCP server '(.+?)' connection failed: (.+)$/s, (reason) => reason],
  [/^Failed to connect to MCP server '(.+?)'(?: for [^:]+)?: (.+)$/s, (reason) => reason],
  [/^Interactive OAuth failed for '(.+?)': (.+)$/s, (reason) => `sign-in failed: ${reason}`],
]

export function devinMcpStartup(): AcpMcpStartupDecoder {
  const failed = new Set<string>()
  return {
    decode(method: string, params: JsonObject): AcpNotificationDecoding | undefined {
      if (method !== "_cognition.ai/output") return undefined
      const output = Output.safeParse(params).data
      const channel = output?.channel
      if (!output || (channel !== "MCP" && !channel?.startsWith("MCP: "))) return undefined
      const sessionId = output.sessionId || undefined
      const kind = `${method}/mcp`
      if (output.level !== "warn" && output.level !== "error") return { sessionId, kind, notices: [] }
      const failure = serverFailure(output.message.trim(), channel)
      if (!failure) return undefined
      if (failed.has(failure.name)) return { sessionId, kind, notices: [] }
      failed.add(failure.name)
      return { sessionId, kind, notices: [{ kind: "event", event: mcpServerFailedEvent(failure.name, failure.reason) }] }
    },
  }
}

function serverFailure(message: string, channel: string): { name: string; reason: string } | undefined {
  for (const [pattern, explain] of FAILURES) {
    const [, name, reason] = pattern.exec(message) ?? []
    if (name && reason) return { name, reason: explain(reason.trim()) }
  }
  if (channel.startsWith("MCP: ") && /blocked by policy/i.test(message))
    return { name: channel.slice("MCP: ".length), reason: "blocked by policy" }
  return undefined
}
