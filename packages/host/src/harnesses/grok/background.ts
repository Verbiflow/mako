import { z } from "zod"
import type { AcpBackgroundObserver } from "../acp-source.js"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

/**
 * Verified 2026-09-26 against grok 1.0.41: an `is_background` command is
 * reported through `_x.ai/session_notification` as a `background_tasks`
 * update carrying every task of the session with its status, again when one
 * finishes. Grok then starts its own turn to read the output. Each task
 * names itself (`task_id`, `command`, `description`, `kind` `bash` or
 * `monitor`), as the updates Grok 1.0.46 keeps in its own store do.
 */
const GrokBackgroundTask = z.object({
  status: z.string(),
  task_id: z.string().nullish(),
  command: z.string().nullish(),
  display_command: z.string().nullish(),
  description: z.string().nullish(),
  kind: z.string().nullish(),
  exit_code: z.number().nullish(),
  signal: z.string().nullish(),
})
export const GrokBackgroundTasksSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("background_tasks"),
    tasks: z.array(GrokBackgroundTask),
  }),
})

function observation(task: z.infer<typeof GrokBackgroundTask>, id: string): NativeAgentObservation {
  const command = (task.display_command ?? task.command ?? "").slice(0, 8192)
  const ended = task.signal ? `Ended by ${task.signal}` : task.exit_code !== null && task.exit_code !== undefined ? `Exited with code ${task.exit_code}` : undefined
  return {
    nativeId: id,
    title: (task.description || command || "Background task").slice(0, 512),
    work: task.kind === "monitor" ? "monitor" : "command",
    ...(command && { detail: command }),
    background: true,
    // `_x.ai/task/kill` ends one, but Grok always queues a turn about the
    // kill, and that turn has re-run the command the user stopped.
    stoppable: false,
    source: "grok background_tasks",
    state: task.status === "running"
      ? { kind: "working" }
      : task.status === "failed"
        ? { kind: "failed", error: ended ?? "The task failed" }
        : task.status === "completed"
          ? { kind: "completed", ...(ended && { summary: ended }) }
          : { kind: "canceled" },
  }
}

/**
 * Grok's background tasks: the count of running ones, and each task as a
 * roster entry when its status moves. Every report is the whole list,
 * finished tasks included, so only what changed is observed again.
 */
export function grokBackground(): AcpBackgroundObserver {
  const seen = new Map<string, string>()
  return {
    extension(method, params) {
      if (method !== "_x.ai/session_notification") return undefined
      const parsed = GrokBackgroundTasksSchema.safeParse(params)
      if (!parsed.success) return undefined
      const items: NativeAgentObservation[] = []
      for (const task of parsed.data.update.tasks) {
        if (!task.task_id) continue
        const key = `${task.status}\0${task.exit_code ?? ""}\0${task.signal ?? ""}`
        if (seen.get(task.task_id) === key) continue
        seen.set(task.task_id, key)
        if (seen.size > 1024) seen.delete(seen.keys().next().value!)
        items.push(observation(task, task.task_id))
      }
      return {
        sessionId: parsed.data.sessionId,
        running: parsed.data.update.tasks.filter((task) => task.status === "running").length,
        items,
      }
    },
    /**
     * Checked on grok 1.0.41: `session/close` ends every task and the resumed
     * session keeps its context, with no turn after it. `_x.ai/task/kill` ends
     * one but always queues a turn about the kill, even when it lands before
     * the cancel, and that turn has re-run the command the user stopped.
     */
    async stop(control) {
      if (control.running) await control.reopen()
    },
  }
}
