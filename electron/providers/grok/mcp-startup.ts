import { z } from "zod"
import { mcpServerFailedEvent, plainWords } from "@mako/sessions/events"
import type { JsonObject } from "../../codex-app-json.js"
import type { AcpMcpStartupDecoder, AcpNotificationDecoding } from "../acp-source.js"

/**
 * How grok 1.0.44 reports its MCP servers starting, recorded 2026-10-01 over
 * ACP with one working server, one that exits during the handshake and one
 * whose command does not exist:
 *
 * 1. `_x.ai/mcp/servers_updated {mcpServers: [{name, …}]}`, before the
 *    session has an id: every server it will start.
 * 2. `_x.ai/mcp/init_progress {total, connected}`, then `_x.ai/mcp_initialized`.
 * 3. `_x.ai/mcp/server_status {name, status, reason, detail}` for each server
 *    that spawned: `ready`/`initialized`, or `unavailable`/`handshake_failed`
 *    with Grok's own explanation.
 *
 * A server whose process could not be launched gets no status at all, so it
 * is named once the first turn's response completes: by then every status
 * has arrived (about 30 ms after `mcp_initialized`).
 */
const STARTING = new Set(["ready", "initializing", "starting", "pending", "connecting", "disabled"])

const ServersUpdated = z.object({ mcpServers: z.array(z.looseObject({ name: z.string().min(1) })) })
const ServerStatus = z.object({
  sessionId: z.string(),
  name: z.string().min(1),
  status: z.string().min(1),
  reason: z.string().nullish(),
  detail: z.string().nullish(),
})
const Session = z.object({ sessionId: z.string() })
const ResponseCompleted = z.object({ sessionId: z.string(), update: z.looseObject({ sessionUpdate: z.literal("response_completed") }) })

const QUIET = new Set(["_x.ai/mcp/init_progress", "_x.ai/mcp_initialized"])

/** In the words Codex's and Claude's notices use. */
const REASONS = new Map([["auth_required", "sign-in required"], ["needs_auth", "sign-in required"], ["setup_required", "setup required"]])

const lowerFirst = (words: string) => words.charAt(0).toLowerCase() + words.slice(1)

export function grokMcpStartup(): AcpMcpStartupDecoder {
  let configured: string[] = []
  const reported = new Set<string>()
  const failed = new Set<string>()
  let settled = false
  return {
    decode(method: string, params: JsonObject): AcpNotificationDecoding | undefined {
      if (method === "_x.ai/mcp/servers_updated") {
        configured = ServersUpdated.safeParse(params).data?.mcpServers.map((server) => server.name) ?? configured
        return { kind: method, notices: [] }
      }
      if (QUIET.has(method)) return { sessionId: Session.safeParse(params).data?.sessionId, kind: method, notices: [] }
      if (method === "_x.ai/mcp/server_status") {
        const status = ServerStatus.safeParse(params).data
        if (!status) return { kind: method, notices: undefined }
        reported.add(status.name)
        const kind = `${method}/${status.status}`
        if (STARTING.has(status.status) || failed.has(status.name)) return { sessionId: status.sessionId, kind, notices: [] }
        failed.add(status.name)
        const reason = status.detail?.trim().replace(`MCP server '${status.name}' `, "") || REASONS.get(status.reason ?? status.status) || lowerFirst(plainWords(status.reason ?? status.status))
        return { sessionId: status.sessionId, kind, notices: [{ kind: "event", event: mcpServerFailedEvent(status.name, reason) }] }
      }
      if (settled || method !== "_x.ai/session_notification") return undefined
      const completed = ResponseCompleted.safeParse(params).data
      if (!completed) return undefined
      settled = true
      const unlaunched = configured.filter((name) => !reported.has(name))
      if (!unlaunched.length) return undefined
      return {
        sessionId: completed.sessionId,
        kind: `${method}/response_completed`,
        notices: unlaunched.map((name) => ({ kind: "event", event: mcpServerFailedEvent(name, "could not be launched") })),
      }
    },
  }
}
