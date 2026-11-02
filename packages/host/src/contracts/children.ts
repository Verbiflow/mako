import { z } from "zod"
import { ROLE_WORD, type ChildState } from "./agents.js"
import type { Block } from "./conversation-session.js"
import { isProviderWork, type NativeAgent, type NativeAgentRoster } from "./native-agents.js"

/** The header every delivery an agent wrote starts with: the model reads it as an agent's words, never the person's. */
export const FROM_AGENTS = "[mako · from your agents, not the person]"
export function fromAgent(name: string): string {
  return `[mako · from ${name} (agent), not the person]`
}

/**
 * The header of the person's own message a lead passed on to a child
 * (`agents_send` with `forward`): the child reads them as the person's words,
 * which reached it through its lead, and the lead's words (if any) after them.
 */
export function passedOn(name: string): string {
  return `[mako · the person's words, passed on by ${name} (agent)]`
}
/** Between the person's words a lead passed on and what it added. */
export const PASSED_ON_NOTE = `[mako · what your ${ROLE_WORD} adds]`

const AGENT_HEADER = /^\[mako · from (.+?)(?: \(agent\))?, not the person\]\n?/
const PASSED_ON_HEADER = /^\[mako · the person's words, passed on by (.+?) \(agent\)\]\n?/

/** A brief's lines for its child alone, who it is and how it reports: the person's card of the brief leaves them out. */
export function briefIntro(name: string): string {
  return `You're child:${name}${INTRO_TAIL}`
}
const INTRO_TAIL = ", a Thread another Thread started to do one piece of work. It reads your reports, not this conversation."
export const BRIEF_CLOSE = `When you finish, are blocked, or need a decision, call agents_report (from a shell, \`mako agents report\`). Ending your turn without one tells your ${ROLE_WORD} how it ended.`

/**
 * Words an agent wrote into a conversation (`fromAgent`, `FROM_AGENTS`), read
 * from their own header, so a saved transcript and a live one say the same:
 * who wrote them as the header names them (`your lead`, `your agents`), and the
 * words after it, less a brief's lines for its child alone. Undefined for the
 * person's own words.
 */
/** Words an agent wrote into a Thread, read from their header: who wrote them, and for the person's own message a lead passed on, what it added. */
export interface AgentWords {
  from: string
  body: string
  passedOn?: { added?: string }
}

export function agentWords(text: string): AgentWords | undefined {
  const passed = PASSED_ON_HEADER.exec(text)
  if (passed) {
    const [said, added] = text.slice(passed[0].length).split(`\n\n${PASSED_ON_NOTE}\n`)
    return { from: passed[1]!, body: said!.trim(), passedOn: { ...(added?.trim() && { added: added.trim() }) } }
  }
  const header = AGENT_HEADER.exec(text)
  if (!header) return undefined
  const body = text
    .slice(header[0].length)
    .split("\n")
    .filter((line) => line !== BRIEF_CLOSE && !(line.startsWith("You're child:") && line.endsWith(INTRO_TAIL)))
    .join("\n")
    .trim()
  return { from: header[1]!, body }
}

type ToolCallBlock = Extract<Block, { type: "toolCall" }>

/** A lead's `agents_send` as its transcript keeps the call: to whom, and whether it passed on the person's message. */
export interface Routed {
  to: string
  forward: boolean
  text?: string
}

/**
 * A call on Mako's `mako` server that routed a message to a child, read from
 * the call itself (its server, its tool and its arguments, as every harness's
 * decoder names them), so a live turn and a saved one draw the same line.
 */
export function routedCall(block: ToolCallBlock): Routed | undefined {
  if (block.tool?.kind !== "mcp" || block.tool.server !== "mako" || block.tool.tool !== "agents_send") return undefined
  const call = RoutedCallSchema.safeParse(block.arguments)
  if (!call.success) return undefined
  const { to, forward, text } = call.data
  return { to: to.startsWith("child:") ? to.slice("child:".length) : to, forward: forward === true, ...(text?.trim() && { text: text.trim() }) }
}
const RoutedArgsSchema = z.looseObject({ to: z.string().min(1), forward: z.boolean().optional(), text: z.string().optional() })

/** An object's JSON, as a harness keeps a call's arguments and Mako writes its answers. */
const JsonObjectText = z.string().transform((text, context) => {
  try {
    if (text.trimStart().startsWith("{")) return JSON.parse(text)
  } catch {
    // Read as no object below.
  }
  context.addIssue({ code: "custom", message: "not an object's JSON" })
  return z.NEVER
})
const RoutedCallSchema = z.union([RoutedArgsSchema, JsonObjectText.pipe(RoutedArgsSchema)])

/** Where an `agents_send` landed, read from its result's text: undefined for a refusal, or a result a harness kept only in part. */
export function routedAnswer(text: string): RoutedAnswer | undefined {
  return JsonObjectText.pipe(RoutedAnswerSchema).safeParse(text).data
}
const RoutedAnswerSchema = z.object({ child: z.string(), request: z.string(), delivery: z.enum(["turn", "steer", "queued"]) })
export type RoutedAnswer = z.infer<typeof RoutedAnswerSchema>

/** What the person is shown a child as: the one reading `rollup`, the strip, the panel and the phone group it by. */
export type ChildGroup = "needs" | "working" | "queued" | "failed" | "done"

/** The order children are listed in, everywhere: what needs the person first, so it never falls behind "+N". */
export const CHILD_GROUPS: readonly ChildGroup[] = ["needs", "working", "queued", "failed", "done"]

/**
 * A child entry's state: `childState`'s, as its entry carries it. An entry from
 * a host before `child.state` says only its roster state, which is read as
 * plainly as it can be: waiting is idle there, since it can't say on whom.
 */
export function childStateOf(agent: NativeAgent): ChildState {
  if (agent.child?.state) return agent.child.state
  switch (agent.state.kind) {
    case "working":
      return { kind: "working", ...(agent.state.activity && { step: agent.state.activity }) }
    case "waiting":
      return { kind: "idle" }
    case "completed":
      return { kind: "ended", outcome: "done" }
    case "canceled":
      return { kind: "ended", outcome: "stopped" }
    case "failed":
      return { kind: "ended", outcome: "failed", reason: agent.state.error }
    case "unknown":
      return { kind: "ended", outcome: "failed", reason: agent.state.reason }
  }
}

/**
 * Where a child stands for the person. A question on its lead is the lead's
 * to answer, so that child is still at work as far as the person goes; an
 * idle one has nothing running and nothing asked.
 */
export function childGroup(state: ChildState): ChildGroup {
  switch (state.kind) {
    case "queued":
      return "queued"
    case "starting":
    case "working":
      return "working"
    case "blocked":
      return state.on === "lead" ? "working" : "needs"
    case "idle":
      return "done"
    case "ended":
      return state.outcome === "failed" ? "failed" : "done"
  }
}

const NO_CHILDREN: readonly NativeAgent[] = []
const childrenOfRoster = new WeakMap<NativeAgentRoster, readonly NativeAgent[]>()

/** A roster's children, in the order `orderedChildren` gives: the same array while the roster is the same. */
export function rosterChildren(roster: NativeAgentRoster | undefined): readonly NativeAgent[] {
  if (!roster) return NO_CHILDREN
  const held = childrenOfRoster.get(roster)
  if (held) return held
  const children = roster.agents.some((agent) => !isProviderWork(agent)) ? orderedChildren(roster.agents.filter((agent) => !isProviderWork(agent))) : NO_CHILDREN
  childrenOfRoster.set(roster, children)
  return children
}

/** Children grouped in `CHILD_GROUPS`' order, the oldest first within each, as the strip's tabs and the panel's sections stand. */
export function orderedChildren(children: readonly NativeAgent[]): NativeAgent[] {
  const rank = (agent: NativeAgent) => CHILD_GROUPS.indexOf(childGroup(childStateOf(agent)))
  return [...children].sort((left, right) => rank(left) - rank(right) || (left.startedAt ?? left.observedAt) - (right.startedAt ?? right.observedAt))
}

/** How many of a lead's Threads stand in each group: the rail's badge, the strip's count, the panel's headings and the phone's list. */
export interface Rollup {
  total: number
  needs: number
  working: number
  queued: number
  failed: number
  done: number
}

const EMPTY_ROLLUP: Rollup = { total: 0, needs: 0, working: 0, queued: 0, failed: 0, done: 0 }
const rollups = new WeakMap<readonly NativeAgent[], Rollup>()

/** The one count of a lead's children every surface shows: the same object while the children are. */
export function rollup(children: readonly NativeAgent[]): Rollup {
  if (!children.length) return EMPTY_ROLLUP
  const held = rollups.get(children)
  if (held) return held
  const counts = { ...EMPTY_ROLLUP, total: children.length }
  for (const child of children) counts[childGroup(childStateOf(child))] += 1
  rollups.set(children, counts)
  return counts
}

export function sameRollup(left: Rollup, right: Rollup): boolean {
  return left.total === right.total && left.needs === right.needs && left.working === right.working &&
    left.queued === right.queued && left.failed === right.failed && left.done === right.done
}

export function threadsWord(count: number): string {
  return count === 1 ? "1 Thread" : `${count} Threads`
}

/** The badge's words, for screen readers and its tip: "12 Threads: 2 need you, 5 working, 2 queued, 3 done". */
export function rollupLabel(counts: Rollup): string {
  const parts = [
    `${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you`,
    `${counts.working} working`,
    `${counts.queued} queued`,
    ...(counts.failed ? [`${counts.failed} failed`] : []),
    `${counts.done} done`,
  ]
  return `${threadsWord(counts.total)}: ${parts.join(", ")}`
}

/**
 * A lead's composer line: what's at work and what waits on the person, "5 working · 2 need you"; with neither, what's
 * queued, failed or done. Queued and asking children are never "running".
 */
export function rollupLine(counts: Rollup): string {
  const now = [...(counts.working ? [`${counts.working} working`] : []), ...(counts.needs ? [`${counts.needs} ${counts.needs === 1 ? "needs" : "need"} you`] : [])]
  if (now.length) return now.join(" · ")
  const rest = [...(counts.queued ? [`${counts.queued} queued`] : []), ...(counts.failed ? [`${counts.failed} failed`] : []), ...(counts.done ? [`${counts.done} done`] : [])]
  return rest.join(" · ")
}

/** What a child's state says in a line: its question, its phase or step, why it waits, or how it ended. */
export function childLine(state: ChildState): string | undefined {
  switch (state.kind) {
    case "queued":
      return state.ahead ? `Queued: ${state.ahead} ahead` : "Queued: next to start"
    case "starting":
      return "Starting"
    case "working":
      return state.phase ?? state.step
    case "blocked":
      return state.question
    case "idle":
      return "Idle: a message gives it its next turn"
    case "ended":
      return state.reason
  }
}

/** A child's state in one word, as its strip and its tip say it. */
export function childWord(state: ChildState): string {
  switch (state.kind) {
    case "queued":
      return "Queued"
    case "starting":
      return "Starting"
    case "working":
      return "Working"
    case "blocked":
      return state.on === "lead" ? `Asks its ${ROLE_WORD}` : state.on === "approval" ? "Needs approval" : "Needs your answer"
    case "idle":
      return "Idle"
    case "ended":
      return state.outcome === "done" ? "Done" : state.outcome === "failed" ? "Failed" : "Stopped"
  }
}
