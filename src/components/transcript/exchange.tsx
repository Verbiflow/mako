import { PlanContextChips } from "@/components/composer/plan-context"
import { appendPlanContext, parsePlanContext } from "@/lib/proposed-plan"
import { ProposedPlanCard } from "./proposed-plan"
import { ChangingLabel } from "@/components/ui/changing-label"
import { Collapse } from "@/components/ui/collapse"
import { RewindButton, PromptRewindButton } from "./rewind-button"
import { useCopy } from "@/components/ui/use-copy"
import { copyPromptSelection } from "./prompt-clipboard"
import { acp, useAcp, activeLiveAcp } from "@/state/acp"
import { PlanSummary } from "./tool-details"
import { TranscriptAttachment } from "./attachment"
import { memo, useMemo, useState } from "react"
import { Prose } from "@/components/transcript/markdown"
import { ToolRow } from "@/components/transcript/tool-row"
import { ToolGlyph } from "@/components/transcript/tool-views"
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
  responseSections,
  responseText,
  type Exchange as ExchangeData,
} from "@/lib/exchanges"
import { actions, shallowEqual, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import { continueTargets } from "@/state/descriptors"
import { continueTurn } from "@/state/acp-queue"
import { AUTO_CONTINUE_NOTE, turnStopLabel, type TurnStop } from "@/state/prompt-delivery"
import { useTranscriptSource } from "./source-context"
import { HARNESS_LABEL, harnessLabel } from "@/components/rail/harness-meta"
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
  continues,
  failed,
}: {
  exchange: ExchangeData
  streaming?: boolean
  /** True when the turn stopped early; a `TurnStop` also says why and whether it can be continued. */
  interrupted?: boolean | TurnStop
  /** This exchange picks up an earlier, cut-short turn; Mako's own continuation is drawn as Mako's line. */
  continues?: TurnContinuation
  failed?: boolean
}) {
  const sections = useMemo(
    () => responseSections(exchange.response),
    [exchange.response]
  )
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
    (message) => message.provider && HARNESS_LABEL[message.provider]
  )?.provider
  return (
    <article data-exchange={exchange.id} className="contain-turn scroll-mt-6">
      {exchange.prompt ? (
        continues?.auto ? (
          <Continued continuation={continues} timestamp={exchange.prompt.timestamp} />
        ) : (
          <Prompt message={exchange.prompt} />
        )
      ) : null}
      {exchange.system.map((message) => (
        <SystemNote key={message.id} message={message} />
      ))}

      {sections.length > 0 ? (
        <div className={cn("flex flex-col gap-4", exchange.prompt && "mt-4")}>
          {provider ? <AgentByline provider={provider} /> : null}
          {sections.map((section, index) =>
            section.kind === "steer" ? (
              <div key={section.id} className="mt-1">
                <p className="mb-1 text-right text-label text-faint">
                  Steered mid-turn
                </p>
                <Prompt message={section.message} />
              </div>
            ) : section.kind === "prose" ? (
              <Response key={section.id} message={section.message} showWork />
            ) : (
              <WorkSection
                key={section.id}
                messages={section.messages}
                startedAt={index === 0 ? exchange.prompt?.timestamp : undefined}
                live={Boolean(streaming && index === sections.length - 1)}
                interrupted={Boolean(interrupted) && index === sections.length - 1}
                failed={Boolean(failed && index === sections.length - 1)}
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
  return (
    <div className="flex items-center gap-1.5 text-label text-faint">
      <HarnessIcon harness={provider} className="size-3.5" />
      <span>{HARNESS_LABEL[provider] ?? provider}</span>
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
          : "Mako continued the turn"}
      </span>
      {timestamp ? <span className="tabular">{formatTime(timestamp)}</span> : null}
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
  // References the user typed read back as the chips they were written as.
  const segments = useMemo(
    () => attachmentPromptSegments(text, files),
    [text, files]
  )
  const reusable = useMemo(
    () =>
      reusablePromptAttachments(
        files,
        message.blocks.filter((block) => block.type === "attachment")
      ),
    [files, message.blocks]
  )
  const referenceFiles = useMemo(() => reusable.map((item) => ({ index: item.index, name: item.name, path: item.stagedPath })), [reusable])
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
        {message.blocks
          .filter((block) => block.type === "attachment")
          .map((attachment, index) => (
            <div key={attachment.id ?? index} data-copy-file={attachment.source.kind === "file" ? attachment.source.path : undefined}>
              <TranscriptAttachment attachment={attachment} />
            </div>
          ))}
        {files.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files
              .filter(
                (file) =>
                  !segments.some(
                    (segment) =>
                      segment.kind === "attachment" &&
                      segment.file.path === file.path
                  )
              )
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
            "flex flex-col gap-2.5",
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
  { glyph: "bash", count: (work) => work.commands, phrase: (n) => `ran ${n === 1 ? "a command" : `${n} commands`}` },
  { glyph: "read", count: (work) => work.reads, phrase: (n) => `read ${n === 1 ? "a file" : `${n} files`}` },
  { glyph: "grep", count: (work) => work.searches, phrase: (n) => `searched ${n === 1 ? "once" : `${n} times`}` },
  { glyph: "skill", count: (work) => work.skills, phrase: (n) => `used ${n === 1 ? "a skill" : `${n} skills`}` },
  { glyph: "agent", count: (work) => work.agents, phrase: (n) => `started ${n === 1 ? "a background agent" : `${n} background agents`}` },
  { glyph: "todowrite", count: (work) => work.plans, phrase: (n) => `updated the plan${n === 1 ? "" : ` ${n} times`}` },
  { glyph: "other", count: (work) => work.other, phrase: (n) => `used ${n === 1 ? "another tool" : `${n} other tools`}` },
] satisfies Array<{
  glyph: string
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
            <ToolGlyph
              key={glyph}
              name={glyph}
              override={glyph === "agent" ? BotIcon : undefined}
              className="size-3.5"
            />
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
}: {
  message: ChatMessage
  showWork: boolean
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
      {showWork && thinking && showThinking ? (
        <Thinking text={thinking} live={Boolean(message.streaming && !text)} />
      ) : null}

      {showWork && tools.length > 0 ? (
        <div className="flex flex-col gap-1">
          {tools.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      ) : null}

      {attachments.map((attachment, index) => (
        <TranscriptAttachment
          key={attachment.id ?? index}
          attachment={attachment}
        />
      ))}
      {proposals.map((plan) => (
        <ProposedPlanCard
          key={plan.id}
          plan={plan}
          streaming={message.streaming}
        />
      ))}
      {text ? <Prose text={text} streaming={message.streaming} /> : null}

      {message.error ? (
        <div className="flex items-start gap-2 rounded-md border border-negative/30 bg-negative/[0.06] px-2.5 py-2 text-ui text-negative">
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
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1)
  const summary = lastLine.length > 120 ? `…${lastLine.slice(-119)}` : lastLine
  return (
    <div className="rounded-sm border border-transparent">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${live ? "Reasoning in progress" : "Reasoning"}${summary ? `: ${summary}` : ""}`}
        className="pressable flex w-full items-center gap-2 px-2 py-1.5 text-left text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 [transition:transform_150ms_var(--ease-out)]",
            open && "rotate-90"
          )}
        />
        <span className="shrink-0" title={summary}>Thought process</span>
      </button>
      {open ? (
        <div className="border-t border-hairline px-2.5 py-2 text-muted-foreground">
          <Prose text={text} streaming={live} />
        </div>
      ) : null}
    </div>
  )
}

function SystemNote({ message }: { message: ChatMessage }) {
  const text = textOf(message.blocks)
  if (!text) return null
  return (
    <div className="my-3 flex items-center gap-2.5">
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
  const text = responseText(exchange)
  const { copied, copy } = useCopy(text)
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
 * becomes a NEW thread — on the same harness or any other — while the
 * original stays open. Foreign turns fork through the emitters (their
 * message ids carry the entry index); native turns already have Fork on
 * the prompt, so this stays quiet there.
 */
function ForkButton({ exchange }: { exchange: ExchangeData }) {
  const [open, setOpen] = useState(false)
  const viewing = useThreads((state) => state.viewing?.ref)
  const targets = useThreads((state) => continueTargets(state))
  const last = exchange.response.at(-1)
  const nativeEntry = useSession((state) =>
    last && state.tree.some((entry) => entry.id === last.id) ? last.id : null
  )
  const liveRequestId = useAcp((state) => {
    const live = activeLiveAcp(state)
    const requestId = exchange.prompt?.requestId
    if (!requestId) return null
    return live?.requests?.find((request) => request.id === requestId)
      ?.status === "completed"
      ? requestId
      : null
  })
  if (liveRequestId)
    return (
      <>
        <button
          type="button"
          title="Create an idle fork after this answer"
          onClick={() => void acp.fork(liveRequestId)}
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <GitForkIcon className="size-3" /> Fork
        </button>
        <RewindButton requestId={liveRequestId} />
      </>
    )
  // A catalogued thread's answer carries its provider anchor; the fork names
  // that, not a position, so a store that moves under the reader still forks
  // at this answer.
  const anchor = last?.anchor
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
          title="Fork from this answer into a new thread — any harness"
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
            onClick={() => {
              setOpen(false)
              void threads.forkAt(viewing, anchor, target)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-foreground/90 transition-colors duration-100 hover:bg-fill-hover"
          >
            <HarnessIcon harness={target} className="size-3.5" />
            <span className="flex-1">{HARNESS_LABEL[target] ?? target}</span>
            {target === viewing.harness ? (
              <span className="text-label text-faint">same agent</span>
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
