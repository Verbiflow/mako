import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ActivityIcon, ChevronRightIcon, PauseIcon, RefreshCwIcon } from "lucide-react"
import { toolKindActivity } from "@mako/sessions/tool-identity"
import { durationText } from "@mako/sessions/events"
import { useToolView, type ToolCall } from "@/extend/slots"
import { groupAgentCalls } from "@/lib/agent-groups"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { agentActivity, QUIET_AFTER_MS, quietDuration, type AgentActivity, type AgentActivityKind } from "@/state/agent-activity"
import { promptDelivery } from "@/state/prompt-delivery"
import { shallowEqual } from "@/state/store"
import { Shimmer } from "@/components/ui/shimmer"
import { Ticking } from "@/components/ui/ticking"
import { AgentGroup } from "./agent-group"
import { EventLine } from "./event-line"
import { useTranscriptSource } from "./source-context"
import { CODE_KINDS, namedByLabel, toolLabel, toolTarget } from "@/lib/tools"
import { ToolRow, ToolWords } from "./tool-row"
import { ToolGlyph } from "./tool-views"

/**
 * What a running turn is doing now, said once. The turn's newest step is
 * at the end of its work, under what it has already done: a row for each
 * call running, so calls that run at once stand one above another; the
 * transcript's end no longer says it again. The provider's own reports
 * (retrying after an error, compacting the context) and Mako's (waiting for
 * your approval, no output for a while) take the same place, because they
 * are what the turn is doing.
 */

/** What the newest step of a running turn is, read from the turn's own messages. */
export interface LiveStepData {
  /** The newest call still running, when one is. */
  call?: ToolCall
  /**
   * Every call of the step, in the order they began: those running and
   * those that ran beside them, `call` among them. Agents started together
   * are in it whole. Empty when no call runs.
   */
  calls: readonly ToolCall[]
  /** The harness that made the call, for an agent group's marks. */
  provider?: string
  /** The newest thought's last line, when it is the step or stands just before it. */
  thought?: string
  /** The model is thinking now: the turn's last block is a thought. */
  thinking: boolean
}

/** The provider's and Mako's word on a turn, beyond what its messages say. */
interface LiveTurnStatus extends AgentActivity {
  native?: "compacting" | "retrying" | "waiting"
  /** When the turn last produced anything, on the host's clock. */
  activityAt?: number
}

const NO_BLOCKS: never[] = []
const IDLE: LiveTurnStatus = { kind: "idle", label: "" }

/**
 * The parts of the conversation's state that say what its turn is doing,
 * through `agentActivity` with no blocks: approval, an account switch, the
 * provider's own activity. Primitive fields only, so a token that changes
 * none of them wakes nothing.
 */
function useLiveTurnStatus(): LiveTurnStatus {
  const { liveId } = useTranscriptSource()
  return useAcp((state) => {
    const live = liveId ? state.conversations[liveId] : undefined
    if (live?.kind !== "live") return IDLE
    const receipt = live.control?.approvalResponses?.find((each) => each.id === live.permission?.id)
    // The approval notice, or the plan bar for a plan's approval, owns that wait.
    if (receipt || live.permission?.implementsPlan) return { ...IDLE, activityAt: live.activityAt }
    const switchingAccount = Boolean(live.requests?.some((request) => request.status === "queued" && request.accountSwitch))
    // Starting the harness and sending are said at the transcript's end, where the wait's clock is (`AcpActivity`).
    const connecting = live.session.status === "starting"
    const preparing = live.session.status !== "running" && Boolean(live.requests?.some((request) => request.status === "dispatching") || promptDelivery(live).starting)
    const activity = agentActivity({ blocks: NO_BLOCKS, waiting: Boolean(live.permission), connecting, preparing, switchingAccount, native: live.nativeActivity, harness: live.session.harness })
    return { ...activity, native: live.nativeActivity?.kind, activityAt: live.activityAt }
  }, shallowEqual)
}

/** A turn quiet this long reads so on its live row; checked once, when it would begin, not on a timer per second. */
function useQuietSince(activityAt: number | undefined): boolean {
  const [quiet, setQuiet] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (activityAt === undefined) return
    const wait = activityAt + QUIET_AFTER_MS - Date.now()
    const timer = setTimeout(() => setQuiet(activityAt), Math.max(0, wait))
    return () => clearTimeout(timer)
  }, [activityAt])
  return activityAt !== undefined && quiet === activityAt
}

