import { memo, use, useState } from "react"
import { GitPullRequestIcon, LinkIcon } from "lucide-react"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { AgentAvatar } from "@/components/transcript/message-avatar"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { formatTime } from "@/lib/format"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { useAcpConversation } from "@/state/acp-state"
import { openFinInApex, useApexTitle, useThreadAsks, useThreadChildren } from "@/state/apex-fins"
import { answerFin, type FinAnswer } from "@/state/fin-asks"
import { reportsPhrase, reportStays, said } from "@/lib/fin-report-words"
import { Collapse } from "@/components/ui/collapse"
import { FoldLine } from "@/components/transcript/fold-line"
import { setTurnFoldOpen, turnFoldKey, useTurnFolds } from "@/state/turn-folds"
import { useWakeReports } from "@/components/transcript/use-wake-reports"

/** A pull request's short name from its link ("#369"), else its label or its ref. */
function artifactName(artifact: NonNullable<FinReportCard["artifacts"]>[number]): string {
  const number = artifact.kind === "pull-request" ? /\/pull\/(\d+)/.exec(artifact.ref)?.[1] : undefined
  return artifact.label ?? (number ? `#${number}` : artifact.ref)
}

/**
 * Reports that reached an Apex inside something else: steered into its running turn, or joined to another message.
 * The same two forms a turn's own wake takes (`turnRows`): what needs someone as its own block, the rest behind one
 * line that opens onto each Fin's message.
 */
export const FinReports = memo(function FinReports({ reports: sent, timestamp }: { reports: readonly FinReportCard[]; timestamp?: number }) {
  const source = useTranscriptSource()
  // Kept where a turn's own fold keeps it (`turn-folds.ts`), by the first report the wake carried, so it comes back as it was left.
  const foldKey = turnFoldKey(source.liveId ?? source.threadPath, `reports:${sent[0]?.report ?? ""}`, 0)
  const shown = useTurnFolds((state) => state.open.has(foldKey))
  const reports = useWakeReports(sent)
  const standing = reports.filter((report) => reportStays(report.card, report.open))
  const folded = reports.filter((report) => !reportStays(report.card, report.open))
  return (
    <div data-fin-reports={reports.length} className="flex flex-col gap-3">
      {standing.map(({ card }) => (
        <ReportBlock key={card.report} card={card} timestamp={timestamp} />
      ))}
      {folded.length ? (
        <div data-turn-fold={shown ? "open" : "closed"} className="flex flex-col">
          <FoldLine title={reportsPhrase(folded.map((report) => report.card))} open={shown} onToggle={() => setTurnFoldOpen(foldKey, !shown)} />
          <Collapse open={shown}>
            <div data-turn-fold-body className="mt-1.5 ml-[6.5px] flex flex-col gap-3 border-l border-hairline pt-1 pb-1 pl-4">
              {folded.map(({ card }) => (
                <FinReport key={card.report} card={card} />
              ))}
            </div>
          </Collapse>
        </div>
      ) : null}
    </div>
  )
})

/** Past this many characters a report's line may run over the four lines its block shows. */
const LONG_REPORT = 240

/**
 * A report that needs someone, never folded: in the answer's column, its Fin's mark and name (which opens it), one
 * word for what it did, and what it said held to four lines until it's opened. Its options answer it in place.
 */
export const ReportBlock = memo(function ReportBlock({ card, timestamp }: { card: FinReportCard; timestamp?: number }) {
  return <FinReport card={card} timestamp={timestamp} block />
})

