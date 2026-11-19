import { useState } from "react"
import { childStateOf, openAsk } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { answerFin, type FinAnswer } from "@/state/fin-asks"

/** What a Fin's ask is answered with: the answer sent and not yet settled, and the way to send one. */
export interface FinAnswering {
  sent: FinAnswer | undefined
  send: (answer: FinAnswer) => void
}

/**
 * The person's answer to a Fin's ask, from its press until the roster moves on: sent once through the Apex's host
 * (`answerFin`), and open to another press only when it didn't reach the Fin.
 */
export function useFinAnswer(agent: NativeAgent, apex: string): FinAnswering {
  const [sent, setSent] = useState<FinAnswer | undefined>(undefined)
  const send = (answer: FinAnswer) => {
    const open = openAsk(childStateOf(agent))
    if (sent || !open?.ask || !agent.child) return
    setSent(answer)
    void answerFin(
      apex,
      {
        fin: agent.child.thread,
        title: agent.title,
        harness: agent.provider,
        question: open.question,
        ask: open.ask,
        ...(open.done && { done: true as const }),
      },
      answer
    ).then((answered) => {
      if (!answered) setSent(undefined)
    })
  }
  return { sent, send }
}
