import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { threadChildren, useAcp, type AcpState } from "@/state/acp-state"
import { personAsks, type PersonAsk } from "@/state/fin-asks"
import type { WebThread } from "./threads"

/**
 * The phone's Inbox: what waits on the person, from the records its marks read. A Fin asking the person, from its
 * Apex's roster this page holds (`personAsks`), answered through the Apex's host (`answerFin`), so an answer here
 * leaves the dock, the crew and the desk at once; and a Thread the account lists as waiting, opened to answer.
 */

/** A Fin asking the person, with the Apex it answers through: the row "Mobile polish · Approve: npm ci". */
export interface WebFinAsk {
  key: string
  ask: PersonAsk
  agent: NativeAgent
  apex: { thread: string; title: string; conversation: string }
}

const NONE: readonly never[] = []
const asksOf = new WeakMap<readonly NativeAgent[], Map<string, readonly WebFinAsk[]>>()

function finAsksOfApex(children: readonly NativeAgent[], apex: WebFinAsk["apex"]): readonly WebFinAsk[] {
  let byTitle = asksOf.get(children)
  if (!byTitle) asksOf.set(children, (byTitle = new Map()))
  const held = byTitle.get(apex.title + "\n" + apex.conversation)
  if (held) return held
  const byFin = new Map(children.map((agent) => [agent.child?.thread, agent]))
  const asks = personAsks(children).flatMap((ask): WebFinAsk[] => {
    const agent = byFin.get(ask.fin)
    return agent ? [{ key: `fin:${ask.fin}:${ask.ask.id}`, ask, agent, apex }] : []
  })
  const shown = asks.length ? asks : NONE
  byTitle.set(apex.title + "\n" + apex.conversation, shown)
  return shown
}

/** Every Fin asking the person across the Apexes this page holds, the longest waiting first. */
export function webFinAsks(state: AcpState): readonly WebFinAsk[] {
  const seen = new Set<string>()
  const asks: WebFinAsk[] = []
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.kind !== "live" || !conversation.threadId || seen.has(conversation.threadId)) continue
    seen.add(conversation.threadId)
    const children = threadChildren(state, conversation.threadId)
    if (!children.length) continue
    const title = conversation.threadTitle ?? conversation.title ?? conversation.session.title ?? "Apex"
    asks.push(...finAsksOfApex(children, { thread: conversation.threadId, title, conversation: conversation.key }))
  }
  if (!asks.length) return NONE
  return asks.sort(longestWaitingFirst)
}

/** The longest waiting first; asks of the same moment by their key, so the list reads the same each time. */
export function longestWaitingFirst(left: WebFinAsk, right: WebFinAsk): number {
  return left.agent.observedAt - right.agent.observedAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
}

function sameAsks(left: readonly WebFinAsk[], right: readonly WebFinAsk[]): boolean {
  return left === right || (left.length === right.length && left.every((ask, index) => ask === right[index]))
}

/** The Fins asking the person, the same array while none of their asks has changed: a token repaints no row. */
export function useWebFinAsks(): readonly WebFinAsk[] {
  return useAcp(webFinAsks, sameAsks)
}

/**
 * The Fins placed on other devices that wait on the person, each as the row the device running it writes: what it
 * asks is answered in its own Thread there, so each is a row of its own under Needs you, and its Apex's row doesn't
 * stand in for it. Their devices' quiet ones aren't waiting on anyone.
 */
export function placedWaiting(placed: readonly WebThread[]): readonly WebThread[] {
  return placed.filter((thread) => thread.standing === "waiting" && !thread.quietSince)
}

/** The Fins' asks less those a placed Fin's own row says: that row is the one that opens where it's answered. */
export function asksBesidePlaced(fins: readonly WebFinAsk[], placed: readonly WebThread[]): readonly WebFinAsk[] {
  const own = new Set(placedWaiting(placed).map((thread) => thread.id))
  return own.size ? fins.filter((fin) => !own.has(fin.ask.fin)) : fins
}

/** The Threads the account lists as waiting on the person, but an Apex whose asks are its Fins', said by them. */
export function waitingThreads(threads: readonly WebThread[], fins: readonly WebFinAsk[], placed: readonly WebThread[] = []): readonly WebThread[] {
  const waiting = placedWaiting(placed)
  // An Apex whose waiting Fin has a row of its own: that row says it, and opens where it's answered.
  const apexes = new Set([...fins.map((fin) => fin.apex.thread), ...waiting.flatMap((thread) => (thread.apex ? [thread.apex.thread] : []))])
  const fin = new Set(fins.map((ask) => ask.ask.fin))
  return [...waiting, ...threads.filter((thread) => thread.standing === "waiting" && !apexes.has(thread.id) && !fin.has(thread.id))]
}

/** The Inbox's count: every Fin and Thread waiting on the person, the phone's chip and the desk's row alike. */
export function webInboxCount(threads: readonly WebThread[], fins: readonly WebFinAsk[], placed: readonly WebThread[] = []): number {
  return asksBesidePlaced(fins, placed).length + waitingThreads(threads, fins, placed).length
}
