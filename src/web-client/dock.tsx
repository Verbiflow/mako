import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { ArrowDownIcon, ArrowLeftRightIcon, CheckCheckIcon, CheckIcon, CornerDownLeftIcon, RotateCwIcon, ShieldQuestionIcon, XIcon } from "lucide-react"
import { latestPendingQuestion, activeInputQuestions, type LiveInputQuestion } from "@mako/host/contracts/live-questions"
import type { LivePermissionRequest, PromptAttachment } from "@mako/host/contracts/providers-acp"
import { bareCommand, identifyTool } from "@mako/sessions/tool-identity"
import { PromptQueue } from "@/components/composer/prompt-queue"
import { editQueuedPrompt } from "@/state/acp-queue"
import { descriptorFor } from "@/state/descriptors"
import { usePrefs } from "@/state/prefs"
import { useThreads } from "@/state/thread-store"
import type { PendingPrompt } from "@/state/prompt-delivery"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { Ticking } from "@/components/ui/ticking"
import { GonePermission } from "@/components/viewer/acp-panel"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { promptDelivery } from "@/state/prompt-delivery"
import { shallowEqual } from "@/state/store"
import { record, type AnsweredRecord } from "./answered"
import { Composer, type EditingQueued, type Outgoing, type Steering } from "./composer"
import { ThreadChips } from "./thread-chips"
import { useSwitching } from "./switching"
import { answeredWords, dockStatus, statusWords, workingWords, type DockStatus } from "./dock-status"
import { noteAnswered } from "./install"
import { dropUnsent, keepUnsent, retryUnconfirmed, retryUnsent, sendMessage, useOutbox, type SendTarget } from "./outbox"
import { useWaking, wakeThread } from "./wake"
import { askPreview, useAppStanding } from "./previews"

/**
 * The phone's dock: everything between the transcript and the keyboard, one column pinned to the bottom of the screen.
 *
 * - A 28 px fade where the transcript runs under it, so words leave rather than being cut.
 * - One small capsule floating above it that says the one thing that matters now (`dock-status.ts`), with the way back
 *   to the newest turn sliding out of it while the reader is up the transcript.
 * - What the agent asks the person, pinned here instead of scrolling away with the transcript: an approval, or its
 *   questions. Up to 60% of the screen, scrolling inside; its answers whole-width rows a thumb's size, the one that lets
 *   it go on alone filled. A question can be answered by typing in the composer under it. Answered, it dims while the
 *   answer is on its way, then leaves a one-line record at the end of its turn (`answeredStore`).
 * - Messages the host refused while the field held other words, each with Retry.
 * - The queue, and the composer.
 *
 * The dock takes its own room in the column, so the transcript above it ends where it starts and never runs under a
 * card; only the capsule floats, and the transcript keeps room at its end for it.
 */

/** What the agent asks, as the dock draws it. */
type Ask =
  | { kind: "approval"; permission: LivePermissionRequest }
  | { kind: "gone"; permission: LivePermissionRequest }
  | { kind: "question"; id: string; questions: LiveInputQuestion[]; answer: (answers: Record<string, string[]> | null) => Promise<void> | void; dismiss: string }

function lastExchange(): string | undefined {
  const live = activeLiveAcp(acpStore.get())
  return live?.projection?.exchanges.at(-1)?.id
}

export interface DockProps {
  conversation: string
  harness: string
  target: SendTarget
  draftKey: string
  /** The reader is up the transcript, away from its newest turn; `jump` takes them back. */
  away: boolean
  jump: () => void
  /** The link's way back after a drop: asks the gateway to reconnect now. */
  reconnect: () => void
}

