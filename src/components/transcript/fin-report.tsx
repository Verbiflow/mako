import { memo, use, useState } from "react"
import { GitPullRequestIcon, LinkIcon } from "lucide-react"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { AgentAvatar } from "@/components/transcript/message-avatar"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { formatTime } from "@/lib/format"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { openFinInApex, useApexTitle, useThreadAsks, useThreadChildren } from "@/state/apex-fins"
import { answerFin, type FinAnswer } from "@/state/fin-asks"
import { said } from "@/components/transcript/fin-report-words"

/** A pull request's short name from its link ("#369"), else its label or its ref. */
function artifactName(artifact: NonNullable<FinReportCard["artifacts"]>[number]): string {
  const number = artifact.kind === "pull-request" ? /\/pull\/(\d+)/.exec(artifact.ref)?.[1] : undefined
  return artifact.label ?? (number ? `#${number}` : artifact.ref)
}

/**
 * The reports one wake carried to an Apex, as messages from their Fins: in the place the person's own message stands,
 * each Fin's fin where the person's face is, its name (which opens it), harness, one word for what it did, what it said,
 * its options and what it made. Read from the wake's data (`FinReportCard`), never from the words the Apex reads.
 */
export const FinReports = memo(function FinReports({ reports, timestamp }: { reports: readonly FinReportCard[]; timestamp?: number }) {
  return (
    <div data-fin-reports={reports.length} className="flex flex-col gap-3">
      {reports.map((card) => (
        <FinReport key={card.report} card={card} timestamp={timestamp} />
      ))}
    </div>
  )
})

const FinReport = memo(function FinReport({ card, timestamp }: { card: FinReportCard; timestamp?: number }) {
  useHarnessIdentity()
  const source = useTranscriptSource()
  const thread = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.threadId : undefined))
  const apexTitle = useApexTitle(source.liveId, source.threadPath)
  const children = useThreadChildren(card.apex ? undefined : thread)
  const asks = useThreadAsks(card.apex ? undefined : thread)
  const fin = children.find((agent) => agent.child?.thread === card.fin)
  // Its options answer the Fin while its ask is the person's and still open, through the crew card's own path.
  const open = asks.find((ask) => ask.fin === card.fin && ask.ask.kind === "report" && ask.ask.id === card.report)
  const [sent, setSent] = useState<number>()
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
    <div data-fin-report={card.status} data-fin={card.fin} className="flex w-full items-end justify-end gap-2.5">
      <div className="max-w-[min(82%,64ch)] bg-raised px-3.5 pt-2 pb-2.5">
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
        {card.line ? <p className="mt-0.5 text-prose leading-[1.6] text-foreground [overflow-wrap:anywhere]">{card.line}</p> : null}
        {card.waiting ? <p data-fin-report-waiting className="mt-0.5 text-label text-faint">{card.waiting}</p> : null}
        {options.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {options.map((option, index) => {
              const recommended = index === card.recommended
              const chosen = sent === index
              const body = (
                <>
                  {option.label}
                  {recommended ? <span className="opacity-65">recommended</span> : null}
                </>
              )
              const look = cn(
                "flex h-7 items-center gap-1.5 px-2.5 text-label",
                recommended || chosen ? "bg-foreground text-background" : "bg-fill-hover text-foreground"
              )
              return open ? (
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
              ) : (
                <span key={option.label} title={option.detail} className={cn(look, "opacity-75")}>
                  {body}
                </span>
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
      <AgentAvatar harness={card.harness} kind={card.apex ? "thread" : "fin"} label={card.name} />
    </div>
  )
})
