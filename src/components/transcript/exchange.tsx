import { useHarnessIdentity } from "@/lib/harness-label"
import { PlanContextChips } from "@/components/composer/plan-context"
import { appendPlanContext, parsePlanContext } from "@/lib/proposed-plan"
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
import { TranscriptAttachments } from "./attachment-collection"
import { memo, useMemo, useState } from "react"
import { Prose } from "@/components/transcript/markdown"
import { ToolRow } from "@/components/transcript/tool-row"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { ActivityMark } from "@/components/ui/activity-mark"
import type { ToolKind } from "@mako/sessions/tool-identity"
import { FileChip } from "@/components/composer/reference-chip"
import { Slot } from "@/extend/slot"
import {
  pairTools,
  reportedSubagentCount,
  summarizeToolWork,
  type ToolWorkSummary,
} from "@/lib/tools"
import { formatTime, textOf } from "@/lib/format"
import { parseAttachmentAppendix } from "@/lib/attachments"
import { parseSkillAppendix } from "@/lib/skill-references"
import {
  attachmentPromptSegments,
  reusablePromptAttachments,
  restoreAttachmentReferences,
} from "@/lib/attachment-references"
import {
  parseThreadReferenceAppendix,
  restoreThreadReferences,
} from "@/lib/thread-references"
import {
  notesBesideStop,
  responseSections,
  responseText,
  type Exchange as ExchangeData,
  type ResponseSection,
} from "@/lib/exchanges"
import { EventNotes } from "./event-notes"
import { actions, shallowEqual, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import { continueTargets } from "@/state/descriptors"
import { continueTurn } from "@/state/acp-queue"
import { AUTO_CONTINUE_NOTE, turnStopLabel, type MakoPrompt, type TurnStop } from "@/state/prompt-delivery"
import { useTranscriptSource } from "./source-context"
import { harnessLabels, harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import type { ChatMessage, TurnContinuation } from "@/lib/types"
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  GitBranchIcon,
  GitForkIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
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
  failed,
}: {
  exchange: ExchangeData
  streaming?: boolean
  /** True when the turn stopped early; a `TurnStop` also says why and whether it can be continued. */
  interrupted?: boolean | TurnStop
  /** Mako sent this exchange's prompt itself, so it's drawn as Mako's line. */
  sentByMako?: MakoPrompt
  failed?: boolean
}) {
  useHarnessIdentity()
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
  const plan = exchange.response
    .flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === "toolResult"
          ? (block.details ?? []).filter((detail) => detail.type === "plan")
          : []
      )
    )
    .at(-1)
  const provider = exchange.response.find(
    (message) => message.provider && harnessLabels()[message.provider]
  )?.provider
  return (
    <article data-exchange={exchange.id} className="contain-turn scroll-mt-6">
      {exchange.prompt ? (
        sentByMako?.kind === "continued" ? (
          <Continued continuation={sentByMako.continuation} timestamp={exchange.prompt.timestamp} />
        ) : sentByMako?.kind === "moved" ? (
          <MovedNote timestamp={exchange.prompt.timestamp} />
        ) : (
          <Prompt message={exchange.prompt} />
        )
      ) : exchange.opener ? (
        <ProviderTurn message={exchange.opener} provider={provider} />
      ) : null}
      <SystemNotes messages={notes.flatMap((note) => (note.after === 0 ? [note.message] : []))} />

      {sections.length > 0 ? (
        <div className={cn("flex flex-col gap-4", (exchange.prompt || exchange.opener) && "mt-4")}>
          {provider ? <AgentByline provider={provider} /> : null}
          {sections.map((section, index) =>
            section.kind === "note" ? (
              sections[index - 1]?.kind === "note" ? null : (
                <SystemNotes key={section.id} messages={noteRun(sections, index)} inline />
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
      {exchange.response.length > 0 || interrupted ? (
        <Footer exchange={exchange} streaming={streaming} interrupted={interrupted} />
      ) : null}
    </article>
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

/**
 * Mako's own continuation of a turn the provider dropped. It is not the
 * user's words, so it does not get the user's bubble: one quiet line where
 * the prompt would be, saying what happened and who acted, with the moment.
 */
function Continued({ continuation, timestamp }: { continuation: TurnContinuation; timestamp?: number }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const provider = harness ? harnessLabel(harness) : "the provider"
  return (
    <div
      data-turn-continued={continuation.reason}
      className="flex min-h-6 items-center justify-end gap-2 px-0.5 text-label text-faint"
    >
      <PlayIcon className="size-3" />
      <span>
        {continuation.reason === "connection-lost"
          ? `Mako continued the turn after the connection to ${provider} dropped`
          : continuation.reason === "provider-exited"
            ? `Mako restarted ${provider} and continued the turn`
            : "Mako continued the turn"}
      </span>
      {timestamp ? <span className="tabular">{formatTime(timestamp)}</span> : null}
    </div>
  )
}

/** Mako told the agent it's on its Thread's own branch now, after the move it asked for. */
function MovedNote({ timestamp }: { timestamp?: number }) {
  return (
    <div data-turn-moved className="flex min-h-6 items-center justify-end gap-2 px-0.5 text-label text-faint">
      <GitBranchIcon className="size-3" />
      <span>Mako moved this session onto its own branch</span>
      {timestamp ? <span className="tabular">{formatTime(timestamp)}</span> : null}
    </div>
  )
}

/**
 * A turn the provider started itself. What it reported as the cause stands
 * where a prompt would, in Mako's quiet line rather than the user's bubble.
 */
function ProviderTurn({ message, provider }: { message: ChatMessage; provider?: string }) {
  useHarnessIdentity()
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  const agent = provider ?? harness
  return (
    <div
      data-provider-turn
      className="flex min-h-6 items-start gap-2 px-0.5 py-0.5 text-label text-faint"
    >
      <BotIcon className="mt-[0.2em] size-3 shrink-0" />
      <span className="min-w-0 text-pretty break-words">
        {`${agent ? harnessLabel(agent) : "The agent"} continued on its own: ${textOf(message.blocks)}`}
      </span>
      {message.timestamp ? <span className="tabular ml-auto shrink-0">{formatTime(message.timestamp)}</span> : null}
    </div>
  )
}

function Prompt({ message }: { message: ChatMessage }) {
  const raw = textOf(message.blocks)
  // Sent context appendices read back as chips, not walls of implementation
  // detail. Skills were appended last, so they come off first; their entries
  // tell each `$skill` chip whether the provider had the skill or was handed it.
  const { body: withoutSkills, skills: sentSkills } = useMemo(
    () => parseSkillAppendix(raw),
    [raw]
  )
  // Referenced conversations went out as "[Referenced conversation N]" with
  // a heading naming each; the heading's token puts the chip back where the
  // placeholder stands. A heading from before tokens were carried has only
  // a title, and its placeholder reads as that title.
  const { body: withoutThreads, references: sentThreads } = useMemo(
    () => parseThreadReferenceAppendix(withoutSkills),
    [withoutSkills]
  )
  const titledThreads = useMemo(
    () => sentThreads.filter((entry) => !entry.token),
    [sentThreads]
  )
  const { body, plans } = useMemo(
    () => parsePlanContext(withoutThreads),
    [withoutThreads]
  )
  const { body: text, files } = useMemo(() => {
    const parsed = parseAttachmentAppendix(body)
    return { body: restoreThreadReferences(parsed.body, sentThreads), files: parsed.files }
  }, [body, sentThreads])
  const reusable = useMemo(
    () =>
      reusablePromptAttachments(
        files,
        message.blocks.filter((block) => block.type === "attachment")
      ),
    [files, message.blocks]
  )
  const referenceFiles = useMemo(() => reusable.map((item) => ({ index: item.index, name: item.name, path: item.stagedPath })), [reusable])
  // A file the user referenced in their words shows as that chip, not again below.
  const inlinePaths = useMemo(
    () =>
      new Set(
        attachmentPromptSegments(text, referenceFiles).flatMap((segment) =>
          segment.kind === "attachment" ? [segment.file.path] : []
        )
      ),
    [text, referenceFiles]
  )
  // A copied prompt keeps its `$skill` and `@thread:` tokens and drops the
  // bodies and bundles they carried: pasted back into the composer they
  // resolve again for whichever provider answers next. Only a prompt whose
  // headings carried no token keeps its appendix, since the headings are
  // then the only record of what was referenced.
  const { copied, copy } = useCopy(
    appendPlanContext(restoreAttachmentReferences(text, reusable), plans) +
      (titledThreads.length > 0 ? withoutSkills.slice(withoutThreads.length) : ""),
    reusable
  )
  const compose = () =>
    window.dispatchEvent(
      new CustomEvent("mako:compose", {
        detail: {
          text: appendPlanContext(
            restoreAttachmentReferences(text, reusable),
            plans
          ),
          attachments: reusable,
        },
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
      <div onCopy={event => copyPromptSelection(event, reusable)} className="max-w-[min(82%,64ch)] rounded-xl rounded-br-md bg-raised px-3.5 py-2.5">
        <Prose text={text} references={referenceFiles} skills={sentSkills} threads={titledThreads} className="prompt-prose whitespace-normal" />
        <PlanContextChips plans={plans} />
        <TranscriptAttachments attachments={message.blocks
          .filter((block) => block.type === "attachment")
          .filter(
            (block) =>
              block.source.kind !== "file" ||
              /^(?:image|audio|video)\//i.test(block.mimeType) ||
              !inlinePaths.has(block.source.path)
          )
        } />
        {files.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files
              .filter((file) => !inlinePaths.has(file.path))
              .map((file) => (
                <FileChip
                  key={file.path}
                  path={file.path}
                  name={file.name}
                  interactive
                />
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
      {text ? <Prose text={text} streaming={message.streaming} previewedFiles={previewedFiles} /> : null}

      {message.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-negative/30 bg-negative/[0.06] px-2.5 py-2 text-ui text-negative">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{message.error}</span>
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
function SystemNotes({ messages, inline }: { messages: readonly ChatMessage[]; inline?: boolean }) {
  const groups: ChatMessage[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (message.note && last?.[0]?.note) last.push(message)
    else groups.push([message])
  }
  return groups.map((group) =>
    group[0]!.note ? (
      <EventNotes key={group[0]!.id} messages={group} inline={inline} />
    ) : (
      <SystemNote key={group[0]!.id} message={group[0]!} inline={inline} />
    )
  )
}

/** `inline` sits inside the answer, whose gap already spaces it. */
function SystemNote({ message, inline }: { message: ChatMessage; inline?: boolean }) {
  const text = textOf(message.blocks)
  if (!text) return null
  return (
    <div className={cn("flex items-center gap-2.5", inline ? "my-1" : "my-3")}>
      <span className="h-px flex-1 bg-hairline" />
      <span className="shrink-0 text-label text-faint">
        {text.slice(0, 140)}
      </span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
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
  return (
    <>
      <span data-turn-stopped={reason}>
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
