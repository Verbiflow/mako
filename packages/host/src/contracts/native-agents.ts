import { z } from "zod"

export const NATIVE_AGENT_LIMIT = 256
const note = z.string().max(8192)
/** The most Fins one start waits on (`agents_start` `after`): admission refuses more, so a queued state never carries more. */
export const AFTER_LIMIT = 20
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

/** The most answers one question offers. */
export const ASK_OPTIONS = 12
/** One answer a Fin's question offers: what's picked, and what picking it does. */
export const AskOptionSchema = z.object({
  label: z.string().min(1).max(200),
  detail: z.string().max(600).optional(),
})
export type AskOption = z.infer<typeof AskOptionSchema>

/**
 * What a blocked Fin asks, whole, so it can be answered without opening its
 * Thread: a question in its report (`agents_report`), or its harness's own
 * question or approval. `id` names the ask, so an answer says which one it
 * answers and a second answer to the same one is refused, not sent twice.
 */
export const FinAskSchema = z.object({
  kind: z.enum(["report", "question", "approval"]),
  id: z.string().min(1).max(600),
  options: z.array(AskOptionSchema).max(ASK_OPTIONS).optional(),
  /** The option it recommends, by its place in `options`. */
  recommended: z.number().int().nonnegative().optional(),
  /** What whoever answers does, in one sentence. */
  action: z.string().max(400).optional(),
  /**
   * An approval answered in its own words: its first option allows and its second keeps things as they are, as an
   * agent's ask through Mako's tools does ("Move to the cloud", "Keep here"), where a harness's says "Allow once".
   */
  named: z.literal(true).optional(),
})
export type FinAsk = z.infer<typeof FinAskSchema>

/**
 * What a Fin that finished leaves for someone to decide (a merge, a choice
 * between results), from the question its done report asks: its Apex's
 * (`lead`) or the person's, and the ask that answers it, which only its
 * owner has: a row's Fin on another device says the question alone.
 */
export const FinDecisionSchema = z.object({ question: note, on: z.enum(["lead", "person"]), ask: FinAskSchema.optional() })
export type FinDecision = z.infer<typeof FinDecisionSchema>

/**
 * One thing a Fin waits on outside its tree, as its report names it: a pull request until its checks, a review or a
 * merge, whose outcome Mako wakes it with (`contracts/pull-waits.ts`); the person, for what they do ("merge"); or
 * anything else in a few words (`other`). Person and other waits record intent only; they register no automatic wake.
 */
export const WaitingOnSchema = z.union([
  z.object({
    kind: z.literal("pull-request"),
    /** As the report named it: its URL, `owner/name#412` or `#412`. */
    ref: z.string().min(1).max(400),
    /** `owner/name` and the number, read from `ref` as the report is kept (`pullRef`); absent for a bare `#412`. */
    repository: z.string().min(1).max(200).optional(),
    number: z.number().int().positive().optional(),
    until: z.enum(["checks", "review", "merge"]).optional(),
  }),
  z.object({ kind: z.literal("person"), what: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("other"), text: z.string().min(1).max(200) }),
])
export type WaitingOn = z.infer<typeof WaitingOnSchema>
/** The most a report names. */
export const WAITING_ON_LIMIT = 8
const waitingOn = z.array(WaitingOnSchema).max(WAITING_ON_LIMIT)

/** Who answered a Fin's question, and with what, while it works on the answer. */
export const FinAnsweredSchema = z.object({ by: z.enum(["lead", "person"]), answer: z.string().max(400) })
export type FinAnswered = z.infer<typeof FinAnsweredSchema>

/**
 * A child's state as `childState` computes it (`contracts/agents.ts`), carried
 * on its entry so every surface (the rail's badge, the strip, the panel, the
 * phone) reads that one computation and never infers it from `state`'s words.
 */
