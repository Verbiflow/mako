import { z } from "zod"
import { hostLog } from "../../base/host-log.js"
import { routeShellCall } from "../../contracts/native-calls.js"
import type { JsonObject } from "../../contracts/json.js"
import type { AcpCallHooks } from "../acp-source.js"

/** Grok's shell tool, the one tool its hooks are registered for. */
const GROK_SHELL = "run_terminal_command"

const HookRun = z.object({
  hookEventName: z.string(),
  toolName: z.string().optional(),
  toolInput: z.object({ command: z.string().optional() }).loose().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
})

/**
 * Grok's client hooks over ACP, as 1.0.70 reads them (Grok's
 * `xai-grok-hooks` client; proven against a scripted model, 2026-11-03):
 * groups under `_meta["x.ai/hooks"]` by snake_case event, each call a
 * `_x.ai/hooks/run` request. A pre-tool `{decision: "deny", reason}` is what
 * the model reads as the result (`Hook denied: …`) and the call never runs;
 * a pre-tool note is dropped, so a warn answers the post-tool hook with
 * `additionalContext`, which the model reads after the output. A subagent
 * inherits the hooks. An unanswered hook fails open.
 */
export const GROK_CALL_HOOKS: AcpCallHooks = {
  meta: {
    "x.ai/hooks": {
      pre_tool_use: [{ matcher: `^${GROK_SHELL}$`, hookCallbackIds: ["mako-pre"], timeout: 10 }],
      post_tool_use: [{ matcher: `^${GROK_SHELL}$`, hookCallbackIds: ["mako-post"], timeout: 10 }],
    },
  },
  method: "_x.ai/hooks/run",
  answer(params, thread): JsonObject {
    const run = HookRun.safeParse(params)
    const command = run.data?.toolInput?.command
    if (!run.success || run.data.toolName !== GROK_SHELL || !command) return {}
    const route = routeShellCall(thread, { command, ...run.data.cwd && { cwd: run.data.cwd } })
    const pre = run.data.hookEventName === "pre_tool_use"
    if (route.kind === "deny" && pre) {
      hostLog("routing", "native call denied", { harness: "grok", tool: GROK_SHELL, family: route.family, rule: route.rule, session: run.data.sessionId })
      return { decision: "deny", reason: route.message }
    }
    if (route.kind === "warn" && run.data.hookEventName === "post_tool_use") {
      hostLog("routing", "native call warned", { harness: "grok", tool: GROK_SHELL, family: route.family, rule: route.rule, session: run.data.sessionId })
      return { additionalContext: route.message }
    }
    return {}
  },
}
