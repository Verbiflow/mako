import { isAbsolute } from "node:path"
import { z } from "zod"
import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk"
import type { CallBounds } from "../call-bounds.js"
import { claudeRoutedCall, type ClaudeRouting } from "./routing.js"

/** Claude's tools that write the one file their input names. */
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

/**
 * Claude's tools that never change the workspace, which a turn's checkpoint
 * needn't hold. One that starts an agent isn't held either: that agent's own
 * calls pass these hooks. Any other tool, an MCP server's or one Claude adds,
 * may write, so it waits: a server's tool by its `mcp__<server>__<tool>` name,
 * and the tools that read a server's resources, which run its code too. That
 * is what lets a launch with the person's own stdio servers send at once.
 */
const NEVER_WRITE = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "Agent", "Task"])

/** What the hooks read of a tool's input: the file it writes, and whether it leaves work running. */
const ToolInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  run_in_background: z.boolean().optional(),
})

/** Whether PreToolUse's answer stops the call, so it never runs. */
function denies(output: SyncHookJSONOutput): boolean {
  const specific = output.hookSpecificOutput
  return specific?.hookEventName === "PreToolUse" && specific.permissionDecision === "deny"
}

export interface ClaudeCallHooks {
  pre: HookCallback
  post: HookCallback
}

/**
 * Claude's PreToolUse and PostToolUse hooks as a call's exact bounds
 * (`CallBounds`). Claude runs PreToolUse before asking for approval and
 * reports with PostToolUse how long the tool itself ran, so the start is the
 * later of the two. Each changes nothing, but for a native spawn `routing`
 * denies, which never starts: the person's own hooks
 * on the same events run beside them as before. A subagent's calls come
 * through too (`agent_id`), which the stream never shows.
 *
 * `beforeWrite`, when given, is what a tool that may write waits on first: its
 * turn's checkpoint holding the workspace (`WriteHolds`), or the tool being
 * cancelled.
 */
export function claudeCallHooks(bounds: CallBounds, routing?: ClaudeRouting, beforeWrite?: (signal: AbortSignal) => Promise<void> | undefined): ClaudeCallHooks {
  return {
    pre: async (input, _toolUseId, { signal }) => {
      if (input.hook_event_name !== "PreToolUse") return {}
      const routed = routing && claudeRoutedCall(routing, input)
      // A denied call never runs, so it has nothing to wait for.
      if (routed && denies(routed)) return routed
      // A tool Claude Code cancels meanwhile (the turn stopped) lets go at once.
      if (!NEVER_WRITE.has(input.tool_name)) await beforeWrite?.(signal)
      // A call routing only warns of still runs (a `git switch -c`, a server's tool Mako has its own for): it waited
      // for the checkpoint as any other does. Answered before the wait, it once wrote ahead of it.
      if (routed) return routed
      const tool = ToolInputSchema.safeParse(input.tool_input).data
      const path = FILE_TOOLS.has(input.tool_name) ? (tool?.file_path ?? tool?.notebook_path) : undefined
      bounds.before(input.tool_use_id, path && isAbsolute(path) ? [path] : [])
      return {}
    },
    post: async (input) => {
      if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {}
      bounds.after(input.tool_use_id, input.hook_event_name === "PostToolUse" ? "completed" : "failed", {
        ranMs: input.duration_ms,
        detached: ToolInputSchema.safeParse(input.tool_input).data?.run_in_background === true,
      })
      return {}
    },
  }
}
