import { CodexAgentStatus, type CodexAgentRun } from "./agent-status.js"
import { z } from "zod"
import type { ThreadItem } from "./generated/v2/ThreadItem.js"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

export const CodexAgentItemSchema = z.object({
  type: z.literal("collabAgentToolCall"),
  id: z.string(),
  tool: z.enum([
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "wait",
    "closeAgent",
  ]),
  status: z.enum(["inProgress", "completed", "failed"]),
  senderThreadId: z.string(),
  receiverThreadIds: z.array(z.string()).max(256),
  prompt: z.string().nullable(),
  model: z.string().nullable(),
  agentsStates: z.record(
    z.string(),
    z
      .object({
        status: z.enum([
          "pendingInit",
          "running",
          "interrupted",
          "completed",
          "errored",
          "shutdown",
          "notFound",
        ]),
        message: z.string().nullable(),
      })
      .optional()
  ),
}) satisfies z.ZodType<
  Omit<Extract<ThreadItem, { type: "collabAgentToolCall" }>, "reasoningEffort">
>
// The checked-in generated baseline predates the additive completed activity.
// Verified in the installed 0.154.0 native records and upstream completion emitter.
export const CodexAgentActivitySchema = z.object({
  type: z.literal("subAgentActivity"),
  id: z.string(),
  kind: z.enum(["started", "interacted", "interrupted", "completed"]),
  agentThreadId: z.string(),
  agentPath: z.string(),
}) satisfies z.ZodType<Omit<Extract<ThreadItem, { type: "subAgentActivity" }>, "kind"> & { kind: "started" | "interacted" | "interrupted" | "completed" }>
export type CodexAgentItem =
  | z.infer<typeof CodexAgentItemSchema>
  | z.infer<typeof CodexAgentActivitySchema>

function nativeState(
  state: NonNullable<
    z.infer<typeof CodexAgentItemSchema>["agentsStates"][string]
  >
): NativeAgentObservation["state"] {
  const message = state.message?.slice(0, 8192)
  switch (state.status) {
    case "pendingInit":
      return { kind: "waiting", reason: "Starting agent" }
    case "running":
      return { kind: "working", activity: message }
    case "completed":
      return { kind: "completed", summary: message }
    case "errored":
      return { kind: "failed", error: message ?? "Agent failed" }
    case "interrupted":
    case "shutdown":
      return { kind: "canceled" }
    case "notFound":
      return { kind: "unknown", reason: "Provider could not find this agent" }
  }
}

export class CodexAgents {
  private readonly agents = new Map<string, NativeAgentObservation>()
  private readonly status?: CodexAgentStatus
  constructor(source?: {
    read(nativeId: string): Promise<CodexAgentRun | null>
    publish(agent: NativeAgentObservation): void
  }) {
    if (source) this.status = new CodexAgentStatus({
      read: source.read,
      publish: (nativeId, run) => {
        const previous = this.agents.get(nativeId)
        if (!previous) return
        const agent: NativeAgentObservation = {
          ...previous,
          nativeRunId: run.id,
          state: run.status === "inProgress" ? { kind: "working" }
            : run.status === "completed" ? { kind: "completed" }
            : run.status === "interrupted" ? { kind: "canceled" }
            : { kind: "failed", error: "Agent turn failed" },
        }
        this.agents.set(nativeId, agent)
        source.publish(agent)
      },
    })
  }
  restore(agents: readonly NativeAgentObservation[]): void {
    for (const agent of agents.slice(0, 256)) {
      this.agents.set(agent.nativeId, {
        ...agent,
        state: { kind: "unknown", reason: "Rechecking child after reconnect." },
      })
      this.status?.observe(agent.nativeId)
    }
  }
  dispose(): void { this.status?.dispose() }
  refresh(nativeId: string): void {
    if (this.agents.has(nativeId)) this.status?.observe(nativeId)
  }
  project(item: CodexAgentItem, replay: boolean): NativeAgentObservation[] {
    const updates = new Map<string, NativeAgentObservation>()
    const add = (agent: NativeAgentObservation) => {
      const observed: NativeAgentObservation =
        replay &&
        (agent.state.kind === "working" || agent.state.kind === "waiting")
          ? {
              ...agent,
              state: {
                kind: "unknown",
                reason:
                  "Historical agent status; current activity is not confirmed.",
              },
            }
          : agent
      this.agents.set(agent.nativeId, observed)
      updates.set(agent.nativeId, observed)
      if (!replay) this.status?.observe(agent.nativeId)
    }
    if (item.type === "subAgentActivity") {
      if (item.kind === "interacted") {
        if (!replay && this.agents.has(item.agentThreadId)) this.status?.observe(item.agentThreadId)
        return []
      }
      const previous = this.agents.get(item.agentThreadId)
      add({
        ...previous,
        nativeId: item.agentThreadId,
        title: previous?.title ?? item.agentPath.slice(0, 512),
        toolId: previous?.toolId ?? item.id,
        nativeRunId: item.kind === "started" ? undefined : previous?.nativeRunId,
        state: item.kind === "started" ? { kind: "working" }
          : item.kind === "completed" || this.status
            ? previous?.state ?? { kind: "unknown", reason: "Awaiting current child turn evidence." }
            : { kind: "canceled" },
      })
    } else {
      if (item.tool === "spawnAgent" || item.tool === "resumeAgent") {
        for (const nativeId of item.receiverThreadIds) {
          const previous = this.agents.get(nativeId)
          add({
            ...previous,
            nativeId,
            parentNativeId: item.senderThreadId,
            title: previous?.title ?? item.prompt?.slice(0, 512) ?? "Agent",
            model: item.model?.slice(0, 256) ?? previous?.model,
            toolId: previous?.toolId ?? item.id,
            state:
              item.status === "failed"
                ? { kind: "failed", error: "Agent launch failed" }
                : { kind: "working" },
          })
        }
      }
      for (const [nativeId, state] of Object.entries(item.agentsStates).slice(
        0,
        256
      )) {
        if (!state) continue
        const previous = this.agents.get(nativeId)
        add({
          ...previous,
          nativeId,
          title: previous?.title ?? "Agent",
          parentNativeId: previous?.parentNativeId ?? item.senderThreadId,
          state: nativeState(state),
        })
      }
    }
    while (this.agents.size > 1024) {
      const oldest = this.agents.keys().next().value
      if (!oldest) break
      this.agents.delete(oldest)
      this.status?.forget(oldest)
    }
    return [...updates.values()]
  }
}
