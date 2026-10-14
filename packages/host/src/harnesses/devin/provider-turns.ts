import { z } from "zod"
import { subagentTurn } from "@mako/sessions"
import type { AcpProviderTurnObserver } from "../acp-source.js"

const SubagentMeta = z.object({
  "cognition.ai/subagent_started": z.object({ agentId: z.string(), title: z.string(), depth: z.number().optional() }).optional(),
  "cognition.ai/subagent_completed": z.object({ agentId: z.string(), success: z.boolean(), summary: z.string().optional(), depth: z.number().optional() }).optional(),
})

const AgentStoppedSchema = z.object({ sessionId: z.string(), cause: z.string() })

/**
 * Verified 2026-09-27 against devin 3000.6.14: when a background subagent of
 * the session finishes with no turn running, Devin completes the subagent's
 * call with `cognition.ai/subagent_completed`, then runs a turn on its
 * `<subagent_completion_notification>` with no prompt pending and no user
 * chunk, and ends it with `_cognition.ai/agent_stopped`, cause `complete`.
 * A cancel ends a turn with cause `cancelled`. Stopping a subagent with
 * `session/cancel` completes its call unsuccessfully and starts no turn; the
 * `agent_stopped` that follows clears the announcement. `depth` counts from
 * the session, so only a depth-1 subagent reports to it. The completion's
 * `summary` is the subagent's report, the text saved history reads from its
 * completion notification; how long it ran is measured here, from the
 * start to the completion this host saw.
 */
export function devinProviderTurns(now: () => number = Date.now): AcpProviderTurnObserver {
  const titles = new Map<string, { title: string; at: number }>()
  return {
    // Verified 2026-10-12 against devin 3000.10.23 (scripts/probe-provider-turn.mjs): a background subagent that
    // finished while its parent's turn ran was written into that turn, and the turn answered it.
    midTurn: "marker",
    updateCause({ sessionId, update }) {
      if (update.sessionUpdate !== "tool_call_update") return undefined
      const parsed = SubagentMeta.safeParse(update._meta ?? {})
      if (!parsed.success) return undefined
      const started = parsed.data["cognition.ai/subagent_started"]
      if (started) titles.set(started.agentId, { title: started.title, at: now() })
      const completed = parsed.data["cognition.ai/subagent_completed"]
      if (!completed) return undefined
      const begun = titles.get(completed.agentId)
      titles.delete(completed.agentId)
      if ((completed.depth ?? 1) > 1) return undefined
      return {
        sessionId,
        ...subagentTurn({
          description: begun?.title,
          id: completed.agentId,
          state: completed.success ? "completed" : "failed",
          durationMs: begun ? now() - begun.at : undefined,
          result: completed.summary,
        }),
      }
    },
    ended(method, params) {
      if (method !== "_cognition.ai/agent_stopped") return undefined
      const parsed = AgentStoppedSchema.safeParse(params)
      if (!parsed.success) return undefined
      return { sessionId: parsed.data.sessionId, interrupted: parsed.data.cause === "cancelled" }
    },
  }
}
