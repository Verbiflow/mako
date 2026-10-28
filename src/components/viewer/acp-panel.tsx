import { useHarnessIdentity, useHarnessLabels } from "@/lib/harness-label"
import { latestPendingQuestion } from "@mako/host/contracts/live-questions"
import { carriedHistories, promptDelivery, recoverableRequests, recoveriesByPlace, makoPrompts, turnStops } from "@/state/prompt-delivery"
import { FailureRow } from "@/components/transcript/failure-row"
import { FailedRequestsContext } from "@/components/transcript/failed-requests"
import { agentActivity, startLabel } from "@/state/agent-activity"
import { shallowEqual } from "@/state/store"
import { ActivityMark } from "@/components/ui/activity-mark"
import { useLasting } from "@/components/ui/use-lasting"
import { Shimmer } from "@/components/ui/shimmer"
import { durationText } from "@mako/sessions/events"
import { loadEarlierLive } from "@/state/live-recovery"
import { continueTurn } from "@/state/acp-queue"
import { skipWorktree } from "@/state/acp-start"
import { WorktreeOpening } from "@/components/viewer/worktree-opening"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useStartedWorktree } from "@/state/worktrees"
import { BackgroundWorkLine } from "./background-work-line"
import { useEffect, useMemo, useState } from "react"
import { Disclosure } from "@/components/ui/notice"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { acp, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { scopedAcp, scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreads } from "@/state/threads"
import { asksInSession, descriptorFor } from "@/state/descriptors"
import { usePlanDecision } from "@/state/plan-mode"
import { viewerHandedOff } from "@/state/thread-viewing"
import { toast } from "sonner"
import type { LivePermissionRequest, LiveRequest } from "@/lib/types"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { identifyTool } from "@mako/sessions/tool-identity"
import { ToolGlyph } from "@/components/transcript/tool-views"
import {
  CheckCheckIcon,
  CheckIcon,
  CircleAlertIcon,
  PlayIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react"
import { Orb } from "@/components/ui/orb/orb"

/**
 * A foreign agent, live.
 *
 * This is the difference between reading another harness's session and
 * *driving* it: tokens stream as they are generated, tool calls appear as
 * they run, and when the agent wants a permission its mode does not grant,
 * the question lands here — with the agent's own options, not a yes/no we
 * invented. A Claude Code thread opened this way is the same session its CLI
 * would resume, not a copy. The one composer below the column does the
 * talking; this surface is the transcript, the permission question, and the
 * agent's own modes.
 */

const EMPTY_QUEUE: never[] = []
const NO_RECOVERIES = { onTurns: new Map<string, LiveRequest>(), apart: EMPTY_QUEUE }

export function AcpPanel() {
  const scope = useConversationScope()
  const session = useAcp((state) => scopedLiveAcp(state, scope)?.session ?? null)
  const starting = useAcp((state) => scopedAcp(state, scope)?.kind === "starting")
  // The reader was already looking at this conversation's history when it
  // went live: the same turns stay where they are, so the panel does not
  // arrive as a new surface. Read once per conversation, so moving focus
  // between panes never replays the entrance while switching to another
  // conversation still plays it. The timeline owns the entrance; a second
  // one on this frame compounded its fade.
  const identity = useAcp((state) => scopedAcp(state, scope)?.draftKey)
  const inPlace = useContinuedInPlace()
  const [arrival, setArrival] = useState({ identity, continued: inPlace })
  if (arrival.identity !== identity) setArrival({ identity, continued: inPlace })
  const continued = arrival.identity === identity ? arrival.continued : inPlace

  if (starting) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <Blocks starting continued={continued} />
      </div>
    )
  }
  if (!session) return null

  return (
    <div data-live-conversation={session.id} className="flex min-h-0 flex-1 flex-col bg-surface">
      <Blocks continued={continued} />
      {scope ? (
        <PaneWaiting />
      ) : (
        <>
          <Permission />
          <SessionQuestion />
        </>
      )}
    </div>
  )
}

