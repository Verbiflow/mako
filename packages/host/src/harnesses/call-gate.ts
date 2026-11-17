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

/**
 * How long a command hook's call may wait on Mako for a turn's checkpoint: under the 8 s each hook gives up after
 * (Codex's and Devin's `curl -m 8`, OpenCode's plugin's `AbortSignal.timeout(8000)`), so Mako lets it go first and
 * knows it went (`WriteHolds.beforeWrite`'s `withinMs`).
 */
export const CALL_GATE_HOLD_MS = 6_000

/** The tools hooks post that only read, across the harnesses whose hooks post here; any other may write. */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "todoread", "todowrite"])

/** Whether a hooked call may change the workspace, so a turn's checkpoint holds it. */
export function hookMayWrite(call: HookCall | undefined): boolean {
  return !READ_ONLY_TOOLS.has(call?.tool_name ?? "")
}

/** Whether a gate's answer refuses the call, which then never runs. */
export function gateDenies(answer: JsonObject): boolean {
  return answer.decision === "block"
}

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
