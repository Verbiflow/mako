import type { McpSignIn, McpSignIns } from "@mako/host/contracts/mcp-sign-ins"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * The MCP servers a harness couldn't start (`McpSignIns`), for the rail and Settings › MCP: the one place each
 * is said, with the one thing that fixes it, instead of a line in every conversation that starts.
 */
export const mcpSignInsStore = createStore<McpSignIns>({ servers: [] })
export const useMcpSignIns = createHook(mcpSignInsStore)

/** The host's reading, at boot and whenever it changes (`mcp-sign-ins`). */
export function applyMcpSignIns(reading: McpSignIns): void {
  mcpSignInsStore.set(reading)
}

export async function loadMcpSignIns(): Promise<void> {
  if (!hasBridge()) return
  applyMcpSignIns(await getMako().mcpSignIns())
}

/** Signs a server in: the harness's own command, which the host runs, or its page, which opens in the browser. */
export async function signInMcp(server: McpSignIn): Promise<void> {
  if (server.way === "page" && server.url) await getMako().openUrl(server.url)
  applyMcpSignIns(await getMako().mcpSignIn(server.harness, server.server))
}
