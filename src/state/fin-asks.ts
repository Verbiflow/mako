import { toast } from "sonner"
import type { AgentsRespondInput } from "@mako/host/contracts/agents"
import { askWords, finAskWaiting, openAsk, rosterChildren } from "@mako/host/contracts/children"
import type { FinAsk, NativeAgent } from "@mako/host/contracts/native-agents"
import { getMako, hasBridge } from "@/lib/bridge"
import { conversationRoster, type AcpState, type LiveAcpConversation } from "@/state/acp-state"

/** One of an Apex's Fins asking the person, as the Apex's roster carries it: theirs to answer from the Apex's Thread. */
export interface PersonAsk {
  fin: string
  title: string
  harness: string
  question: string
  ask: FinAsk
  /** It finished, and this is the decision its work leaves: its words read "Done · needs you: …" (`askWords`). */
  done?: true
}

/** Every ask of these Fins that's the person's, a done Fin's decision too, in the roster's order. */
export function personAsks(children: readonly NativeAgent[]): PersonAsk[] {
  const asks: PersonAsk[] = []
  for (const agent of children) {
    // A limit's notice is the tree's, not this Fin's: it reads once, and first, and "Got it" tells the host it was seen.
    if (agent.child?.limitNotice) asks.unshift({ fin: agent.child.thread, title: "Usage", harness: agent.child.limitNotice.harness, question: agent.child.limitNotice.line, ask: { kind: "report", id: agent.child.limitNotice.id, options: [{ label: "Got it" }] } })
    const open = agent.child?.state && openAsk(agent.child.state)
    if (!agent.child || !open || open.on === "lead" || !open.ask) continue
    asks.push({ fin: agent.child.thread, title: agent.title, harness: agent.provider, question: open.question, ask: open.ask, ...(open.done && { done: true as const }) })
  }
  return asks
}

/**
 * The first of a conversation's Fins' asks that's the person's, as its Thread's mark says it: "Sheet motion: Approve:
 * npm ci". Its Thread's Fins as they stand (`conversationRoster`), whichever of its Sessions it is.
 */
export function finAskLine(state: AcpState, conversation: Pick<LiveAcpConversation, "threadId" | "nativeAgents">): string | undefined {
  const ask = personAsks(rosterChildren(conversationRoster(state, conversation)))[0]
  return ask && finAskWaiting(ask.ask, ask.title, askWords(ask)).line
}

/** How the person answers: one of its options by its place, their own words, or for an approval, allow or refuse. */
export type FinAnswer = Pick<AgentsRespondInput, "option" | "answer" | "allow">

/**
 * Answers through the Apex's host, as the person's own answer, on whichever
 * device they're on. False when it didn't reach the Fin, with a toast that
 * says why: the ask moved on, or the Apex's host is out of reach.
 */
export async function answerFin(apexConversation: string, ask: PersonAsk, answer: FinAnswer): Promise<boolean> {
  if (!hasBridge()) return false
  try {
    const answered = await getMako().agentsRespond(apexConversation, { fin: ask.fin, ask: ask.ask.id, request: crypto.randomUUID(), ...answer })
    if ("refused" in answered) {
      toast(answered.why)
      return false
    }
    return true
  } catch (error) {
    toast.error(`${ask.title} didn't get your answer`, { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}

/** Where a Thread a limit holds could go on, as its card says it; undefined with nowhere, or with no host to ask. */
export async function nextPlace(conversation: string): Promise<{ label: string; harness: string } | undefined> {
  if (!hasBridge()) return undefined
  return getMako().agentsNextPlace(conversation).then((next) => next ?? undefined, () => undefined)
}

/** The person pressed that card. False when it didn't go, with a toast that says so. */
export async function continueNext(conversation: string): Promise<boolean> {
  try {
    const went = await getMako().agentsContinueNext(conversation, crypto.randomUUID())
    if (!went) toast("This Thread can't go on there now")
    return went
  } catch (error) {
    toast.error("This Thread didn't move", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}
