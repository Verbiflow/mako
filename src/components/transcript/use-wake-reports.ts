import { useMemo } from "react"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { childStateOf, openAsk } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { useAcpConversation } from "@/state/acp-state"
import { useThreadAsks, useThreadChildren } from "@/state/apex-fins"

/** A wake's report as the person reads it, and whether the roster still holds its decision open. */
export interface WakeReport {
  card: FinReportCard
  open: boolean
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
    return sent.map((card) => ({
      card: card.decides === "lead" && asks.some((ask) => ask.fin === card.fin && ask.ask.kind === "report" && ask.ask.id === card.report) ? { ...card, decides: "person" as const } : card,
      open: decisionsOpen.has(`${card.fin}:${card.report}`),
    }))
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
