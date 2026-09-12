import { promptDelivery, recoverableRequests } from "@/state/prompt-delivery"
import { agentActivity } from "@/state/agent-activity"
import { shallowEqual } from "@/state/store"
import { useCopy } from "@/components/ui/use-copy"
import { ActivityMark } from "@/components/ui/activity-mark"
import { TransferStatus } from "./transfer-status"
import { LiveActionStatus } from "./live-action-status"
import { loadEarlierLive } from "@/state/live-recovery"
import { sendTo } from "@/state/acp-queue"
import { useMemo, useState } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { acp, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import type { LivePermissionRequest, LiveRequest } from "@/lib/types"
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

  if (starting) {
    return (
      <div className="animate-enter flex min-h-0 flex-1 flex-col bg-surface">
        <Blocks starting />
      </div>
    )
  }
  if (!session) return null

  return (
    <div data-live-conversation={session.id} className="animate-enter flex min-h-0 flex-1 flex-col bg-surface">
      <Blocks />
      <TransferStatus />
      <LiveActionStatus />
      <RetainedRequests />
      <Permission />
    </div>
  )
}

function Blocks({ starting = false }: { starting?: boolean }) {
  const session = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const projection = useAcp((state) => activeAcp(state)?.projection)
  const history = useAcp((state) => activeAcp(state)?.base)
  const requests = useAcp((state) => activeAcp(state)?.requests ?? EMPTY_QUEUE)
  const interruptedRequests = useMemo(() => new Map(requests.map((request) => [request.id, request.status === "interrupted"])), [requests])
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
  const exchanges = projection?.exchanges ?? EMPTY_QUEUE
  const lastExchangeId = exchanges.at(-1)?.id

  return (
    <ConversationTimeline
      source={{ liveId: session?.id }}
      identity={`${history?.ref.path ?? "new"}:${session?.id ?? "starting"}`}
      hasEarlier={history?.hasEarlier}
      onLoadEarlier={session ? () => loadEarlierLive(session.id) : undefined}
      exchanges={exchanges}
      streamingId={running ? lastExchangeId : undefined}
      interruptedRequests={interruptedRequests}
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

function RequestRecovery({ request }: { request: LiveRequest }) {
  const text = request.displayText ?? request.text
  const { copy, copied } = useCopy(text)
  const conversationId = useAcp((state) => activeLiveAcp(state)?.key ?? null)
  const [resent, setResent] = useState<"sending" | "sent" | null>(null)
  const label = request.status === "uncertain" ? "Delivery unconfirmed" : request.status === "interrupted" ? "Stopped message" : "Message failed"
  // A failed request is re-sent as a new request carrying the same text and
  // attachments; the failed record stays, so nothing is replayed silently.
  const resend = async () => {
    if (!conversationId || resent) return
    setResent("sending")
    const accepted = await sendTo(conversationId, request.text, request.attachments)
    setResent(accepted ? "sent" : null)
  }
  return (
    <details className="py-2" data-request-recovery={request.id}>
      <summary className="pressable cursor-pointer">{label}. Review saved message</summary>
      {request.error ? <p className="mt-2">{request.error}</p> : null}
      <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap">{text}</p>
      <div className="mt-2 flex items-center gap-3">
        {request.status === "failed" && conversationId ? (
          <button type="button" onClick={() => void resend()} disabled={resent !== null} className="pressable rounded px-1 py-1 hover:bg-fill-hover hover:text-foreground disabled:opacity-50">
            {resent === "sent" ? "Sent again" : resent === "sending" ? "Sending…" : "Send again"}
          </button>
        ) : null}
        <button type="button" onClick={() => void copy()} className="pressable rounded px-1 py-1 hover:bg-fill-hover hover:text-foreground">{copied ? "Copied" : "Copy saved message"}</button>
      </div>
    </details>
  )
}
