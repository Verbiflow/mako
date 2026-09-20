import { promptDelivery, recoverableRequests, turnContinuations, turnStopLabel, turnStops } from "@/state/prompt-delivery"
import { agentActivity } from "@/state/agent-activity"
import { shallowEqual } from "@/state/store"
import { useCopy } from "@/components/ui/use-copy"
import { CompactionControl } from "@/components/composer/compaction-control"
import { compactionAvailable } from "../../../electron/contracts/recovery"
import { ActivityMark } from "@/components/ui/activity-mark"
import { TransferStatus } from "./transfer-status"
import { LiveActionStatus } from "./live-action-status"
import { loadEarlierLive } from "@/state/live-recovery"
import { sendTo } from "@/state/acp-queue"
import { useMemo, useState } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { acp, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { toast } from "sonner"
import type { InterruptionReason, LivePermissionRequest, LiveRequest } from "@/lib/types"
import { describeProviderFailure } from "../../../electron/contracts/provider-failure"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { liveToolName } from "@/lib/tools"
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
  const session = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const starting = useAcp((state) => activeAcp(state)?.kind === "starting")
  // The reader was already looking at this conversation's history when it
  // went live: the same turns stay where they are, so the panel does not
  // arrive as a new surface.
  const continued = useContinuedInPlace()

  if (starting) {
    return (
      <div className={cn(!continued && "animate-enter", "flex min-h-0 flex-1 flex-col bg-surface")}>
        <Blocks starting continued={continued} />
      </div>
    )
  }
  if (!session) return null

  return (
    <div data-live-conversation={session.id} className={cn(!continued && "animate-enter", "flex min-h-0 flex-1 flex-col bg-surface")}>
      <Blocks continued={continued} />
      <TransferStatus />
      <LiveActionStatus />
      <RetainedRequests />
      <Permission />
    </div>
  )
}

function useContinuedInPlace(): boolean {
  const threadPath = useAcp((state) => activeAcp(state)?.threadPath)
  return useThreads((state) => threadPath !== undefined && state.viewing?.ref.path === threadPath)
}