export function WebDock({ conversation, harness, target, draftKey, away, jump, reconnect }: DockProps) {
  const ask = useAsk()
  const running = useAcp((state) => {
    const live = activeLiveAcp(state)
    return live?.session.status === "running" || live?.session.status === "starting"
  })
  const canceling = useAcp((state) => activeLiveAcp(state)?.canceling === true)
  const typed = useRef<((text: string) => boolean) | null>(null)
  const answerTyped = useCallback((answer: ((text: string) => boolean) | null) => {
    typed.current = answer
  }, [])
  const unsent = useOutbox((state) => state.unsent.filter((each) => each.conversation === conversation), shallowArray)
  const send = async (text: string, attachments: PromptAttachment[], id: string): Promise<boolean> => {
    // A question waiting: the words are its answer, not a message.
    if (ask?.kind === "question" && attachments.length === 0 && typed.current?.(text)) return true
    return sendMessage(target, id, text, attachments)
  }
  const steering = useSteering()
  const steerByDefault = usePrefs((prefs) => prefs.steerOnEnter)
  const harnessId = useAcp((state) => activeLiveAcp(state)?.harness)
  const switching = useSwitching((state) => state.pending.has(conversation))
  const editing = useEditingQueued(conversation)
  const placeholder = ask?.kind === "question" ? "Tap an answer above, or type your own" : running ? (steering.canSteer && steerByDefault ? `Steer ${harness}` : `Queue a message for ${harness}`) : `Message ${harness}`
  return (
    <div className="web-dock shrink-0" data-asking={ask ? ask.kind : undefined}>
      <div aria-hidden className="web-dock-fade" />
      <StatusCapsule conversation={conversation} cloudThread={target.cloudThread} asking={Boolean(ask)} away={away} jump={jump} reconnect={reconnect} />
      {ask ? <AskCard key={ask.kind === "question" ? ask.id : ask.permission.id} ask={ask} conversation={conversation} harness={harness} answerTyped={answerTyped} /> : null}
      {unsent.length ? (
        <ul role="list" aria-label="Messages not sent" className="mx-auto flex w-full max-w-content flex-col gap-1.5 px-3 pb-1">
          {unsent.map((message) => (
            <li key={message.id} className="web-unsent">
              <p className="min-w-0 flex-1 truncate text-ui">{message.text}</p>
              <span className="shrink-0 text-label text-negative">Not sent</span>
              <button type="button" className="web-quiet-button web-unsent-action" onClick={() => void retryUnsent(target, message.id)}>
                Retry
              </button>
              <button type="button" aria-label="Discard this message" className="web-icon-button size-9" onClick={() => dropUnsent(message.id)}>
                <XIcon className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mx-auto w-full max-w-content px-3">
        <PromptQueue onEdit={editing.begin} />
      </div>
      <Composer
        key={draftKey}
        draftKey={draftKey}
        placeholder={placeholder}
        running={running}
        stopping={canceling}
        onStop={() => void acp.cancel()}
        onSend={send}
        onWrite={target.cloudThread ? () => void wakeThread(target.cloudThread!, conversation) : undefined}
        onUnsent={(message: Outgoing) => keepUnsent({ ...message, conversation })}
        // A question is answered in words: nothing to attach, and the hint gets the room.
        attach={ask?.kind !== "question"}
        // A question waiting: typed words are its answer, which a send takes; nothing steers past it.
        steering={ask?.kind === "question" ? undefined : steering}
        answering={ask?.kind === "question"}
        editing={editing.current}
        waiting={switching ? "Switching access…" : undefined}
        tools={harnessId ? <ThreadChips conversation={conversation} harness={harnessId} /> : undefined}
      />
    </div>
  )
}

/** Whether the open conversation's harness takes a message into its running turn, and how it lands; and the steer. */
function useSteering(): Steering {
  const harness = useAcp((state) => activeLiveAcp(state)?.harness)
  const lands = useThreads((state) => {
    const steering = descriptorFor(state, harness)?.capabilities.steering
    return steering?.state === "implemented" ? steering.lands : null
  })
  const working = useAcp((state) => activeLiveAcp(state)?.session.status === "running")
  return useMemo(() => ({ canSteer: lands !== null && working, lands, steer: (text, attachments, id) => acp.steer(text, attachments, id) }), [lands, working])
}

interface QueuedEditor {
  /** The queued message whose words are in the field now. */
  current: EditingQueued | undefined
  begin: (request: PendingPrompt, body: string) => void
}

/**
 * A queued message edited in the composer rather than in its row: its words take the field while it stays in line, and
 * ✓ puts the new words in its place only if the host still holds it as it was (the edit names the words it replaces),
 * as the desk's queue edits. Nothing pauses it meanwhile, so a screen left, a reload or a second message picked can't
 * stall the queue behind it. If it started first, the new words are kept under the composer to send on their own.
 */
function useEditingQueued(conversation: string): QueuedEditor {
  const [editing, setEditing] = useState<{ request: PendingPrompt; body: string } | undefined>(undefined)
  const target = useMemo(() => ({ kind: "live" as const, id: conversation }), [conversation])
  const begin = useCallback((request: PendingPrompt, body: string) => setEditing({ request, body }), [])
  const current = useMemo((): EditingQueued | undefined => {
    if (!editing) return undefined
    const { request, body } = editing
    return {
      id: request.id,
      text: body,
      save: async (text) => {
        const words = text + request.text.slice(body.length)
        try {
          await editQueuedPrompt(target, request, { kind: "edit", text: words })
          setEditing(undefined)
          return true
        } catch (error) {
          const still = acpStore.get().conversations[conversation]?.requests?.some((each) => each.id === request.id && (each.status === "queued" || each.status === "held"))
          // Still in line: the field keeps the words for ✓ again. Gone from it, they're kept to send as a message.
          if (still) return false
          toast.error(error instanceof Error ? error.message : String(error))
          setEditing(undefined)
          if (words !== request.text) keepUnsent({ id: crypto.randomUUID(), conversation, text: words, attachments: [] })
          return true
        }
      },
      cancel: () => setEditing(undefined),
    }
  }, [editing, target, conversation])
  return { current, begin }
}

function shallowArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((each, index) => each === right[index])
}

/** What the open conversation asks the person now, if anything: its approval first, else its newest open question. */
function useAsk(): Ask | undefined {
  const permission = useAcp((state) => activeLiveAcp(state)?.permission ?? null)
  const gone = useAcp((state) => Boolean(activeLiveAcp(state)?.permission?.gone) || activeLiveAcp(state)?.session.connection === "disconnected")
  const control = useAcp((state) => activeLiveAcp(state)?.control)
  const requests = useAcp((state) => activeLiveAcp(state)?.requests)
  const question = useMemo(() => (control && !permission ? latestPendingQuestion(control, requests ?? []) : undefined), [control, requests, permission])
  return useMemo((): Ask | undefined => {
    if (permission) {
      if (gone) return { kind: "gone", permission }
      if (permission.questions?.length)
        return { kind: "question", id: permission.id, questions: permission.questions, answer: (answers) => acp.answerPermission(null, answers ?? undefined), dismiss: "Cancel" }
      return { kind: "approval", permission }
    }
    if (question)
      return {
        kind: "question",
        id: question.id,
        questions: question.native.questions.filter((item) => !question.answered?.includes(item.id)),
        answer: (answers) => acp.answerQuestion(question.id, answers),
        dismiss: "Dismiss",
      }
    return undefined
  }, [permission, gone, question])
}

/** The card above the composer: an approval's answers, a question's, or an agent that went before it was answered. */
/** How a question card takes the words typed in the composer: it hands the dock its answerer while it's shown. */
type AnswerTyped = (answer: ((text: string) => boolean) | null) => void

function AskCard({ ask, conversation, harness, answerTyped }: { ask: Ask; conversation: string; harness: string; answerTyped: AnswerTyped }) {
  return (
    <div className="web-ask" data-ask={ask.kind} data-permission-card={ask.kind === "question" ? ask.id : ask.permission.id}>
      {ask.kind === "gone" ? (
        <GonePermission permission={ask.permission} />
      ) : ask.kind === "approval" ? (
        <ApprovalCard permission={ask.permission} conversation={conversation} harness={harness} />
      ) : (
        <QuestionCard ask={ask} conversation={conversation} harness={harness} answerTyped={answerTyped} />
      )}
    </div>
  )
}

/** The answer that lets the agent go on and asks nothing more: the one filled row. */
function primaryOption(options: LivePermissionRequest["options"]): string | undefined {
  return (options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow") ?? options.find((option) => option.kind?.startsWith("allow")))?.optionId
}

function ApprovalCard({ permission, conversation, harness }: { permission: LivePermissionRequest; conversation: string; harness: string }) {
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const inFlight = useAcp((state) => Boolean(activeLiveAcp(state)?.control?.approvalResponses?.some((receipt) => receipt.id === permission.id)))
  const tool = identifyTool({ acpKind: permission.kind, title: permission.title })
  const makoTool = tool.server === "mako" && tool.kind === "mcp" ? tool.label : undefined
  const title = makoTool ?? bareCommand(permission.title)
  const primary = primaryOption(permission.options)
  const answer = (option: LivePermissionRequest["options"][number]) => {
    if (chosen) return
    setChosen(option.optionId)
    noteAnswered()
    const allowed = option.kind?.startsWith("allow") === true
    const exchange = lastExchange()
    if (exchange) record(conversation, { id: permission.id, exchange, kind: allowed ? "allowed" : "refused", words: answeredWords(option.name), detail: title })
    acp.answerPermission(option.optionId)
  }
  const busy = chosen !== undefined || inFlight
  return (
    <div className="web-ask-body" aria-busy={busy || undefined} data-busy={busy || undefined}>
      <p className="web-ask-asker">{permission.kind === "authentication" ? `${harness} asks you to sign in` : `${harness} asks to run`}</p>
      <p className="web-ask-title">
        {permission.kind ? <ToolGlyph kind={tool.kind} className="size-4 shrink-0 text-caution" /> : <ShieldQuestionIcon className="size-4 shrink-0 text-caution" />}
        <span className={cn("min-w-0 break-words", !makoTool && !permission.detail && "font-mono")}>{title}</span>
      </p>
      <div className="web-ask-scroll">
        {permission.detail ? <p className="web-ask-hint">{permission.detail}</p> : permission.kind === "authentication" ? <p className="web-ask-hint">Continue with the provider's sign-in. Your message waits until it succeeds.</p> : null}
      </div>
      <div className="web-ask-options" role="group" aria-label="Answers">
        {permission.options.map((option) => {
          const allow = option.kind?.startsWith("allow") === true
          const Icon = option.kind === "allow_always" ? CheckCheckIcon : allow ? CheckIcon : XIcon
          return (
            <button
              key={option.optionId}
              type="button"
              data-permission-option={option.kind ?? "other"}
              data-primary={option.optionId === primary || undefined}
              data-refuse={!allow || undefined}
              data-chosen={chosen === option.optionId || undefined}
              disabled={busy}
              onClick={() => answer(option)}
              className="web-ask-option"
            >
              <Icon className="size-4 shrink-0" />
              {option.name}
            </button>
          )
        })}
        {permission.kind === "authentication" ? (
          <button type="button" disabled={busy} onClick={() => acp.answerPermission(null)} className="web-ask-option" data-refuse>
            Cancel sign-in
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * A question's card: each question with its answers as rows. One question with one answer to pick goes with the tap;
 * more, or several to pick, are picked and sent together. Typed words in the composer answer the first question still
 * open (`typed`), and send them all once every question has its answer.
 */
function QuestionCard({ ask, conversation, harness, answerTyped }: { ask: Extract<Ask, { kind: "question" }>; conversation: string; harness: string; answerTyped: AnswerTyped }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ask.questions.filter((question) => question.defaultValues?.length && question.options.length === 0).map((question) => [question.id, question.defaultValues ?? []]))
  )
  const [sent, setSent] = useState(false)
  const shown = activeInputQuestions(ask.questions, answers)
  const complete = (given: Record<string, string[]>) => activeInputQuestions(ask.questions, given).every((question) => question.required === false || given[question.id]?.some((value) => value.trim()))
  const quick = shown.length === 1 && shown[0]!.options.length > 0 && shown[0]!.valueType !== "string-array"
  const submit = (given: Record<string, string[]> | null) => {
    if (sent) return
    setSent(true)
    noteAnswered()
    const exchange = lastExchange()
    if (exchange && given) {
      const words = activeInputQuestions(ask.questions, given).map((question) => (given[question.id] ?? []).join(", ")).filter(Boolean).join(" · ")
      record(conversation, { id: ask.id, exchange, kind: "answered", words, detail: shown[0]?.header || shown[0]?.question })
    }
    const kept = given && Object.fromEntries(Object.entries(given).map(([id, values]) => [id, values.map((value) => value.trim()).filter(Boolean)] as const).filter(([, values]) => values.length > 0))
    void Promise.resolve(ask.answer(kept)).catch(() => setSent(false))
  }
  const pick = (question: LiveInputQuestion, value: string) => {
    if (sent) return
    if (quick) return submit({ ...answers, [question.id]: [value] })
    setAnswers((current) => {
      const had = current[question.id] ?? []
      const next = question.valueType === "string-array" ? (had.includes(value) ? had.filter((each) => each !== value) : [...had, value]) : [value]
      return { ...current, [question.id]: next }
    })
  }
  useEffect(() => {
    answerTyped((text) => {
      if (sent) return false
      const open = shown.find((question) => !answers[question.id]?.some((value) => value.trim()) && !question.isSecret) ?? shown.find((question) => !question.isSecret)
      if (!open) return false
      const given = { ...answers, [open.id]: [text] }
      if (complete(given)) submit(given)
      else setAnswers(given)
      return true
    })
    return () => answerTyped(null)
  })
  return (
    <div className="web-ask-body" aria-busy={sent || undefined} data-busy={sent || undefined}>
      <p className="web-ask-asker">{shown.length > 1 ? `${harness} asks ${shown.length} questions` : `${harness} asks`}</p>
      <div className="web-ask-scroll">
        {shown.map((question) => (
          <fieldset key={question.id} className="web-ask-question" disabled={sent}>
            <legend className="web-ask-legend">{question.header || question.question}</legend>
            {question.header && question.question !== question.header ? <p className="web-ask-hint">{question.question}</p> : null}
            {question.options.length ? (
              <div className="web-ask-options" role={question.valueType === "string-array" ? "group" : "radiogroup"}>
                {question.options.map((option) => {
                  const value = option.value ?? option.label
                  const selected = answers[question.id]?.includes(value) === true
                  return (
                    <button
                      key={value}
                      type="button"
                      role={question.valueType === "string-array" ? "checkbox" : "radio"}
                      aria-checked={selected}
                      data-selected={selected || undefined}
                      onClick={() => pick(question, value)}
                      className="web-ask-option web-ask-choice"
                    >
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block">{option.label}</span>
                        {option.description && option.description !== option.label ? <span className="block text-label text-muted-foreground">{option.description}</span> : null}
                      </span>
                      {selected ? <CheckIcon className="size-4 shrink-0" /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {question.isSecret ? (
              <input
                type="password"
                value={answers[question.id]?.[0] ?? ""}
                placeholder="Type it here"
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: [event.target.value] }))}
                className="web-ask-input"
              />
            ) : (!question.options.length || question.allowOther) && answers[question.id]?.length && !question.options.some((option) => answers[question.id]!.includes(option.value ?? option.label)) ? (
              <p className="web-ask-typed">
                <CornerDownLeftIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{answers[question.id]!.join(", ")}</span>
              </p>
            ) : null}
          </fieldset>
        ))}
      </div>
      <div className="web-ask-actions">
        <button type="button" disabled={sent} onClick={() => submit(null)} className="web-ask-dismiss">
          {ask.dismiss}
        </button>
        {quick ? null : (
          <button type="button" disabled={sent || !complete(answers)} onClick={() => submit(answers)} className="web-ask-send" data-primary>
            {sent ? "Sending…" : "Send answers"}
          </button>
        )}
      </div>
    </div>
  )
}

/** A record of an answer given from the dock, at the end of its turn: one muted line. */
export function AnsweredLine({ entry }: { entry: AnsweredRecord }) {
  const Icon = entry.kind === "refused" || entry.kind === "not-switched" ? XIcon : entry.kind === "allowed" ? CheckIcon : entry.kind === "switched" ? ArrowLeftRightIcon : CornerDownLeftIcon
  return (
    <p data-answered={entry.id} className="web-answered">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{entry.words}</span>
      {entry.detail ? (
        <>
          <span aria-hidden>·</span>
          <span className={cn("min-w-0 truncate", (entry.kind === "allowed" || entry.kind === "refused") && "font-mono")}>{entry.detail}</span>
        </>
      ) : null}
    </p>
  )
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener("online", changed)
      window.addEventListener("offline", changed)
      return () => {
        window.removeEventListener("online", changed)
        window.removeEventListener("offline", changed)
      }
    },
    () => navigator.onLine,
    () => true
  )
}

/**
 * The capsule above the composer: one status (`dockStatus`), what's queued behind the turn, and the way back to the
 * newest turn sliding out beside it. It arrives in 180 ms and leaves in 120; its words come in 80 ms after it. What it
 * last said stays while it leaves, so it never empties before it goes.
 */
function StatusCapsule({ conversation, cloudThread, asking, away, jump, reconnect }: { conversation: string; cloudThread: string | undefined; asking: boolean; away: boolean; jump: () => void; reconnect: () => void }) {
  const online = useOnline()
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    if (!current) return undefined
    const pending = current.pendingPrompts ?? []
    return {
      unconfirmed: pending.some((prompt) => prompt.unconfirmed),
      canceling: current.canceling,
      running: current.session.status === "running",
      since: current.projection?.exchanges.at(-1)?.prompt?.timestamp,
      pendingIds: pending.map((prompt) => prompt.id).join(" "),
      queued: promptDelivery(current).queued.length,
    }
  }, shallowEqual)
  const waking = useWaking((state) => (cloudThread ? state.waking.has(cloudThread) : false))
  const pendingIds = live?.pendingIds
  const wakingMessage = useOutbox((state) => Boolean(pendingIds) && pendingIds!.split(" ").some((id) => state.sending.get(id) === "waking"))
  const status = dockStatus({ online, unconfirmed: live?.unconfirmed ?? false, canceling: live?.canceling ?? false, waking, wakingMessage, running: live?.running ?? false, since: live?.since, asking })
  const queued = live?.queued ?? 0
  // Its app, while it runs or starts: a segment of its own that opens it (`preview.tsx`).
  const app = useAppStanding(conversation)
  const shown = status !== undefined || queued > 0 || app !== undefined
  // What it last said, kept while it leaves.
  const key = `${status?.kind}:${status?.kind === "working" ? status.since : status?.kind === "waking" ? status.message : ""}:${queued}:${app}`
  const [kept, keep] = useState<{ key: string; status: DockStatus | undefined; queued: number; app?: "running" | "starting" }>({ key, status, queued, app })
  if (shown && kept.key !== key) keep({ key, status, queued, app })
  const retry = () => {
    reconnect()
    void retryUnconfirmed(conversation)
  }
  let words: ReactNode = null
  if (kept.status?.kind === "working") {
    const since = kept.status.since
    words = <Ticking words={(now) => workingWords(now - since)} />
  } else if (kept.status) words = statusWords(kept.status)
  const tappable = kept.status?.kind === "offline" || kept.status?.kind === "reconnecting"
  return (
    <div className="web-float" data-away={away || undefined}>
      <div className="web-capsule" data-shown={shown || undefined} data-status={kept.status?.kind} role="status" aria-live="polite">
        {kept.status ? (
          tappable ? (
            <button type="button" className="web-capsule-segment" onClick={retry}>
              <RotateCwIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="web-capsule-words">{words}</span>
            </button>
          ) : (
            <span className="web-capsule-segment">
              {kept.status.kind === "working" || kept.status.kind === "waking" ? <span aria-hidden className="web-capsule-dot" /> : null}
              <span className="web-capsule-words">{words}</span>
            </span>
          )
        ) : null}
        {kept.queued > 0 ? <span className="web-capsule-segment web-capsule-queued">{kept.queued} queued</span> : null}
        {kept.app ? (
          <button type="button" className="web-capsule-segment web-capsule-app" data-app={kept.app} onClick={() => askPreview(conversation)}>
            <span aria-hidden className="web-capsule-app-dot" />
            <span className="web-capsule-app-words">{kept.app === "running" ? "App running · Open" : "App starting…"}</span>
          </button>
        ) : null}
      </div>
      <button type="button" aria-label="Jump to newest" tabIndex={away ? 0 : -1} aria-hidden={!away} className="web-jump" data-shown={away || undefined} onClick={jump}>
        <ArrowDownIcon className="size-4" />
      </button>
    </div>
  )
}
