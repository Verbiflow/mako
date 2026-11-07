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
  try {
    await getMako().answerAgentAsk(conversationId, ask.id, allow)
    return true
  } catch (error) {
    toast.error("That didn't go through", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}
