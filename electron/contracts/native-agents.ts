import { z } from "zod"

export const NATIVE_AGENT_LIMIT = 256
const note = z.string().max(8192)
export const NativeAgentStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working"), activity: note.optional() }),
  z.object({ kind: z.literal("waiting"), reason: note.optional() }),
  z.object({ kind: z.literal("completed"), summary: note.optional() }),
  z.object({ kind: z.literal("failed"), error: note }),
  z.object({ kind: z.literal("canceled") }),
  z.object({ kind: z.literal("unknown"), reason: note }),
])
export const NativeAgentObservationSchema = z.object({
  nativeId: z.string().min(1).max(512),
  nativeRunId: z.string().min(1).max(512).optional(),
  title: z.string().max(512),
  parentNativeId: z.string().max(512).optional(),
  toolId: z.string().max(512).optional(),
  model: z.string().max(256).optional(),
  role: z.string().max(256).optional(),
  state: NativeAgentStateSchema,
  usage: z
    .object({
      tokens: z.number().nonnegative().optional(),
      toolUses: z.number().nonnegative().optional(),
      durationMs: z.number().nonnegative().optional(),
    })
    .optional(),
})
export type NativeAgentObservation = z.infer<
  typeof NativeAgentObservationSchema
>
export function isActiveNativeAgent(agent: NativeAgentObservation): boolean {
  return agent.state.kind === "working" || agent.state.kind === "waiting"
}
export const NativeAgentSchema = NativeAgentObservationSchema.extend({
  bindingId: z.string(),
  provider: z.string(),
  requestId: z.string().optional(),
  observedAt: z.number(),
})
export type NativeAgent = z.infer<typeof NativeAgentSchema>
export const NativeAgentRosterSchema = z.object({
  agents: z.array(NativeAgentSchema).max(NATIVE_AGENT_LIMIT),
  limited: z.boolean(),
})
export type NativeAgentRoster = z.infer<typeof NativeAgentRosterSchema>

export function observeNativeAgent(
  roster: NativeAgentRoster | undefined,
  agent: NativeAgent
): NativeAgentRoster {
  const agents = [...(roster?.agents ?? [])]
  const index = agents.findIndex(
    (current) =>
      current.bindingId === agent.bindingId &&
      current.nativeId === agent.nativeId
  )
  if (index >= 0)
    agents[index] = {
      ...agent,
      requestId: agents[index]?.requestId ?? agent.requestId,
    }
  else agents.push(agent)
  let limited = roster?.limited ?? false
  if (agents.length > NATIVE_AGENT_LIMIT) {
    const settled = agents.findIndex((current) =>
      ["completed", "failed", "canceled", "unknown"].includes(
        current.state.kind
      )
    )
    agents.splice(settled >= 0 ? settled : 0, 1)
    limited = true
  }
  return { agents, limited }
}

/** Losing observation is not evidence that provider-owned work completed. */
export function disconnectNativeAgents(
  roster: NativeAgentRoster | undefined,
  bindingId?: string
): NativeAgentRoster | undefined {
  if (!roster) return roster
  let changed = false
  const agents = roster.agents.map((agent): NativeAgent => {
    if (
      (bindingId && agent.bindingId !== bindingId) ||
      !["working", "waiting"].includes(agent.state.kind)
    )
      return agent
    changed = true
    return {
      ...agent,
      state: {
        kind: "unknown",
        reason: "Connection ended; current agent status is unavailable.",
      },
    }
  })
  return changed ? { ...roster, agents } : roster
}