function Blocks({ starting = false, continued = false }: { starting?: boolean; continued?: boolean }) {
  const session = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const projection = useAcp((state) => activeAcp(state)?.projection)
  const history = useAcp((state) => activeAcp(state)?.base)
  // Stable from the first keystroke of a start through promotion and any
  // later binding: the transcript keeps its scroll position and its turns.
  const identity = useAcp((state) => activeAcp(state)?.draftKey ?? "none")
  const requests = useAcp((state) => activeAcp(state)?.requests ?? EMPTY_QUEUE)
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
    const current = activeLiveAcp(state)
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
  const continuations = useMemo(() => turnContinuations(requests), [requests])
  const exchanges = projection?.exchanges ?? EMPTY_QUEUE
  const lastExchangeId = exchanges.at(-1)?.id

  return (
    <ConversationTimeline
      source={{ liveId: sessionId }}
      identity={identity}
      entrance={!continued}
      hasEarlier={history?.hasEarlier}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
      exchanges={exchanges}
      streamingId={running ? lastExchangeId : undefined}
      interruptedRequests={interruptedRequests}
      continuations={continuations}
      failedId={session?.status === "failed" ? lastExchangeId : undefined}
      empty={
        <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-6 py-6">
          <p className="pt-8 text-center text-ui leading-relaxed text-faint">
            {session?.status === "failed"
              ? session.error || "The provider could not open this session. Your saved message is preserved below."
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
      }
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
  const activity = useAcp((state) => {
    const live = activeLiveAcp(state)
    return agentActivity({ blocks: live?.blocks ?? EMPTY_QUEUE, waiting: Boolean(live?.permission), connecting: starting, preparing })
  }, shallowEqual)
  return running && activity.kind !== "responding" ? (
    <div role="status" data-agent-activity={activity.kind} className="flex min-h-8 min-w-0 items-center gap-2 py-1 text-ui text-muted-foreground">
      <ActivityMark state={activity.kind} size={20} />
      <span className="truncate">{activity.label}</span>
    </div>
  ) : null
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
  if (!permission) return null
  if (permission.questions)
    return <QuestionPermission key={permission.id} permission={permission} />
  return (
    <div className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-2.5">
      <p className="flex items-center gap-1.5 text-ui text-foreground/90">
        {permission.kind ? (
          <ToolGlyph
            name={liveToolName(permission.kind, permission.title)}
            className="size-3.5 shrink-0 text-caution/90"
          />
        ) : (
          <ShieldQuestionIcon className="size-3.5 shrink-0 text-caution/90" />
        )}
        <span className="min-w-0 truncate font-mono">{permission.title}</span>
      </p>
      <p className="pt-0.5 pb-2 text-label text-faint">
        {permission.kind === "authentication" ? "Continue with the provider's sign-in flow. Your prompt waits until sign-in succeeds." : "Choose how long to allow it."}
      </p>
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

function QuestionPermission({
  permission,
}: {
  permission: LivePermissionRequest
}) {
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
          onClick={() => acp.answerPermission(null)}
          className="pressable rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!complete}
          onClick={() =>
            acp.answerPermission(
              null,
              Object.fromEntries(
                Object.entries(answers)
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

export function RetainedRequests() {
  const requests = useAcp((state) => {
    const current = activeAcp(state)
    return current ? recoverableRequests(current) : EMPTY_QUEUE
  }, (left, right) => left.length === right.length && left.every((request, index) => request === right[index]))
  if (!requests.length) return null
  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-t border-hairline px-4 text-label text-muted-foreground">
      {requests.map((request) => <RequestRecovery key={request.id} request={request} />)}
    </div>
  )
}

/** The recovery row's word for a stopped message; the footer's label, with the message named. */
function interruptedLabel(reason: InterruptionReason, provider: string): string {
  return reason === "stopped" ? "Stopped message" : turnStopLabel(reason, provider)
}

function RequestRecovery({ request }: { request: LiveRequest }) {
  const text = request.displayText ?? request.text
  const { copy, copied } = useCopy(text)
  const conversationId = useAcp((state) => activeLiveAcp(state)?.key ?? null)
  const harness = useAcp((state) => activeLiveAcp(state)?.session.harness)
  const [resent, setResent] = useState<"sending" | "sent" | null>(null)
  const recovered = useAcp((state) => activeLiveAcp(state)?.control?.actions?.some((action) =>
    action.input.kind === "compact" && action.input.requestId === request.id && action.state.kind === "completed") ?? false)
  const idle = useAcp((state) => {
    const live = activeLiveAcp(state)
    return Boolean(live && compactionAvailable(live.session, live.control?.actions ?? [],
      live.requests?.some((item) => item.status === "queued" || item.status === "dispatching") ?? false))
  })
  // The host classified the provider's text once; the panel says what the
  // kind means for this provider and offers Send again only when it can work.
  const failure =
    request.status === "failed" && request.failure
      ? describeProviderFailure(request.failure, harness ? harnessLabel(harness) : undefined)
      : null
  const label = failure
    ? failure.title
    : request.interruption
      ? interruptedLabel(request.interruption.reason, harness ? harnessLabel(harness) : "the provider")
      : request.status === "uncertain"
        ? "Delivery unconfirmed"
        : request.status === "interrupted"
          ? "Stopped message"
          : "Message failed"
  const retriable = request.status === "failed" && ((failure?.retriable ?? true) || recovered)
  // A failed request is re-sent as a new request carrying the same text and
  // attachments; the failed record stays, so nothing is replayed silently.
  const resend = async () => {
    if (!conversationId || resent) return
    setResent("sending")
    const accepted = await sendTo(conversationId, request.text, request.attachments)
    setResent(accepted ? "sent" : null)
  }
  return (
    <details className="py-2" data-request-recovery={request.id} data-failure={request.failure}>
      <summary className="pressable cursor-pointer">{label}. Review saved message</summary>
      {failure ? <p className="mt-2 text-foreground/80">{failure.guidance}</p> : null}
      {request.error ? <p className={cn("mt-2", failure && "text-faint")}>{request.error}</p> : null}
      <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap">{text}</p>
      {request.status === "failed" && request.failure === "context-exhausted" ? <CompactionControl requestId={request.id} /> : null}
      {recovered ? <p className="mt-2">Compaction completed. You can send the saved message again.</p> : null}
      <div className="mt-2 flex items-center gap-3">
        {retriable && conversationId ? (
          <button type="button" onClick={() => void resend()} disabled={resent !== null || !idle} className="pressable rounded px-1 py-1 hover:bg-fill-hover hover:text-foreground disabled:opacity-50">
            {resent === "sent" ? "Sent again" : resent === "sending" ? "Sending…" : "Send again"}
          </button>
        ) : null}
        {request.status === "failed" && request.failure !== "transport-limit" && conversationId ? (
          <button type="button" disabled={resent !== null} className="pressable rounded px-1 py-1 hover:bg-fill-hover hover:text-foreground disabled:opacity-50"
            onClick={() => {
              setResent("sending")
              void acp.recoverFresh(conversationId, request.id).then((accepted) => setResent(accepted ? "sent" : null))
            }}>Start new thread with saved message</button>
        ) : null}
        <button type="button" onClick={() => void copy()} className="pressable rounded px-1 py-1 hover:bg-fill-hover hover:text-foreground">{copied ? "Copied" : "Copy saved message"}</button>
      </div>
      {request.status === "failed" && request.failure !== "transport-limit" ? <p className="mt-2 text-faint">A new thread starts with this message and its attachments. Earlier conversation stays here.</p> : null}
    </details>
  )
}
