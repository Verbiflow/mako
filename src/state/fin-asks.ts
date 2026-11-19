import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { toast } from "sonner"
import type { LimitNoticeChoice, AgentsRespondInput } from "@mako/host/contracts/agents"
import { askWords, finAskWaiting, openAsk, rosterChildren } from "@mako/host/contracts/children"
import type { FinAsk, NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
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
  limit?: NonNullable<NonNullable<NativeAgent["child"]>["limitNotice"]>
}

/** Every ask of these Fins that's the person's, a done Fin's decision too, in the roster's order. */
export function personAsks(children: readonly NativeAgent[]): PersonAsk[] {
  const asks: PersonAsk[] = []
  for (const agent of children) {
    if (agent.child?.limitNotice) {
      const notice = agent.child.limitNotice
      asks.unshift({ fin: agent.child.thread, title: "Usage", harness: notice.harness, question: notice.line, limit: notice,
        ask: { kind: "report", id: notice.id, options: notice.waiting ? [] : [{ label: "Got it" }] } })
    }
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
  const roster = conversationRoster(state, conversation)
  if (!roster) return undefined
  let held = askLines.get(roster)
  if (!held) {
    const ask = personAsks(rosterChildren(roster)).find(ask => !ask.limit?.waiting)
    held = { line: ask && finAskWaiting(ask.ask, ask.title, askWords(ask)).line }
    askLines.set(roster, held)
  }
  return held.line
}

/** A roster's line, read once: an Apex's row asks for it on every change the rail hears, over a few hundred Fins. */
const askLines = new WeakMap<NativeAgentRoster, { line: string | undefined }>()

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
  } catch {
    // The host settles one answer to an ask once, so trying again can't answer it twice.
    toast.error(`${ask.title} didn't get your answer`, {
      description: "Mako couldn't reach the Apex's host, so nothing was sent.",
      duration: ACTION_TOAST_MS,
      action: { label: "Try again", onClick: () => void answerFin(apexConversation, ask, answer) },
    })
    return false
  }
}

/** Where a Thread a limit holds could go on, as its card says it; undefined with nowhere, or with no host to ask. */
export async function nextPlace(conversation: string, notice?: string): Promise<{ label: string; harness: string; choice?: LimitNoticeChoice } | undefined> {
  if (!hasBridge()) return undefined
  return getMako().agentsNextPlace(conversation, notice).then((next) => next ?? undefined, () => undefined)
}

/** The person pressed that card. False when it didn't go, with a toast that says so. */
export async function continueNext(conversation: string, choice?: LimitNoticeChoice, request: string = crypto.randomUUID()): Promise<boolean> {
  try {
    const went = await getMako().agentsContinueNext(conversation, request, choice)
    if (!went) toast("This Thread can't go on there now")
    return went
  } catch (error) {
    toast.error("This Thread didn't move", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}
