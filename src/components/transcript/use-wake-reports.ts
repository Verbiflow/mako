import { useMemo } from "react"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { answeredWords, childStateOf, openAsk } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { useAcpConversation } from "@/state/acp-state"
import { useThreadAsks, useThreadChildren } from "@/state/apex-fins"

/**
 * A wake's report as the person reads it, and whether the roster still holds its decision open. `waits` while it is
 * a question the person hasn't answered, which the Shiver card answers; `answered` is who answered its Fin and with
 * what ("You answered: Plain"), for as long as the roster says so: while the Fin works on the answer.
 */
export interface WakeReport {
  card: FinReportCard
  open: boolean
  waits: boolean
  answered?: string
}

const NO_REPORTS: readonly WakeReport[] = []

/**
 * A wake's reports as they stand for the person now. A decision its Apex left went to the person
 * (`escalateDecision`): the report still says its Apex decides, the roster says the person does, so it reads as
 * theirs from then on. A done Fin's decision stays `open` while the roster holds it, its Apex's or the person's.
 */
export function useWakeReports(sent: readonly FinReportCard[] | undefined): readonly WakeReport[] {
  const source = useTranscriptSource()
  const thread = useAcpConversation(sent?.length ? source.liveId : undefined, (conversation) => conversation?.threadId)
  const children = useThreadChildren(thread)
  const asks = useThreadAsks(thread)
  return useMemo(() => {
    if (!sent?.length) return NO_REPORTS
    const decisionsOpen = openDecisions(children)
    const answers = answered(children)
    // An answer is its Fin's newest question's: an earlier one in the same wake was settled before it.
    const newest = new Map(sent.flatMap((card) => (card.status === "needs-input" || card.decides ? [[card.fin, card.report] as const] : [])))
    return sent.map((card) => {
      const asked = asks.some((ask) => ask.fin === card.fin && ask.ask.kind === "report" && ask.ask.id === card.report)
      const said = newest.get(card.fin) === card.report ? answers.get(card.fin) : undefined
      return {
        card: card.decides === "lead" && asked ? { ...card, decides: "person" as const } : card,
        open: decisionsOpen.has(`${card.fin}:${card.report}`),
        // An approval is asked under its own id, never its report's: its Fin waiting on the person at all is it.
        waits: asked || (card.status === "blocked" && card.forPerson === true && asks.some((ask) => ask.fin === card.fin)),
        ...(said && { answered: said }),
      }
    })
  }, [sent, children, asks])
}

/** The done Fins' decisions still open, its Apex's or escalated to the person, as `<fin thread>:<report>`. */
function openDecisions(children: readonly NativeAgent[]): ReadonlySet<string> {
  const open = new Set<string>()
  for (const agent of children) {
    const ask = openAsk(childStateOf(agent))
    if (agent.child?.thread && ask?.done && ask.ask?.id) open.add(`${agent.child.thread}:${ask.ask.id}`)
  }
  return open
}

/** What each Fin was answered with, by its Thread, while its state says so (`answeredWords`). */
function answered(children: readonly NativeAgent[]): ReadonlyMap<string, string> {
  const answers = new Map<string, string>()
  for (const agent of children) {
    const state = childStateOf(agent)
    const words = state.kind === "working" && state.answered ? answeredWords(state.answered) : undefined
    if (agent.child?.thread && words) answers.set(agent.child.thread, words)
  }
  return answers
}