function useContinuedInPlace(): boolean {
  const scope = useConversationScope()
  const threadPath = useAcp((state) => scopedAcp(state, scope)?.threadPath)
  const viewed = useThreads((state) => threadPath !== undefined && state.viewing?.ref.path === threadPath)
  // A pane opening beside another grows in; its transcript doesn't enter again.
  // The viewer may already have let go of the transcript in the same update
  // that mounted this panel, so its handoff counts as having viewed it.
  return scope !== null || viewed || viewerHandedOff(threadPath)
}

/** A pane without focus says the agent is waiting; the answer is given once the pane has focus. */
function PaneWaiting() {
  const scope = useConversationScope()
  const waiting = useAcp((state) => {
    const live = scopedLiveAcp(state, scope)
    if (!live) return false
    return Boolean(live.permission) || Boolean(live.control && latestPendingQuestion(live.control, live.requests ?? EMPTY_QUEUE))
  })
  if (!waiting) return null
  return (
    <p className="flex shrink-0 items-center gap-1.5 border-t border-hairline px-4 py-2 text-label text-caution">
      <ShieldQuestionIcon className="size-3.5 shrink-0" />
      Waiting for your answer. Click here to answer.
    </p>
  )
}

/**
 * The top of a conversation whose earlier turns the host reads from their
 * session rather than its journal: a read under way, or one that found
 * nothing. Holds the history edge's single row.
 */
function HistoryReadNote({ state }: { state: "reading" | { failed: string } }) {
  if (state === "reading")
    return (
      <span role="status" className="animate-enter mx-auto flex items-center gap-2 text-label text-faint">
        <Orb state="breathing" size={20} />
        <span>Reading earlier turns…</span>
      </span>
    )
  return (
    <span title={state.failed} className="animate-enter mx-auto flex min-w-0 items-center gap-1.5 text-label text-caution">
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">Couldn’t read the earlier turns. New messages still continue this conversation.</span>
    </span>
  )
}

