/**
 * The MCP servers a harness couldn't start, by harness: what it reported as it started a session
 * (`mcpServerFailedEvent`), with the one thing the person can do about it. A conversation no longer draws these:
 * each is said once, in the rail and Settings › MCP, not as a line in every session that starts.
 */
export interface McpSignIn {
  harness: string
  server: string
  /** Why it didn't start, in the shared words ("sign-in required", "could not connect", …) or the harness's own line. */
  reason: string
  /**
   * What fixes it: the harness's own sign-in command, run by Mako; the page where it's connected; or, where the
   * harness offers neither, Settings › MCP, where its server is kept.
   */
  way: "command" | "page" | "settings"
  /** The page, for `way: "page"`. */
  url?: string
  /** A sign-in under way (the command still running), or why the last one didn't finish. */
  state?: { kind: "signing-in" } | { kind: "failed"; reason: string }
  /** When a session last reported it. */
  reportedAt: number
}

/** `mako:mcp-sign-ins` and the window-wide `mcp-sign-ins` event. */
export interface McpSignIns {
  servers: McpSignIn[]
}

/**
 * A server that couldn't be reached (it closed, or didn't answer in time) may well start next time, and nothing the
 * person presses fixes it: Settings › MCP says so quietly, and the rail leaves it out.
 */
export function mcpServerUnreachable(server: Pick<McpSignIn, "reason">): boolean {
  return server.reason === "could not connect" || server.reason === "timed out"
}
