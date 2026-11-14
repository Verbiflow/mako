import { z } from "zod"
import type { AgentDefinition, HookCallback, PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk"
import { FIN_SUBAGENT } from "../../contracts/primer.js"
import { hostLog } from "../../base/host-log.js"
import { MAKO_THREAD_SERVER } from "../../contracts/mcp-reach.js"
import { NATIVE_CHILD_INSTRUCTIONS, routeNativeSpawn, type NativeSpawn, type RoutedThread } from "../../contracts/native-routing.js"
import { mcpToolName, routeNativeTool, routeShellCall, type CallRoute, type CallThread } from "../../contracts/native-calls.js"

/** Claude's tools that start subagents: `Agent` (`Task` before Claude Code 2.1) and `Workflow`, which runs a script of them. */
const SPAWN_TOOLS = new Set(["Agent", "Task", "Workflow"])

/** What routing reads of an `Agent` call (`AgentInput` in the SDK's tool types); any other input reads as none of it. */
export const ClaudeAgentInput = z.object({
  subagent_type: z.string(),
  run_in_background: z.boolean(),
  isolation: z.string(),
  name: z.string(),
}).partial().catch({})
export type ClaudeAgentInput = z.infer<typeof ClaudeAgentInput>

/** Mako's `agents_start` as Claude names an MCP server's tool. */
export const CLAUDE_START_TOOL = `mcp__${MAKO_THREAD_SERVER}__agents_start`

/** Mako's own subagent type on Claude (`FIN_SUBAGENT`). Its one tool is `agents_start`, so spawning it starts a Fin. */
export const CLAUDE_FIN_AGENT = FIN_SUBAGENT.name

/** The `fin` agent Mako declares beside the person's own agents, which still load from their settings. */
export const CLAUDE_FIN_DEFINITION = {
  description: FIN_SUBAGENT.description,
  prompt: FIN_SUBAGENT.prompt,
  tools: [CLAUDE_START_TOOL],
  omitClaudeMd: true,
} satisfies AgentDefinition

/**
 * A Claude tool call as a native spawn, or undefined for any other tool. An
 * `Explore` agent the turn waits for (`run_in_background: false`; Claude runs
 * agents in the background by default) reads and ends in the turn. With agent
 * teams on, a named agent is a teammate that `SendMessage` reaches.
 */
export function claudeSpawn(tool: string, input: ClaudeAgentInput, teams: boolean): NativeSpawn | undefined {
  if (!SPAWN_TOOLS.has(tool)) return undefined
  const agent = tool === "Workflow" ? {} : input
  if (agent.subagent_type === CLAUDE_FIN_AGENT) return undefined
  return {
    tool,
    start: CLAUDE_START_TOOL,
    ...(agent.subagent_type === "Explore" && agent.run_in_background === false && { inTurnExplore: true }),
    ...(agent.isolation !== undefined && { isolated: true }),
    ...(teams && agent.name !== undefined && { teammate: true }),
  }
}

export interface ClaudeRouting {
  /** The Thread as routing reads it at each spawn; absent where only native calls are routed. */
  thread?(): RoutedThread
  /** The Thread as native calls read it at each call (`routeShellCall`); absent where Mako serves no tools. */
  calls?(): CallThread
  /** The launch turned agent teams on. */
  teams: boolean
  conversation: string
}

/** Mako's tools as Claude names an MCP server's tool. */
const claudeNames = (tool: string) => `mcp__${MAKO_THREAD_SERVER}__${tool}`

const BashInput = z.object({ command: z.string() }).partial().catch({})

/** A Claude tool call's route among Mako's tools: Bash by its command, `mcp__<server>__<tool>` by its server. */
function claudeCallRoute(thread: CallThread, input: PreToolUseHookInput): CallRoute {
  if (input.tool_name === "Bash") {
    const command = BashInput.parse(input.tool_input).command
    return command ? routeShellCall(thread, { command, cwd: input.cwd }, claudeNames) : { kind: "allow" }
  }
  const mcp = mcpToolName(input.tool_name)
  return routeNativeTool(thread, { tool: input.tool_name, ...mcp && { server: mcp.server } }, claudeNames)
}

/** PreToolUse's answer to a native call the Thread's calls deny or warn of, or undefined to let it go on unremarked. */
function claudeNativeCall(routing: ClaudeRouting, input: PreToolUseHookInput): SyncHookJSONOutput | undefined {
  if (!routing.calls) return undefined
  const route = claudeCallRoute(routing.calls(), input)
  if (route.kind === "allow") return undefined
  hostLog("routing", route.kind === "deny" ? "native call denied" : "native call warned", { harness: "claude", tool: input.tool_name, family: route.family, rule: route.rule, conversation: routing.conversation, toolUse: input.tool_use_id })
  return route.kind === "deny"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: route.message } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: route.message } }
}

/** PreToolUse's answer to a spawn routing denies or a native call Mako routes, or undefined to let the call go on. */
export function claudeRoutedCall(routing: ClaudeRouting, input: PreToolUseHookInput): SyncHookJSONOutput | undefined {
  const spawn = claudeSpawn(input.tool_name, ClaudeAgentInput.parse(input.tool_input), routing.teams)
  if (!spawn) return claudeNativeCall(routing, input)
  if (!routing.thread) return undefined
  const thread = routing.thread()
  const route = routeNativeSpawn(thread, spawn)
  if (route.kind === "allow") return undefined
  hostLog("routing", "native spawn denied", { harness: "claude", tool: spawn.tool, role: thread.role, conversation: routing.conversation, toolUse: input.tool_use_id, ...(input.agent_id && { inAgent: input.agent_id }) })
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: route.message } }
}

/** SubagentStart: every native subagent starts with Mako's paragraph for native children, but Mako's `fin`, whose work is starting one. */
export const claudeSubagentStart: HookCallback = async (input) =>
  input.hook_event_name === "SubagentStart" && input.agent_type !== CLAUDE_FIN_AGENT ? { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: NATIVE_CHILD_INSTRUCTIONS } } : {}
