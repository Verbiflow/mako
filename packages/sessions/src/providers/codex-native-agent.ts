import { z } from "zod"
import type { NativeAgentOrigin } from "../format.js"

const AgentSource = z.object({ subagent: z.union([
  z.string().transform((role): NativeAgentOrigin => ({ kind: role === "review" ? "agent" : "unknown", role })),
  z.object({ other: z.string() }).transform(({ other }): NativeAgentOrigin => ({ kind: other === "guardian" ? "internal-review" : "unknown", role: other })),
  z.object({ thread_spawn: z.object({ parent_thread_id: z.string(), agent_role: z.string().nullish() }) })
    .transform(({ thread_spawn }): NativeAgentOrigin => ({ kind: "agent", parentNativeId: thread_spawn.parent_thread_id, ...(thread_spawn.agent_role && { role: thread_spawn.agent_role }) })),
]) }).transform(({ subagent }) => subagent)

/** Parsed at the rollout/header I/O boundaries; malformed unrelated fields cannot erase a known review source. */
export const CodexAgentMetaSchema = z.object({
  thread_source: z.string().nullish().catch(undefined),
  parent_thread_id: z.string().nullish().catch(undefined),
  originator: z.string().nullish().catch(undefined),
  source: AgentSource.nullish().catch(undefined),
})
type CodexAgentMeta = z.infer<typeof CodexAgentMetaSchema>

/** Only Codex's native source identifies an internal reviewer; titles and user-selected worker roles do not. */
export function codexNativeAgent(meta: CodexAgentMeta | undefined): NativeAgentOrigin | undefined {
  if (!meta) return undefined
  const agent = meta.source, source = meta.thread_source ?? undefined
  const parentNativeId = meta.parent_thread_id ?? agent?.parentNativeId
  if (!agent && !parentNativeId && source !== "guardian_review" && source !== "subagent") return undefined
  return {
    kind: source === "guardian_review" ? "internal-review" : agent?.kind ?? "unknown",
    ...(agent?.role && { role: agent.role }), ...(source && { source }), ...(parentNativeId && { parentNativeId }),
    ...(meta.originator && { originator: meta.originator }),
  }
}