export const ChildStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("queued"),
    reason: z.enum(["tree-running", "place-full", "device-offline"]),
    ahead: z.number().int().nonnegative(),
    /** The Fins it starts after that haven't finished, by name: while any is listed, `reason` is what it waits for next. */
    after: z.array(note).max(AFTER_LIMIT).optional(),
    /** The one of them that failed or was stopped: it won't start, and its Apex is told to decide. */
    held: note.optional(),
    /** Why it couldn't start once released: it stays, saying so, until its Apex has heard. */
    refused: note.optional(),
    /** Its Apex is a Fin that was stopped: it waits, whatever room there is, until that Fin resumes. */
    apexStopped: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal("starting"), step: z.enum(["placing", "preparing", "booting", "launching"]) }),
  z.object({ kind: z.literal("working"), step: note.optional(), phase: note.optional(), answered: FinAnsweredSchema.optional() }),
  /** `waitingOn`: what its last report said it waits on, since `since`, the report's time; Mako wakes it on a pull request's outcome. */
  z.object({ kind: z.literal("idle"), waitingOn: waitingOn.optional(), since: z.number().optional() }),
  z.object({ kind: z.literal("blocked"), question: note, on: z.enum(["lead", "person", "approval"]), ask: FinAskSchema.optional(), waitingOn: waitingOn.optional() }),
  z.object({ kind: z.literal("ended"), outcome: z.enum(["done", "failed", "stopped"]), reason: note.optional(), unfinished: z.literal(true).optional(), decision: FinDecisionSchema.optional(), waitingOn: waitingOn.optional() }),
])
export type ChildStateReading = z.infer<typeof ChildStateSchema>
export const NativeAgentObservationSchema = z.object({
  nativeId: z.string().min(1).max(512),
  nativeRunId: z.string().min(1).max(512).optional(),
  title: z.string().max(512),
  parentNativeId: z.string().max(512).optional(),
  toolId: z.string().max(512).optional(),
  model: z.string().max(256).optional(),
  /**
   * A Fin's model, reasoning level and fast lane as the person reads them (`finTuningWords`), and why it isn't on the
   * choice its start would have taken (a model its harness stopped listing). Absent before its catalog is read.
   */
  runsOn: z
    .object({ model: z.string().max(256), reasoning: z.string().max(64).optional(), fast: z.literal(true).optional(), note: note.optional(), rule: z.string().max(512).optional() })
    .optional(),
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
   * A Fin: a Thread that works for this conversation's Thread, its Apex
   * (`contracts/agents.ts`), drawn from its edge and its own Thread
   * (`childEntry`), never from a harness's roster. It outlives the
   * conversation's turns and its provider's process. `session` is its Session
   * in the Thread store; `nativeId` its harness's ID for it and `path` where
   * this device's catalog reads it, which open its transcript; `conversation`
   * its live conversation on that device, which opens it live. `state` is
   * `childState`'s, absent from a host before it. `name` is what its Apex and
   * the person address it by; a host that takes the person's messages straight
   * to it (`mako:agents-direct`) says it, and one before doesn't.
   */
  child: z
    .object({
      thread: z.string().uuid(),
      name: z.string().min(1).max(512).optional(),
      origin: z.enum(["started", "discovered", "linked", "attached"]),
      session: z.string().uuid().optional(),
      nativeId: z.string().min(1).max(512).optional(),
      path: z.string().min(1).max(4096).optional(),
      conversation: z.string().min(1).max(512).optional(),
      state: ChildStateSchema.optional(),
      /** Where it went on when its harness's account ran out, and why: "Moved to Claude (work): personal is at its limit until 3:10 PM PST". */
      moved: z.string().max(512).optional(),
      /** Where it runs when that isn't its Apex's device (`place: device:<name>`): its row says the device. */
      place: z.string().max(220).optional(),
      /** The one notice of a limit its tree hit, on the first Fin it touched, until the person has seen it (`limitNoticeLine`). */
      limitNotice: z.object({ id: z.string().min(1).max(600), line: z.string().max(512), harness: z.string().min(1).max(100) }).optional(),
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
 * Work the session's provider holds: its process ending ends it. A child is
 * a Thread of its own, which outlives the provider's process.
 */
export function isProviderWork(agent: NativeAgentObservation): boolean {
  return !agent.child
}
/** Busy work that keeps the provider's process: what it holds, never a child. */
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
  /** A Fin's: when it came to stand as it does (`childSince`), which a row's time counts from. Absent while that isn't known. */
  since: z.number().optional(),
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

/** The binding a roster's children are filed under (`childEntry`); no provider's binding has it. */
export const CHILDREN_BINDING = "mako:children"

/**
 * `roster` with its children replaced by `agents`, which their engine
 * (`Agents`) hands over whole and keeps the identity of while unchanged: the
 * roster itself when none changed.
 */
export function withChildren(roster: NativeAgentRoster | undefined, agents: readonly NativeAgent[]): NativeAgentRoster | undefined {
  const held = roster?.agents.filter((agent) => !isProviderWork(agent)) ?? []
  if (held.length === agents.length && held.every((agent, index) => agent === agents[index])) return roster
  const provider = roster?.agents.filter(isProviderWork) ?? []
  return { agents: [...provider.slice(-(NATIVE_AGENT_LIMIT - agents.length)), ...agents], limited: roster?.limited ?? false }
}

/** What a journal keeps of a roster: its provider's work. Children are their engine's to say, never saved. */
export function providerRoster(roster: NativeAgentRoster | undefined): NativeAgentRoster | undefined {
  if (!roster?.agents.some((agent) => !isProviderWork(agent))) return roster
  return { ...roster, agents: roster.agents.filter(isProviderWork) }
}

/** Whether two rosters hold the same provider work, entry for entry: children alone changed between them. */
export function sameProviderWork(previous: NativeAgentRoster | undefined, next: NativeAgentRoster | undefined): boolean {
  if (!previous || !next) return previous === next
  const before = previous.agents.filter(isProviderWork)
  const after = next.agents.filter(isProviderWork)
  return previous.limited === next.limited && before.length === after.length && before.every((agent, index) => agent === after[index])
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
