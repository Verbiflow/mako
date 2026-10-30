import { useHarnessIdentity } from "@/lib/harness-label"
import { MediaGalleryScope } from "@/components/viewer/media-gallery"
import { PlanContextChips } from "@/components/composer/plan-context"
import { ProposedPlanCard } from "./proposed-plan"
import { ChangingLabel } from "@/components/ui/changing-label"
import { Collapse } from "@/components/ui/collapse"
import { RewindButton, PromptRewindButton } from "./rewind-button"
import { useCopy } from "@/components/ui/use-copy"
import { completeLiveAnswer } from "@/state/live-history"
import { copyPromptSelection } from "./prompt-clipboard"
import { ExchangeNoteContext, MoveDividersContext, PromptNoteContext } from "./transcript-notes"
import { CompactPresentationContext, type CompactPresentation } from "./compact-presentation"
import { acp, useAcp, type ForkAnswer } from "@/state/acp"
import { descriptorFor } from "@/state/descriptors"
import { threadsStore } from "@/state/thread-store"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { acpStore } from "@/state/acp-state"
import { PlanSummary } from "./tool-details"
import { ReviewFindings, ReviewRequest } from "./review-card"
import { TranscriptAttachments } from "./attachment-collection"
import { memo, useContext, useMemo, useState, type ReactNode } from "react"
import { Prose } from "@/components/transcript/markdown"
import { Shimmer } from "@/components/ui/shimmer"
import { AgentMark, LeadSlot, ToolRow } from "@/components/transcript/tool-row"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { ExchangeFailure, TurnError } from "@/components/transcript/failure-row"
import { FailedRequestsContext } from "@/components/transcript/failed-requests"
import { AgentGroup } from "./agent-group"
import { groupAgentCalls } from "@/lib/agent-groups"
import { FollowingList, LiveRow, TurnClock, type LiveStepData } from "./live-step"
import { TurnChanges } from "./turn-changes"
import { TurnMedia } from "./media-shelf"
import { useShelfMedia } from "./use-shelf-media"
import { placeMadeMedia } from "@/lib/media-shelf"
import type { ToolKind } from "@mako/sessions/tool-identity"
import { ContextItemChip } from "@/components/composer/reference-chip"
import { Slot } from "@/extend/slot"
import {
  pairTools,
  reportedSubagentCount,
  summarizeToolWork,
  type ToolWorkSummary,
} from "@/lib/tools"
import { formatDuration, formatTime, textOf } from "@/lib/format"
import { turnFolds, type TurnFold } from "@/lib/turn-fold"
import { setTurnFoldOpen, turnFoldKey, useTurnFolds } from "@/state/turn-folds"
import { readSent } from "@/lib/context/sent"
import { sentDraft } from "@/lib/context/draft"
import { MARKER } from "@/lib/context/wire"
import type { SentProse } from "@/lib/prompt-markdown"
import {
  exchangeRequests,
  isContinuation,
  notesBesideContinuations,
  notesBesideStop,
  responseSections,
  responseText,
  turnRequest,
  type Exchange as ExchangeData,
  type PlacedSection,
} from "@/lib/exchanges"
import type { SavedContinuation } from "@mako/host/contracts/turn-continuation"
import { EventNotes } from "./event-notes"
import { EventLine } from "./event-line"
import { ShowOriginal } from "./show-original"
import { causeWords, eventWords, type EventWords } from "@/lib/transcript-events"
import { actions, shallowEqual, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import { continueTargets } from "@/state/descriptors"
import { continueTurn } from "@/state/acp-queue"
import { AUTO_CONTINUE_NOTE, endedAsChosen, savedMakoPrompt, stoppedWorkWords, turnStopLabel, type CarriedHistory, type MakoPrompt, type TurnStop } from "@/state/prompt-delivery"
import { viewer } from "@/state/viewer"
import { carriedBecause } from "@/lib/restore-plan"
import { AnswerRequestContext, AnswerTimeContext, HarnessContext, TurnRunningContext, useTranscriptSource } from "./source-context"
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
import type { ToolCall } from "@/extend/slots"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CloudIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  GitForkIcon,
  HistoryIcon,
  LayersIcon,
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
  /** Mako sent this exchange's prompt itself, so it's drawn as Mako's line. A continuation is never a prompt (`toExchanges`). */
  sentByMako?: MakoPrompt
  /** The conversation this exchange's prompt carried to a new session: one quiet line above the person's words. */
  carried?: CarriedHistory
  failed?: boolean
}) {
  useHarnessIdentity()
  // A saved conversation keeps no request: Mako's goal steps are known by their words.
  const savedByMako = useMemo(
    () => (sentByMako || !exchange.prompt ? undefined : savedMakoPrompt(textOf(exchange.prompt.blocks))),
    [sentByMako, exchange.prompt]
  )
  const mako = sentByMako ?? savedByMako
  // `toExchanges` never opens a turn on a continuation; one handed in that way is still never drawn as the person's words.
  const continuedPrompt = useMemo(() => (exchange.prompt ? isContinuation(exchange.prompt) : undefined), [exchange.prompt])
  // The request the turn stands on now: its newest continuation's, else its prompt's.
  const standing = turnRequest(exchange)
  const failureRow = useContext(FailedRequestsContext).has(standing ?? "")
  const stopShown = Boolean(interrupted) && !streaming
  const exchangeNote = useContext(ExchangeNoteContext)
  const notes = useMemo(
    () => notesBesideContinuations(stopShown ? notesBesideStop(exchange.system, exchange.response.length) : exchange.system, exchange.response),
    [exchange.system, exchange.response, stopShown]
  )
  const answered = useMemo(
    () => responseSections(exchange.response, notes),
    [exchange.response, notes]
  )
  // What the turn made, drawn where it made it: the same sections live and saved.
  const made = useShelfMedia(exchange)
  const sections = useMemo(() => placeMadeMedia(answered, made), [answered, made])
  const lastWork = sections.findLastIndex((section) => section.kind !== "note" && section.kind !== "made")
  const details = exchange.response.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === "toolResult" ? (block.details ?? []) : []))
  )
  const plan = details.filter((detail) => detail.type === "plan").at(-1)
  const review = details.filter((detail) => detail.type === "review").at(-1)
  const provider = exchange.response.find(
    (message) => message.provider && harnessLabels()[message.provider]
  )?.provider
  const finishedAt = streaming ? undefined : (exchange.response.at(-1) ?? exchange.prompt ?? exchange.opener)?.timestamp
  const began = (exchange.prompt ?? exchange.opener)?.timestamp
  const source = useTranscriptSource()
  const sourceKey = source.liveId ?? source.threadPath
  // A settled turn folds what it did behind one row and keeps its answer in
  // view; a failed one keeps everything, since its failure is the answer.
  const foldable = !streaming && !failed && Boolean(exchange.prompt || exchange.opener) && !exchange.response.some((message) => message.error)
  const folds = useMemo(() => (foldable ? turnFolds(sections, began) : []), [foldable, sections, began])
  // The answer's own last section: what it made may be drawn after it, but the turn is still at work there.
  const lastSection = answered.at(-1)
  // The newest step of a running turn: the trailing work section's own row,
  // or a row of its own under prose or a note, or under the prompt alone.
  const liveTail = streaming && lastSection?.kind !== "work"
  const steers = sections.filter((section) => section.kind === "steer").length
  const renderSection = (section: PlacedSection, index: number, whole = false): ReactNode =>
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
    ) : section.kind === "continued" ? (
      <TurnWentOn key={section.id} continued={section.continued} message={section.message} provider={provider} />
    ) : section.kind === "prose" ? (
      <Response key={section.id} message={section.message} previewedFiles={section.previewedFiles} showWork />
    ) : section.kind === "shown" || section.kind === "made" ? (
      <TurnMedia key={section.id} media={section.media} shown={section.kind === "shown"} />
    ) : (
      <WorkSection
        key={section.id}
        id={`${exchange.id}:${section.id}`}
        messages={section.messages}
        startedAt={index === 0 ? began : undefined}
        live={Boolean(streaming && section === lastSection)}
        whole={whole}
        interrupted={Boolean(interrupted) && index === lastWork}
        failed={Boolean(failed && index === lastWork)}
        // Opening the steps of a running turn keeps them open once it settles.
        onOpenSteps={() => setTurnFoldOpen(turnFoldKey(sourceKey, exchange.id, steers), true)}
      />
    )
  const body: ReactNode[] = []
  for (let index = 0; index < sections.length; ) {
    const fold = folds.find((each) => each.start === index)
    if (!fold) {
      body.push(renderSection(sections[index]!, index))
      index += 1
      continue
    }
    body.push(
      <TurnFoldRow
        key={`fold-${fold.part}`}
        fold={fold}
        foldKey={turnFoldKey(sourceKey, exchange.id, fold.part)}
        // The turn's last stretch is where a stop cut it.
        stop={fold.part === steers ? interrupted : undefined}
        kept={fold.kept.map((at) => {
          const note = sections[at]!
          return note.kind === "note" ? <SystemNotes key={note.id} messages={[note.message]} refused={exchange.refused} inline />
            : note.kind === "shown" || note.kind === "made" ? <TurnMedia key={note.id} media={note.media} shown={note.kind === "shown"} />
              : note.kind === "continued" ? <TurnWentOn key={note.id} continued={note.continued} message={note.message} provider={provider} /> : null
        })}
      >
        {sections.slice(fold.start, fold.end).map((section, offset, hidden) =>
          // A fold over one stretch of work already says what it did: opened, it shows the steps themselves.
          renderSection(section, fold.start + offset, hidden.filter((each) => each.kind === "work").length === 1)
        )}
      </TurnFoldRow>
    )
    index = fold.end
  }
  return (
    <AnswerTimeContext.Provider value={finishedAt}>
      <TurnRunningContext value={Boolean(streaming)}>
      <HarnessContext value={provider}>
      {/* One gallery per exchange: every picture and video in the prompt, the answer and its work steps a step apart. */}
      <MediaGalleryScope>
      <AnswerRequestContext.Provider value={standing}>
      <article data-exchange={exchange.id} className="contain-turn scroll-mt-6">
        {exchange.prompt ? (
          continuedPrompt ? (
            <TurnWentOn continued={continuedPrompt} message={exchange.prompt} provider={provider} />
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

        {sections.length > 0 || streaming ? (
          <div className={cn("flex flex-col gap-4", (exchange.prompt || exchange.opener) && "mt-4")}>
            {provider || (streaming && began !== undefined) ? <AgentByline provider={provider} workingSince={streaming ? began : undefined} /> : null}
            {body}
            {liveTail ? <LiveRow step={NOTHING_RUNNING} answering={lastSection?.kind === "prose"} /> : null}
          </div>
        ) : null}
        {exchangeNote?.(exchange.id, standing)}

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
        {streaming ? null : exchangeRequests(exchange).map((requestId) => <TurnChanges key={requestId} requestId={requestId} />)}
        <ExchangeFailure requestId={standing} />
        {exchange.response.length > 0 || interrupted ? (
          // A turn that ends on its failure row says there why it stopped, and what to do; the footer doesn't repeat it.
          <Footer exchange={exchange} streaming={streaming} interrupted={failureRow ? undefined : interrupted} />
        ) : null}
      </article>
      </AnswerRequestContext.Provider>
      </MediaGalleryScope>
      </HarnessContext>
      </TurnRunningContext>
    </AnswerTimeContext.Provider>
  )
})

/** NOTHING running yet: the live row under a prompt, prose or a note says what the turn does without a step of its own. */
const NOTHING_RUNNING: LiveStepData = { calls: [], thinking: false }

/** Who is answering, and while the turn runs, for how long: "Claude · Working for 1m 12s". */
function AgentByline({ provider, workingSince }: { provider?: string; workingSince?: number }) {
  useHarnessIdentity()
  return (
    <div className="flex min-h-3.5 items-center gap-1.5 text-label text-faint">
      {provider ? <HarnessIcon harness={provider} className="size-3.5" /> : null}
      {provider ? <span>{harnessLabels()[provider] ?? provider}</span> : null}
      {workingSince !== undefined ? <TurnClock since={workingSince} bare={!provider} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* the prompt                                                          */
/* ------------------------------------------------------------------ */

/** What a continuation's line says, by who sent it; one read back from before the words named a sender says only what happened. */
function continuedTitle({ reason, sender, stayed }: SavedContinuation, provider: string): string {
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
    case "handed-off":
      if (stayed) return "Mako continued the turn here: the move didn't happen"
      return sender === "mako" ? "Mako continued the turn it paused to move" : sender === "person" ? "You continued the turn Mako paused to move" : "The turn Mako paused to move continued"
    case "not-saved":
      return sender === "mako" ? "Mako continued the turn it stopped when it couldn't save" : sender === "person" ? "You continued the turn Mako stopped when it couldn't save" : "The turn Mako stopped when it couldn't save continued"
    case "goal-budget":
      return sender === "mako" ? "Mako continued the turn it stopped at the goal's token budget" : sender === "person" ? "You continued the turn Mako stopped at the goal's token budget" : "The turn Mako stopped at the goal's token budget continued"
    case "machine-lost":
      return sender === "person" ? "You picked the interrupted step up again" : `The last step was interrupted; ${provider} picked it up again`
  }
}

/** A line across the transcript where a move to the cloud cut the turn: what came before ran here, the rest there. */
function MovedDivider({ at }: { at: number | undefined }) {
  return (
    <div role="separator" aria-label="Moved to the cloud" data-moved-divider className="my-3 flex items-center gap-3 text-label text-faint">
      <span className="h-px flex-1 bg-hairline" />
      <span className="flex shrink-0 items-center gap-1.5">
        <CloudIcon aria-hidden className="size-3.5" />
        Moved to the cloud{at ? ` · ${formatTime(at)}` : ""}
      </span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  )
}

/**
 * Where a turn that was cut short went on. The words are Mako's, whether
 * Mako sent them on its own or the person pressed Continue turn, and the
 * turn reads as one: nothing stands where they were sent. Two exceptions:
 * a step the loss of a machine undid changed the person's files, so where
 * it was picked up again is one quiet line; and with Settings › Diagnostics'
 * originals on, the line says why and who, opens onto the exact words, and
 * offers their Original.
 */
function TurnWentOn({ continued, message, provider }: { continued: SavedContinuation; message: ChatMessage; provider?: string }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const diagnosing = usePrefs((prefs) => prefs.showOriginals)
  const dividers = useContext(MoveDividersContext)
  // Only a turn that went on in the cloud moved: one that stayed, its move refused, goes on as one run.
  if (dividers && !diagnosing && continued.reason === "handed-off" && !continued.stayed) return <MovedDivider at={message.timestamp} />
  if (!diagnosing && continued.reason !== "machine-lost") return null
  const agent = provider ?? harness
  const said = textOf(message.blocks).trim()
  return (
    <EventLine
      icon={continued.reason === "provider-exited" || continued.reason === "machine-lost" ? RefreshCwIcon : continued.reason === "handed-off" ? CloudIcon : PlayIcon}
      time={message.timestamp}
      data-turn-continued={continued.reason}
      data-continued-by={continued.sender ?? "unknown"}
      words={{ title: continuedTitle(continued, agent ? harnessLabel(agent) : "the provider") }}
      action={<ShowOriginal origins={[message.origin]} />}
    >
      {diagnosing && said ? <p className="text-faint">{said}</p> : null}
    </EventLine>
  )
}

/**
 * Where a session began from another one's history: a divider above the
 * person's words, never a message of its own, since what the agent was told
 * is Mako's framing and not what the person typed. Its action opens the
 * transcript the agent was given, the file it reads.
 */
function CarriedLine({ carried, time }: { carried: CarriedHistory; time?: number }) {
  const from = carried.from.map((harness) => harnessLabel(harness)).join(" and ")
  const turns = carried.turns === undefined ? undefined : `${carried.turns} turn${carried.turns === 1 ? "" : "s"}`
  // Why the harness didn't resume its own session: the version here is older than the one that wrote it.
  const because = carried.outdated ? carriedBecause(harnessLabel(carried.outdated.harness), carried.outdated) : undefined
  // A handoff is a boundary in the conversation: drawn as a divider, as a compaction is.
  return (
    <EventLine
      variant="divider"
      icon={HistoryIcon}
      time={time}
      className="mb-3"
      data-carried-history=""
      data-carried-outdated={carried.outdated ? "" : undefined}
      words={{ title: from ? `Continued from ${from}` : "Continued with the conversation so far", detail: [turns, because].filter(Boolean).join(" · ") || undefined }}
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
  const note = useContext(PromptNoteContext)
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
        {note?.(message.requestId)}
        <button type="button" aria-label="Copy question" onClick={() => void copy()} className="pressable flex h-6 items-center gap-1 rounded px-1 hover:bg-fill-hover hover:text-foreground">
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {copied ? "Copied question" : "Copy question"}
        </button>
        {message.timestamp ? (
          <span className="tabular">{formatTime(message.timestamp)}</span>
        ) : null}
        <button
          type="button"
          data-transcript-action="reuse"
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
              data-transcript-action="edit"
              title="Rewind to here and re-ask — later turns stay on their own branch"
              onClick={() => void editHere()}
              className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <PencilIcon className="size-3" />
              Edit
            </button>
            <button
              type="button"
              data-transcript-action="fork"
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

/** With `settled`, the running step's calls: count only calls that have finished, and none of those. */
function summarizeWork(
  messages: readonly ChatMessage[],
  started?: number,
  settled?: readonly ToolCall[]
): WorkSummaryData {
  const paired = messages.flatMap((message) => pairTools(message.blocks))
  const running = new Set(settled?.map((call) => call.id))
  const calls = settled ? paired.filter((call) => !call.pending && !running.has(call.id)) : paired
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

/**
 * A stretch of work between two pieces of prose. Settled, it is its rows,
 * folded under a summary from three steps on. While it is the running end of
 * a turn (`live`), it is what it has done so far as that summary, then the
 * step running now, a row for each of its calls. The summary opens the whole
 * list, capped and following its newest row while the turn runs. Every row
 * of it, the summary, the steps and the running step, stands in one column:
 * glyphs over glyphs, words over words, nothing indented under anything, so
 * the stretch reads as one log. One tree in every state, so a stretch that
 * settles keeps what it had mounted.
 */
function WorkSection({
  id,
  messages,
  startedAt,
  live,
  whole = false,
  interrupted,
  failed,
  onOpenSteps,
}: {
  /** Which run of the transcript it is, for a compact presentation (`CompactPresentationContext`). */
  id: string
  messages: ChatMessage[]
  startedAt?: number
  live: boolean
  /** Drawn as its steps, never folded under a summary of its own: the turn's fold already is one. */
  whole?: boolean
  interrupted: boolean
  failed: boolean
  onOpenSteps?: () => void
}) {
  const [open, setOpen] = useState(false)
  const work = useMemo(
    () => summarizeWork(messages, startedAt),
    [messages, startedAt]
  )
  const step = useMemo(() => (live ? liveStep(messages) : undefined), [live, messages])
  // While it runs, the summary says only what has finished; the running step is its own rows.
  const done = useMemo(() => (step ? summarizeWork(messages, undefined, step.calls) : undefined), [step, messages])
  // The open list leaves out what the live row under it says, so the row stays its last entry.
  // The thought is the newest message's only; earlier messages lose only the step's calls.
  const shown = useMemo(() => {
    if (!step) return undefined
    const calls = new Set(step.calls.map((call) => call.id))
    const earlier: LiveShown = { calls, thought: false }
    return { earlier, newest: step.thinking ? { calls, thought: true } : earlier }
  }, [step])
  const folded = work.tools >= 3 && !whole
  const summarized = live ? (done?.tools ?? 0) > 0 : folded
  const toggle = () =>
    setOpen((value) => {
      if (!value && live) onOpenSteps?.()
      return !value
    })
  // On a phone the run is one line that opens its steps; inside a fold's body it is drawn whole, as here.
  const compact = useContext(CompactPresentationContext)?.steps
  if (compact && !whole)
    return compact({
      id,
      calls: messages.flatMap((message) => pairTools(message.blocks)),
      provider: messages.find((message) => message.provider)?.provider,
      live,
      interrupted: !live && interrupted,
      failed: !live && failed,
      ...(!live && work.duration !== undefined && { worked: work.duration }),
    })
  return (
    <div className="flex flex-col">
      {summarized ? (
        <WorkSummary
          work={live ? done! : work}
          interrupted={!live && interrupted}
          failed={!live && failed}
          open={open}
          onToggle={toggle}
        />
      ) : null}
      <Collapse open={live ? open : !summarized || open}>
        <FollowingList capped={live}>
          <div data-work-log className="flex flex-col">
            {messages.map((message) => (
              <Response key={message.id} message={message} showWork live={message === messages.at(-1) ? shown?.newest : shown?.earlier} />
            ))}
          </div>
        </FollowingList>
      </Collapse>
      {step ? <LiveRow step={step} open={open} /> : null}
    </div>
  )
}

/** What a running stretch's live row says: the calls it stands for, and whether its step is a thought. */
interface LiveShown {
  calls: ReadonlySet<string>
  thought: boolean
}

/**
 * The newest step of a running stretch, from its messages: the calls
 * running now with any that ran beside them (`stepCalls`), or the thought
 * the model is in the middle of. A thought shows above a call only when it
 * led to it, in the same response.
 */
function liveStep(messages: readonly ChatMessage[]): LiveStepData {
  let call: ToolCall | undefined
  let group: ToolCall[] | undefined
  let provider: string | undefined
  let thought: string | undefined
  const every: ToolCall[] = []
  for (const message of messages) {
    const calls = pairTools(message.blocks)
    for (const each of calls) {
      every.push(each)
      if (each.pending) call = each
    }
    if (call && calls.includes(call)) {
      // Agents started together run as one step: the group is the live row.
      const item = groupAgentCalls(calls).find((each) => each.kind === "agents" && each.calls.includes(call!))
      group = item?.kind === "agents" ? item.calls : undefined
      provider = message.provider
    }
    const thinking = message.blocks.findLast((block) => block.type === "thinking" && block.thinking)
    if (thinking?.type === "thinking" && (calls.some((each) => each === call) || message === messages.at(-1)))
      thought = thoughtLine(thinking.thinking)
  }
  const lastBlock = messages.at(-1)?.blocks.at(-1)
  const thinking = lastBlock?.type === "thinking" && Boolean(lastBlock.thinking)
  if (thinking) return { calls: [], thought, thinking }
  return { call, calls: call ? stepCalls(every, group) : [], provider, thought: call ? thought : undefined, thinking }
}

/**
 * The calls one step stands for, in the order they began: every call
 * running now, and every call begun together with one of them. Calls begin
 * together when none returned between their starts, so a call that
 * finishes among others keeps its place until its step is done, while calls
 * made one after another are steps of their own: beside a call that never
 * returns, each later call settles into the summary once it finishes and
 * stays there. Agents started together (`group`) are one step whole. The
 * times are the host's, so a reopened conversation draws the same step as a
 * watched one.
 */
function stepCalls(calls: readonly ToolCall[], group: readonly ToolCall[] = []): ToolCall[] {
  const ends = calls.flatMap((call) => (!call.pending && call.endedAt !== undefined ? [call.endedAt] : [])).sort((a, b) => a - b)
  // A step is named by how many calls had returned when it began: two calls share it when none returned between their starts.
  const returnedBy = (at: number) => {
    let low = 0
    let high = ends.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (ends[middle]! <= at) low = middle + 1
      else high = middle
    }
    return low
  }
  const running = new Set(calls.flatMap((call) => (call.pending && call.startedAt !== undefined ? [returnedBy(call.startedAt)] : [])))
  const together = new Set(group.map((call) => call.id))
  return calls.filter((call) =>
    call.pending || together.has(call.id) ||
    (call.endedAt !== undefined && call.startedAt !== undefined && running.has(returnedBy(call.startedAt)))
  )
}

/** A thought's newest line, without list marks or emphasis, cut from the front past 120 characters. */
function thoughtLine(text: string): string {
  const trimmed = text.trim()
  const lastLine = trimmed
    .slice(trimmed.lastIndexOf("\n") + 1)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`#>]+/g, "")
    .trim()
  return lastLine.length > 120 ? `…${lastLine.slice(-119)}` : lastLine
}

/**
 * A settled turn's work behind one row: "Worked for 3m 12s", then what it
 * did in the transcript's words. The row is a fold and nothing else, so its
 * first column is the fold's chevron, where the glyph of every row of work
 * stands; its body hangs from that chevron on a hairline. Its answer stays
 * below it. A stretch after a steer "Continued for"; a turn
 * that was stopped says so ("Stopped after 2m", "Interrupted after 2m"). A
 * note that wants attention or marks a boundary stays in view while the
 * fold is closed. Whether it is open is kept per turn (`turn-folds.ts`).
 */
function TurnFoldRow({ fold, foldKey, stop, kept, children }: { fold: TurnFold; foldKey: string; stop?: boolean | TurnStop; kept: ReactNode[]; children: ReactNode }) {
  const open = useTurnFolds((state) => state.open.has(foldKey))
  const work = useMemo(() => summarizeWork(fold.messages), [fold.messages])
  const { text } = describeWork(work)
  const duration = fold.worked !== undefined ? formatDuration(fold.worked) : undefined
  const yours = stop === true || (stop !== undefined && stop !== false && endedAsChosen(stop.reason))
  const cut = Boolean(stop) && !yours
  const verb = stop ? (yours ? "Stopped" : "Interrupted") : fold.continued ? "Continued" : "Worked"
  const said = work.tools > 0 ? text : undefined
  const title = duration ? `${verb} ${stop ? "after" : "for"} ${duration}` : stop ? verb : said ? said.charAt(0).toUpperCase() + said.slice(1) : "Show the steps"
  const detail = duration || stop ? said : undefined
  // On a phone a settled turn's work is one line too, opening everything it hides, the words between steps included.
  const compact = useContext(CompactPresentationContext)?.steps
  if (compact)
    return (
      <div data-turn-fold="compact" className="flex flex-col">
        {compact({
          id: foldKey,
          calls: fold.messages.flatMap((message) => pairTools(message.blocks)),
          provider: fold.messages.find((message) => message.provider)?.provider,
          live: false,
          interrupted: cut,
          failed: false,
          ...(fold.worked !== undefined && { worked: fold.worked }),
          body: <div className="flex flex-col gap-4 pt-1">{children}</div>,
        })}
        {kept.length ? <div className="mt-3 flex flex-col gap-4">{kept}</div> : null}
      </div>
    )
  return (
    <div data-turn-fold={open ? "open" : "closed"} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setTurnFoldOpen(foldKey, !open)}
        className={cn(
          "pressable group/fold -mx-1.5 flex h-7 max-w-full items-center gap-2 self-start rounded-md px-1.5 text-ui transition-colors duration-100 hover:bg-fill-hover",
          cut ? "text-caution" : "text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-faint transition-[transform,color] duration-200 ease-[var(--ease-out)] group-hover/fold:text-muted-foreground",
            open && "rotate-90"
          )}
        />
        <span className="shrink-0">{title}</span>
        {detail ? <span className="min-w-0 truncate text-faint">{detail}</span> : null}
        <WorkEndings work={work} />
      </button>
      <Collapse open={open}>
        <div data-turn-fold-body className="mt-1.5 ml-[6.5px] flex flex-col gap-4 border-l border-hairline pt-1 pb-1 pl-4">
          {children}
        </div>
      </Collapse>
      {!open && kept.length ? <div className="mt-3 flex flex-col gap-4">{kept}</div> : null}
    </div>
  )
}

/** How the calls under a summary ended other than well: "2 failed", "3 stopped", "1 cut off". */
function WorkEndings({ work }: { work: Pick<WorkSummaryData, "failed" | "stopped" | "cutOff"> }) {
  return (
    <>
      {work.failed > 0 ? <span className="shrink-0 text-negative">{work.failed} failed</span> : null}
      {work.stopped > 0 ? <span className="shrink-0 text-faint">{work.stopped} stopped</span> : null}
      {work.cutOff > 0 ? <span className="shrink-0 text-faint">{work.cutOff} cut off</span> : null}
    </>
  )
}

/**
 * What a folded stretch of tool calls did, said the way the transcript says
 * everything else: "Ran 5 commands and read a file". One glyph in front,
 * where each step's own stands: the kind's, when every step was one kind (an
 * agent's is its harness's mark), else the stack of steps.
 */
const WORK_PHRASES = [
  { glyph: "edit", count: (work) => work.edits, phrase: (n) => `made ${n === 1 ? "an edit" : `${n} edits`}` },
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
  return { kinds: done.map((entry) => entry.glyph), text }
}

/** The summary's one glyph (see `WORK_PHRASES`). */
function SummaryGlyph({ kinds, className }: { kinds: readonly ToolKind[]; className?: string }) {
  const [only] = kinds
  if (kinds.length !== 1 || !only) return <LayersIcon className={className} />
  return only === "agent" ? <AgentMark className={className} /> : <ToolGlyph kind={only} className={className} />
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
  const { kinds, text } = describeWork(work)
  const troubled = interrupted || failed
  const stop = interrupted ? "Interrupted" : "Failed"
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-work-summary
      className={cn(
        "pressable group/row -mx-1.5 flex h-7 max-w-full items-center gap-2 self-start rounded-md px-1.5 text-ui transition-colors duration-100 hover:bg-fill-hover",
        interrupted
          ? "text-caution"
          : failed
            ? "text-negative"
            : "text-muted-foreground hover:text-foreground aria-expanded:text-foreground"
      )}
    >
      <LeadSlot
        open={open}
        glyph={troubled ? <TriangleAlertIcon aria-hidden className="size-3.5" /> : <SummaryGlyph kinds={kinds} className="size-3.5 text-faint" />}
      />
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
      <WorkEndings work={work} />
      {elapsed && !troubled ? (
        <span className="shrink-0 text-label text-faint tabular">{elapsed}</span>
      ) : null}
    </button>
  )
}

function Response({
  message,
  showWork,
  previewedFiles,
  live,
}: {
  message: ChatMessage
  showWork: boolean
  previewedFiles?: readonly string[]
  /** What the running turn's live row already says, left out here so it is said once: its calls, and its thought when the step is one. */
  live?: LiveShown
}) {
  const showThinking = usePrefs((prefs) => prefs.showThinking)

  const { thinking, tools, text } = useMemo(() => {
    const thinkingParts: string[] = []
    const textParts: string[] = []
    for (const block of message.blocks) {
      if (block.type === "thinking" && block.thinking && !live?.thought)
        thinkingParts.push(block.thinking)
      if (block.type === "text" && block.text) textParts.push(block.text)
    }
    const paired = pairTools(message.blocks)
    return {
      thinking: thinkingParts.join("\n\n"),
      tools: live?.calls.size ? paired.filter((call) => !live.calls.has(call.id)) : paired,
      text: textParts.join(""),
    }
  }, [message.blocks, live])

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
          {groupAgentCalls(tools).map((item) =>
            item.kind === "agents" ? (
              <AgentGroup key={item.id} calls={item.calls} provider={message.provider} />
            ) : (
              <ToolRow key={item.call.id} call={item.call} />
            )
          )}
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

      {message.error ? <TurnError error={message.error} /> : null}

    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  const summary = thoughtLine(text)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${live ? "Reasoning in progress" : "Reasoning"}${summary ? `: ${summary}` : ""}`}
        className="pressable group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui transition-colors duration-100 hover:bg-fill-hover"
      >
        <LeadSlot open={open} glyph={<ToolGlyph kind="think" className={cn("size-3.5", live ? "text-foreground/80" : "text-faint")} />} />
        {/* A thought still coming sweeps, as a running call's words do; nothing at the row's end says it again. */}
        {live ? <Shimmer text="Thinking" className="shrink-0" /> : <span className="shrink-0 text-muted-foreground">Thought process</span>}
        {summary && !open ? <span className="min-w-0 truncate text-faint">{summary}</span> : null}
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
function noteRun(sections: readonly PlacedSection[], start: number): ChatMessage[] {
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
  const compact = useContext(CompactPresentationContext)?.reply
  if (!text && !last?.timestamp && !interrupted) return null
  if (compact) return <CompactFooter exchange={exchange} text={text} streaming={streaming} interrupted={interrupted} reply={compact} />

  return (
    <div className="mt-1.5 flex min-h-6 items-center gap-2.5 text-label text-muted-foreground">
      {interrupted && !streaming ? <Stopped stop={interrupted} /> : null}
      {/* The answer's time and model are the finished answer's: a running turn's newest step is not its answer. */}
      {last?.timestamp && !streaming ? (
        <span className="tabular">{formatTime(last.timestamp)}</span>
      ) : null}
      {last?.model && !streaming ? <span className="truncate">{last.model}</span> : null}
      {/* The whole answer exists once the turn ends; until then the footer keeps its place, empty of it. */}
      {text && !streaming ? (
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

/** The phone's footer: a reply offers what it can be used for; its time and model are the desk's details. */
function CompactFooter({ exchange, text, streaming, interrupted, reply }: { exchange: ExchangeData; text: string; streaming?: boolean; interrupted?: boolean | TurnStop; reply: NonNullable<CompactPresentation["reply"]> }) {
  // Asked only here: whether a fork can follow this answer is the phone's Branch, never the desk's footer.
  const fork = useLiveFork(exchange)
  return (
    <div className="mt-1.5 flex min-h-6 flex-wrap items-center gap-x-2.5 text-label text-muted-foreground">
      {interrupted && !streaming ? <Stopped stop={interrupted} /> : null}
      {streaming ? null : reply({ exchange: exchange.id, text, ...(fork && !interrupted && { branch: fork }) })}
    </div>
  )
}

/**
 * Why the turn ended early. A bare `true` is a Stop with no recorded reason
 * (a foreign transcript's own marker). When Mako's exit or the provider's
 * own connection cut the newest turn short, the footer says which and offers
 * to pick the turn up; the offer sends through the same path as a typed
 * message, so it queues, steers or reopens the session exactly as one would.
 * A goal's token budget ending it is said as quietly as a Stop, with the
 * goal's mark: an outcome the person set, offered nothing.
 */
function Stopped({ stop }: { stop: true | TurnStop }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const [sending, setSending] = useState(false)
  const detail = stop === true ? undefined : stop
  const reason = detail?.reason ?? "stopped"
  const yours = endedAsChosen(reason)
  // What else the stop ended, in the words the agent is told of it when the turn goes on.
  const alsoStopped = detail?.stopped ? stoppedWorkWords(detail.stopped) : undefined
  return (
    <>
      <span data-turn-stopped={reason} className={cn("flex min-w-0 items-center gap-1.5", !yours && "text-foreground")}>
        {reason === "goal-budget" ? <TargetIcon aria-hidden className="size-3 shrink-0" />
          : yours ? <CircleStopIcon aria-hidden className="size-3 shrink-0" />
            : <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-caution" />}
        <span className="shrink-0">{turnStopLabel(reason, harness ? harnessLabel(harness) : "the provider")}</span>
        {alsoStopped ? (
          <span data-turn-stopped-work={detail?.stopped?.length} title={alsoStopped.all} className="min-w-0 truncate text-muted-foreground">
            {alsoStopped.text}
          </span>
        ) : null}
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
 * A fork after this answer of a live conversation, where its harness can fork and the turn is done: the new Session's
 * conversation once it's made, or undefined when the host refused it (it says why). The phone's Branch.
 */
function useLiveFork(exchange: ExchangeData): (() => Promise<string | undefined>) | undefined {
  const scope = useConversationScope()
  const requestId = exchange.prompt?.requestId
  const live = useAcp((state) => {
    const current = scopedLiveAcp(state, scope)
    if (!current || !requestId || current.requests?.find((request) => request.id === requestId)?.status !== "completed") return undefined
    return descriptorFor(threadsStore.get(), current.harness)?.capabilities.fork.state === "implemented" ? current.key : undefined
  })
  if (!live || !requestId) return undefined
  return () => acp.fork({ kind: "run", requestId }, "parent", scopedLiveAcp(acpStore.get(), scope), false)
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
          data-transcript-action="fork"
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
        data-transcript-action="fork"
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
