import type { AcpBlock } from "@/lib/acp-blocks"
import { liveToolName } from "@/lib/tools"
import type { NativeActivity } from "@/lib/types"

export type AgentActivityKind = "working" | "connecting" | "reasoning" | "searching" | "executing" | "editing" | "responding" | "waiting" | "failed" | "complete" | "idle"

export interface AgentActivity {
  kind: AgentActivityKind
  label: string
  /** Quieter words after the label. */
  detail?: string
  /**
   * Set when the provider itself reported what the turn is doing, rather
   * than Mako reading it from output: host epoch ms it began, and the row
   * counts up from it. Primitive fields keep the activity `shallowEqual`.
   */
  since?: number
  /** Host epoch ms of the provider's next attempt; the row counts down to it. */
  retryAt?: number
}

/**
 * How long a running turn goes without output before it reads as quiet.
 * Models reason silently and tools run long, so a quiet turn is reported,
 * never ended or sent again.
 */
export const QUIET_AFTER_MS = 60_000

export function toolActivity(name: string): AgentActivityKind {
  const tool = name.toLowerCase().split(".").at(-1)
  if (["edit", "write", "apply_patch", "multiedit", "delete", "move", "write_file"].includes(tool ?? "")) return "editing"
  if (["grep", "glob", "rg", "find", "read", "readfile", "read_file", "websearch", "web_search", "webfetch", "ls"].includes(tool ?? "")) return "searching"
  return "executing"
}

export function agentActivity({ blocks, waiting, connecting, makingWorktree = false, preparing, quietForMs = 0, native }: { blocks: readonly AcpBlock[]; waiting: boolean; connecting: boolean; makingWorktree?: boolean; preparing: boolean; quietForMs?: number; native?: NativeActivity }): AgentActivity {
  if (waiting) return { kind: "waiting", label: "Waiting for your approval" }
  if (connecting) return { kind: "connecting", label: makingWorktree ? "Making a worktree" : "Connecting" }
  if (preparing) return { kind: "connecting", label: "Sending" }
  if (native) return nativeAgentActivity(native)
  const quiet = quietForMs >= QUIET_AFTER_MS ? `No output for ${quietDuration(quietForMs)}` : undefined
  const tool = blocks.findLast((block) => block.type === "tool" && block.status === "pending")
  if (tool?.type === "tool") return { kind: toolActivity(liveToolName(tool.toolKind, tool.title)), label: quiet ? `${quiet} · ${tool.title}` : tool.title }
  const last = blocks.at(-1)
  if (last?.type === "thinking" && last.text.length > 0) return { kind: "reasoning", label: quiet ?? "Reasoning" }
  if (last?.type === "text" && last.text.length > 0) return quiet ? { kind: "working", label: quiet } : { kind: "responding", label: "Responding" }
  return { kind: "working", label: quiet ?? "Working" }
}

function nativeAgentActivity(activity: NativeActivity): AgentActivity {
  switch (activity.kind) {
    case "compacting":
      return { kind: "working", label: "Compacting context", detail: "Making room to continue", since: activity.since }
    case "retrying": {
      const attempt = activity.attempt
        ? activity.maxAttempts ? `attempt ${activity.attempt} of ${activity.maxAttempts}` : `attempt ${activity.attempt}`
        : undefined
      const detail = [attempt, activity.reason].filter(Boolean).join(" · ") || undefined
      return { kind: "working", label: "Retrying", detail, since: activity.since, retryAt: activity.retryAt }
    }
    case "waiting":
      return { kind: "working", label: activity.label, since: activity.since }
  }
}

function quietDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}