/** "Working for 1m 12s" at the head of a running turn, counted from `since` without rendering; `bare` when nothing stands before it. */
export function TurnClock({ since, bare = false }: { since: number; bare?: boolean }) {
  return (
    <span data-turn-clock className="flex min-w-0 items-baseline gap-1.5 text-faint">
      {bare ? null : <span aria-hidden>·</span>}
      <Ticking words={(now) => (now - since >= 1_000 ? `Working for ${formatDuration(now - since)}` : "Working")} />
    </span>
  )
}

/**
 * The newest step's rows. A call that runs is its glyph in the tool column
 * and its words, verb and target, under one sweep of light (`ToolWords`):
 * that sweep is the only running signal, so the row has no mark at its end.
 * Calls that run at once each have their row; one that finishes first
 * settles in its place into the row the list will show for it, the same
 * height, so nothing under it moves. A wait, the provider's own report or
 * the model thinking is one row of the same shape. `onToggle` opens the
 * turn's whole list of steps; without it the row is only a line (nothing
 * has run yet to list). Under an answer that is still being written
 * (`answering`) the words are the news, so the row stays away unless the
 * turn has something else to say.
 */
export function LiveRow({ step, open, onToggle, answering = false }: { step: LiveStepData; open?: boolean; onToggle?: () => void; answering?: boolean }) {
  const status = useLiveTurnStatus()
  const quiet = useQuietSince(status.kind === "idle" || status.native ? undefined : status.activityAt)
  if (status.kind === "connecting") return null
  if (status.native === "compacting") return <CompactingDivider since={status.since} />
  const waiting = status.kind === "waiting"
  const native = status.native === "retrying" || status.native === "waiting"
  if (answering && !waiting && !native && !quiet) return null
  const call = step.call
  const kind: AgentActivityKind = waiting ? "waiting" : native ? "working" : call ? toolKindActivity(call.tool.kind) : step.thinking ? "reasoning" : "working"
  const quietFor = quiet && !waiting && status.activityAt !== undefined ? <QuietFor since={status.activityAt} /> : null
  const thought = step.thought && call && !open && !waiting && !native ? <ThoughtLine text={step.thought} /> : null
  const items = call && !waiting && !native ? groupAgentCalls(step.calls) : []
  if (items.length)
    return (
      <div role="status" data-agent-activity={kind} data-live-step={items.length > 1 ? "calls" : items[0]!.kind === "agents" ? "agents" : ""} className="flex min-w-0 flex-col">
        {thought}
        {items.map((item) =>
          item.kind === "agents" ? (
            <AgentGroup key={item.id} calls={item.calls} provider={step.provider} live />
          ) : item.call.pending ? (
            <LiveLine key={item.call.id} onToggle={onToggle} open={open} glyph={<ToolGlyph kind={item.call.tool.kind} className="size-3.5 text-foreground/80" />}>
              <ToolWords call={item.call} />
              {item.call === call ? quietFor : null}
            </LiveLine>
          ) : (
            <ToolRow key={item.call.id} call={item.call} />
          )
        )}
      </div>
    )
  const words: ReactNode = waiting || native ? (
    <>
      {waiting ? <span className="shrink-0 text-foreground">{status.label}</span> : <Shimmer text={status.label} className="shrink-0" />}
      {status.detail ? <span className="min-w-0 truncate text-faint">{status.detail}</span> : null}
      {native && status.since !== undefined ? <NativeClock since={status.since} retryAt={status.retryAt} /> : null}
      {waiting && call ? <CallObject call={call} /> : null}
    </>
  ) : (
    <Shimmer className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{step.thinking ? "Thinking" : "Working"}</span>
      {step.thinking && step.thought ? <span className="min-w-0 truncate text-faint">{step.thought}</span> : null}
    </Shimmer>
  )
  const glyph = waiting ? (
    <PauseIcon className="size-3.5 text-caution" />
  ) : status.native === "retrying" ? (
    <RefreshCwIcon className="size-3.5 text-foreground/80" />
  ) : call ? (
    <ToolGlyph kind={call.tool.kind} className="size-3.5 text-foreground/80" />
  ) : step.thinking ? (
    <ToolGlyph kind="think" className="size-3.5 text-foreground/80" />
  ) : (
    <ActivityIcon className="size-3.5 text-foreground/80" />
  )
  return (
    <div role="status" data-agent-activity={kind} data-live-step="" className="flex min-w-0 flex-col">
      <LiveLine onToggle={onToggle} open={open} glyph={glyph}>
        <span className="flex min-w-0 items-baseline gap-1.5">{words}</span>
        {quietFor}
      </LiveLine>
    </div>
  )
}

/**
 * One row of the live step: the tool column, then its words; a button that
 * opens the turn's steps when there are steps to open. The height of a
 * transcript's tool row, so a call that settles in it moves nothing. A row
 * arrives with the step it stands for; the arrival is the row's own
 * animation, never its words', which sweep.
 */
