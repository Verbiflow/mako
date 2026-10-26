import type { ToolCall } from "@/extend/slots"
import type { NativeAgent } from "@/lib/types"
import type { SubagentStanding } from "@/lib/tools"

/** Agents started in one response read as one row from this many on. */
export const AGENT_GROUP_MIN = 2

export type CallItem = { kind: "call"; call: ToolCall } | { kind: "agents"; id: string; calls: ToolCall[] }

/**
 * A response's calls, with the agents it started together gathered into one
 * item: the calls of one model response that start subagents, side by side.
 * Four parallel agents were four running rows, each with its own mark.
 */
export function groupAgentCalls(calls: readonly ToolCall[]): CallItem[] {
  const items: CallItem[] = []
  let run: ToolCall[] = []
  const flush = () => {
    if (run.length >= AGENT_GROUP_MIN) items.push({ kind: "agents", id: `agents-${run[0]!.id}`, calls: run })
    else for (const call of run) items.push({ kind: "call", call })
    run = []
  }
  for (const call of calls) {
    if (call.tool.kind === "agent") {
      run.push(call)
      continue
    }
    flush()
    items.push({ kind: "call", call })
  }
  flush()
  return items
}

/** The roster's word for an agent, where it has a settled one; `unknown` defers to the call. */
export function rosterStanding(agent: NativeAgent): SubagentStanding | undefined {
  switch (agent.state.kind) {
    case "working":
      return "working"
    case "waiting":
      return "waiting"
    case "completed":
      return "done"
    case "failed":
      return "failed"
    case "canceled":
      return "stopped"
    case "unknown":
      return undefined
  }
}

/** The group's count words, in the order a person scans them: what still runs, then how the rest ended. */
const COUNT_WORDS = [
  ["working", (standing: SubagentStanding) => standing === "working"],
  ["waiting", (standing: SubagentStanding) => standing === "waiting"],
  ["done", (standing: SubagentStanding) => standing === "done"],
  ["failed", (standing: SubagentStanding) => standing === "failed"],
  ["stopped", (standing: SubagentStanding) => standing === "stopped" || standing === "cut off" || standing === "canceled"],
] as const

/** A group's title ("4 agents") and its counts by standing, each a word and how many. */
export interface AgentGroupWords {
  title: string
  counts: Array<{ word: string; count: number }>
}

export function agentGroupWords(standings: readonly SubagentStanding[]): AgentGroupWords {
  return {
    title: `${standings.length} agents`,
    counts: COUNT_WORDS.flatMap(([word, matches]) => {
      const count = standings.filter(matches).length
      return count > 0 ? [{ word, count }] : []
    }),
  }
}
