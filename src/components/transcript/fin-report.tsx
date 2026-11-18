import { memo, use, useMemo, useState } from "react"
import { GitPullRequestIcon, LinkIcon } from "lucide-react"
import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { childStateOf, openAsk } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
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
export const FinReports = memo(function FinReports({ reports: sent, timestamp }: { reports: readonly FinReportCard[]; timestamp?: number }) {
  const [shown, setShown] = useState(false)
  const source = useTranscriptSource()
  const thread = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.threadId : undefined))
  const children = useThreadChildren(thread)
  const asks = useThreadAsks(thread)
  // A decision its Apex left went to the person (`escalateDecision`): the report still says its Apex decides, the
  // roster says the person does, so it reads as theirs (its word, the head's count, open) from then on.
  const reports = useMemo(
    () => sent.map((card) => (card.decides === "lead" && asks.some((ask) => ask.fin === card.fin && ask.ask.kind === "report" && ask.ask.id === card.report) ? { ...card, decides: "person" as const } : card)),
    [sent, asks]
  )
  const decisionsOpen = useMemo(() => openDecisions(children), [children])
  const keep = (card: FinReportCard) => staysOpen(card, decisionsOpen)
  const open = reports.filter(keep)
  const folded = reports.filter((card) => !keep(card))
  // One report, or one to fold, reads best as it is.
  if (folded.length < 2)
    return (
      <div data-fin-reports={reports.length} className="flex flex-col gap-3">
        {reports.map((card) => (
          <FinReport key={card.report} card={card} timestamp={timestamp} />
        ))}
      </div>
    )
  const prs = folded.flatMap((card) => card.artifacts ?? []).filter((artifact) => artifact.kind === "pull-request").length
  return (
    <div data-fin-reports={reports.length} data-shiver-update className="flex flex-col gap-3">
      <p data-shiver-update-head className="flex items-baseline justify-end gap-1.5 text-label text-faint">
        {shiverUpdateWords(reports).map((part) => (
          <span key={part.text} className={part.tone}>{part.text}</span>
        ))}
        {timestamp ? (
          <time dateTime={new Date(timestamp).toISOString()} className="tabular pl-2">
            {formatTime(timestamp)}
          </time>
        ) : null}
      </p>
      {open.map((card) => (
        <FinReport key={card.report} card={card} />
      ))}
      {shown ? (
        folded.map((card) => <FinReport key={card.report} card={card} />)
      ) : (
        <button
          type="button"
          data-shiver-update-fold={folded.length}
          onClick={() => setShown(true)}
          className="pressable ml-auto flex max-w-[min(82%,64ch)] items-center gap-2 bg-raised/60 px-3.5 py-2 text-left text-ui text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          <span className="line-clamp-2 min-w-0">{foldedWords(folded)}</span>
          {prs ? (
            <span className="flex shrink-0 items-center gap-1 bg-fill-hover px-1.5 text-label">
              <GitPullRequestIcon aria-hidden className="size-3" />
              {prs === 1 ? "1 PR" : `${prs} PRs`}
            </span>
          ) : null}
          <span className="shrink-0 text-label text-faint">Show</span>
        </button>
      )}
    </div>
  )
})

/**
 * What stays open in a shiver update: what waits on the person, a failure, and a done Fin's decision while it's still open,
 * whoever's it is now: its Apex's, or the person's once the Apex left it (`escalateDecision`), when the roster says
 * `on: "person"` while the report still says `decides: "lead"`. Everything else folds into one line.
 */
function staysOpen(card: FinReportCard, decisionsOpen: ReadonlySet<string>): boolean {
  return (
    said(card).tone === "text-attention" ||
    card.status === "failed" ||
    (card.apex === true && card.status !== "done") ||
    decisionsOpen.has(`${card.fin}:${card.report}`)
  )
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

/** The update's head, one part a kind: "4 finished · Sheet motion needs you · 1 failed". */
function shiverUpdateWords(reports: readonly FinReportCard[]): { text: string; tone: string }[] {
  const needs = reports.filter((card) => said(card).tone === "text-attention")
  const failed = reports.filter((card) => card.status === "failed").length
  const others = reports.filter((card) => said(card).tone !== "text-attention" && card.status !== "failed")
  const rest = others.length
  const verb = others.every((card) => said(card).word === "finished") ? "finished" : "reported"
  return [
    ...(rest ? [{ text: `${rest} ${verb}`, tone: "" }] : []),
    ...(needs.length ? [{ text: `${needs.length === 1 ? `${needs[0]!.name} needs` : `${needs.length} need`} you`, tone: "text-attention" }] : []),
    ...(failed ? [{ text: `${failed} failed`, tone: "text-negative" }] : []),
  ].flatMap((part, index) => (index ? [{ text: "·", tone: "" }, part] : [part]))
}

/** The folded reports as one line: "Docs pass, Token sweep and 2 more finished". */
function foldedWords(folded: readonly FinReportCard[]): string {
  const names = folded.map((card) => card.name)
  const who = names.length <= 3 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
  const words = new Set(folded.map((card) => said(card).word))
  return `${who} ${words.size === 1 ? [...words][0] : "reported"}`
}

const FinReport = memo(function FinReport({ card, timestamp }: { card: FinReportCard; timestamp?: number }) {
  useHarnessIdentity()
  const source = useTranscriptSource()
  const thread = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.threadId : undefined))
  const apexTitle = useApexTitle(source.liveId, source.threadPath)
  const children = useThreadChildren(card.apex ? undefined : thread)
  const asks = useThreadAsks(card.apex ? undefined : thread)
  const fin = children.find((agent) => agent.child?.thread === card.fin)
  // Its options answer the Fin while its ask is the person's and still open, through the shiver card's own path.
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
      <AgentAvatar harness={card.harness} kind={card.apex ? "thread" : "fin"} label={card.name} />
    </div>
  )
})