function LiveLine({ glyph, onToggle, open, children }: { glyph: ReactNode; onToggle?: () => void; open?: boolean; children: ReactNode }) {
  const row = "motion-safe:animate-[label-arrive_160ms_var(--ease-out)] -mx-1.5 flex h-7 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui"
  const line = (
    <>
      <LeadGlyph glyph={glyph} toggles={Boolean(onToggle)} open={Boolean(open)} />
      {children}
    </>
  )
  return onToggle ? (
    <button type="button" aria-expanded={open} aria-label={open ? "Hide the steps so far" : "Show the steps so far"} onClick={onToggle} className={cn(row, "pressable group/live transition-colors duration-100 hover:bg-fill-hover")}>
      {line}
    </button>
  ) : (
    <div className={row}>{line}</div>
  )
}

/** The tool column's glyph, giving way to a chevron where the row opens. */
function LeadGlyph({ glyph, toggles, open }: { glyph: ReactNode; toggles: boolean; open: boolean }) {
  const layer = "absolute inset-0 m-auto flex items-center justify-center [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  return (
    <span className="relative size-3.5 shrink-0">
      <span className={cn(layer, toggles && (open ? "opacity-0" : "group-hover/live:opacity-0"))}>{glyph}</span>
      {toggles ? <ChevronRightIcon aria-hidden className={cn(layer, "size-3.5 text-faint", open ? "rotate-90 opacity-100" : "opacity-0 group-hover/live:opacity-100")} /> : null}
    </span>
  )
}

/** What a call waiting on approval acts on, as its own row would show it: the view's summary, or the target. */
function CallObject({ call }: { call: ToolCall }) {
  const view = useToolView(call)
  const label = namedByLabel(call.tool) ? toolLabel(call.tool) : undefined
  const summary = view?.summary ? view.summary(call) : toolTarget(call.tool)
  return (
    <>
      {label ? <span className="shrink-0 text-muted-foreground">{label}</span> : null}
      {summary ? <span className={cn("min-w-0 truncate text-faint", !view?.summary && CODE_KINDS.has(call.tool.kind) && "font-mono text-label")}>{summary}</span> : null}
    </>
  )
}

/** One line of the model's newest thought, above the step it led to. */
function ThoughtLine({ text }: { text: string }) {
  return (
    <p data-live-thought className="flex h-6 min-w-0 items-center gap-2 text-ui text-faint">
      <span aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </p>
  )
}

/** "No output for 4m" beside a step that has said nothing for a while; minutes, so it counts without rendering. */
function QuietFor({ since }: { since: number }) {
  return <Ticking words={(now) => `· no output for ${quietDuration(now - since)}`} className="shrink-0 text-faint" />
}

/** How long the provider has been at it, or how long until its next attempt. */
function NativeClock({ since, retryAt }: { since: number; retryAt?: number }) {
  return (
    <Ticking
      words={(now) =>
        retryAt !== undefined && retryAt > now ? `· next try in ${durationText(retryAt - now + 999)}` : now - since >= 1_000 ? `· ${durationText(now - since)}` : ""
      }
      className="shrink-0 text-faint"
    />
  )
}

/**
 * The provider compacting the context, drawn where its "Context compacted"
 * divider will stand once it has: the same divider, sweeping while it works.
 */
function CompactingDivider({ since }: { since?: number }) {
  return (
    <div role="status" data-agent-activity="working" data-live-step="compacting">
      <EventLine
        variant="divider"
        running
        words={{ glyph: "compaction", title: "Compacting context", detail: "Making room to continue" }}
        trailing={since !== undefined ? <NativeClock since={since} /> : undefined}
      />
    </div>
  )
}

/**
 * A list that keeps its newest row in view as rows arrive, unless the
 * reader has scrolled up in it; `capped` while its turn runs, so forty
 * steps open to a window onto them rather than a wall. Settled, it is the
 * plain list, in the same element, so settling remounts nothing.
 */
export function FollowingList({ capped, children }: { capped: boolean; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && capped && following.current) element.scrollTop = element.scrollHeight
  })
  useEffect(() => {
    const element = scroller.current
    const content = element?.firstElementChild
    if (!element || !content || !capped) return
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [capped])
  return (
    <div
      ref={scroller}
      data-live-list
      onScroll={(event) => {
        const element = event.currentTarget
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
      }}
      className={capped ? "max-h-[min(18rem,50vh)] overflow-y-auto overscroll-contain" : undefined}
    >
      {children}
    </div>
  )
}