function Blocks({ starting = false, continued = false }: { starting?: boolean; continued?: boolean }) {
  const scope = useConversationScope()
  const session = useAcp((state) => scopedLiveAcp(state, scope)?.session ?? null)
  const projection = useAcp((state) => scopedAcp(state, scope)?.projection)
  const history = useAcp((state) => scopedAcp(state, scope)?.base)
  const historyWindow = useAcp((state) => scopedAcp(state, scope)?.history)
  // Stable from the first keystroke of a start through promotion and any
  // later binding: the transcript keeps its scroll position and its turns.
  const identity = useAcp((state) => scopedAcp(state, scope)?.draftKey ?? "none")
  const requests = useAcp((state) => scopedAcp(state, scope)?.requests ?? EMPTY_QUEUE)
  const sessionId = session?.id
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const loadEarlier = useMemo(
    () =>
      sessionId === undefined
        ? undefined
        : async () => {
            setLoadingEarlier(true)
            try {
              await loadEarlierLive(sessionId)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error))
            } finally {
              setLoadingEarlier(false)
            }
          },
    [sessionId]
  )
  const preparing = useAcp((state) => {
    const current = scopedLiveAcp(state, scope)
    return Boolean(
      current &&
      (current.requests?.some((request) => request.status === "dispatching") ||
        promptDelivery(current).starting)
    )
  })
  const running =
    starting ||
    preparing ||
    session?.status === "starting" ||
    session?.status === "running"
  const interruptedRequests = useMemo(() => turnStops(requests, running), [requests, running])
  const blocks = useAcp((state) => scopedLiveAcp(state, scope)?.blocks ?? EMPTY_QUEUE)
  const earlierRequests = useAcp((state) => scopedLiveAcp(state, scope)?.history?.earlierRequests)
  // Only a conversation with a message to recover reads its turns for where each was said.
  const recovering = requests.some((request) => request.status === "failed" || request.status === "uncertain" || request.status === "interrupted")
  const recoveries = useMemo(
    () => recovering ? recoveriesByPlace({ blocks, history: earlierRequests ? { earlierRequests } : undefined, requests }) : NO_RECOVERIES,
    [recovering, blocks, earlierRequests, requests]
  )
  const madeByMako = useMemo(() => makoPrompts(requests), [requests])
  const carried = useMemo(() => carriedHistories(requests), [requests])
  const exchanges = projection?.exchanges ?? EMPTY_QUEUE
  const unread = useAcp((state) => scopedLiveAcp(state, scope)?.hydrated === false)
  const lastExchangeId = exchanges.at(-1)?.id
  const row = useAcp((state) => {
    const current = scopedAcp(state, scope)
    return { threadId: current?.threadId, sessionId: current?.sessionId, cwd: scopedLiveAcp(state, scope)?.session.cwd ?? current?.cwd }
  }, shallowEqual)
  const worktree = useStartedWorktree(useThreadGroups((state) => rowThread(row, state.threadOf)), row.cwd)
  const historyState = useAcp((state) => {
    const current = scopedAcp(state, scope)
    if (!current?.baseSource || current.hydrated === false || current.base) return null
    return current.historyFailure ? { failed: current.historyFailure } : "reading"
  }, shallowEqual)
  const historyNote = historyState ? <HistoryReadNote state={historyState} /> : null

  return (
    <FailedRequestsContext value={recoveries.onTurns}>
    <ConversationTimeline
      source={{ liveId: sessionId, historyFrom: historyWindow ? { blocks: historyWindow.blockStart, base: history?.start ?? 0 } : undefined }}
      identity={identity}
      entrance={!continued}
      hasEarlier={Boolean(historyWindow?.before || history?.hasEarlier)}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
      exchanges={exchanges}
      streamingId={running ? lastExchangeId : undefined}
      interruptedRequests={interruptedRequests}
      makoPrompts={madeByMako}
      carriedHistories={carried}
      failedId={session?.status === "failed" ? lastExchangeId : undefined}
      opening={historyNote ?? (worktree?.start ? <WorktreeOpening worktree={worktree} start={worktree.start} /> : undefined)}
      empty={unread ? null : historyState === "reading" ? (
        <div className="mx-auto flex w-full max-w-content px-6 py-6 pt-14">{historyNote}</div>
      ) : (
        <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-6 py-6">
          {historyNote}
          <p className="pt-8 text-center text-ui leading-relaxed text-faint">
            {session?.status === "failed"
              ? requests.some((request) => request.status === "failed" || request.status === "uncertain")
                ? "Saved conversation"
                : session.error || "The provider could not open this session."
              : session?.connection === "disconnected"
                ? "Saved conversation. The provider is not currently connected."
                : running
                  ? "Connecting to the provider. Your message is being kept until it is ready."
                  : "The session is loaded. Anything you send continues it — same conversation, same working directory."}
          </p>
          <AcpActivity
            running={running}
            starting={starting || session?.status === "starting"}
            preparing={preparing && session?.status !== "running"}
          />
        </div>
      )}
      footer={
        <>
          {sessionId && recoveries.apart.length ? (
            <div className="flex flex-col gap-3">
              {recoveries.apart.map((request) => (
                <FailureRow key={request.id} conversationId={sessionId} request={request} quoted />
              ))}
            </div>
          ) : null}
          <AcpActivity
            running={running}
            starting={starting || session?.status === "starting"}
            preparing={preparing && session?.status !== "running"}
            hosted={exchanges.length > 0}
          />
          {running ? null : <BackgroundWorkLine />}
        </>
      }
    />
    </FailedRequestsContext>
  )
}

/**
 * What a conversation is doing before its turn can say it: starting the
 * harness, making its worktree, sending. Once a turn is on screen
 * (`hosted`), its own live row says what it is doing (`live-step.tsx`), so
 * this row speaks only for those waits; with no turn yet it says it all.
 */
