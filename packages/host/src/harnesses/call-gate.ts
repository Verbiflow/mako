import { z } from "zod"
import { hostLog } from "../base/host-log.js"
import type { JsonObject } from "../contracts/json.js"
import { mcpToolName, routeNativeTool, routeShellCall, scriptFlag, type CallRoute, type CallThread } from "../contracts/native-calls.js"

/** A shell tool's command as one line: argv (`["bash", "-lc", "…"]`) reads as its script. */
const CommandLine = z.union([
  z.string(),
  z.array(z.string()).transform((argv) => {
    const script = argv.findIndex(scriptFlag)
    return script >= 0 && argv[script + 1] !== undefined ? argv[script + 1]! : argv.join(" ")
  }),
])

/**
 * One tool call as a harness's command hook posts it to the conversation
 * server (`/calls/<pre|post>`): Claude Code's hook event, which Devin and
 * Codex share.
 */
export const HookCall = z.object({
  tool_name: z.string().optional(),
  tool_input: z.object({ command: CommandLine.optional(), workdir: z.string().optional() }).loose().optional(),
  cwd: z.string().optional(),
}).loose()
export type HookCall = z.infer<typeof HookCall>

/** A hooked call's route: a shell tool by its command, an MCP tool (`mcp__<server>__<tool>`) by its server. */
function hookRoute(call: HookCall, thread: CallThread): CallRoute {
  const command = call.tool_input?.command
  if (command) {
    const cwd = call.tool_input?.workdir ?? call.cwd ?? thread.folder
    return routeShellCall(thread, { command, ...cwd && { cwd } })
  }
  const mcp = mcpToolName(call.tool_name ?? "")
  return mcp ? routeNativeTool(thread, { tool: call.tool_name!, server: mcp.server }) : { kind: "allow" }
}

/**
 * What the hook prints for one call: a deny before it runs, a note after it
 * ran (or before it, for `before`), or nothing. A deny carries both spellings
 * a hook may answer with (`decision: "block"` and PreToolUse's
 * `permissionDecision`), so one answer serves every harness that reads either.
 */
export function callGateAnswer(event: "pre" | "post" | "before", call: HookCall | undefined, thread: CallThread, conversation: string): JsonObject {
  if (!call) return {}
  const route = hookRoute(call, thread)
  if (route.kind === "deny" && event !== "post") {
    hostLog("routing", "native call denied", { tool: call.tool_name, conversation, family: route.family, rule: route.rule })
    return { decision: "block", reason: route.message, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: route.message } }
  }
  if (route.kind === "warn" && event !== "pre") {
    hostLog("routing", "native call warned", { tool: call.tool_name, conversation, family: route.family, rule: route.rule })
    return { hookSpecificOutput: { hookEventName: event === "before" ? "PreToolUse" : "PostToolUse", additionalContext: route.message } }
  }
  return {}
}
