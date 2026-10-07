import { useHarnessIdentity } from "@/lib/harness-label"
import { latestPendingQuestion } from "../../../electron/contracts/live-questions"
import { ApprovalStatus } from "./approval-status"
import { promptDelivery, recoverableRequests, makoPrompts, turnStopLabel, turnStops } from "@/state/prompt-delivery"
import { agentActivity } from "@/state/agent-activity"
import { shallowEqual } from "@/state/store"
import { useCopy } from "@/components/ui/use-copy"
import { CompactionControl } from "@/components/composer/compaction-control"
import { compactionAvailable } from "../../../electron/contracts/recovery"
import { ActivityMark } from "@/components/ui/activity-mark"
import { Shimmer } from "@/components/ui/shimmer"
import { durationText } from "@mako/sessions/events"
import { TransferStatus } from "./transfer-status"
import { LiveActionStatus } from "./live-action-status"
import { loadEarlierLive } from "@/state/live-recovery"
import { sendTo } from "@/state/acp-queue"
import { skipWorktree } from "@/state/acp-start"
import { WorktreeOpening } from "@/components/viewer/worktree-opening"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useStartedWorktree } from "@/state/worktrees"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { RecoveryNotice } from "./recovery-notice"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Collapse } from "@/components/ui/collapse"
import { Disclosure, NoticeAction } from "@/components/ui/notice"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { acp, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { scopedAcp, scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreads } from "@/state/threads"
import { usePlanDecision } from "@/state/plan-mode"
import { viewerHandedOff } from "@/state/thread-viewing"
import { toast } from "sonner"
import type { InterruptionReason, LivePermissionRequest, LiveRequest } from "@/lib/types"
import { describePromptRecovery } from "../../../electron/contracts/prompt-recovery"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { identifyTool } from "@mako/sessions/tool-identity"
import { ToolGlyph } from "@/components/transcript/tool-views"
import {
  CheckCheckIcon,
  CheckIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react"

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
          <TransferStatus />
          <LiveActionStatus />
          <RetainedRequests />
          <ApprovalStatus />
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
  const madeByMako = useMemo(() => makoPrompts(requests), [requests])
  const exchanges = projection?.exchanges ?? EMPTY_QUEUE
  const unread = useAcp((state) => scopedLiveAcp(state, scope)?.hydrated === false)
  const lastExchangeId = exchanges.at(-1)?.id
  const row = useAcp((state) => {
    const current = scopedAcp(state, scope)
    return { threadId: current?.threadId, sessionId: current?.sessionId, cwd: scopedLiveAcp(state, scope)?.session.cwd ?? current?.cwd }
  }, shallowEqual)
  const worktree = useStartedWorktree(useThreadGroups((state) => rowThread(row, state.threadOf)), row.cwd)

  return (
    <ConversationTimeline
      source={{ liveId: sessionId }}
      identity={identity}
      entrance={!continued}
      hasEarlier={Boolean(historyWindow?.before || history?.hasEarlier)}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
      exchanges={exchanges}
      streamingId={running ? lastExchangeId : undefined}
      interruptedRequests={interruptedRequests}
      makoPrompts={madeByMako}
      failedId={session?.status === "failed" ? lastExchangeId : undefined}
      opening={worktree?.start ? <WorktreeOpening worktree={worktree} start={worktree.start} /> : undefined}
      empty={unread ? null : (
        <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-6 py-6">
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
        <AcpActivity
          running={running}
          starting={starting || session?.status === "starting"}
          preparing={preparing && session?.status !== "running"}
        />
      }
    />
  )
}

function AcpActivity({
  running,
  starting = false,
  preparing = false,
}: {
  running: boolean
  starting?: boolean
  preparing?: boolean
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
  const makingWorktree = useLasting(Boolean(making), MAKING_WORKTREE_SHOWN_AFTER_MS)
  const slowWorktree = useLasting(Boolean(making), SLOW_WORKTREE_MS)
  const activity = useAcp((state) => {
    const live = scopedLiveAcp(state, scope)
    const approval = live?.control?.approvalResponses?.find(receipt => receipt.id === live.permission?.id)
    // The approval notice, or the plan bar for a plan's approval, owns this
    // status; do not repeat it in the transcript.
    if (approval || live?.permission?.implementsPlan) return { kind: "idle" as const, label: "" }
    const switchingAccount = Boolean(live?.requests?.some((request) => request.status === "queued" && request.accountSwitch))
    return agentActivity({ blocks: live?.blocks ?? EMPTY_QUEUE, waiting: Boolean(live?.permission), connecting: starting, makingWorktree, worktreeStep, preparing, switchingAccount, quietForMs, native: live?.nativeActivity, harness: live?.session.harness })
  }, shallowEqual)
  return running && activity.kind !== "responding" && activity.kind !== "idle" ? (
    <div role="status" data-agent-activity={activity.kind} className="flex min-h-8 min-w-0 items-center gap-2 py-1 text-ui text-muted-foreground">
      <ActivityMark state={activity.kind} size={20} />
      {activity.since === undefined ? (
        <>
          <span key={activity.label} className="truncate animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">{activity.label}</span>
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

/** `value`, once it has held for `ms`; false again as soon as it stops. */
function useLasting(value: boolean, ms: number): boolean {
  const [lasted, setLasted] = useState(false)
  useEffect(() => {
    if (!value) return
    const timer = setTimeout(() => setLasted(true), ms)
    return () => {
      clearTimeout(timer)
      setLasted(false)
    }
  }, [value, ms])
  return value && lasted
}

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
  // A plan approval is answered from the plan bar above the composer.
  const planApproval = usePlanDecision()?.approval?.id
  if (!permission || planApproval === permission.id) return null
  // Keep a structured draft mounted while its answer is in flight. A proven
  // refusal can renew the public occurrence without clearing the user's input.
  return <div hidden={Boolean(receipt)}>
    <PermissionInput key={permission.origin ? JSON.stringify(permission.origin) : permission.id} permission={permission} />
  </div>
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

function SessionQuestion() {
  const control = useAcp(state => activeLiveAcp(state)?.control)
  const requests = useAcp(state => activeLiveAcp(state)?.requests ?? EMPTY_QUEUE)
  const blocking = useAcp(state => activeLiveAcp(state)?.permission)
  const question = useMemo(() => control && !blocking ? latestPendingQuestion(control, requests) : undefined, [control, requests, blocking])
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

export function RetainedRequests({ history = false }: { history?: boolean }) {
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
  const allRequests = useAcp(
    (state) => activeLiveAcp(state)?.requests ?? EMPTY_QUEUE
  )
  const latest = useMemo(() => {
    const completed = allRequests.findLastIndex(
      (request) => request.status === "completed"
    )
    const candidates = new Set(
      allRequests.slice(completed + 1).map((request) => request.id)
    )
    return requests.findLast((request) => candidates.has(request.id))
  }, [allRequests, requests])
  const dismissed = usePrefs((state) => state.dismissedRecoveryRequests)
  if (history)
    return requests.length ? (
      <Disclosure summary={`Saved messages (${requests.length})`} className="px-2 py-2" bodyClassName="text-label text-muted-foreground">
        {requests.map((request) => (
          <RequestRecovery key={request.id} request={request} />
        ))}
      </Disclosure>
    ) : null
  if (
    !conversation ||
    !latest ||
    dismissed[`${conversation}:${latest.id}`] === latest.status
  )
    return null
  return (
    <RequestNotice
      key={`${conversation}:${latest.id}`}
      request={latest}
      earlier={requests.filter((request) => request.id !== latest.id)}
      onDismiss={() => {
        setPref("dismissedRecoveryRequests", {
          ...prefsStore.get().dismissedRecoveryRequests,
          [`${conversation}:${latest.id}`]: latest.status,
        })
      }}
    />
  )
}

function RequestNotice({
  request,
  earlier,
  onDismiss,
}: {
  request: LiveRequest
  earlier: LiveRequest[]
  onDismiss(): void
}) {
  const [reviewId, setReview] = useState<string | null>(null)
  const review = request.id === reviewId ? request : earlier.find((item) => item.id === reviewId) ?? null
  const recovery = describePromptRecovery(request)
  const [history, setHistory] = useState(false)
  // The body keeps the last reviewed message while it folds away.
  const [reviewed, setReviewed] = useState<LiveRequest | null>(null)
  if (review && review !== reviewed) setReviewed(review)
  return (
    <RecoveryNotice
      title={recovery.title}
      description="Your message is saved. Review delivery details before trying again."
      onDismiss={onDismiss}
      actions={
        <>
          <NoticeAction
            onClick={() => setReview(review ? null : request.id)}
            expanded={Boolean(review)}
          >
            {review ? "Hide details" : "Review message"}
          </NoticeAction>
          {earlier.length ? (
            <NoticeAction quiet onClick={() => setHistory(!history)} expanded={history}>
              Earlier messages ({earlier.length})
            </NoticeAction>
          ) : null}
        </>
      }
    >
      <Collapse open={history}>
        <div className="-mx-1 mb-1 space-y-0.5">
          {[...earlier].reverse().map((item) => (
            <button
              type="button"
              key={item.id}
              className="pressable block w-full truncate rounded px-2 py-1 text-left text-label text-muted-foreground hover:bg-fill-hover"
              onClick={() => {
                setReview(item.id)
                setHistory(false)
              }}
            >
              {item.displayText ?? item.text}
            </button>
          ))}
        </div>
      </Collapse>
      <Collapse open={Boolean(review)}>
        {reviewed ? (
          <RequestRecovery key={reviewed.id} request={reviewed} expanded />
        ) : null}
      </Collapse>
    </RecoveryNotice>
  )
}

/** The recovery row's word for a stopped message; the footer's label, with the message named. */
function interruptedLabel(reason: InterruptionReason, provider: string): string {
  return reason === "stopped" ? "Stopped message" : turnStopLabel(reason, provider)
}

function RequestRecovery({ request, expanded = false }: { request: LiveRequest; expanded?: boolean }) {
  useHarnessIdentity()
  const text = request.displayText ?? request.text
  const { copy, copied } = useCopy(text)
  const conversationId = useAcp((state) => activeLiveAcp(state)?.key ?? null)
  const harness = useAcp((state) => activeLiveAcp(state)?.session.harness)
  const [resent, setResent] = useState<"sending" | "sent" | null>(null)
  const [restored, setRestored] = useState(false)
  const continued = useAcp((state) => {
    const requests = activeLiveAcp(state)?.requests ?? []
    const index = requests.findIndex((item) => item.id === request.id)
    return index >= 0 && requests.slice(index + 1).some((item) => item.status === "completed")
  })
  const recovered = useAcp((state) => activeLiveAcp(state)?.control?.actions?.some((action) =>
    action.input.kind === "compact" && action.input.requestId === request.id && action.state.kind === "completed") ?? false)
  const idle = useAcp((state) => {
    const live = activeLiveAcp(state)
    return Boolean(live && compactionAvailable(live.session, live.control?.actions ?? [],
      live.requests?.some((item) => item.status === "queued" || item.status === "dispatching") ?? false))
  })
  const recovery = describePromptRecovery(request, harness ? harnessLabel(harness) : undefined, recovered)
  const failure = recovery.failure
  const label = failure
    ? failure.title
    : request.interruption
      ? interruptedLabel(request.interruption.reason, harness ? harnessLabel(harness) : "the provider")
      : request.status === "uncertain"
        ? recovery.title
        : request.status === "interrupted"
          ? "Stopped message"
          : "Message failed"
  // A failed request is re-sent as a new request carrying the same text and
  // attachments; the failed record stays, so nothing is replayed silently.
  const resend = async () => {
    if (!conversationId || resent || !idle || !recovery.resendLabel) return
    setResent("sending")
    const accepted = await sendTo(conversationId, request.text, request.attachments)
    setResent(accepted ? "sent" : null)
  }
  // A new thread opens in the same folder over the same transport, so it can't escape these.
  const freshThread = request.status === "failed" && request.failure !== "auth" && request.failure !== "transport-limit" && request.failure !== "missing-folder" && request.failure !== "launch-failed"
  return (
    <RecoveryBody expanded={expanded} summary={`${continued && request.status === "failed" ? "An earlier message failed" : label}. Review saved message`} request={request}>
      {failure ? <p className="mt-2 text-foreground/80">{failure.guidance}</p> : null}
      <p className="mt-2 text-foreground/80" data-delivery-evidence={request.nativeDelivery?.evidence.kind ?? "unknown"}>{recovery.delivery}</p>
      {request.error ? <p className={cn("mt-2", failure && "text-faint")}>{request.error}</p> : null}
      <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap">{text}</p>
      {request.status === "failed" && request.failure === "context-exhausted" ? <CompactionControl requestId={request.id} /> : null}
      {recovered && request.failure === "context-exhausted" ? <p className="mt-2">Compaction completed. You can send the saved message again.</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {request.status === "failed" && request.failure === "auth" && conversationId ? (
          <button type="button" disabled={restored} className="pressable h-6 rounded-md bg-fill-hover px-2 text-foreground hover:bg-fill-selected disabled:opacity-45"
            onClick={() => {
              const event = new CustomEvent("mako:restore-saved-message", { cancelable: true, detail: { conversationId, requestId: request.id } })
              if (!window.dispatchEvent(event)) setRestored(true)
            }}>{restored ? "Restored to composer" : "Restore to composer"}</button>
        ) : null}
        {recovery.resendLabel && conversationId ? (
          <button type="button" onClick={() => void resend()} disabled={resent !== null || !idle} className="pressable h-6 rounded-md bg-fill-hover px-2 text-foreground hover:bg-fill-selected disabled:opacity-45">
            {resent === "sent" ? "Sent again" : resent === "sending" ? "Sending…" : recovery.resendLabel}
          </button>
        ) : null}
        {freshThread && conversationId ? (
          <button type="button" disabled={resent !== null} className="pressable h-6 rounded-md px-2 hover:bg-fill-hover hover:text-foreground disabled:opacity-45"
            onClick={() => {
              setResent("sending")
              void acp.recoverFresh(conversationId, request.id).then((accepted) => setResent(accepted ? "sent" : null))
            }}>Use in new thread</button>
        ) : null}
        {request.status === "failed" && (request.failure === "auth" || request.failure === "wrong-account" || request.failure === "launch-failed" || request.failure === "launch-stalled") ? (
          <button type="button" className="pressable h-6 rounded-md px-2 hover:bg-fill-hover hover:text-foreground"
            onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: request.failure === "launch-stalled" ? "mcp" : "agents" }))}>
            {request.failure === "launch-stalled" ? "MCP settings" : "Agents settings"}
          </button>
        ) : null}
        <button type="button" onClick={() => void copy()} className="pressable h-6 rounded-md px-2 hover:bg-fill-hover hover:text-foreground">{copied ? "Copied" : "Copy saved message"}</button>
      </div>
      {freshThread ? <p className="mt-2 text-faint">A new thread starts with this message and its attachments. Earlier conversation stays here.</p> : null}
      {request.status === "failed" && request.failure === "auth" ? <p className="mt-2 text-faint">Fix sign-in or choose an available model in Agents settings, then review and send the restored draft. Restoring does not send a message.</p> : null}
    </RecoveryBody>
  )
}

/** A saved message's recovery: open in the notice that reviews it, folded in a list of them. */
function RecoveryBody({ expanded, summary, request, children }: { expanded: boolean; summary: string; request: LiveRequest; children: ReactNode }) {
  const data = { "data-request-recovery": request.id, "data-failure": request.failure }
  if (expanded)
    return (
      <div className="py-1" {...data}>
        <p className="sr-only">{summary}</p>
        {children}
      </div>
    )
  return (
    <div className="py-1.5" {...data}>
      <Disclosure summary={summary} tone={request.status === "failed" ? "danger" : "caution"}>
        {children}
      </Disclosure>
    </div>
  )
}
