import type { AcpBlock } from "@/lib/acp-blocks"
import { liveToolName } from "@/lib/tools"

export type AgentActivityKind = "working" | "connecting" | "reasoning" | "searching" | "executing" | "editing" | "responding" | "waiting" | "failed" | "complete" | "idle"

export interface AgentActivity {
  kind: AgentActivityKind
  label: string
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

export function agentActivity({ blocks, waiting, connecting, preparing, quietForMs = 0 }: { blocks: readonly AcpBlock[]; waiting: boolean; connecting: boolean; preparing: boolean; quietForMs?: number }): AgentActivity {
  if (waiting) return { kind: "waiting", label: "Waiting for your approval" }
  if (connecting) return { kind: "connecting", label: "Connecting" }
  if (preparing) return { kind: "connecting", label: "Sending" }
  const quiet = quietForMs >= QUIET_AFTER_MS ? `No output for ${quietDuration(quietForMs)}` : undefined
  const tool = blocks.findLast((block) => block.type === "tool" && block.status === "pending")
  if (tool?.type === "tool") return { kind: toolActivity(liveToolName(tool.toolKind, tool.title)), label: quiet ? `${quiet} · ${tool.title}` : tool.title }
  const last = blocks.at(-1)
  if (last?.type === "thinking" && last.text.length > 0) return { kind: "reasoning", label: quiet ?? "Reasoning" }
  if (last?.type === "text" && last.text.length > 0) return quiet ? { kind: "working", label: quiet } : { kind: "responding", label: "Responding" }
  return { kind: "working", label: quiet ?? "Working" }
}

function quietDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}
