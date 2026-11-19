import { finsWord } from "@mako/host/contracts/agents"
import { activeWork, backgroundWork, backgroundWorkText, type BackgroundWork } from "@mako/host/contracts/background-work"
import { childGroup, childStateOf } from "@mako/host/contracts/children"
import type { NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { conversationRoster, useRailAcp, type AcpState, type LiveAcpConversation } from "@/state/acp-state"

/**
 * What a conversation waits on once its turn has ended, for the line at its transcript's end and the pill beside
 * "Jump to latest": its Fins at work or queued (one that waits on the person is theirs, not waited on), then the
 * work its provider holds (commands, subagents, monitors). `unnamed` is what the provider counts without naming.
 */
export interface Waiting {
  items: readonly NativeAgent[]
  fins: number
  unnamed: number
}

const NOTHING: Waiting = { items: [], fins: 0, unnamed: 0 }

function waitedOn(agent: NativeAgent): boolean {
  if (!agent.child) return true
  const group = childGroup(childStateOf(agent))
  return group === "working" || group === "queued"
}

/** `work` as what is waited on: its Fins first, as the roster orders them, then what the provider holds. */
export function waitingOfWork(work: BackgroundWork | null): Waiting {
  if (!work) return NOTHING
  const fins = work.named.filter((agent) => agent.child && waitedOn(agent))
  const rest = work.named.filter((agent) => !agent.child)
  return fins.length || rest.length || work.unnamed ? { items: [...fins, ...rest], fins: fins.length, unnamed: work.unnamed } : NOTHING
}

const byRoster = new WeakMap<NativeAgentRoster, { status: string; connection: string | undefined; tasks: number | undefined; value: Waiting }>()

/**
 * What the conversation `key` waits on. Kept by the roster it was read from (its Thread's Fins as they stand,
 * `conversationRoster`, the same object while none changed) and the three facts of its session that decide it, so a
 * batch that moves none of them (a token of this conversation, anything of another) returns the same object
 * without reading a Fin.
 */
export function waitingOf(state: AcpState, key: string | undefined): Waiting {
  const live = key ? state.conversations[key] : undefined
  if (!live || live.kind !== "live") return NOTHING
  const roster = conversationRoster(state, live)
  const session = live.session
  const held = roster ? byRoster.get(roster) : undefined
  if (held && held.status === session.status && held.connection === session.connection && held.tasks === session.backgroundTasks) return held.value
  const value = waitingOfWork(backgroundWork(session, roster))
  if (roster) byRoster.set(roster, { status: session.status, connection: session.connection, tasks: session.backgroundTasks, value })
  return value
}

const atWork = new WeakMap<NativeAgentRoster, Waiting>()

/** Everything of the conversation `key` at work now, a running turn or not, for the pill's count: kept by its roster. */
export function atWorkOf(state: AcpState, key: string | undefined): Waiting {
  const live = key ? state.conversations[key] : undefined
  const roster = live?.kind === "live" ? conversationRoster(state, live) : undefined
  if (!roster) return NOTHING
  let held = atWork.get(roster)
  if (!held) {
    const named = activeWork(roster)
    atWork.set(roster, (held = waitingOfWork({ count: named.length, named, unnamed: 0 })))
  }
  return held
}

export function useConversationAtWork(key: string | undefined): Waiting {
  return useRailAcp((state) => atWorkOf(state, key))
}

/** The conversation's `Waiting`, said to its reader only when it changed: the rail's store hears no streamed batch. */
export function useConversationWaiting(key: string | undefined): Waiting {
  return useRailAcp((state) => waitingOf(state, key))
}

/** A message sits this long unsent before the line says since when. */
export const QUEUED_AFTER_MS = 60_000

/** When the conversation's oldest message still waiting to be sent was written, queued or held. */
export function queuedAt(conversation: Pick<LiveAcpConversation, "requests"> | undefined): number | undefined {
  return conversation?.requests?.find((request) => request.status === "queued" || request.status === "held")?.createdAt
}

/** Since when the conversation has had a message waiting unsent, once it has waited `QUEUED_AFTER_MS` at `now`. */
export function queuedSince(conversation: Pick<LiveAcpConversation, "requests"> | undefined, now: number): number | undefined {
  const at = queuedAt(conversation)
  return at !== undefined && now - at >= QUEUED_AFTER_MS ? at : undefined
}

/** The line's words in parts: whom it names (at most three; past that the first two) and what it says of the rest. */
export interface WaitingWords {
  named: readonly NativeAgent[]
  /** "4 other Fins", "2 others", or with nobody named "3 background tasks". */
  rest?: string
}

export function waitingWords(waiting: Waiting): WaitingWords {
  const { items, unnamed, fins } = waiting
  if (!items.length) return { named: [], ...(unnamed && { rest: backgroundWorkText({ count: unnamed, named: [], unnamed }) }) }
  const named = items.length + (unnamed ? 1 : 0) > 3 ? items.slice(0, 2) : items
  const others = items.length - named.length + unnamed
  if (!others) return { named }
  const onlyFins = fins === items.length && !unnamed
  return { named, rest: onlyFins ? `${others} other ${finsWord(others).split(" ")[1]}` : others === 1 ? "1 other" : `${others} others` }
}
