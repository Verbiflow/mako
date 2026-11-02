import { toast } from "sonner"
import type { AgentsRespondInput } from "@mako/host/contracts/agents"
import { rosterChildren } from "@mako/host/contracts/children"
import type { FinAsk, NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { getMako, hasBridge } from "@/lib/bridge"

/** One of an Apex's Fins asking the person, as the Apex's roster carries it: theirs to answer from the Apex's Thread. */
export interface PersonAsk {
  fin: string
  title: string
  harness: string
  question: string
  ask: FinAsk
}

/** Every ask of these Fins that's the person's, in the roster's order. */
export function personAsks(children: readonly NativeAgent[]): PersonAsk[] {
  const asks: PersonAsk[] = []
  for (const agent of children) {
    const state = agent.child?.state
    if (!agent.child || state?.kind !== "blocked" || state.on === "lead" || !state.ask) continue
    asks.push({ fin: agent.child.thread, title: agent.title, harness: agent.provider, question: state.question, ask: state.ask })
  }
  return asks
}

/** The first of a conversation's Fins' asks that's the person's, as its Thread's mark says it: "Sheet motion: Approve: npm ci". */
export function finAskLine(conversation: { nativeAgents?: NativeAgentRoster }): string | undefined {
  const ask = personAsks(rosterChildren(conversation.nativeAgents))[0]
  return ask && `${ask.title}: ${ask.question}`
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
