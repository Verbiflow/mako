import { toast } from "sonner"
import { agentAskLine, agentAskWords, type AgentAsk } from "@mako/host/contracts/agent-asks"
import type { AskCard } from "@/lib/ask-card"
import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveAcpConversation } from "@/state/acp-state"

/** What the agent of a conversation asks the person through Mako's tools, first asked first. */
export function agentAskOf(conversation: Pick<LiveAcpConversation, "control"> | undefined): AgentAsk | undefined {
  return conversation?.control?.asks?.[0]
}

/** That ask in a line, for a row. */
export function agentAskDetail(conversation: Pick<LiveAcpConversation, "control">): string | undefined {
  const ask = agentAskOf(conversation)
  return ask && agentAskLine(ask.want)
}

/**
 * What its agent asked, as every surface draws an ask (`AskCard`, shared with Setup's): who asked, what it wants, why,
 * and its two answers, which say whether they landed so a card can be answered again when one didn't.
 */
export function agentAskCard(conversationId: string, ask: AgentAsk, harness: string): AskCard {
  const words = agentAskWords(ask.want, harness)
  const line = agentAskLine(ask.want)
  return {
    who: harness,
    want: line.charAt(0).toLowerCase() + line.slice(1),
    description: words.description,
    detail: words.detail,
    choices: [
      { answer: "allow", label: words.allow, primary: true, choose: () => answerAgentAsk(conversationId, ask, true) },
      { answer: "keep", label: words.keep, choose: () => answerAgentAsk(conversationId, ask, false) },
    ],
  }
}

export async function answerAgentAsk(conversationId: string, ask: AgentAsk, allow: boolean): Promise<boolean> {
  if (!hasBridge()) return false
  // Ask selectors also load while threads initialize; recovery is an action dependency, loaded before the RPC.
  const { readBackLive } = await import("@/state/live-recovery")
  let failure: unknown
  try { await getMako().answerAgentAsk(conversationId, ask.id, allow) } catch (error) { failure = error }
  // The accepted answer may arrive without its event. Read it through the same lifecycle as an approval's receipt;
  // never replay an answer whose outcome is unknown.
  await readBackLive(conversationId)
  if (!failure) return true
  toast.error("Mako couldn't record that answer", { description: failure instanceof Error ? failure.message : String(failure) })
  return false
}
