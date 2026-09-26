import { z } from "zod"
import { homedir } from "node:os"
import { join } from "node:path"
import { GrokAgents } from "./agents.js"
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

/**
 * Verified 2026-09-26 against grok 1.0.41: an `is_background` command is
 * reported through `_x.ai/session_notification` as a `background_tasks`
 * update carrying every task of the session with its status, again when one
 * finishes. Grok then starts its own turn to read the output.
 */
const GrokBackgroundTasksSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("background_tasks"),
    tasks: z.array(z.object({ status: z.string() })),
  }),
})

export const grokAcpSource: ProviderAcpSource = {
  provider: "grok",
  approvalEvidence: { kind: "submission-only", reason: "ACP can forward requests if offered; tested native modes denied tools without an interactive ask. Exact decision observation and broader question coverage remain unverified." },
  async observeAgents({ env, ...input }) {
    const observer = new GrokAgents({ ...input, home: env.GROK_HOME ?? join(homedir(), ".grok") })
    await observer.ready
    return observer
  },
  compaction: { kind: "unavailable", reason: "Grok's ACP connection does not provide verified compaction. Start a new thread and carry over what matters." },
  observeBackground: () => ({
    extension(method, params) {
      if (method !== "_x.ai/session_notification") return undefined
      const parsed = GrokBackgroundTasksSchema.safeParse(params)
      if (!parsed.success) return undefined
      return {
        sessionId: parsed.data.sessionId,
        running: parsed.data.update.tasks.filter((task) => task.status === "running").length,
      }
    },
  }),
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