function AcpActivity({
  running,
  starting = false,
  preparing = false,
  hosted = false,
}: {
  running: boolean
  starting?: boolean
  preparing?: boolean
  hosted?: boolean
}) {
  const scope = useConversationScope()
  const activityAt = useAcp((state) => scopedLiveAcp(state, scope)?.activityAt)
  const quietForMs = useQuietFor(running ? activityAt : undefined)
  const making = useAcp((state) => {
    const current = scopedAcp(state, scope)
    return current?.kind === "starting" && current.worktree === "making" ? current.key : undefined
  })
  const worktreeStep = useAcp((state) => {
    const current = scopedAcp(state, scope)
    return current?.kind === "starting" ? current.worktreeStep : undefined
  })
  const makingWorktree = useLasting(making, MAKING_WORKTREE_SHOWN_AFTER_MS)
  const conversationKey = useAcp((state) => scopedAcp(state, scope)?.key)
  const slowWorktree = useLasting(making, SLOW_WORKTREE_MS)
  const labels = useHarnessLabels()
  const startingAs = useAcp((state) => {
    const current = scopedAcp(state, scope)
    if (current?.kind === "starting") return startLabel(labels[current.harness], current.cloudStep)
    return current?.kind === "live" ? startLabel(labels[current.session.harness]) : undefined
  })
  const activity = useAcp((state) => {
    const live = scopedLiveAcp(state, scope)
    const approval = live?.control?.approvalResponses?.find(receipt => receipt.id === live.permission?.id)
    // The approval notice, or the plan bar for a plan's approval, owns this
    // status; do not repeat it in the transcript.
    if (approval || live?.permission?.implementsPlan) return { kind: "idle" as const, label: "" }
    const switchingAccount = Boolean(live?.requests?.some((request) => request.status === "queued" && request.accountSwitch))
    return agentActivity({ blocks: live?.blocks ?? EMPTY_QUEUE, waiting: Boolean(live?.permission), connecting: starting, starting: startingAs, makingWorktree, worktreeStep, preparing, switchingAccount, quietForMs, native: live?.nativeActivity, harness: live?.session.harness })
  }, shallowEqual)
  const waiting = running && activity.kind === "connecting"
  // The wait ended (it started, or the send went): the next one is timed afresh.
  useEffect(() => {
    if (!waiting && conversationKey) waitsBegan.delete(conversationKey)
  }, [waiting, conversationKey])
  return running && activity.kind !== "responding" && activity.kind !== "idle" && (!hosted || activity.kind === "connecting") ? (
    <div role="status" data-agent-activity={activity.kind} className="flex min-h-8 min-w-0 items-center gap-2 py-1 text-ui text-muted-foreground">
      <ActivityMark state={activity.kind} size={20} />
      {activity.since === undefined ? (
        <>
          <span key={activity.label} className="truncate animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">{activity.label}</span>
          {activity.kind === "connecting" && !making ? <WaitClock waitKey={conversationKey} /> : null}
          {making && slowWorktree && (
            <button
              type="button"
              onClick={() => skipWorktree(making)}
              className="pressable ml-1 shrink-0 rounded-md px-1.5 py-0.5 text-label text-faint animate-in fade-in-0 duration-200 ease-[var(--ease-out)] hover:bg-fill-hover hover:text-foreground"
            >
              Use the project folder instead
            </button>
          )}
        </>
      ) : (
        <span data-native-activity className="flex min-w-0 items-baseline gap-1">
          <Shimmer text={activity.label} className="shrink-0" />
          {activity.detail ? <span className="truncate text-faint">· {activity.detail}</span> : null}
          <NativeClock since={activity.since} retryAt={activity.retryAt} />
        </span>
      )}
    </div>
  ) : null
}

/** A wait this short reads as instant and shows no clock; one longer shows how long, and past `WAIT_LONG_MS`, that it is. */
const WAIT_CLOCK_MS = 3_000
const WAIT_LONG_MS = 20_000
/**
 * When each conversation began waiting to start or send, kept across the panel's remounts (a tab switch), so a wait
 * that goes on isn't shown as just begun. One per conversation; cleared when the wait ends.
 */
const waitsBegan = new Map<string, number>()

/**
 * How long a start or a send has waited, for a person: nothing for the first seconds, then a quiet count, then that
 * it's taking longer than usual. A cloud Thread waking or starting reads like any other wait: never its machinery.
 */
