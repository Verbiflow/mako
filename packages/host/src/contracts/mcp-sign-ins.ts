/**
 * The MCP servers that need the person's sign-in, by harness: what a harness reported as it started a session
 * (`mcpServerFailedEvent`, "sign-in required"), with the one way it signs in. A conversation no longer draws these:
 * they're the person's to fix once, here, not a line in every session that starts.
 */
export interface McpSignIn {
  harness: string
  server: string
  /** How it's signed in: the harness's own command, run by Mako, or a page to open. */
  way: "command" | "page"
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
