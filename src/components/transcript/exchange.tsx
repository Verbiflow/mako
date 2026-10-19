import { useHarnessIdentity } from "@/lib/harness-label"
import { PlanContextChips } from "@/components/composer/plan-context"
import { ProposedPlanCard } from "./proposed-plan"
import { ChangingLabel } from "@/components/ui/changing-label"
import { Collapse } from "@/components/ui/collapse"
import { RewindButton, PromptRewindButton } from "./rewind-button"
import { useCopy } from "@/components/ui/use-copy"
import { completeLiveAnswer } from "@/state/live-history"
import { copyPromptSelection } from "./prompt-clipboard"
import { acp, useAcp, type ForkAnswer } from "@/state/acp"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { acpStore } from "@/state/acp-state"
import { PlanSummary } from "./tool-details"
import { ReviewFindings, ReviewRequest } from "./review-card"
import { TranscriptAttachments } from "./attachment-collection"
import { memo, useMemo, useState } from "react"
import { Prose } from "@/components/transcript/markdown"
import { ToolRow } from "@/components/transcript/tool-row"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { ActivityMark } from "@/components/ui/activity-mark"
import type { ToolKind } from "@mako/sessions/tool-identity"
import { ContextItemChip } from "@/components/composer/reference-chip"
import { Slot } from "@/extend/slot"
import {
  pairTools,
  reportedSubagentCount,
  summarizeToolWork,
  type ToolWorkSummary,
} from "@/lib/tools"
import { formatTime, textOf } from "@/lib/format"
import { readSent } from "@/lib/context/sent"
import { sentDraft } from "@/lib/context/draft"
import { MARKER } from "@/lib/context/wire"
import type { SentProse } from "@/lib/prompt-markdown"
import {
  notesBesideStop,
  responseSections,
  responseText,
  type Exchange as ExchangeData,
  type ResponseSection,
} from "@/lib/exchanges"
import { EventNotes } from "./event-notes"
import { EventLine } from "./event-line"
import { ShowOriginal } from "./show-original"
import { causeWords, eventWords, type EventWords } from "@/lib/transcript-events"
import { actions, shallowEqual, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import { continueTargets } from "@/state/descriptors"
import { continueTurn } from "@/state/acp-queue"
import { AUTO_CONTINUE_NOTE, savedMakoPrompt, turnStopLabel, type CarriedHistory, type MakoPrompt, type TurnStop } from "@/state/prompt-delivery"
import { viewer } from "@/state/viewer"
import { AnswerTimeContext, useTranscriptSource } from "./source-context"
import { harnessLabels, harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import type { ChatMessage, MessageOrigin } from "@/lib/types"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  GitForkIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TargetIcon,
  TriangleAlertIcon,
} from "lucide-react"

/**
 * One question and the answer to it.
 *
 * Grouping by exchange is what lets the prompt be unmistakably the user's —
 * it gets its own surface rather than a hairline that reads like a quote — and
 * what lets "copy" mean "the agent's answer to this", once, instead of
 * appearing on every fragment of a long reply.
 */
export const Exchange = memo(function Exchange({
  exchange,
  streaming,
  interrupted,
  sentByMako,
  carried,
  failed,
}: {
  exchange: ExchangeData
  streaming?: boolean
  /** True when the turn stopped early; a `TurnStop` also says why and whether it can be continued. */
  interrupted?: boolean | TurnStop
  /** Mako sent this exchange's prompt itself, so it's drawn as Mako's line. */
  sentByMako?: MakoPrompt
  /** The conversation this exchange's prompt carried to a new session: one quiet line above the person's words. */
  carried?: CarriedHistory
  failed?: boolean
}) {
  useHarnessIdentity()
  // A saved conversation keeps no request, and the person's Continue turn
  // sends Mako's words as an ordinary message: either is known by its words.
  const savedByMako = useMemo(
    () => (sentByMako || !exchange.prompt ? undefined : savedMakoPrompt(textOf(exchange.prompt.blocks))),
    [sentByMako, exchange.prompt]
  )
  const mako = sentByMako ?? savedByMako
  const stopShown = Boolean(interrupted) && !streaming
  const notes = useMemo(
    () => (stopShown ? notesBesideStop(exchange.system, exchange.response.length) : exchange.system),
    [exchange.system, exchange.response.length, stopShown]
  )
  const sections = useMemo(
    () => responseSections(exchange.response, notes),
    [exchange.response, notes]
  )
  const lastWork = sections.findLastIndex((section) => section.kind !== "note")
  const details = exchange.response.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === "toolResult" ? (block.details ?? []) : []))
  )
  const plan = details.filter((detail) => detail.type === "plan").at(-1)
  const review = details.filter((detail) => detail.type === "review").at(-1)
  const provider = exchange.response.find(
    (message) => message.provider && harnessLabels()[message.provider]
  )?.provider
  const finishedAt = streaming ? undefined : (exchange.response.at(-1) ?? exchange.prompt ?? exchange.opener)?.timestamp
  return (
    <AnswerTimeContext.Provider value={finishedAt}>
      <article data-exchange={exchange.id} className="contain-turn scroll-mt-6">
        {exchange.prompt ? (
          mako?.kind === "continued" ? (
            <Continued continued={mako} provider={provider} said={textOf(exchange.prompt.blocks)} timestamp={exchange.prompt.timestamp} origin={exchange.prompt.origin} />
          ) : mako?.kind === "moved" ? (
            <MovedNote timestamp={exchange.prompt.timestamp} origin={exchange.prompt.origin} />
          ) : mako?.kind === "goal" ? (
            <GoalNote step={mako.step} timestamp={exchange.prompt.timestamp} origin={exchange.prompt.origin} />
          ) : mako?.kind === "review" ? (
            <ReviewRequest target={mako.target} timestamp={exchange.prompt.timestamp} />
          ) : (
            <>
              {carried ? <CarriedLine carried={carried} time={exchange.prompt.timestamp} /> : null}
              <Prompt message={exchange.prompt} />
            </>
          )
        ) : exchange.opener ? (
          <ProviderTurn message={exchange.opener} provider={provider} />
        ) : null}
        <SystemNotes messages={notes.flatMap((note) => (note.after === 0 ? [note.message] : []))} refused={exchange.refused} />

        {sections.length > 0 ? (
          <div className={cn("flex flex-col gap-4", (exchange.prompt || exchange.opener) && "mt-4")}>
            {provider ? <AgentByline provider={provider} /> : null}
            {sections.map((section, index) =>
              section.kind === "note" ? (
                sections[index - 1]?.kind === "note" ? null : (
                  <SystemNotes key={section.id} messages={noteRun(sections, index)} refused={exchange.refused} inline />
                )
              ) : section.kind === "steer" ? (
                <div key={section.id} className="mt-1">
                  <p className="mb-1 text-right text-label text-faint">
                    Steered mid-turn
                  </p>
                  <Prompt message={section.message} />
                </div>
              ) : section.kind === "prose" ? (
                <Response key={section.id} message={section.message} previewedFiles={section.previewedFiles} showWork />
              ) : (
                <WorkSection
                  key={section.id}
                  messages={section.messages}
                  startedAt={index === 0 ? (exchange.prompt ?? exchange.opener)?.timestamp : undefined}
                  live={Boolean(streaming && index === lastWork)}
                  interrupted={Boolean(interrupted) && index === lastWork}
                  failed={Boolean(failed && index === lastWork)}
                />
              )
            )}
          </div>
        ) : null}

        {plan ? (
          <div className="mt-3">
            <PlanSummary plan={plan} />
          </div>
        ) : null}
        {review ? (
          <div className="mt-3">
            <ReviewFindings report={review} />
          </div>
        ) : null}
        {exchange.response.length > 0 || interrupted ? (
          <Footer exchange={exchange} streaming={streaming} interrupted={interrupted} />
        ) : null}
      </article>
    </AnswerTimeContext.Provider>
  )
})