function WaitClock({ waitKey }: { waitKey: string | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  const began = waitKey ? (waitsBegan.get(waitKey) ?? now) : now
  useEffect(() => {
    if (waitKey && !waitsBegan.has(waitKey)) waitsBegan.set(waitKey, began)
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [waitKey, began])
  const waited = now - began
  if (waited < WAIT_CLOCK_MS) return null
  return (
    <span className="flex min-w-0 shrink items-baseline gap-1 text-faint animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">
      {waited >= WAIT_LONG_MS ? <span className="truncate">· taking longer than usual</span> : null}
      <span className="tabular shrink-0">· {durationText(waited)}</span>
    </span>
  )
}

/**
 * How long the provider has been at it, or how long until its next attempt.
 * Only this span ticks, once a second, while the row is shown.
 */
function NativeClock({ since, retryAt }: { since: number; retryAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const text = retryAt !== undefined && retryAt > now
    ? `next try in ${durationText(retryAt - now + 999)}`
    : now - since >= 1_000 ? durationText(now - since) : undefined
  return text ? <span className="tabular shrink-0 text-faint">· {text}</span> : null
}

/** A spare worktree is ready in well under this; only a checkout made on the spot is worth naming. */
const MAKING_WORKTREE_SHOWN_AFTER_MS = 400
/** A start still making its worktree after this offers to go ahead in the project folder. */
const SLOW_WORKTREE_MS = 2_000

/** Time since `activityAt`, read again when it moves and every few seconds while it is set. */
function useQuietFor(activityAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (activityAt === undefined) return
    const read = () => setNow(Date.now())
    const first = setTimeout(read, 0)
    const timer = setInterval(read, 5_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [activityAt])
  return activityAt === undefined ? 0 : Math.max(0, now - activityAt)
}

/**
 * The agent's question, with the agent's answers.
 *
 * Choices and structured questions come from the agent and render without
 * inventing a second permission vocabulary. This should read as a question,
 * not an alert.
 */
function Permission() {
  const permission = useAcp((state) => activeLiveAcp(state)?.permission ?? null)
  const receipt = useAcp(state => {
    const live = activeLiveAcp(state)
    return live?.control?.approvalResponses?.find(item => item.id === live.permission?.id)
  })
  // The process that asked has exited: the host marks it, and a dropped connection says so before the host does.
  const gone = useAcp((state) => Boolean(activeLiveAcp(state)?.permission?.gone) || activeLiveAcp(state)?.session.connection === "disconnected")
  // A plan approval is answered from the plan bar above the composer.
  const planApproval = usePlanDecision()?.approval?.id
  if (!permission || planApproval === permission.id) return null
  if (gone) return <GonePermission permission={permission} />
  // Keep a structured draft mounted while its answer is in flight. A proven
  // refusal can renew the public occurrence without clearing the user's input.
  return <div hidden={Boolean(receipt)}>
    <PermissionInput key={permission.origin ? JSON.stringify(permission.origin) : permission.id} permission={permission} />
  </div>
}

/**
 * A request whose agent process has gone: no answer can reach it, so it
 * offers none. It says so, names what was asked, and offers what still
 * works: Continue turn starts the agent again on this turn, which asks
 * again if it still needs to; Stop puts the request away.
 */
function GonePermission({ permission }: { permission: LivePermissionRequest }) {
  useHarnessIdentity()
  const key = useAcp((state) => activeLiveAcp(state)?.key)
  const harness = useAcp((state) => activeLiveAcp(state)?.harness)
  const canceling = useAcp((state) => activeLiveAcp(state)?.canceling ?? false)
  const [continuing, setContinuing] = useState(false)
  const provider = harness ? harnessLabel(harness) : "The agent"
  const tool = identifyTool({ acpKind: permission.kind, title: permission.title })
  const makoTool = tool.server === "mako" && tool.kind === "mcp" ? tool.label : undefined
  return (
    <div data-permission-gone={permission.id} className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-2.5">
      <p className="flex items-center gap-1.5 text-ui text-foreground/90">
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-caution" />
        <span className="min-w-0 truncate">{provider} stopped before you answered</span>
      </p>
      <p className="pt-0.5 pb-2 pl-5 text-label text-muted-foreground">
        It asked about <span className={cn(!makoTool && !permission.detail && "font-mono")}>{makoTool ?? permission.title}</span>. Nothing can answer it now; continue the turn and it asks again if it still needs to.
      </p>
      <div className="flex flex-wrap gap-1.5 pl-5">
        <button
          type="button"
          disabled={!key || continuing}
          onClick={() => {
            if (!key) return
            setContinuing(true)
            void continueTurn(key, "provider-exited").finally(() => setContinuing(false))
          }}
          className="pressable flex items-center gap-1.5 rounded-md border border-hairline bg-foreground px-2 py-1 text-label text-background hover:opacity-90 disabled:opacity-50"
        >
          <PlayIcon className="size-3 fill-current" strokeWidth={0} />
          {continuing ? "Continuing…" : "Continue turn"}
        </button>
        <button
          type="button"
          disabled={canceling}
          onClick={() => void acp.cancel()}
          className="pressable rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Stop
        </button>
      </div>
    </div>
  )
}

function PermissionInput({ permission }: { permission: LivePermissionRequest }) {
  if (permission.questions)
    return <QuestionPermission permission={permission} />
  // Devin and Codex ask to run `mako: app_start`; the row names Mako's own tools in words.
  const tool = identifyTool({ acpKind: permission.kind, title: permission.title })
  const makoTool = tool.server === "mako" && tool.kind === "mcp" ? tool.label : undefined
  return (
    <div className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-2.5">
      <p className="flex items-center gap-1.5 text-ui text-foreground/90">
        {permission.kind ? (
          <ToolGlyph
            kind={tool.kind}
            className="size-3.5 shrink-0 text-caution/90"
          />
        ) : (
          <ShieldQuestionIcon className="size-3.5 shrink-0 text-caution/90" />
        )}
        <span className={cn("min-w-0 truncate", !makoTool && !permission.detail && "font-mono")}>{makoTool ?? permission.title}</span>
      </p>
      {permission.detail ? (
        <p data-request-detail className="max-w-prose pt-0.5 pb-2 text-label text-muted-foreground">{permission.detail}</p>
      ) : (
        <p className="pt-0.5 pb-2 text-label text-faint">
          {permission.kind === "authentication" ? "Continue with the provider's sign-in flow. Your prompt waits until sign-in succeeds." : "Choose how long to allow it."}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {permission.options.map((option) => {
          const allow = option.kind?.startsWith("allow") === true
          const always = option.kind === "allow_always"
          return (
            <button
              key={option.optionId}
              type="button"
              onClick={() => acp.answerPermission(option.optionId)}
              className={cn(
                "pressable flex items-center gap-1.5 rounded-md border px-2 py-1 text-label transition-colors",
                allow && !always
                  ? "border-hairline bg-foreground text-background hover:opacity-90"
                  : always
                    ? "border-foreground/20 text-foreground hover:bg-fill-hover"
                    : "border-hairline text-negative/80 hover:bg-negative/10 hover:text-negative"
              )}
            >
              {always ? (
                <CheckCheckIcon className="size-3" />
              ) : allow ? (
                <CheckIcon className="size-3" />
              ) : (
                <XIcon className="size-3" />
              )}
              {option.name}
            </button>
          )
        })}
        {permission.kind === "authentication" ? (
          <button type="button" onClick={() => acp.answerPermission(null)} className="pressable rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:text-foreground">
            Cancel sign-in
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** Registered against `questions` asked in the session: the harness must declare that form for the card to draw. */
function SessionQuestion() {
  const harness = useAcp(state => activeLiveAcp(state)?.harness)
  const inSession = useThreads(state => asksInSession(descriptorFor(state, harness)))
  const control = useAcp(state => activeLiveAcp(state)?.control)
  const requests = useAcp(state => activeLiveAcp(state)?.requests ?? EMPTY_QUEUE)
  const blocking = useAcp(state => activeLiveAcp(state)?.permission)
  const question = useMemo(() => inSession && control && !blocking ? latestPendingQuestion(control, requests) : undefined, [inSession, control, requests, blocking])
  if (!question) return null
  return <QuestionPermission key={question.id} permission={{
    id: question.id, sessionId: question.bindingId, title: "Question", options: [], questions: question.native.questions.filter(item => !question.answered?.includes(item.id)),
  }} onAnswer={answers => acp.answerQuestion(question.id, answers)} dismissLabel="Dismiss" />
}

function QuestionPermission({
  permission,
  onAnswer = answers => acp.answerPermission(null, answers ?? undefined),
  dismissLabel = "Cancel",
}: {
  permission: LivePermissionRequest
  onAnswer?: (answers: Record<string, string[]> | null) => void | Promise<void>
  dismissLabel?: string
}) {
  const [submitting, setSubmitting] = useState(false)
  const answer = (values: Record<string, string[]> | null) => {
    if (submitting) return
    setSubmitting(true)
    void Promise.resolve(onAnswer(values)).finally(() => setSubmitting(false))
  }
  const questions = permission.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      questions
        .filter((question) => question.defaultValues?.length)
        .map((question) => [question.id, question.defaultValues ?? []])
    )
  )
  const complete = questions.every(
    (question) =>
      question.required === false ||
      answers[question.id]?.some((answer) => answer.trim().length > 0)
  )
  return (
    <div className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-3">
      <p className="flex items-center gap-1.5 pb-2 text-ui text-foreground/90">
        <ShieldQuestionIcon className="size-3.5 shrink-0 text-caution/90" />
        <span className="min-w-0 truncate">{permission.title}</span>
      </p>
      <div className="max-h-72 space-y-3 overflow-y-auto">
        {questions.map((question) => (
          <fieldset key={question.id} className="space-y-1.5">
            <legend className="text-ui font-medium text-foreground/90">
              {question.header || question.question}
            </legend>
            {question.header && question.question !== question.header ? (
              <p className="text-label text-faint">{question.question}</p>
            ) : null}
            {question.options.length ? (
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const value = option.value ?? option.label
                  const selected =
                    answers[question.id]?.includes(value) === true
                  return (
                    <button
                      key={value}
                      type="button"
                      title={option.description || undefined}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]:
                            question.valueType === "string-array"
                              ? selected
                                ? (current[question.id] ?? []).filter(
                                    (answer) => answer !== value
                                  )
                                : [...(current[question.id] ?? []), value]
                              : [value],
                        }))
                      }
                      className={cn(
                        "pressable rounded-md border px-2 py-1 text-label",
                        selected
                          ? "border-foreground/20 bg-fill-selected text-foreground"
                          : "border-hairline text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {!question.options.length || question.allowOther ? (
              <input
                type={
                  question.isSecret
                    ? "password"
                    : question.valueType === "number" ||
                        question.valueType === "integer"
                      ? "number"
                      : "text"
                }
                step={question.valueType === "integer" ? 1 : undefined}
                value={answers[question.id]?.[0] ?? ""}
                placeholder={
                  question.options.length ? "Other answer" : "Type your answer"
                }
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: [event.target.value],
                  }))
                }
                className="h-8 w-full rounded-md border border-hairline bg-surface px-2 text-ui text-foreground placeholder:text-faint focus:outline-none"
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-3">
        <button
          type="button"
          disabled={submitting}
          onClick={() => answer(null)}
          className="pressable rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:text-foreground"
        >
          {dismissLabel}
        </button>
        <button
          type="button"
          disabled={!complete || submitting}
          onClick={() =>
            answer(
              Object.fromEntries(
                Object.entries(answers)
                  .filter(([id]) => questions.some(question => question.id === id))
                  .map(([id, values]) => [
                    id,
                    values.map((value) => value.trim()).filter(Boolean),
                  ])
                  .filter(([, values]) => values.length > 0)
              )
            )
          }
          className="pressable rounded-md bg-foreground px-2 py-1 text-label text-background disabled:opacity-40"
        >
          Send answers
        </button>
      </div>
    </div>
  )
}

/**
 * Every message of the conversation that ended without an answer, newest
 * first, for the conversation menu: the archive behind the rows the
 * transcript draws where each one failed.
 */
export function RetainedRequests() {
  const requests = useAcp(
    (state) => {
      const current = activeAcp(state)
      return current ? recoverableRequests(current) : EMPTY_QUEUE
    },
    (left, right) =>
      left.length === right.length &&
      left.every((request, index) => request === right[index])
  )
  const conversation = useAcp((state) => activeLiveAcp(state)?.key)
  if (!conversation || !requests.length) return null
  return (
    <Disclosure summary={`Saved messages (${requests.length})`} className="px-2 py-2" bodyClassName="flex flex-col gap-3 pt-2">
      {[...requests].reverse().map((request) => (
        <FailureRow key={request.id} conversationId={conversation} request={request} quoted compact />
      ))}
    </Disclosure>
  )
}
