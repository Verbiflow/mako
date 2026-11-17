import { z } from "zod"
import { hostLog } from "../../base/host-log.js"
import { routeShellCall } from "../../contracts/native-calls.js"
import type { JsonObject } from "../../contracts/json.js"
import { readOnlyCommand } from "../../attribution/index.js"
import type { AcpCallHooks } from "../acp-source.js"
import { grokPersonCode } from "./person-code.js"

/** Grok's shell tool, whose calls Mako routes. */
const GROK_SHELL = "run_terminal_command"
/**
 * Grok's tools that only read or ask, which never wait for a turn's checkpoint (its tool table, 1.0.77): every other
 * call does, whatever it is. That's its shell and `monitor`, its edits and Write, its image tools, an MCP tool
 * (`<server>__<tool>`, or through `use_tool`) and a subagent or workflow it starts, which then writes only after
 * the checkpoint holds the workspace, whatever its own tools ask.
 */
const GROK_READS = new Set([
  "read_file", "list_dir", "grep", "web_search", "x_search", "web_fetch", "search_tool", "todo_write",
  "ask_user_question", "enter_plan_mode", "exit_plan_mode", "get_command_or_subagent_output", "scheduler_list",
])

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
      // Every tool: which wait is `writes.holds`'s to say, so a tool Grok adds waits until it's known to only read.
      pre_tool_use: [{ matcher: ".*", hookCallbackIds: ["mako-pre"], timeout: 10 }],
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
  writes: {
    via: "Mako's `pre_tool_use` client hook for every Grok tool, answered over ACP (`_x.ai/hooks/run`), which Grok awaits before the tool runs (its subagents' tools too); only on a launch serving Mako's tools in a folder Grok trusts and reports none of the person's hooks, plugins, MCP or LSP servers for (`grok inspect --json`).",
    holds(params, answer) {
      const run = HookRun.safeParse(params)
      if (!run.success || run.data.hookEventName !== "pre_tool_use" || answer.decision === "deny") return false
      const tool = run.data.toolName ?? ""
      if (GROK_READS.has(tool)) return false
      const command = run.data.toolInput?.command
      return !(tool === GROK_SHELL && command && readOnlyCommand(command))
    },
    personCodeRuns: grokPersonCode,
  },
}
