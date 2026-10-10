import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

/** SDK task events own identity; ordinary background shell/MCP tasks are not agents. */
export class ClaudeAgents {
  private readonly agents = new Map<string, NativeAgentObservation>()

  project(message: SDKMessage): NativeAgentObservation | undefined {
    if (message.type !== "system") return undefined
    if (message.subtype === "task_started") {
      if (
        message.ambient ||
        (message.task_type !== "local_agent" && !message.subagent_type)
      )
        return undefined
      return this.remember({
        nativeId: message.task_id,
        title: message.description.slice(0, 512),
        toolId: message.tool_use_id,
        role: message.subagent_type?.slice(0, 256),
        state: { kind: "working" },
      })
    }
    if (message.subtype === "task_progress") {
      const previous = this.agents.get(message.task_id)
      if (!previous && !message.subagent_type) return undefined
      if (message.tool_use_id && previous?.toolId && message.tool_use_id !== previous.toolId)
        return undefined
      if (previous && !["working", "waiting"].includes(previous.state.kind))
        return undefined
      return this.remember({
        ...previous,
        nativeId: message.task_id,
        title: message.description.slice(0, 512),
        toolId: message.tool_use_id ?? previous?.toolId,
        role: message.subagent_type?.slice(0, 256) ?? previous?.role,
        state: {
          kind: "working",
          activity: (message.summary ?? message.last_tool_name)?.slice(0, 8192),
        },
        usage: {
          tokens: message.usage.total_tokens,
          toolUses: message.usage.tool_uses,
          durationMs: message.usage.duration_ms,
        },
      })
    }
    if (message.subtype === "task_notification") {
      const previous = this.agents.get(message.task_id)
      if (!previous || message.ambient) return undefined
      if (message.tool_use_id && previous.toolId && message.tool_use_id !== previous.toolId)
        return undefined
      return this.remember({
        ...previous,
        state:
          message.status === "completed"
            ? { kind: "completed", summary: message.summary.slice(0, 8192) }
            : message.status === "failed"
              ? { kind: "failed", error: message.summary.slice(0, 8192) }
              : { kind: "canceled" },
        usage: message.usage
          ? {
              tokens: message.usage.total_tokens,
              toolUses: message.usage.tool_uses,
              durationMs: message.usage.duration_ms,
            }
          : previous.usage,
      })
    }
    if (message.subtype === "task_updated") {
      const previous = this.agents.get(message.task_id)
      if (!previous) return undefined
      const patch = message.patch
      if (!["working", "waiting"].includes(previous.state.kind) &&
        (patch.status === "pending" || patch.status === "running" || patch.status === "paused"))
        return undefined
      let state = previous.state
      switch (patch.status) {
        case "pending":
        case "paused":
          state = { kind: "waiting" }
          break
        case "running":
          state = { kind: "working" }
          break
        case "completed":
          state =
            previous.state.kind === "completed"
              ? previous.state
              : { kind: "completed" }
          break
        case "failed":
          state = {
            kind: "failed",
            error: patch.error?.slice(0, 8192) ?? "Agent failed",
          }
          break
        case "killed":
          state = { kind: "canceled" }
          break
        case undefined:
          break
      }
      return this.remember({
        ...previous,
        title: patch.description?.slice(0, 512) ?? previous.title,
        state,
      })
    }
    return undefined
  }

  private remember(agent: NativeAgentObservation): NativeAgentObservation {
    this.agents.set(agent.nativeId, agent)
    if (this.agents.size > 1024) {
      const oldest = this.agents.keys().next().value
      if (oldest) this.agents.delete(oldest)
    }
    return agent
  }
}
