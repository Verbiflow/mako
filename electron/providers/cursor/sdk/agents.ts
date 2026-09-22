import { z } from "zod"
import type { NativeAgentObservation } from "../../../contracts/native-agents.js"
import type { SdkMessage } from "./wire.js"

const taskArgs = z.object({
  agentId: z.string().min(1).max(512),
  description: z.string(),
  model: z.string().optional(),
  subagentType: z.object({ kind: z.string(), name: z.string().optional() }).optional(),
})
const taskResult = z.object({
  status: z.literal("success"),
  value: z.object({
    agentId: z.string().optional(),
    isBackground: z.boolean(),
  }),
})

/** Native Task identity and invocation bookends, not enclosing SDK task/status messages. */
export class CursorAgents {
  private readonly agents = new Map<string, NativeAgentObservation>()
  private readonly calls = new Map<string, string>()

  project(message: SdkMessage): NativeAgentObservation | undefined {
    if (message.type !== "tool_call" || message.name !== "task") return undefined
    if (!message.call_id || message.call_id.length > 512 || message.truncated?.args) return undefined
    const args = taskArgs.safeParse(message.args)
    const nativeId = this.calls.get(message.call_id) ?? (args.success ? args.data.agentId : undefined)
    if (!nativeId) return undefined
    const previous = this.agents.get(nativeId)
    const knownCall = this.calls.has(message.call_id)
    if (previous && previous.toolId !== message.call_id &&
      (knownCall || message.status !== "running")) return undefined
    // Duplicate running bookends cannot revive an invocation already settled.
    if (knownCall && previous?.toolId === message.call_id &&
      !["working", "waiting"].includes(previous.state.kind) && message.status === "running") return undefined
    const title = args.success ? args.data.description.slice(0, 512) : previous?.title
    if (title === undefined) return undefined
    let state: NativeAgentObservation["state"] = { kind: "working" }
    if (message.status === "completed") {
      const result = taskResult.safeParse(message.result)
      if (!result.success || message.truncated?.result ||
        (result.data.value.agentId && result.data.value.agentId !== nativeId)) return undefined
      if (result.data.value.isBackground && previous?.toolId === message.call_id &&
        !["working", "waiting"].includes(previous.state.kind)) return undefined
      // A successful background launch is not completion of the child.
      if (!result.data.value.isBackground) state = { kind: "completed" }
    } else if (message.status === "error") {
      // A tool transport error cannot prove that its child stopped.
      return undefined
    }
    const agent: NativeAgentObservation = {
      ...previous,
      nativeId,
      parentNativeId: message.agent_id,
      // The native Task call identifies this child invocation; run_id is the parent run.
      nativeRunId: message.call_id,
      toolId: message.call_id,
      title,
      model: args.success ? args.data.model?.slice(0, 256) : previous?.model,
      role: args.success ? args.data.subagentType?.kind.slice(0, 256) : previous?.role,
      state,
    }
    this.calls.set(message.call_id, nativeId)
    this.agents.set(nativeId, agent)
    if (this.calls.size > 1024) {
      const oldest = this.calls.keys().next().value
      if (oldest) this.calls.delete(oldest)
    }
    if (this.agents.size > 1024) {
      const oldest = this.agents.keys().next().value
      if (oldest) this.agents.delete(oldest)
    }
    return agent
  }
}
