import { memo, use, useMemo } from "react"
import { Collapse } from "@/components/ui/collapse"
import { CompactPresentationContext } from "@/components/transcript/compact-presentation"
import { Exchange } from "@/components/transcript/exchange"
import { ReportLine } from "@/components/transcript/fin-report"
import { FoldLine } from "@/components/transcript/fold-line"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { useWakeReports } from "@/components/transcript/use-wake-reports"
import { replyProse, type Exchange as ExchangeData } from "@/lib/exchanges"
import { asksPerson, reportStays, runPhrase } from "@/lib/fin-report-words"
import { setTurnFoldOpen, turnFoldKey, useTurnFolds } from "@/state/turn-folds"

/** A run's own fold among its first turn's (`turnFoldKey`): no turn has a stretch numbered below zero. */
const RUN_FOLD = -1

/** What the Apex last said of its Fins' news in `turns`, as one line. */
function lastRemark(turns: readonly ExchangeData[]): string | undefined {
  for (let turn = turns.length - 1; turn >= 0; turn--) {
    const response = turns[turn]!.response
    for (let index = response.length - 1; index >= 0; index--) {
      const words = response[index]!.role === "assistant" ? replyProse(response[index]!.blocks).replace(/\s+/g, " ").trim() : ""
      if (words) return words
    }
  }
  return undefined
}

/**
 * A run of turns an Apex's Fins woke (`Exchange.run`), as one row: a line that counts what they reported, what
 * needs the person first ("1 Fin needs you · 1 failed · 4 finished"), then quieter the last thing the Apex said of
 * it, where the line has room. Under the closed line stands a line for each report a count must never be all that's said of it: a question
 * the person hasn't answered, a failure, an end without a result, a decision still open (`reportStays`). Opened,
 * the row is its turns as they were, each with its own line, reports and words.
 *
 * It listens to the roster once for the run, whatever it holds, and its turns mount when it's first opened.
 */
export const ReportRun = memo(function ReportRun({ exchange }: { exchange: ExchangeData }) {
  const { turns, cards } = exchange.run!
  const source = useTranscriptSource()
  const foldKey = turnFoldKey(source.liveId ?? source.threadPath, exchange.id, RUN_FOLD)
  const open = useTurnFolds((state) => state.open.has(foldKey))
  const reports = useWakeReports(cards)
  const title = useMemo(() => {
    const waiting = new Set(reports.flatMap((report) => (report.waits ? [report.card.report] : [])))
    return runPhrase(cards, (card) => waiting.has(card.report))
  }, [cards, reports])
  // What waits on the person first, then the rest in the order it came.
  const kept = useMemo(() => {
    const stay = reports.filter((report) => (asksPerson(report.card) ? report.waits : reportStays(report.card, report.open)))
    return [...stay.filter((report) => report.waits), ...stay.filter((report) => !report.waits)]
  }, [reports])
  const remark = useMemo(() => lastRemark(turns), [turns])
  const needs = kept.some((report) => report.waits)
  // A phone's line has room for the count alone.
  const compact = use(CompactPresentationContext)?.navigator === false
  return (
    <article data-exchange={exchange.id} data-report-run={turns.length} className="contain-turn scroll-mt-6">
      <div data-turn-fold={open ? "open" : "closed"} className="flex flex-col">
        <FoldLine title={title} detail={open || compact ? undefined : remark} open={open} strong={needs} onToggle={() => setTurnFoldOpen(foldKey, !open)} data-report-run-line="" />
        {!open && kept.length ? (
          <div data-report-run-kept={kept.length} className="mt-1 ml-[6.5px] flex flex-col pl-4">
            {kept.map((report, index) => (
              <ReportLine key={`${report.card.report}:${index}`} report={report} />
            ))}
          </div>
        ) : null}
        <Collapse open={open}>
          <div data-turn-fold-body className="mt-1.5 ml-[6.5px] flex flex-col gap-7 border-l border-hairline pt-1 pb-1 pl-4">
            {turns.map((turn) => (
              <Exchange key={turn.id} exchange={turn} within />
            ))}
          </div>
        </Collapse>
      </div>
    </article>
  )
})
