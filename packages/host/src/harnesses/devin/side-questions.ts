import { z } from "zod"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { AcpSideQuestions } from "../acp-source.js"
import { untilStopped, withEarlierExchanges } from "../../contracts/live-side-questions.js"

const SIDE_CHAIN = { "cognition.ai/chain": "side" } as const

const SideChainMeta = z.looseObject({ "cognition.ai/chain": z.literal("side") })

/**
 * Devin's `/btw`, sent as a prompt on its side chain. Checked against devin
 * 3000.10.23 with Mako's client capabilities: the answer streams while a
 * main turn runs, each update tagged with the side chain, and neither the
 * question nor the answer joins the conversation's history. Each side
 * question is answered alone, so a follow-up carries the exchanges before it.
 */
export const devinSideQuestions: AcpSideQuestions = {
  kind: "native",
  via: "Its `/btw`, as a prompt on its side chain (`cognition.ai/chain: side`), with the side conversation's earlier exchanges ahead of each follow-up.",
  chain: (notification: SessionNotification) => SideChainMeta.safeParse(notification._meta).success,
  ask: async (peer, { question, earlier, stream, signal }) => {
    let answer = ""
    const stopListening = peer.listen(({ update }) => {
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return
      answer += update.content.text
      stream(update.content.text)
    })
    try {
      await untilStopped(peer.prompt({
        sessionId: peer.sessionId,
        prompt: [{ type: "text", text: `/btw ${withEarlierExchanges(question, earlier)}` }],
        _meta: SIDE_CHAIN,
      }), signal)
    } finally {
      stopListening()
    }
    return answer
  },
}
