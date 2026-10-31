import { useCopy } from "@/components/ui/use-copy"
import type { ToolIdentity } from "@mako/sessions/tool-identity"
import { memo, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react"
import { readPersonTokenProblem } from "@mako/host/contracts/github-person"
import { useToolView, type ToolCall } from "@/extend/slots"
import {
  formatToolArguments,
  hasToolArguments,
  namedByLabel,
  normalizeToolOutput,
  relativeTo,
  toolLabel,
  toolTarget,
} from "@/lib/tools"
import { callEntryId } from "@/lib/entry-messages"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { usePrefs } from "@/state/prefs"
import { liveVerb, QUIET_AFTER_MS, quietDuration } from "@/state/agent-activity"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Ticking } from "@/components/ui/ticking"
import { HarnessContext, TurnRunningContext, useTranscriptSource } from "./source-context"
import { ToolDetails } from "./tool-details"
import { TranscriptAttachment } from "./attachment"
import { viewer } from "@/state/viewer"
import { loadThreadEntry } from "@/state/thread-viewing"
import { loadLiveHistoryDetail } from "@/state/live-history"
import {
  ChevronRightIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
} from "lucide-react"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { PersonTokenNotice } from "./person-token-notice"
import { Shimmer } from "@/components/ui/shimmer"

/**
 * One tool invocation, collapsed to a single line by default. The row is the
 * transcript's rhythm section — it has to stay quiet at a glance and be
 * complete when opened. Every harness and kind draws the same line: glyph,
 * then its words in one face and size, then whatever is still true about the
 * call at the far end. While the call runs, its words say so (`ToolWords`),
 * and the same row is the running step and, once it returns, the settled
 * one: nothing is swapped when a call finishes.
 */
