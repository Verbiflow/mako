import { z } from "zod"

type ListenerSetting = "MAKO_DESK_BROWSER_PORT" | "MAKO_RUNTIME_CONTROL_PORT" | "MAKO_CONVERSATION_MCP_PORT" | "MAKO_OPENCODE_API_PORT" | "MAKO_CLAUDE_PERMISSION_PORT"
const Port = z.coerce.number().int().min(1).max(65535)

/** Explicit isolation when configured; normal launches keep OS allocation. */
export function configuredListenPort(setting: ListenerSetting, env: NodeJS.ProcessEnv = process.env): number {
  const value = env[setting]
  if (value === undefined) return 0
  const parsed = Port.safeParse(value)
  if (!parsed.success) throw new Error(`${setting} must be a port from 1 to 65535`)
  return parsed.data
}
