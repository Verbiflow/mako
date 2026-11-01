import { z } from "zod"

export const NATIVE_AGENT_LIMIT = 256
const note = z.string().max(8192)
/**
 * What a roster entry is: a subagent, a workflow, a command the agent left
 * running, a monitor that watches a command and wakes the agent on its
 * events, or another provider task. Absent is an agent, as every entry was
 * before commands and monitors joined the roster.
 */
export const NativeWorkSchema = z.enum(["agent", "workflow", "command", "monitor", "task"])
export type NativeWork = z.infer<typeof NativeWorkSchema>
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
  work: NativeWorkSchema.optional(),
  /** What it runs: a command line, or the prompt an agent was given. */
  detail: note.optional(),
  /** Registered to run past the turn that started it. */
  background: z.boolean().optional(),
  /**
   * Housekeeping the provider says is not activity (Claude's `ambient`): it
   * is listed, never counted as work the session waits on.
   */
  ambient: z.boolean().optional(),
  /** The provider can stop this one entry on its own (Claude's `stopTask`). */
  stoppable: z.boolean().optional(),
  /** The end of a command's or monitor's output once it settled, read from the provider's own file. */
  output: note.optional(),
  /** Which native messages the entry was read from, for the diagnostics readout. */
  source: z.string().max(256).optional(),
  /**
   * A background agent: a harness's own run that works for the conversation
   * and outlives its turns and its provider's process (`background-agents.ts`).
   * `session` is its harness's ID for its own Session once known, and `path`
   * where this Mac's catalog reads it, which opens its transcript.
   */
  detached: z
    .object({
      id: z.string().min(1).max(64),
      origin: z.enum(["started", "discovered", "linked"]),
      session: z.string().min(1).max(512).optional(),
      path: z.string().min(1).max(4096).optional(),
    })
    .optional(),
  /**
   * A child: a Thread this conversation's Thread leads (`contracts/agents.ts`),
   * drawn from its edge and its own Thread (`childEntry`), never from a
   * harness's roster. `session` is its Session in the Thread store, and `path`
   * where this device's catalog reads its transcript, which opens it.
   */
  child: z
    .object({
      thread: z.string().uuid(),
      origin: z.enum(["started", "discovered", "linked", "attached"]),
      session: z.string().uuid().optional(),
      path: z.string().min(1).max(4096).optional(),
    })
    .optional(),
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
/** Active work that keeps a session busy: an ambient watcher never does. */
export function isBusyNativeAgent(agent: NativeAgentObservation): boolean {
  return isActiveNativeAgent(agent) && !agent.ambient
}
/**
 * Work the session's provider holds: its process ending ends it. A
 * background agent is Mako's own process, which outlives the provider's.
 */
export function isProviderWork(agent: NativeAgentObservation): boolean {
  return !agent.detached
}
/** Busy work that keeps the provider's process: what it holds, never a background agent. */
export function isBusyProviderWork(agent: NativeAgentObservation): boolean {
  return isBusyNativeAgent(agent) && isProviderWork(agent)
}
export const NativeAgentSchema = NativeAgentObservationSchema.extend({
  bindingId: z.string(),
  provider: z.string(),
  requestId: z.string().optional(),
  observedAt: z.number(),
  /** Host epoch ms of the first observation; elapsed time counts from it. */
  startedAt: z.number().optional(),
  /** Host epoch ms of the observation that settled it. */
  settledAt: z.number().optional(),
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
  const previous = index >= 0 ? agents[index] : undefined
  const settledAt = isActiveNativeAgent(agent)
    ? undefined
    : previous && !isActiveNativeAgent(previous)
      ? (previous.settledAt ?? agent.observedAt)
      : agent.observedAt
  const next: NativeAgent = {
    ...agent,
    requestId: previous?.requestId ?? agent.requestId,
    startedAt: previous?.startedAt ?? agent.startedAt ?? agent.observedAt,
    ...(settledAt !== undefined && { settledAt }),
  }
  if (index >= 0) agents[index] = next
  else agents.push(next)
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

/** The binding a roster's background agents are filed under; no provider's binding has it. */
export const BACKGROUND_AGENTS_BINDING = "mako:background-agents"
/** The binding a roster's children are filed under (`childEntry`); no provider's binding has it. */
export const CHILDREN_BINDING = "mako:children"

/**
 * `roster` with its background agents replaced by `agents`, which their
 * owner (`BackgroundAgents`) hands over whole and keeps the identity of
 * while unchanged: the roster itself when none changed.
 */
export function withBackgroundAgents(roster: NativeAgentRoster | undefined, agents: readonly NativeAgent[]): NativeAgentRoster | undefined {
  const held = roster?.agents.filter((agent) => !isProviderWork(agent)) ?? []
  if (held.length === agents.length && held.every((agent, index) => agent === agents[index])) return roster
  const provider = roster?.agents.filter(isProviderWork) ?? []
  return { agents: [...provider.slice(-(NATIVE_AGENT_LIMIT - agents.length)), ...agents], limited: roster?.limited ?? false }
}

/** How the turn that started an entry ended, for an entry that ends with its turn. */
export type TurnEnd = { kind: "finished" } | { kind: "stopped" } | { kind: "failed"; error?: string }

/**
 * What an entry still at work when its turn ended ended as, on a provider
 * that lets nothing outlive the turn that started it (`ends-with-turn`): a
 * stopped turn stopped it, a failed one failed it; a turn that finished
 * without its end said nothing of how it went.
 */
export function endedWithTurn(end: TurnEnd): NativeAgentObservation["state"] {
  if (end.kind === "stopped") return { kind: "canceled" }
  if (end.kind === "failed") return { kind: "failed", error: `Its turn ended with an error${end.error ? `: ${end.error.slice(0, 8000)}` : "."}` }
  return { kind: "unknown", reason: "Its turn ended without saying how it finished." }
}

/**
 * Ends what `ends` names as ended with its turn: each entry it returns a
 * turn end for, at `at`, the moment the turn ended. Without `at` (a turn
 * that ended before this host read it) the entry ends when it was last
 * heard of, so its elapsed time stops there. The roster itself when nothing
 * changed.
 */
export function endWithTurns(
  roster: NativeAgentRoster | undefined,
  ends: (agent: NativeAgent) => TurnEnd | undefined,
  at?: number
): NativeAgentRoster | undefined {
  if (!roster) return roster
  let changed = false
  const agents = roster.agents.map((agent): NativeAgent => {
    const end = isProviderWork(agent) ? ends(agent) : undefined
    if (!end) return agent
    changed = true
    const state = endedWithTurn(end)
    return at === undefined
      ? { ...agent, stoppable: false, settledAt: agent.settledAt ?? agent.observedAt, state }
      : { ...agent, stoppable: false, observedAt: at, settledAt: at, state }
  })
  return changed ? { ...roster, agents } : roster
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
      !isProviderWork(agent) ||
      !["working", "waiting"].includes(agent.state.kind)
    )
      return agent
    changed = true
    return {
      ...agent,
      state: {
        kind: "unknown",
        reason: "The provider's process ended, so how this ended is unknown.",
      },
    }
  })
  return changed ? { ...roster, agents } : roster
}
