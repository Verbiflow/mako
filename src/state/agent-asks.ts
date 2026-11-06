import { toast } from "sonner"
import { agentAskLine, type AgentAsk } from "@mako/host/contracts/agent-asks"
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

export async function answerAgentAsk(conversationId: string, ask: AgentAsk, allow: boolean): Promise<boolean> {
  if (!hasBridge()) return false
  try {
    await getMako().answerAgentAsk(conversationId, ask.id, allow)
    return true
  } catch (error) {
    toast.error("Mako couldn't record that answer", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}
