import type { LiveSessionState } from "./providers-acp.js"
import { isBusyNativeAgent, type NativeAgent, type NativeAgentRoster, type NativeWork } from "./native-agents.js"

/**
 * What a session still runs after its turn ended: the work the provider
 * keeps going on its own (commands, monitors, subagents, workflows) and
 * that wakes it again when it settles. It is its own state, neither a
 * running turn nor a finished one.
 *
 * Two sources meet here. The roster names each piece of work it observed;
 * `backgroundTasks` is the provider's own count, a level some harnesses
 * report without naming anything (Codex's terminal list, Grok's task
 * list) and the one that cannot wedge on a missed end. The count is the
 * larger of the two, and `unnamed` is what the count holds that the roster
 * does not name.
 */
export interface BackgroundWork {
  /** How many things the session waits on. */
  count: number
  /** The roster's active, non-ambient entries, oldest first. */
  named: readonly NativeAgent[]
  /** Counted by the provider but not named in the roster. */
  unnamed: number
}

type WorkSession = Pick<LiveSessionState, "status" | "connection" | "backgroundTasks">

/** Active work the roster names that counts as activity: ambient watchers never do. */
export function activeWork(roster: NativeAgentRoster | undefined): NativeAgent[] {
  return (roster?.agents ?? []).filter(isBusyNativeAgent)
}

/**
 * The work a session waits on between turns, or null when there is none
 * or a turn is running (a running turn is "working", whatever else runs).
 * A closed or disconnected session waits on nothing: its process, and the
 * work it held, is gone.
 */
export function backgroundWork(session: WorkSession | undefined, roster: NativeAgentRoster | undefined): BackgroundWork | null {
  if (!session || session.status === "running" || session.status === "starting" || session.status === "closed") return null
  if (session.connection === "disconnected" || session.connection === "hibernated") return null
  const named = activeWork(roster)
  const count = Math.max(session.backgroundTasks ?? 0, named.length)
  if (!count) return null
  return { count, named, unnamed: count - named.length }
}

const NOUNS = {
  agent: ["agent", "agents"],
  workflow: ["workflow", "workflows"],
  command: ["command", "commands"],
  monitor: ["monitor", "monitors"],
  task: ["task", "tasks"],
} satisfies Record<NativeWork, [string, string]>

/** "2 commands and an agent", or "3 background tasks" when the kinds are mixed past two or unnamed. */
export function backgroundWorkText(work: BackgroundWork): string {
  const counts = new Map<NativeWork, number>()
  for (const agent of work.named) counts.set(agent.work ?? "agent", (counts.get(agent.work ?? "agent") ?? 0) + 1)
  if (work.unnamed || counts.size > 2 || counts.size === 0)
    return `${work.count} background ${work.count === 1 ? "task" : "tasks"}`
  return [...counts].map(([kind, count]) => `${count === 1 ? (kind === "agent" ? "an" : "a") : count} ${NOUNS[kind][count === 1 ? 0 : 1]}`).join(" and ")
}

/** Field-wise equality for selectors, so a progress note does not re-render a row's mark. */
export function sameBackgroundCount(left: BackgroundWork | null, right: BackgroundWork | null): boolean {
  return (left?.count ?? 0) === (right?.count ?? 0)
}