function AgentByline({ provider }: { provider: string }) {
  useHarnessIdentity()
  return (
    <div className="flex items-center gap-1.5 text-label text-faint">
      <HarnessIcon harness={provider} className="size-3.5" />
      <span>{harnessLabels()[provider] ?? provider}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* the prompt                                                          */
/* ------------------------------------------------------------------ */

type ContinuedPrompt = Extract<MakoPrompt, { kind: "continued" }>

/** What a continuation's line says, by who sent it; one read back from before the words named a sender says only what happened. */
function continuedTitle({ reason, sender }: ContinuedPrompt, provider: string): string {
  const who = sender === "mako" ? "Mako continued the turn" : sender === "person" ? "You continued the turn" : "The turn continued"
  switch (reason) {
    case "connection-lost":
      return `${who} after the connection to ${provider} dropped`
    case "provider-exited":
      return sender === "mako" ? `Mako restarted ${provider} and continued the turn` : `${who} after ${provider} stopped unexpectedly`
    case "signed-out":
      return `${who} after ${provider} signed in again`
    case "host-quit":
    case "host-crashed":
    case "stopped":
      return `${who} after Mako closed`
  }
}

/**
 * A continuation of a turn that was cut short. Its words are Mako's,
 * whether Mako sent them on its own or the person pressed Continue turn, so
 * it does not get the user's bubble: one quiet line where the prompt would
 * be, saying what happened and who acted, with the moment. What the agent
 * was told opens under it.
 */
function Continued({ continued, provider, said, timestamp, origin }: { continued: ContinuedPrompt; provider?: string; said: string; timestamp?: number; origin?: MessageOrigin }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const agent = provider ?? harness
  return (
    <EventLine
      align="end"
      icon={continued.reason === "provider-exited" ? RefreshCwIcon : PlayIcon}
      time={timestamp}
      data-turn-continued={continued.reason}
      data-continued-by={continued.sender ?? "unknown"}
      words={{ title: continuedTitle(continued, agent ? harnessLabel(agent) : "the provider") }}
      action={<ShowOriginal origins={[origin]} />}
    >
      {said.trim() ? <p className="text-faint">{said.trim()}</p> : null}
    </EventLine>
  )
}

/**
 * Where a session began from another one's history: a quiet line above the
 * person's words, never a message of its own, since what the agent was told
 * is Mako's framing and not what the person typed. Its action opens the
 * transcript the agent was given, the file it reads.
 */
function CarriedLine({ carried, time }: { carried: CarriedHistory; time?: number }) {
  const from = carried.from.map((harness) => harnessLabel(harness)).join(" and ")
  const turns = carried.turns === undefined ? undefined : `${carried.turns} turn${carried.turns === 1 ? "" : "s"}`
  return (
    <EventLine
      align="end"
      icon={HistoryIcon}
      time={time}
      data-carried-history=""
      words={{ title: from ? `Continued from ${from}` : "Continued with the conversation so far", detail: [turns].filter(Boolean).join(" · ") || undefined }}
      action={
        <button
          type="button"
          data-open-transcript=""
          onClick={() => void viewer.open(carried.file)}
          title="The transcript the agent was given"
          className="pressable flex h-5 items-center gap-1 rounded px-1 hover:text-foreground focus-visible:text-foreground"
        >
          <FileTextIcon className="size-3" />
          <span>Transcript</span>
        </button>
      }
    />
  )
}

/** Mako told the agent it's on its Thread's own branch now, after the move it asked for. */
function MovedNote({ timestamp, origin }: { timestamp?: number; origin?: MessageOrigin }) {
  return (
    <EventLine align="end" icon={GitBranchIcon} time={timestamp} data-turn-moved words={{ title: "Mako moved this session onto its own branch" }} action={<ShowOriginal origins={[origin]} />} />
  )
}

const GOAL_NOTES = {
  continue: "Mako continued toward the goal",
  clear: "Mako cleared the unfinished goal to set the new one",
  pause: "Mako paused the goal when the turn was stopped",
  set: "Mako set the goal",
  resume: "Mako resumed the goal",
} as const satisfies Record<MakoGoalStep["step"], string>

type MakoGoalStep = Extract<MakoPrompt, { kind: "goal" }>["step"]

/** A message Mako's goal sent on its own, such as the next turn toward it. */
function GoalNote({ step, timestamp, origin }: { step: MakoGoalStep; timestamp?: number; origin?: MessageOrigin }) {
  return (
    <EventLine
      align="end"
      icon={TargetIcon}
      time={timestamp}
      data-goal-step={step.step}
      words={{ title: GOAL_NOTES[step.step], detail: step.step === "continue" && step.turn ? `turn ${step.turn}` : undefined }}
      action={<ShowOriginal origins={[origin]} />}
    />
  )
}

/** Past this, a provider's sentence standing alone may not fit its line, so the line opens onto it. */
const LONG_CAUSE = 96

/**
 * A turn the provider started itself, where a prompt would stand: what
 * settled, in the transcript's words when the provider said what it was,
 * else in the provider's own. What opens under it is what the work left to
 * read: an agent's report, the end of a command's output, a monitor's
 * event. The provider's sentence opens only when the line couldn't say it
 * whole; once a cause words the line, the sentence would only repeat it.
 */
function ProviderTurn({ message, provider }: { message: ChatMessage; provider?: string }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const agent = provider ?? harness
  const said = textOf(message.blocks)
  const note = message.note
  const words: EventWords = note?.cause
    ? causeWords(note.cause, agent ? harnessLabel(agent) : undefined)
    : note
      ? eventWords(note)
      : { glyph: "notice", title: said }
  if (note?.tone && !words.tone) words.tone = note.tone
  const quoted = !note?.cause && !note?.body && said.length > LONG_CAUSE
  return (
    <EventLine align="end" words={words} time={message.timestamp} data-provider-turn={note?.cause?.kind ?? "said"} action={<ShowOriginal origins={[message.origin]} />}>
      {note?.body ? (
        <Prose text={note.body} className="event-prose" />
      ) : quoted ? (
        <p className="text-faint">{said}</p>
      ) : null}
    </EventLine>
  )
}

function Prompt({ message }: { message: ChatMessage }) {
  const raw = textOf(message.blocks)
  // One reading of what was sent (`readSent`): the words with a marker where
  // each chip stood and the items they number, from this build's context
  // block or an older prompt's appendices alike. The bubble draws chips from
  // it, and Reuse, Edit and copy put the same message back as a draft.
  const sent = useMemo(() => readSent(raw), [raw])
  const media = useMemo(
    () => message.blocks.filter((block) => block.type === "attachment"),
    [message.blocks]
  )
  const reused = useMemo(() => sentDraft(sent, media), [sent, media])
  const prose = useMemo<SentProse>(() => ({ items: sent.items, records: reused.byItem }), [sent.items, reused.byItem])
  // An item the words place shows there; a file placed nowhere shows below.
  const placed = useMemo(
    () => new Set(Array.from(sent.body.matchAll(MARKER), (match) => Number(match[2]))),
    [sent.body]
  )
  const unplacedFiles = useMemo(
    () => sent.items.flatMap((item) => (item.kind === "file" && item.file.path && !placed.has(item.n) ? [item] : [])),
    [sent.items, placed]
  )
  const shownPaths = useMemo(
    () => new Set(sent.items.flatMap((item) => (item.kind === "file" && item.file.path && placed.has(item.n) ? [item.file.path] : []))),
    [sent.items, placed]
  )
  const { copied, copy } = useCopy(reused.text, reused.records)
  const compose = () =>
    window.dispatchEvent(
      new CustomEvent("mako:compose", {
        detail: { text: reused.text, attachments: reused.records, plans: reused.plans },
      })
    )
  // Edit and Fork exist only where the session tree knows this message —
  // native conversations. A foreign transcript's synthetic ids stay quiet.
  const node = useSession((state) => {
    const found = state.tree.find((entry) => entry.id === message.id)
    return found ? { id: found.id, parentId: found.parentId } : null
  }, shallowEqual)

  const editHere = async () => {
    // Rewind the conversation to just before this prompt, then hand the
    // words back for editing. Nothing is lost: the turns that followed
    // stay reachable as a branch in History.
    if (!node) return
    if (node.parentId) await actions.navigate(node.parentId)
    compose()
  }

  return (
    <div className="group/prompt relative flex flex-col items-end">
      {/* The user's words are a bubble, not a slab: right-aligned and capped
          at a reading measure, unmistakably theirs without a ring. The
          assistant's reply below stays full-width and chrome-free. */}
      <div onCopy={event => copyPromptSelection(event, reused.records)} className="max-w-[min(82%,64ch)] rounded-xl rounded-br-md bg-raised px-3.5 py-2.5">
        <Prose text={sent.body} sent={prose} className="prompt-prose whitespace-normal" />
        <PlanContextChips plans={reused.plans} />
        <TranscriptAttachments attachments={media.filter(
          (block) =>
            block.source.kind !== "file" ||
            /^(?:image|audio|video)\//i.test(block.mimeType) ||
            !shownPaths.has(block.source.path)
        )} />
        {unplacedFiles.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {unplacedFiles.map((item) => (
              <ContextItemChip key={item.n} item={item} record={reused.byItem.get(item.n)} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-1 flex min-h-6 items-center justify-end gap-2 px-0.5 text-label text-muted-foreground">
        <button type="button" aria-label="Copy question" onClick={() => void copy()} className="pressable flex h-6 items-center gap-1 rounded px-1 hover:bg-fill-hover hover:text-foreground">
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {copied ? "Copied question" : "Copy question"}
        </button>
        {message.timestamp ? (
          <span className="tabular">{formatTime(message.timestamp)}</span>
        ) : null}
        <button
          type="button"
          title="Put this prompt back in the composer"
          onClick={compose}
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <RotateCcwIcon className="size-3" />
          Reuse
        </button>
        <PromptRewindButton requestId={message.requestId} />
        {node ? (
          <>
            <button
              type="button"
              title="Rewind to here and re-ask — later turns stay on their own branch"
              onClick={() => void editHere()}
              className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <PencilIcon className="size-3" />
              Edit
            </button>
            <button
              type="button"
              title="Branch from this point into a new tab — both lines stay open"
              onClick={() => void actions.fork(message.id)}
              className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <GitForkIcon className="size-3" />
              Fork
            </button>
          </>
        ) : null}
        <ShowOriginal origins={[message.origin]} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* the response                                                        */
/* ------------------------------------------------------------------ */

interface WorkSummaryData extends ToolWorkSummary {
  duration?: number
}

function summarizeWork(
  messages: ChatMessage[],
  started?: number
): WorkSummaryData {
  const calls = messages.flatMap((message) => pairTools(message.blocks))
  const summary = summarizeToolWork(calls)
  const agents = Math.max(summary.agents, ...calls.map(reportedSubagentCount))
  const completed = messages.at(-1)?.timestamp
  return {
    ...summary,
    agents,
    duration:
      started !== undefined && completed !== undefined && completed >= started
        ? completed - started
        : undefined,
  }
}

function WorkSection({
  messages,
  startedAt,
  live,
  interrupted,
  failed,
}: {
  messages: ChatMessage[]
  startedAt?: number
  live: boolean
  interrupted: boolean
  failed: boolean
}) {
  const [open, setOpen] = useState(false)
  const work = useMemo(
    () => summarizeWork(messages, startedAt),
    [messages, startedAt]
  )
  const folded = work.tools >= 3
  // One tree whether or not the log folds, so a turn crossing the fold
  // threshold mid-stream keeps its rows mounted.
  const summarized = folded && !live
  return (
    <div className="flex flex-col">
      {summarized ? (
        <WorkSummary
          work={work}
          interrupted={interrupted}
          failed={failed}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />
      ) : null}
      <Collapse open={!summarized || open}>
        <div
          data-work-log
          className={cn(
            "flex flex-col",
            summarized && "mt-1.5 ml-[6.5px] border-l border-hairline pb-1 pl-4"
          )}
        >
          {messages.map((message) => (
            <Response key={message.id} message={message} showWork />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

/**
 * What a folded stretch of tool calls did, said the way the transcript says
 * everything else: "Ran 5 commands and read a file". The glyphs in front
 * are the kinds of step, in the same order, so the row can be read at a
 * glance without the words; the open log hangs from them on a hairline.
 */
const WORK_PHRASES = [
  { glyph: "edit", count: (work) => work.changedFiles, phrase: (n) => `edited ${n === 1 ? "a file" : `${n} files`}` },
  { glyph: "shell", count: (work) => work.commands, phrase: (n) => `ran ${n === 1 ? "a command" : `${n} commands`}` },
  { glyph: "read", count: (work) => work.reads, phrase: (n) => `read ${n === 1 ? "a file" : `${n} files`}` },
  { glyph: "search", count: (work) => work.searches, phrase: (n) => `searched ${n === 1 ? "once" : `${n} times`}` },
  { glyph: "skill", count: (work) => work.skills, phrase: (n) => `used ${n === 1 ? "a skill" : `${n} skills`}` },
  { glyph: "agent", count: (work) => work.agents, phrase: (n) => `started ${n === 1 ? "an agent" : `${n} agents`}` },
  { glyph: "todo", count: (work) => work.plans, phrase: (n) => `updated the plan${n === 1 ? "" : ` ${n} times`}` },
  { glyph: "other", count: (work) => work.other, phrase: (n) => `used ${n === 1 ? "another tool" : `${n} other tools`}` },
] satisfies Array<{
  glyph: ToolKind
  count: (work: WorkSummaryData) => number
  phrase: (count: number) => string
}>

function describeWork(work: WorkSummaryData) {
  const done = WORK_PHRASES.flatMap((entry) => {
    const count = entry.count(work)
    return count > 0 ? [{ glyph: entry.glyph, count, text: entry.phrase(count) }] : []
  })
  const shown = done.slice(0, 3)
  const rest = done.slice(3).reduce((total, entry) => total + entry.count, 0)
  const parts = [
    ...shown.map((entry) => entry.text),
    ...(rest > 0 ? [`${rest} more ${rest === 1 ? "step" : "steps"}`] : []),
  ]
  const text =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
      : (parts[0] ?? `used ${work.tools} tools`)
  return { glyphs: shown.map((entry) => entry.glyph), text }
}

function WorkSummary({
  work,
  interrupted,
  failed,
  open,
  onToggle,
}: {
  work: WorkSummaryData
  interrupted: boolean
  failed: boolean
  open: boolean
  onToggle: () => void
}) {
  const elapsed =
    work.duration !== undefined ? formatDuration(work.duration) : undefined
  const { glyphs, text } = describeWork(work)
  const troubled = interrupted || failed
  const stop = interrupted ? "Interrupted" : "Failed"
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-work-summary
      className={cn(
        "pressable group/work -mx-1.5 flex h-7 max-w-full items-center gap-2 self-start rounded-md px-1.5 text-ui transition-colors duration-100 hover:bg-fill-hover",
        interrupted
          ? "text-caution"
          : failed
            ? "text-negative"
            : "text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
      )}
    >
      {troubled ? (
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <span aria-hidden className="flex shrink-0 items-center gap-1 text-faint transition-colors duration-100 group-hover/work:text-muted-foreground">
          {glyphs.map((glyph) => (
            <ToolGlyph key={glyph} kind={glyph} className="size-3.5" />
          ))}
        </span>
      )}
      <span className="min-w-0 truncate">
        {troubled ? (
          <>
            {elapsed ? `${stop} after ${elapsed}` : stop}
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">
              <ChangingLabel text={text} />
            </span>
          </>
        ) : (
          <ChangingLabel text={text.charAt(0).toUpperCase() + text.slice(1)} />
        )}
      </span>
      {work.failed > 0 ? (
        <span className="shrink-0 text-negative">{work.failed} failed</span>
      ) : null}
      {work.stopped > 0 ? (
        <span className="shrink-0 text-faint">{work.stopped} stopped</span>
      ) : null}
      {work.cutOff > 0 ? (
        <span className="shrink-0 text-faint">{work.cutOff} cut off</span>
      ) : null}
      {elapsed && !troubled ? (
        <span className="shrink-0 text-label text-faint tabular">{elapsed}</span>
      ) : null}
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-[transform,opacity] duration-200 ease-[var(--ease-out)]",
          open ? "rotate-90 opacity-80" : "opacity-40 group-hover/work:opacity-80"
        )}
      />
    </button>
  )
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes < 60)
    return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function Response({
  message,
  showWork,
  previewedFiles,
}: {
  message: ChatMessage
  showWork: boolean
  previewedFiles?: readonly string[]
}) {
  const showThinking = usePrefs((prefs) => prefs.showThinking)

  const { thinking, tools, text } = useMemo(() => {
    const thinkingParts: string[] = []
    const textParts: string[] = []
    for (const block of message.blocks) {
      if (block.type === "thinking" && block.thinking)
        thinkingParts.push(block.thinking)
      if (block.type === "text" && block.text) textParts.push(block.text)
    }
    return {
      thinking: thinkingParts.join("\n\n"),
      tools: pairTools(message.blocks),
      text: textParts.join(""),
    }
  }, [message.blocks])

  const attachments = message.blocks.flatMap((block) =>
    block.type === "attachment" ? [block] : []
  )
  const proposals = message.blocks.filter(
    (block) => block.type === "proposed-plan"
  )
  const visible =
    proposals.length ||
    attachments.length ||
    text ||
    message.error ||
    (showWork && tools.length > 0) ||
    (showWork && showThinking && thinking)
  if (!visible) return null

  return (
    <div className="flex flex-col gap-2.5">
      {showWork && ((thinking && showThinking) || tools.length > 0) ? (
        <div className="flex flex-col">
          {thinking && showThinking ? (
            <Thinking text={thinking} live={Boolean(message.streaming && !text && !tools.length)} />
          ) : null}
          {tools.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      ) : null}

      <TranscriptAttachments attachments={attachments} />
      {proposals.map((plan) => (
        <ProposedPlanCard
          key={plan.id}
          plan={plan}
          streaming={message.streaming}
        />
      ))}
      {text ? <Prose text={text} streaming={message.streaming} previewedFiles={previewedFiles} answerId={message.id} /> : null}

      {message.error ? (
        // The failure is the content here, so all of it shows: the glyph in
        // the tool column and the words in the error's tone, no card.
        <div role="alert" data-event-error className="flex items-start gap-2 text-ui text-negative">
          <CircleAlertIcon aria-hidden className="mt-[3px] size-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{message.error}</span>
        </div>
      ) : null}

    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  const trimmed = text.trim()
  const lastLine = trimmed
    .slice(trimmed.lastIndexOf("\n") + 1)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`#>]+/g, "")
    .trim()
  const summary = lastLine.length > 120 ? `…${lastLine.slice(-119)}` : lastLine
  const layer = "absolute inset-0 m-auto size-3.5 [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${live ? "Reasoning in progress" : "Reasoning"}${summary ? `: ${summary}` : ""}`}
        className="pressable group/think -mx-1.5 flex h-7 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui transition-colors duration-100 hover:bg-fill-hover"
      >
        <span className="relative size-3.5 shrink-0">
          <ToolGlyph
            kind="think"
            className={cn(layer, live ? "text-foreground/80" : "text-faint", open ? "opacity-0" : "group-hover/think:opacity-0")}
          />
          <ChevronRightIcon
            className={cn(layer, "text-faint", open ? "rotate-90 opacity-100" : "opacity-0 group-hover/think:opacity-100")}
          />
        </span>
        <span className="shrink-0 text-muted-foreground">Thought process</span>
        {summary && !open ? <span className="min-w-0 truncate text-faint">{summary}</span> : null}
        <span className="flex-1" />
        {live ? (
          <span role="status" aria-label="Reasoning" className="shrink-0 text-muted-foreground">
            <ActivityMark state="reasoning" />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="ml-1.75 border-l border-hairline py-1.5 pl-3.75 text-muted-foreground">
          <Prose text={text} streaming={live} />
        </div>
      ) : null}
    </div>
  )
}

/** The note sections that run on from `start`, drawn together. */
function noteRun(sections: readonly ResponseSection[], start: number): ChatMessage[] {
  const run: ChatMessage[] = []
  for (let index = start; sections[index]?.kind === "note"; index++) {
    const section = sections[index]
    if (section?.kind === "note") run.push(section.message)
  }
  return run
}

/** Consecutive notes: provider markers as `EventNotes`, Mako's own separators between them. */
function SystemNotes({ messages, inline, refused }: { messages: readonly ChatMessage[]; inline?: boolean; refused?: ExchangeData["refused"] }) {
  const groups: ChatMessage[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (message.note && !message.opensTurn && last?.[0]?.note && !last[0].opensTurn) last.push(message)
    else groups.push([message])
  }
  return groups.map((group) =>
    group[0]!.opensTurn ? (
      // A cause delivered with the prompt above it: it reads as one, under it.
      <div key={group[0]!.id} className={cn("flex flex-col", inline ? "my-1" : "mt-1")}>
        <ProviderTurn message={group[0]!} />
      </div>
    ) : group[0]!.note ? (
      <EventNotes key={group[0]!.id} messages={group} inline={inline} refused={refused} />
    ) : (
      <SystemNote key={group[0]!.id} message={group[0]!} inline={inline} />
    )
  )
}

/** A system line with no marker behind it: the same quiet line, opening onto the rest when there is more. */
function SystemNote({ message, inline }: { message: ChatMessage; inline?: boolean }) {
  const text = textOf(message.blocks).trim()
  if (!text) return null
  const first = text.split("\n", 1)[0]!
  return (
    <EventLine words={{ glyph: "notice", title: first }} className={inline ? undefined : "my-3"} data-system-note>
      {first !== text || first.length > LONG_CAUSE ? <p className="whitespace-pre-wrap text-faint">{text}</p> : null}
    </EventLine>
  )
}

/* ------------------------------------------------------------------ */
/* one footer per answer                                               */
/* ------------------------------------------------------------------ */

function Footer({ exchange, streaming, interrupted }: { exchange: ExchangeData; streaming?: boolean; interrupted?: boolean | TurnStop }) {
  const { liveId } = useTranscriptSource()
  const text = responseText(exchange)
  const { copied, copy } = useCopy(text, undefined, () => completeLiveAnswer(liveId, exchange))
  const last = exchange.response.at(-1)
  if (!text && !last?.timestamp && !interrupted) return null

  return (
    <div className="mt-1.5 flex min-h-6 items-center gap-2.5 text-label text-muted-foreground">
      {interrupted && !streaming ? <Stopped stop={interrupted} /> : null}
      {last?.timestamp ? (
        <span className="tabular">{formatTime(last.timestamp)}</span>
      ) : null}
      {last?.model ? <span className="truncate">{last.model}</span> : null}
      {text ? (
        <button
          type="button"
          aria-label="Copy answer"
          title="Copy the agent's whole answer to this question"
          onClick={() => {
            void copy()
          }}
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          {copied ? (
            <CheckIcon className="size-3 text-positive" />
          ) : (
            <CopyIcon className="size-3" />
          )}
          <span role="status" className="min-w-20">
            <ChangingLabel text={copied ? "Copied answer" : "Copy answer"} />
          </span>
        </button>
      ) : null}
      {!streaming && !interrupted ? <ForkButton exchange={exchange} /> : null}
      {!streaming ? <ShowOriginal origins={exchange.response.map((message) => message.origin)} /> : null}
      {last ? <Slot name="transcript.turn.trailing" message={last} /> : null}
    </div>
  )
}

/**
 * Why the turn ended early. A bare `true` is a Stop with no recorded reason
 * (a foreign transcript's own marker). When Mako's exit or the provider's
 * own connection cut the newest turn short, the footer says which and offers
 * to pick the turn up; the offer sends through the same path as a typed
 * message, so it queues, steers or reopens the session exactly as one would.
 */
function Stopped({ stop }: { stop: true | TurnStop }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const [sending, setSending] = useState(false)
  const detail = stop === true ? undefined : stop
  const reason = detail?.reason ?? "stopped"
  const yours = reason === "stopped"
  return (
    <>
      <span data-turn-stopped={reason} className={cn("flex items-center gap-1.5", !yours && "text-foreground")}>
        {yours ? <CircleStopIcon aria-hidden className="size-3" /> : <TriangleAlertIcon aria-hidden className="size-3 text-caution" />}
        {turnStopLabel(reason, harness ? harnessLabel(harness) : "the provider")}
      </span>
      {detail?.automatic ? (
        // Mako is about to send the continuation itself: the live mark says
        // the thread is not finished, and there is nothing to press.
        <span data-turn-continuing className="flex items-center gap-1.5">
          <span className="animate-live size-1.5 rounded-full bg-ember" />
          <span>{AUTO_CONTINUE_NOTE}</span>
        </span>
      ) : null}
      {detail?.continuable && liveId ? (
        <button
          type="button"
          disabled={sending}
          onClick={() => {
            setSending(true)
            void continueTurn(liveId, reason).finally(() => setSending(false))
          }}
          className="pressable flex items-center gap-1 rounded px-1 text-foreground hover:bg-fill-hover disabled:opacity-50"
          title="Ask the agent to go on from where this turn stopped"
        >
          <PlayIcon className="size-3" />
          <span>{sending ? "Continuing…" : "Continue turn"}</span>
        </button>
      ) : null}
    </>
  )
}

/**
 * Fork from this answer. The conversation up to and including this turn
 * becomes a new Session — on the same harness or any other — while the
 * original stays open. It joins this Thread as a tab; Option-click puts it
 * in a Thread of its own. Foreign turns fork through the emitters (their
 * message ids carry the entry index); native turns already have Fork on
 * the prompt, so this stays quiet there.
 */
function ForkButton({ exchange }: { exchange: ExchangeData }) {
  useHarnessIdentity()
  const [open, setOpen] = useState(false)
  const scope = useConversationScope()
  const globalViewing = useThreads((state) => state.viewing?.ref)
  const viewing = scope ? (scope.kind === "history" ? scope.ref : undefined) : globalViewing
  const targets = useThreads((state) => continueTargets(state))
  const last = exchange.response.at(-1)
  const nativeEntry = useSession((state) =>
    last && state.tree.some((entry) => entry.id === last.id) ? last.id : null
  )
  const liveRequestId = useAcp((state) => {
    const live = scopedLiveAcp(state, scope)
    const requestId = exchange.prompt?.requestId
    if (!requestId) return null
    return live?.requests?.find((request) => request.id === requestId)
      ?.status === "completed"
      ? requestId
      : null
  })
  // A catalogued thread's answer carries its provider anchor; the fork names
  // that, not a position, so a store that moves under the reader still forks
  // at this answer.
  const anchor = last?.anchor
  const fromNative = useAcp((state) =>
    Boolean(anchor && !exchange.prompt?.requestId && scopedLiveAcp(state, scope)?.base)
  )
  const liveAnswer: ForkAnswer | undefined = liveRequestId
    ? { kind: "run", requestId: liveRequestId }
    : !viewing && fromNative && anchor
      ? { kind: "native", anchor }
      : undefined
  if (liveAnswer)
    return (
      <>
        <button
          type="button"
          title="Fork after this answer into a new tab in this Thread. Option-click forks into a new Thread."
          onClick={(event) => void acp.fork(liveAnswer, event.altKey ? "new" : "parent", scopedLiveAcp(acpStore.get(), scope))}
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <GitForkIcon className="size-3" /> Fork
        </button>
        {liveRequestId ? <RewindButton requestId={liveRequestId} /> : null}
      </>
    )
  if (!viewing && nativeEntry) {
    return (
      <button
        type="button"
        title="Fork from this completed answer into a new tab"
        onClick={() => void actions.fork(nativeEntry, "at")}
        className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
      >
        <GitForkIcon className="size-3" />
        Fork
      </button>
    )
  }
  if (!viewing || !anchor) return null
  const options = targets

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Fork from this answer into a new tab in this Thread, any agent. Option-click an agent to fork into a new Thread."
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <GitForkIcon className="size-3" />
          Fork
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-56 p-1"
      >
        <p className="px-2 pt-1.5 pb-1 text-label font-medium text-faint/80">
          Fork from here into
        </p>
        {options.map((target) => (
          <button
            key={target}
            type="button"
            onClick={(event) => {
              setOpen(false)
              void threads.forkAt(viewing, anchor, target, event.altKey ? "new" : "parent")
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-foreground/90 transition-colors duration-100 hover:bg-fill-hover"
          >
            <HarnessIcon harness={target} className="size-3.5" />
            <span className="flex-1">{harnessLabels()[target] ?? target}</span>
            {target === viewing.harness ? (
              <span className="text-label text-faint">same agent</span>
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
