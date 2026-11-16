import type { SDKMessage, SDKTaskStartedMessage } from "@anthropic-ai/claude-agent-sdk"
import type { NativeAgentObservation, NativeWork } from "../../contracts/native-agents.js"
import { claudeTaskCause } from "@mako/sessions/harnesses"
import { z } from "zod"

const KEPT = 1024
/**
 * The end of a settled command's output the roster keeps. The roster is
 * journaled whole on each change, so this stays small; the transcript's
 * event line carries the longer tail.
 */
const OUTPUT_KEPT = 2048
/** What a tool that starts a task runs: Bash's and Monitor's command, an Agent's prompt. */
const ToolInputSchema = z.object({ command: z.string(), prompt: z.string() }).partial()
type ToolInput = z.infer<typeof ToolInputSchema>
const settledKinds = new Set(["completed", "failed", "canceled", "unknown"])

/**
 * The roster of what Claude runs besides its turn, from the SDK's task
 * events: subagents and workflows, and the commands and monitors it left
 * running in the background. A foreground command is part of its turn
 * and stays a tool row; one a subagent runs belongs to that subagent,
 * whose progress counts it.
 *
 * `task_started`, `task_progress`, `task_updated` and `task_notification`
 * are edges; `background_tasks_changed` is the level. A background entry
 * the level stops listing and no notification settles (a missed end)
 * settles as unknown at the next level or turn end, so the roster cannot
 * wedge on "working".
 *
 * Claude Code 2.1.29x reports a Monitor as a `local_bash` task, so the
 * kind comes from the tool that started it, read off the assistant's
 * `tool_use` blocks.
 */
export class ClaudeAgents {
  private readonly agents = new Map<string, NativeAgentObservation>()
  /** Tasks seen but not listed (a foreground command): kept so a later move to the background can list them. */
  private readonly unlisted = new Map<string, SDKTaskStartedMessage>()
  /** Tasks a subagent runs; their notifications are the subagent's, not the session's. */
  private readonly owned = new Set<string>()
  /** Tool name and input summary by tool use id, for the tasks those calls start. */
  private readonly tools = new Map<string, { name: string; detail?: string }>()
  /** Background entries the level stopped listing, settled if nothing else does first. */
  private dropped = new Set<string>()

  constructor(observed: readonly NativeAgentObservation[] = []) {
    for (const agent of observed) this.agents.set(agent.nativeId, agent)
  }

  get(taskId: string): NativeAgentObservation | undefined {
    return this.agents.get(taskId)
  }

  /** The task belongs to a subagent; its end is not the session's news. */
  ownedBySubagent(taskId: string): boolean {
    return this.owned.has(taskId)
  }

  /** The end of a settled command's or monitor's output, once the driver has read it. */
  withOutput(taskId: string, output: string): NativeAgentObservation | undefined {
    const previous = this.agents.get(taskId)
    if (!previous || !output) return undefined
    return this.remember({ ...previous, output: output.slice(-OUTPUT_KEPT) })
  }

