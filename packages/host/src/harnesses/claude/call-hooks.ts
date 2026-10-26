import { isAbsolute } from "node:path"
import { z } from "zod"
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import type { CallBounds } from "../call-bounds.js"

/** Claude's tools that write the one file their input names. */
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

/** What the hooks read of a tool's input: the file it writes, and whether it leaves work running. */
const ToolInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  run_in_background: z.boolean().optional(),
})

export interface ClaudeCallHooks {
  pre: HookCallback
  post: HookCallback
}

/**
 * Claude's PreToolUse and PostToolUse hooks as a call's exact bounds
 * (`CallBounds`). Claude runs PreToolUse before asking for approval and
 * reports with PostToolUse how long the tool itself ran, so the start is the
 * later of the two. Each answers at once and changes nothing: the person's
 * own hooks on the same events run beside them as before. A subagent's calls
 * come through too (`agent_id`), which the stream never shows.
 */
export function claudeCallHooks(bounds: CallBounds): ClaudeCallHooks {
  return {
    pre: async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {}
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