export const ToolRow = memo(function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const dense = usePrefs((prefs) => prefs.denseTools)
  const source = useTranscriptSource()
  const view = useToolView(call)

  const openPath = view?.openPath?.(call)
  const Body = view?.body
  const server = toolServer(call.tool)
  // A page carries the head of each tool output; the rest is read when the
  // row opens, and the head stays on screen until it lands.
  const rest = open ? call.rest : undefined
  const threadPath = source.threadPath
  const liveId = source.liveId
  // A pull request tool's refusal of the person's own GitHub token is drawn as its notice, open, with both ways on.
  const tokenProblem = useMemo(() => (call.isError ? readPersonTokenProblem(call.result) : undefined), [call.isError, call.result])
  useEffect(() => {
    if (!rest) return
    let active = true
    const read = "live" in rest && liveId
      ? loadLiveHistoryDetail(liveId, rest.live.token, rest.live.at)
      : "entry" in rest && threadPath ? loadThreadEntry(threadPath, rest.entry)
      : Promise.reject(new Error("The source of this output is unavailable."))
    void read.then(() => { if (active) setReadError(null) }, error => {
      if (active) setReadError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [rest, threadPath, liveId, readAttempt])

  return (
    <div data-transcript-tool={call.id}>
      <div className="group/row -mx-1.5 flex min-w-0 items-center rounded-md transition-colors duration-100 hover:bg-fill-hover">
        <button
          type="button"
          aria-expanded={open}
          data-open={open || undefined}
          data-pending={call.pending || undefined}
          onClick={() => setOpen((value) => !value)}
          className="pressable flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-ui"
        >
          <LeadSlot open={open} glyph={<CallGlyph call={call} icon={view?.icon} />} />
          <ToolWords call={call} />
          <span className="flex-1" />
          {server ? <span className="shrink-0 text-label text-faint/70">{server}</span> : null}
          <Status call={call} />
        </button>
        {openPath ? (
          <button
            type="button"
            title={`Open ${openPath}`}
            aria-label={`Open ${openPath}`}
            onClick={() =>
              void viewer.open(
                openPath,
                undefined,
                source.threadPath,
                source.liveId
              )
            }
            className="pressable mr-1 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 hover:text-foreground focus:opacity-100"
          >
            <FileTextIcon className="size-3" />
          </button>
        ) : null}
      </div>

      {tokenProblem ? <PersonTokenNotice problem={tokenProblem} /> : null}
      {open ? (
        <div data-tool-body className="ml-1.75 space-y-2 border-l border-hairline py-1.5 pl-3.75">
          {!rest && call.details?.length ? <ToolDetails details={call.details} /> : null}
          {!rest && (Body && !call.details?.some((detail) => detail.type === "diff") ? (
            <Body call={call} expanded />
          ) : (
            <DefaultBody call={call} dense={dense} />
          ))}
          {!rest && call.attachments?.length ? (
            <div className="space-y-2">
              {call.attachments.map((attachment, index) => (
                <TranscriptAttachment
                  key={attachment.id ?? index}
                  attachment={attachment}
                />
              ))}
            </div>
          ) : null}
          {rest ? (
            <p className="text-label">
              {readError ? <><span role="alert">{readError}</span>{" "}<button type="button" className="pressable underline" onClick={() => { setReadError(null); setReadAttempt(value => value + 1) }}>Try again</button></>
                : <Shimmer text={`Reading the rest of this output${rest.length ? ` · ${rest.length.toLocaleString()} characters` : ""}`} />}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

function toolServer(tool: ToolIdentity): string | undefined {
  return tool.kind === "mcp" || tool.kind === "computer" ? tool.server : undefined
}

/**
 * What a call is and what it acts on, as its row says it: its label and
 * target, or while it runs, its verb and target ("Running npm test") under
 * one sweep of light. That sweep is the only running signal a call has: no
 * spinner in place of its glyph, no mark at the end of its row. A command is
 * its own words, so its row is the command alone ("npm test", not "Shell npm
 * test"), and an agent is what it was asked to do, its harness's mark in
 * front saying it is an agent (running, "Map every protected route" sweeps
 * with no verb). Every part is in the row's one face and size; code reads in full,
 * in the code face, when the row opens. A path inside the conversation's
 * folder reads from there. A call that has run a minute says for how long
 * ("for 4m"), counted in minutes, so it rarely repaints. When the call
 * finishes, the same place holds its settled words. Only a call of a running
 * turn runs (`TurnRunningContext`): a finished record's call that never
 * returned keeps its settled words.
 */
export function ToolWords({ call }: { call: ToolCall }) {
  const view = useToolView(call)
  const turnRunning = useContext(TurnRunningContext)
  const cwd = useTranscriptCwd()
  const running = call.pending && turnRunning
  const command = call.tool.kind === "shell"
  const summary = view?.summary ? view.summary(call) : command ? toolTarget(call.tool) : relativeTo(cwd, toolTarget(call.tool))
  // A command and an agent are named by what they do; the label would only repeat the glyph.
  const named = Boolean(summary) && (command || call.tool.kind === "agent")
  const label = named ? undefined : toolLabel(call.tool)
  // One line of words with plain spaces between its parts, truncated as one, so every row's words sit alike.
  if (running)
    return (
      <>
        <Shimmer className="min-w-0 truncate">
          {named && !command ? null : `${liveVerb(call.tool.kind)} `}
          {namedByLabel(call.tool) ? `${toolLabel(call.tool)} ` : null}
          {summary}
        </Shimmer>
        {call.startedAt !== undefined ? <RunningFor since={call.startedAt} /> : null}
      </>
    )
  const tone = call.isError ? "text-negative" : "text-muted-foreground"
  return (
    <span className={cn("min-w-0 truncate", tone)}>
      {label}
      {label && summary ? " " : null}
      {summary ? <span className={label ? "text-faint" : undefined}>{summary}</span> : null}
    </span>
  )
}

/** "for 4m" after work that has run a minute or more; nothing before that. */
export function RunningFor({ since }: { since: number }) {
  return <Ticking words={(now) => (now - since >= QUIET_AFTER_MS ? `for ${quietDuration(now - since)}` : "")} className="shrink-0 text-faint empty:hidden" />
}

/** The folder the conversation runs in: a live conversation's own, else the one the workspace shows. */
function useTranscriptCwd(): string | undefined {
  const { liveId } = useTranscriptSource()
  const live = useAcp((state) => {
    const conversation = liveId ? state.conversations[liveId] : undefined
    return conversation?.kind === "live" ? conversation.session.cwd : undefined
  })
  const focus = useWorkspaceFocus()
  return live ?? focus.cwd
}

/**
 * The row's first column: what the row is, as a glyph; where the row opens,
 * a chevron takes its place under the pointer and while it is open. One
 * fixed square crossfaded in CSS, so the row never shifts and nothing
 * re-renders. The row's hover surface carries `group/row`.
 */
export function LeadSlot({ glyph, open = false, opens = true }: { glyph: ReactNode; open?: boolean; opens?: boolean }) {
  const layer = "absolute inset-0 m-auto flex size-3.5 items-center justify-center [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  return (
    <span className="relative size-3.5 shrink-0">
      <span className={cn(layer, opens && (open ? "opacity-0" : "group-hover/row:opacity-0"))}>{glyph}</span>
      {opens ? (
        <ChevronRightIcon aria-hidden className={cn(layer, "text-faint", open ? "rotate-90 opacity-100" : "opacity-0 group-hover/row:opacity-100")} />
      ) : null}
    </span>
  )
}

/**
 * A call's glyph: its kind's, brighter while it runs. An agent's is the mark
 * of the harness that runs it (`AgentMark`). The running state itself is the
 * sweep over the words.
 */
export function CallGlyph({ call, icon }: { call: ToolCall; icon?: ComponentType<{ className?: string }> }) {
  const tone = call.isError ? "text-negative" : call.pending ? "text-foreground/80" : "text-faint"
  if (call.tool.kind === "agent" && !icon) return <AgentMark callId={call.id} className={cn("size-3.5", tone)} />
  return <ToolGlyph kind={call.tool.kind} override={icon} className={cn("size-3.5", tone)} />
}

/**
 * The mark of the harness that runs an agent: the one named (`harness`), else
 * the roster's word for the agent call `callId` started, else the harness
 * answering in the transcript around it. An agent another harness runs shows
 * that harness. With none known, the agent glyph.
 */
export function AgentMark({ callId, harness, className }: { callId?: string; harness?: string; className?: string }) {
  const { liveId } = useTranscriptSource()
  const answering = useContext(HarnessContext)
  const listed = useAcp((state) => {
    if (harness || !callId || !liveId) return undefined
    const native = callEntryId(callId)
    return state.conversations[liveId]?.nativeAgents?.agents.find((agent) => agent.toolId === native)?.provider
  })
  const runs = harness ?? listed ?? answering
  return runs ? <HarnessIcon harness={runs} className={className} /> : <ToolGlyph kind="agent" className={className} />
}

/** How the call ended, in words, when it ended other than well; a running call says so in its words (`ToolWords`). */
function Status({ call }: { call: ToolCall }) {
  if (call.pending) return null
  if (call.isError) return <span className="shrink-0 text-label text-negative">failed</span>
  if (call.isCutOff) return <span className="shrink-0 text-label text-faint">{call.isCanceled ? "stopped" : "cut off"}</span>
  if (call.isCanceled) return <span className="shrink-0 text-label text-faint">canceled</span>
  return null
}

/**
 * How a call that never finished ended, said after whatever it had
 * produced: stopped with its turn, cut off when its process went, or
 * canceled by its harness.
 */
export function Ending({ call }: { call: ToolCall }) {
  const ended = call.isCutOff
    ? call.isCanceled ? "Stopped before it finished." : "Cut off before it finished."
    : call.isCanceled ? "Canceled." : undefined
  return ended ? <p className="text-ui text-faint">{ended}</p> : null
}

function DefaultBody({ call, dense }: { call: ToolCall; dense: boolean }) {
  const args = hasToolArguments(call.arguments)
  const input = args ? formatToolArguments(call.arguments) : ""

  return (
    <div className="space-y-2">
      {args ? (
        <CopyableBlock label="input" text={input}>
          <pre className="rounded bg-raised px-2 py-1.5 font-mono text-label leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {input}
          </pre>
        </CopyableBlock>
      ) : null}
      {call.result ? (
        <Output text={call.result} dense={dense} isError={call.isError} running={call.pending} />
      ) : call.pending ? (
        <p className="text-ui"><Shimmer text="Waiting for result…" /></p>
      ) : !call.isCanceled && !call.isCutOff && !call.attachments?.length && !call.details?.length ? (
        <p className="text-ui text-faint">Completed with no text output.</p>
      ) : null}
      <Ending call={call} />
    </div>
  )
}

const CLAMP = 12_000

/** A call's output, its first `CLAMP` characters until asked for all; while `running`, its newest. */
export function Output({
  text,
  dense,
  isError,
  running,
}: {
  text: string
  dense?: boolean
  isError?: boolean
  running?: boolean
}) {
  const [full, setFull] = useState(false)
  // Streamed output is plain text, and a running command's can grow without end.
  const normalized = running ? text : normalizeToolOutput(text)
  const clipped = !full && normalized.length > CLAMP

  return (
    <CopyableBlock label="output" text={normalized}>
      <pre
        className={cn(
          "font-mono text-label leading-[1.6] break-words whitespace-pre-wrap",
          dense ? "max-h-40 overflow-y-auto" : "max-h-[26rem] overflow-y-auto",
          isError ? "text-negative/90" : "text-muted-foreground"
        )}
      >
        {!clipped ? normalized : running ? `…\n${normalized.slice(-CLAMP)}` : `${normalized.slice(0, CLAMP)}\n…`}
      </pre>
      {clipped ? (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="mt-1 text-label text-muted-foreground hover:underline"
        >
          Show all {normalized.length.toLocaleString()} characters
        </button>
      ) : null}
    </CopyableBlock>
  )
}

/**
 * A block whose contents can leave. The copy affordance appears on hover in
 * the block's own corner — input and output each copy independently, whole
 * and unclipped, because "copy the answer" and "copy the command that
 * produced it" are different needs.
 */
function CopyableBlock({
  label,
  text,
  children,
}: {
  label: string
  text: string
  children: React.ReactNode
}) {
  const { copied, copy } = useCopy(text)
  return (
    <div className="group/copyblock relative">
      {children}
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copy()
        }}
        className={cn(
          "pressable absolute top-1 right-1 rounded-md bg-raised p-1 ring-1 ring-hairline backdrop-blur-sm",
          "text-faint transition-opacity duration-100 hover:text-foreground",
          copied
            ? "opacity-100"
            : "opacity-0 group-hover/copyblock:opacity-100 focus-visible:opacity-100"
        )}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </button>
    </div>
  )
}