  project(message: SDKMessage): NativeAgentObservation[] {
    if (message.type === "assistant") {
      const named: NativeAgentObservation[] = []
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue
        this.tool(block.id, block.name, ToolInputSchema.safeParse(block.input).data)
        // With partial messages on, the task can start before its call's
        // block arrives whole: the block then names what the task is.
        for (const agent of this.agents.values()) {
          if (agent.toolId !== block.id) continue
          const work = this.work(undefined, block.id, agent.work === "agent")
          const detail = agent.detail ?? this.tools.get(block.id)?.detail
          if ((work !== "task" && work !== agent.work) || detail !== agent.detail)
            named.push(this.remember({ ...agent, ...(work !== "task" && { work }), ...(detail && { detail }) }))
        }
      }
      return named
    }
    if (message.type === "result") return this.settleDropped()
    if (message.type !== "system") return []
    switch (message.subtype) {
      case "task_started":
        return this.started(message)
      case "task_progress": {
        const previous = this.agents.get(message.task_id)
        if (!previous || settledKinds.has(previous.state.kind)) return []
        if (message.tool_use_id && previous.toolId && message.tool_use_id !== previous.toolId) return []
        return [this.remember({
          ...previous,
          role: message.subagent_type?.slice(0, 256) ?? previous.role,
          state: {
            kind: "working",
            // The progress `description` says what the task does now
            // ("Running …"); the entry keeps the name it started with.
            activity: (message.summary ?? message.description ?? message.last_tool_name)?.slice(0, 8192),
          },
          usage: {
            tokens: message.usage.total_tokens,
            toolUses: message.usage.tool_uses,
            durationMs: message.usage.duration_ms,
          },
        })]
      }
      case "task_notification": {
        this.dropped.delete(message.task_id)
        const previous = this.agents.get(message.task_id)
        if (!previous) return []
        if (message.tool_use_id && previous.toolId && message.tool_use_id !== previous.toolId) return []
        // An agent's summary is its report; a command's or monitor's is
        // Claude's sentence about it, which the entry says in its own words.
        const sentence = previous.work === "command" || previous.work === "monitor"
        const cause = sentence ? claudeTaskCause(message.summary, message.status) : undefined
        const exit = cause?.kind === "command" && cause.exitCode !== undefined ? `Exited with code ${cause.exitCode}` : undefined
        const summary = sentence ? exit : message.summary.slice(0, 8192)
        return [this.remember({
          ...previous,
          ...(message.ambient !== undefined && { ambient: message.ambient }),
          stoppable: false,
          state:
            message.status === "completed" && !(cause?.kind === "command" && cause.outcome === "failed")
              ? { kind: "completed", ...(summary && { summary }) }
              : message.status === "completed" || message.status === "failed"
                ? { kind: "failed", error: summary || message.summary.slice(0, 8192) || "The task failed" }
                : message.reason === "worker_restart"
                  ? { kind: "unknown", reason: "Claude restarted and found the task orphaned" }
                  : { kind: "canceled" },
          usage: message.usage
            ? {
                tokens: message.usage.total_tokens,
                toolUses: message.usage.tool_uses,
                durationMs: message.usage.duration_ms,
              }
            : previous.usage,
        })]
      }
      case "task_updated":
        return this.updated(message.task_id, message.patch)
      case "background_tasks_changed":
        return this.level(message.tasks)
      default:
        return []
    }
  }

  private tool(id: string, name: string, input: ToolInput | undefined): void {
    const detail = input?.command ?? input?.prompt
    this.tools.set(id, { name, ...(detail && { detail: detail.slice(0, 2048) }) })
    if (this.tools.size > KEPT) this.tools.delete(this.tools.keys().next().value!)
  }

  private work(taskType: string | undefined, toolId: string | undefined, subagent: boolean): NativeWork {
    const tool = toolId ? this.tools.get(toolId)?.name : undefined
    if (tool === "Monitor" || taskType === "monitor") return "monitor"
    if (taskType === "local_agent" || subagent) return "agent"
    if (taskType === "local_workflow") return "workflow"
    if (taskType === "local_bash") return "command"
    return "task"
  }

  private started(message: SDKTaskStartedMessage): NativeAgentObservation[] {
    if ("owned_by_subagent" in message && message.owned_by_subagent === true) {
      this.owned.add(message.task_id)
      if (this.owned.size > KEPT) this.owned.delete(this.owned.values().next().value!)
      return []
    }
    const work = this.work(message.task_type, message.tool_use_id, Boolean(message.subagent_type))
    // A command or task in the foreground is its tool row; it joins the
    // roster if it moves to the background.
    if (!message.is_backgrounded && work !== "agent" && work !== "workflow" && work !== "monitor" && !this.agents.has(message.task_id)) {
      this.unlisted.set(message.task_id, message)
      if (this.unlisted.size > KEPT) this.unlisted.delete(this.unlisted.keys().next().value!)
      return []
    }
    return [this.list(message, work, "task_started")]
  }

  private list(message: SDKTaskStartedMessage, work: NativeWork, source: string): NativeAgentObservation {
    const previous = this.agents.get(message.task_id)
    const detail = message.prompt ?? (message.tool_use_id ? this.tools.get(message.tool_use_id)?.detail : undefined)
    return this.remember({
      ...previous,
      nativeId: message.task_id,
      title: (message.workflow_name ?? message.description).slice(0, 512) || previous?.title || "Background task",
      toolId: message.tool_use_id ?? previous?.toolId,
      role: message.subagent_type?.slice(0, 256) ?? previous?.role,
      work,
      ...(detail && { detail: detail.slice(0, 8192) }),
      background: message.is_backgrounded ?? previous?.background,
      ...((message.ambient ?? previous?.ambient) !== undefined && { ambient: message.ambient ?? previous?.ambient }),
      stoppable: true,
      source: `claude ${source} ${message.task_type ?? "task"}`.slice(0, 256),
      state: { kind: "working" },
    })
  }

  private updated(taskId: string, patch: Extract<SDKMessage, { subtype: "task_updated" }>["patch"]): NativeAgentObservation[] {
    const pending = this.unlisted.get(taskId)
    if (pending && patch.is_backgrounded) {
      this.unlisted.delete(taskId)
      this.list({ ...pending, is_backgrounded: true }, this.work(pending.task_type, pending.tool_use_id, Boolean(pending.subagent_type)), "task_updated")
    }
    const previous = this.agents.get(taskId)
    if (!previous) return []
    const active = !settledKinds.has(previous.state.kind)
    if (!active && (patch.status === "pending" || patch.status === "running" || patch.status === "paused")) return []
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
        state = previous.state.kind === "completed" ? previous.state : { kind: "completed" }
        break
      case "failed":
        state = { kind: "failed", error: patch.error?.slice(0, 8192) ?? "The task failed" }
        break
      case "killed":
        state = { kind: "canceled" }
        break
      case undefined:
        break
    }
    return [this.remember({
      ...previous,
      title: patch.description?.slice(0, 512) ?? previous.title,
      ...(patch.is_backgrounded !== undefined && { background: patch.is_backgrounded }),
      ...(settledKinds.has(state.kind) && { stoppable: false }),
      state,
    })]
  }

  /** The level: every live background task. Names what the edges missed, flags ambient changes, and marks what it dropped. */
  private level(tasks: Extract<SDKMessage, { subtype: "background_tasks_changed" }>["tasks"]): NativeAgentObservation[] {
    const changed = this.settleDropped()
    const listed = new Set(tasks.map((task) => task.task_id))
    for (const task of tasks) {
      const previous = this.agents.get(task.task_id)
      const pending = this.unlisted.get(task.task_id)
      if (!previous) {
        this.unlisted.delete(task.task_id)
        const started: SDKTaskStartedMessage = pending ?? {
          type: "system", subtype: "task_started", task_id: task.task_id, description: task.description,
          task_type: task.task_type, uuid: "00000000-0000-0000-0000-000000000000", session_id: "",
        }
        changed.push(this.list({ ...started, is_backgrounded: true, ambient: task.ambient }, this.work(task.task_type, started.tool_use_id, Boolean(started.subagent_type)), "background_tasks_changed"))
      } else if (Boolean(previous.ambient) !== Boolean(task.ambient) && !settledKinds.has(previous.state.kind))
        changed.push(this.remember({ ...previous, ambient: Boolean(task.ambient) }))
    }
    for (const [id, agent] of this.agents)
      if (agent.background && !listed.has(id) && !settledKinds.has(agent.state.kind)) this.dropped.add(id)
    return changed
  }

  private settleDropped(): NativeAgentObservation[] {
    const settled: NativeAgentObservation[] = []
    for (const id of this.dropped) {
      const agent = this.agents.get(id)
      if (agent && !settledKinds.has(agent.state.kind))
        settled.push(this.remember({ ...agent, stoppable: false, state: { kind: "unknown", reason: "Claude no longer lists this task and did not say how it ended." } }))
    }
    this.dropped = new Set()
    return settled
  }

  private remember(agent: NativeAgentObservation): NativeAgentObservation {
    this.agents.set(agent.nativeId, agent)
    if (this.agents.size > KEPT) {
      const oldest = this.agents.keys().next().value
      if (oldest) this.agents.delete(oldest)
    }
    return agent
  }
}