/** One Fin's report as its own message where the person's would stand, or with `block` as `ReportBlock` draws it. */
export const FinReport = memo(function FinReport({ card, timestamp, block }: { card: FinReportCard; timestamp?: number; block?: boolean }) {
  useHarnessIdentity()
  const source = useTranscriptSource()
  const thread = useAcpConversation(source.liveId, (conversation) => conversation?.threadId)
  const apexTitle = useApexTitle(source.liveId, source.threadPath)
  const children = useThreadChildren(card.apex ? undefined : thread)
  const asks = useThreadAsks(card.apex ? undefined : thread)
  const fin = children.find((agent) => agent.child?.thread === card.fin)
  // Its options answer the Fin while its ask is the person's and still open, through the crew card's own path.
  const open = asks.find((ask) => ask.fin === card.fin && ask.ask.kind === "report" && ask.ask.id === card.report)
  const [sent, setSent] = useState<number>()
  const [whole, setWhole] = useState(false)
  const { word, tone } = said(card)
  const answer = (option: number) => {
    if (!open || !source.liveId || sent !== undefined) return
    setSent(option)
    const choice: FinAnswer = { option }
    void answerFin(source.liveId, open, choice).then((answered) => {
      if (!answered) setSent(undefined)
    })
  }
  const routed = use(RoutedOpenContext)
  const options = card.options ?? []
  const made = (card.artifacts ?? []).filter((artifact) => artifact.kind === "pull-request" || artifact.kind === "link")
  return (
    <div data-fin-report={card.status} data-fin={card.fin} data-report-block={block ? "" : undefined} className={cn("flex w-full gap-2.5", block ? "items-start" : "items-end justify-end")}>
      {block ? <AgentAvatar harness={card.harness} kind={card.apex ? "thread" : "fin"} label={card.name} /> : null}
      <div className={block ? "min-w-0 max-w-[min(100%,72ch)] flex-1" : "max-w-[min(82%,64ch)] bg-raised px-3.5 pt-2 pb-2.5"}>
        <p className="flex min-w-0 items-baseline gap-1.5 text-label text-faint">
          {fin && thread ? (
            <button
              type="button"
              onClick={() => (routed ? routed(fin) : openFinInApex(thread, apexTitle ?? "Apex", fin))}
              title={`Open ${card.name}`}
              className="pressable min-w-0 truncate text-ui font-medium text-foreground hover:underline"
            >
              {card.name}
            </button>
          ) : (
            <span className="min-w-0 truncate text-ui font-medium text-foreground">{card.name}</span>
          )}
          {card.harness ? <span className="shrink-0">{harnessLabel(card.harness)}</span> : null}
          <span aria-hidden className="shrink-0">·</span>
          <span className={cn("shrink-0 font-medium", tone)}>{word}</span>
          {timestamp ? (
            <time dateTime={new Date(timestamp).toISOString()} className="tabular ml-auto shrink-0 pl-3">
              {formatTime(timestamp)}
            </time>
          ) : null}
        </p>
        {card.line ? <p data-fin-report-line className={cn("mt-0.5 text-prose leading-[1.6] text-foreground [overflow-wrap:anywhere]", block && !whole && "line-clamp-4")}>{card.line}</p> : null}
        {block && card.line.length > LONG_REPORT ? (
          <button type="button" data-fin-report-whole aria-expanded={whole} onClick={() => setWhole((value) => !value)} className="pressable mt-0.5 text-label text-faint hover:text-foreground">
            {whole ? "Show less" : "Show all"}
          </button>
        ) : null}
        {card.waiting ? <p data-fin-report-waiting className="mt-0.5 text-label text-faint">{card.waiting}</p> : null}
        {options.length && open ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {options.map((option, index) => {
              const recommended = index === card.recommended
              const chosen = sent === index
              const body = (
                <>
                  {option.label}
                  {recommended ? <span className="opacity-65">Recommended</span> : null}
                </>
              )
              const look = cn(
                "flex h-7 items-center gap-1.5 px-2.5 text-label",
                recommended || chosen ? "bg-foreground text-background" : "bg-fill-hover text-foreground"
              )
              return (
              <button
                key={option.label}
                type="button"
                data-fin-report-option={index}
                disabled={sent !== undefined}
                title={option.detail}
                onClick={() => answer(index)}
                className={cn("pressable disabled:opacity-60", look, !recommended && !chosen && "hover:bg-fill-selected")}
              >
                {body}
              </button>
              )
            })}
          </div>
        ) : null}
        {made.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {made.map((artifact) => {
              const link = /^https?:\/\//.test(artifact.ref)
              const Icon = artifact.kind === "pull-request" ? GitPullRequestIcon : LinkIcon
              const chip = (
                <>
                  <Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{artifactName(artifact)}</span>
                </>
              )
              const look = "flex h-6 max-w-72 items-center gap-1.5 bg-fill-hover px-2 text-label text-muted-foreground"
              return link ? (
                <a key={artifact.ref} href={artifact.ref} target="_blank" rel="noreferrer noopener" title={artifact.ref} className={cn(look, "pressable hover:text-foreground")}>
                  {chip}
                </a>
              ) : (
                <span key={artifact.ref} title={artifact.ref} className={look}>
                  {chip}
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
      {block ? null : <AgentAvatar harness={card.harness} kind={card.apex ? "thread" : "fin"} label={card.name} />}
    </div>
  )
})
