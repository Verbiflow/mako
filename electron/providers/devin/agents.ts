import { z } from "zod"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"
import type { AcpAgentObserver } from "../acp-source.js"

const id = z.string().min(1).max(512)
const metadata = z.object({
  "cognition.ai/subagent_context": z.object({ parentAgentId: id }).optional(),
  "cognition.ai/subagent_started": z.object({
    agentId: id, title: z.string(), profile: z.string().optional(),
    model: z.string().optional(), isBackground: z.boolean(),
  }).optional(),
  "cognition.ai/subagent_completed": z.object({
    agentId: id, success: z.boolean(), summary: z.string().optional(),
  }).optional(),
  "cognition.ai/inferenceToolName": z.string().optional(),
})
const resumeInput = z.object({ resume: id, title: z.string().optional() })

interface Child {
  observation: NativeAgentObservation
  /** Unkeyed completion is authoritative only for a child's first execution. */
  resumed: boolean
  invocation?: { id: string; foreground: boolean; started: boolean; previous?: Child }
}

/** Devin 3000.6.14's negotiated ACP extension; never infer completion from parent idle. */
export class DevinAgents implements AcpAgentObserver {
  private readonly children = new Map<string, Child>()
  private readonly resumes = new Map<string, string>()
  private disposed = false
  private readonly input: { nativeId: string; publish(agent: NativeAgentObservation): void }

  constructor(input: { nativeId: string; observedAgents?: readonly NativeAgentObservation[]; publish(agent: NativeAgentObservation): void }) {
    this.input = input
    for (const observation of input.observedAgents ?? []) {
      this.children.set(observation.nativeId, { observation, resumed: true })
    }
  }

  observe(notification: SessionNotification): "child" | undefined {
    if (this.disposed || notification.sessionId !== this.input.nativeId) return
    const update = notification.update
    const rawMeta = update._meta
    const parsed = metadata.safeParse(rawMeta ?? {})
    // Even malformed child extensions must never leak child text/control into
    // the parent. Validate their values separately before changing any state.
    const nested = Boolean(rawMeta && [
      "cognition.ai/subagent_context", "cognition.ai/subagent_started", "cognition.ai/subagent_completed",
    ].some(key => Object.hasOwn(rawMeta, key)))
    if (!parsed.success) return nested ? "child" : undefined
    const meta = parsed.data
    const started = meta["cognition.ai/subagent_started"]
    const completed = meta["cognition.ai/subagent_completed"]
    const context = meta["cognition.ai/subagent_context"]
    if (started) {
      if (update.sessionUpdate !== "tool_call_update" || update.toolCallId !== started.agentId || update.status !== "in_progress") return "child"
      const previous = this.children.get(started.agentId)
      if (previous && !previous.invocation) return "child" // Duplicate/late start cannot revive an old execution.
      const child: Child = previous ?? {
        resumed: false,
        observation: { nativeId: started.agentId, nativeRunId: started.agentId, parentNativeId: this.input.nativeId, title: started.title.slice(0, 512), state: { kind: "working" } },
      }
      if (child.invocation) {
        child.invocation.foreground = !started.isBackground
        child.invocation.started = true
      }
      child.observation = {
        ...child.observation,
        model: started.model?.slice(0, 256), role: started.profile?.slice(0, 256),
        state: { kind: "working" },
      }
      this.publish(child)
      return "child"
    }
    if (completed) {
      if (update.sessionUpdate !== "tool_call_update" || update.toolCallId !== completed.agentId ||
        (update.status !== "completed" && update.status !== "failed")) return "child"
      const child = this.children.get(completed.agentId)
      // This native event carries no invocation ID. After reuse, only the
      // matching foreground run_subagent result can settle the current run.
      if (child && !child.resumed && child.observation.state.kind === "working") {
        child.observation = { ...child.observation, state: completed.success
          ? { kind: "completed", summary: completed.summary?.slice(0, 8192) }
          : { kind: "failed", error: completed.summary?.slice(0, 8192) || "Native child failed" } }
        this.publish(child)
      }
      return "child"
    }
    // Nested children can themselves invoke run_subagent. Their explicit
    // resume identity is just as authoritative as a top-level call's.
    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      (meta["cognition.ai/inferenceToolName"] === "run_subagent" || this.resumes.has(update.toolCallId))) {
      const args = resumeInput.safeParse(update.rawInput)
      if (args.success && id.safeParse(update.toolCallId).success && !this.resumes.has(update.toolCallId)) {
        const previous = this.children.get(args.data.resume)
        const child: Child = {
          resumed: true,
          invocation: { id: update.toolCallId, foreground: false, started: false, previous },
          observation: {
            ...previous?.observation,
            nativeId: args.data.resume, nativeRunId: update.toolCallId, toolId: update.toolCallId,
            parentNativeId: context?.parentAgentId ?? this.input.nativeId,
            title: args.data.title?.slice(0, 512) ?? previous?.observation.title ?? "Subagent",
            state: { kind: "working" },
          },
        }
        this.resumes.set(update.toolCallId, args.data.resume)
        this.publish(child)
      }
      const nativeId = this.resumes.get(update.toolCallId)
      const child = nativeId ? this.children.get(nativeId) : undefined
      if (child?.invocation?.id === update.toolCallId && update.status === "failed" && !child.invocation.started) {
        // Exact native rejection settles this admission attempt, not any work
        // that existed before it. In particular, reconnect history is not
        // evidence that an older child stopped.
        const previous = child.invocation.previous
        if (previous && !["completed", "failed", "canceled"].includes(previous.observation.state.kind)) {
          this.publish(previous)
        } else {
          child.observation = { ...child.observation, state: { kind: "failed", error: "Native child invocation was rejected" } }
          child.invocation = undefined
          this.publish(child)
        }
      } else if (child?.invocation?.id === update.toolCallId && child.invocation.foreground &&
        (!child.invocation.previous || ["completed", "failed", "canceled"].includes(child.invocation.previous.observation.state.kind)) &&
        (update.status === "completed" || update.status === "failed")) {
        child.observation = { ...child.observation, state: update.status === "completed"
          ? { kind: "completed" } : { kind: "failed", error: "Native child invocation failed" } }
        child.invocation = undefined
        this.publish(child)
      }
    }
    return nested ? "child" : undefined
  }

  dispose(): void { this.disposed = true; this.children.clear(); this.resumes.clear() }

  private publish(child: Child): void {
    this.children.set(child.observation.nativeId, child)
    this.input.publish(child.observation)
    // Retain active work; prune only historical duplicate guards.
    if (this.children.size > 1024) {
      const old = [...this.children].find(([, value]) => ["completed", "failed", "canceled"].includes(value.observation.state.kind))
      if (old) this.children.delete(old[0])
    }
    if (this.resumes.size > 1024) {
      const old = [...this.resumes].find(([call, nativeId]) => this.children.get(nativeId)?.invocation?.id !== call)
      if (old) this.resumes.delete(old[0])
    }
  }
}
