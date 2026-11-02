import { AFTER_START } from "./agent-tools.js"

/**
 * Whether a harness's own subagent runs, or the work goes through Mako's
 * `agents_start` instead: one decision for every harness. Each driver turns
 * it into what its harness offers (a hook that answers each spawn, or a
 * switch its process or session takes at launch) and says which in its
 * `nativeRouting` capability. What still runs natively is observed as
 * before (`NativeAgentRoster`).
 */

/** What routing reads of a Thread: whether it's an Apex. */
export interface RoutedThread {
  /** `apex`: it has Fins, or it's a Fin started to be an Apex of its own; `thread`: any other. */
  role: "apex" | "thread"
}

/**
 * One native spawn, as its harness's adapter reads the harness's tool and
 * arguments. The flags are what the policy weighs; an adapter that can't
 * tell leaves them out, and its spawn counts as an ordinary one.
 */
export interface NativeSpawn {
  /** The harness's name for its spawn tool, for the log. */
  tool: string
  /** The harness's name for Mako's `agents_start`, which the message names. */
  start: string
  /** A read-only explorer the turn waits for, which ends with the turn. */
  inTurnExplore?: boolean
  /** In a worktree of its own, or a run somewhere else. */
  isolated?: boolean
  /** A peer in an agent team rather than a subagent. */
  teammate?: boolean
}

export type NativeRoute = { kind: "allow" } | { kind: "deny"; message: string }

/**
 * An Apex's delegation is Mako's, so the person can open, steer and see it:
 * every native spawn is denied but an explorer that reads and ends in the
 * turn. Elsewhere native spawns keep their speed, but for a second worktree,
 * a remote run or a team of peers, which are Mako's work on any Thread.
 */
export function routeNativeSpawn(thread: RoutedThread, spawn: NativeSpawn): NativeRoute {
  const makos = spawn.isolated === true || spawn.teammate === true || (thread.role === "apex" && spawn.inTurnExplore !== true)
  return makos ? { kind: "deny", message: routedMessage(spawn.start) } : { kind: "allow" }
}

/**
 * Whether a harness that can only switch its spawn tool off at launch does:
 * when a spawn it can't tell apart, an ordinary one, would be denied.
 */
export function nativeSpawnsOff(thread: RoutedThread): boolean {
  return routeNativeSpawn(thread, { tool: "", start: "" }).kind === "deny"
}

/** What a denied spawn tells the model, naming Mako's tool as its harness does. */
export function routedMessage(start: string): string {
  return `This Thread routes background, parallel and writing work through Mako so the person can open and steer it. Call \`agents_start\` (${start}) with this brief instead. It returns at once. ${AFTER_START}`
}

/** Told to every native subagent where its harness lets Mako add to what the subagent starts with. */
export const NATIVE_CHILD_INSTRUCTIONS = "You're a native subagent of a Mako Thread. Do the task and return. Don't start background agents or agent CLIs. If the task needs parallel or durable work, say so in your result, and your parent will start it with `agents_start`."

/**
 * How a harness's driver keeps an Apex's native spawns with Mako, declared
 * once. `per-call`: its harness asks before each spawn, so the Thread's role
 * is read then. `at-launch`: a switch the process or session takes when it
 * starts, so a Thread that becomes an Apex mid-session has it from its next
 * launch. `words`: no switch was seen to work, so the instructions carry the
 * rule and the roster shows what runs. `verified` names the version it was
 * seen to work on, as the harness's launch reads it, and how.
 */
export type NativeRoutingCapability =
  | { kind: "per-call"; via: string; verified: NativeRoutingVerified }
  | { kind: "at-launch"; via: string; verified: NativeRoutingVerified }
  | { kind: "words"; reason: string }

export interface NativeRoutingVerified {
  version: string
  how: string
}

/**
 * Where one harness stands on a lead's native spawns, as Diagnostics shows it.
 * `control`: its switch, seen working on the version installed. `unverified`:
 * its switch, seen working on another version than the one installed, or
 * with none read. `words`: no switch; the instructions alone.
 */
export interface NativeRoutingReading {
  harness: string
  state: "control" | "unverified" | "words"
  /** How it works, or why there's nothing to switch. */
  via: string
  verified?: NativeRoutingVerified
  installed?: string
}
