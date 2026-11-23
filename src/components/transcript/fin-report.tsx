import { memo, use, useState } from "react"
import { GitPullRequestIcon, LinkIcon } from "lucide-react"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { AgentAvatar, StillMark } from "@/components/transcript/message-avatar"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { formatTime } from "@/lib/format"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { useAcpConversation } from "@/state/acp-state"
import { acpStore } from "@/state/acp"
import { openFinInApex, threadChildren, useApexTitle, useThreadChildren } from "@/state/apex-fins"
import { scrollShiverNeedsIntoView } from "@/state/shiver-card-view"
import { asked, asksPerson, reportsPhrase, reportStays, said } from "@/lib/fin-report-words"
import { Collapse } from "@/components/ui/collapse"
import { FoldLine } from "@/components/transcript/fold-line"
import { setTurnFoldOpen, turnFoldKey, useTurnFolds } from "@/state/turn-folds"
import { useWakeReports, type WakeReport } from "@/components/transcript/use-wake-reports"

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
      {standing.map((report) =>
        asksPerson(report.card) ? <ReportLine key={report.card.report} report={report} /> : <ReportBlock key={report.card.report} card={report.card} timestamp={timestamp} />
      )}
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
 * A report as one line of the transcript: its Fin's mark and name, one word for what it did, and what it said, cut
 * to the line until it's pressed (on a phone it takes the line under its name). A question for the person is always this line, never a card with buttons: the
 * Shiver card under the transcript is where it's answered, so an open question has one place to answer it, and
 * the line says where ("Answer below", which brings the card's Needs you back). Once the roster lets it go the
 * line says it was asked, and with what it was answered while the roster says (`WakeReport.answered`). Told what
 * it draws by whoever holds the wake (`useWakeReports`), so a line listens to nothing itself.
 */
export const ReportLine = memo(function ReportLine({ report }: { report: WakeReport }) {
  const { card, waits, answered } = report
  const source = useTranscriptSource()
  const routed = use(RoutedOpenContext)
  const [whole, setWhole] = useState(false)
  // Its Fin is looked up when the name is pressed, from what the window holds then.
  const openFin = () => {
    const state = acpStore.get()
    const apex = source.liveId ? state.conversations[source.liveId] : undefined
    const fin = threadChildren(state, apex?.threadId).find((agent) => agent.child?.thread === card.fin)
    if (!apex?.threadId || !fin) return
    if (routed) routed(fin)
    else openFinInApex(apex.threadId, apex.title ?? "Apex", fin)
  }
  const { word, tone } = asksPerson(card) && !waits ? asked(card) : said(card)
  return (
    <div data-report-line={card.status} data-fin={card.fin} data-report-waits={waits ? "" : undefined} className="flex min-h-7 min-w-0 items-start gap-2 py-0.5 text-ui">
      <StillMark harness={card.harness} kind={card.apex ? "thread" : "fin"} size={16} cut="var(--surface)" label={card.name} className="mt-1 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        {card.apex ? (
          <span className="max-w-[60%] shrink-0 truncate text-foreground">{card.name}</span>
        ) : (
          <button type="button" data-report-line-fin onClick={openFin} title={`Open ${card.name}`} className="pressable max-w-[60%] shrink-0 truncate text-foreground hover:underline">
            {card.name}
          </button>
        )}
        <span className={cn("shrink-0 text-label font-medium", tone)}>{word}</span>
        {card.line ? (
          <button
            type="button"
            data-report-line-words
            aria-expanded={whole}
            title={whole ? undefined : card.line}
            onClick={() => setWhole((value) => !value)}
            className={cn("min-w-0 flex-1 basis-48 text-left text-muted-foreground hover:text-foreground [overflow-wrap:anywhere]", !whole && "truncate")}
          >
            {card.line}
          </button>
        ) : (
          <span className="flex-1" />
        )}
        {waits ? (
          <button type="button" data-report-answer onClick={scrollShiverNeedsIntoView} className="pressable shrink-0 text-label text-faint hover:text-foreground">
            Answer below
          </button>
        ) : answered ? (
          <span data-report-answered className="max-w-[60%] shrink-0 truncate text-label text-faint">{answered}</span>
        ) : null}
      </div>
    </div>
  )
})

/**
 * A report that needs someone and isn't the person's to answer, never folded: in the answer's column, its Fin's mark
 * and name (which opens it), one word for what it did, and what it said held to four lines until it's opened.
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
  const fin = children.find((agent) => agent.child?.thread === card.fin)
  const [whole, setWhole] = useState(false)
  const { word, tone } = said(card)
  const routed = use(RoutedOpenContext)
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
