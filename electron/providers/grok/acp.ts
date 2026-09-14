import { z } from "zod"
import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"
import type { AccessTier } from "../../contracts/access.js"

/**
 * Verified 2026-09-11 against grok 1.0.25 over `agent stdio`: a second
 * session/prompt is queued behind the running turn (eight tool calls ran
 * after it), so Grok advertises no steering. In every permission mode except
 * always-approve the ACP server denies tool calls instead of sending
 * session/request_permission, so the host cannot approve on the user's
 * behalf; the tier is fixed by the launch flag. Grok reports no session
 * modes over ACP, so the default is pinned explicitly: without it an
 * unchosen session ran Grok's own default while the desk reported nothing.
 */
function grokPermissionMode(tier: AccessTier): string | undefined {
  switch (tier) {
    case "plan":
      return "plan"
    case "deny":
      return "default"
    case "auto":
      return "auto"
    case "full":
      return "bypassPermissions"
    default:
      return undefined
  }
}

export const grokAcpSource: ProviderAcpSource = {
  provider: "grok",
  canResume: true,
  launchOptionIds: ["effort"],
  access: { launch: ["plan", "deny", "auto", "full"], default: "deny" },
  available: () => resolveExecutable("grok") !== null,
  async launch(options) {
    const permissionMode = options.access ? grokPermissionMode(options.access) : undefined
    const args = [
      ...(permissionMode ? ["--permission-mode", permissionMode] : []),
      "agent",
      "--no-leader",
    ]
    const effort = z.string().optional().parse(options.tuning?.options?.effort)
    if (effort) args.push("--reasoning-effort", effort)
    args.push("stdio")
    return {
      command: "grok",
      args,
      configureEnvironment(env) {
        env.GROK_DISABLE_AUTOUPDATER = "1"
      },
    }
  },
}
