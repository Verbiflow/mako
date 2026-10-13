import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { ArrowUpIcon, MessageCircleDashedIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react"
import { SIDE_QUESTION_LIMIT, type SideConversation, type SideExchange } from "@mako/host/contracts/live-side-questions"
import { Prose } from "@/components/transcript/markdown"
import { IconAction, Keys } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { descriptorFor } from "@/state/descriptors"
import { forgetSidePanel, useSidePanel } from "@/state/side-questions"
import { threadsStore } from "@/state/thread-store"
import { useThreads } from "@/state/threads"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"

const NO_EXCHANGES: SideExchange[] = []

/** The side conversation beside the conversation the composer sends to: questions answered while its turn goes on. */
export function SidePanel() {
  const key = useAcp((state) => activeLiveAcp(state)?.key)
  const side = useAcp((state) => activeLiveAcp(state)?.side)
  const harness = useAcp((state) => activeLiveAcp(state)?.harness)
  const livePath = useAcp((state) => activeLiveAcp(state)?.threadPath)
  const viewingPath = useThreads((state) => state.opening?.ref.path ?? state.viewing?.ref.path)
  const opened = useSidePanel((state) => (key ? state.open.has(key) : false))
  if (!key || !harness || (!side && !opened) || (viewingPath && viewingPath !== livePath)) return null
  return <SideConversationPanel key={key} conversation={key} harness={harness} side={side} />
}

function SideConversationPanel({ conversation, harness, side }: { conversation: string; harness: string; side?: SideConversation }) {
  const exchanges = side?.exchanges ?? NO_EXCHANGES
  const last = exchanges.at(-1)
  const answering = last?.status === "answering"
  const [draft, setDraft] = useState("")
  const field = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [scrolled, setScrolled] = useState(false)
  const focus = useSidePanel((state) => state.focus)

  useEffect(() => {
    field.current?.focus()
  }, [focus])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [exchanges])

  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`
  }, [draft])

  async function ask(question: string) {
    pinned.current = true
    setDraft("")
    if (!(await acp.sideQuestion({ kind: "ask", question }, conversation))) setDraft((current) => current || question)
    field.current?.focus()
  }

  function close() {
    forgetSidePanel(conversation)
    if (side) void acp.sideQuestion({ kind: "close" }, conversation)
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:focus-composer")))
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    const question = draft.trim()
    if (question && !answering) void ask(question)
  }

  const question = draft.trim()
  const tooLong = question.length > SIDE_QUESTION_LIMIT

  return (
    <section
      aria-label="Side question"
      data-side-panel
      data-side-by={side?.by}
      className="side-panel animate-enter shrink-0 border-b border-hairline"
    >
      <header className="flex h-8 items-center gap-2 px-3 text-label">
        <MessageCircleDashedIcon className={cn("size-3.5 shrink-0 text-faint", answering && "side-panel-glyph")} aria-hidden />
        <span className="shrink-0 font-medium text-muted-foreground">Side question</span>
        <span className="min-w-0 truncate text-faint">{answerer(harness, side)}</span>
        <IconAction label="Close side question" keys={["Esc"]} size="xs" className="ml-auto" onClick={close}>
          <XIcon />
        </IconAction>
      </header>

      {exchanges.length ? (
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
            setScrolled(element.scrollTop > 0)
          }}
          data-scrolled={scrolled || undefined}
          className="side-panel-scroller max-h-[min(28dvh,18rem)] overflow-y-auto overscroll-contain px-3 pb-1"
        >
          <ol aria-live="polite" className="space-y-3 pb-1">
            {exchanges.map((exchange) => (
              <Exchange key={exchange.id} exchange={exchange} onRetry={answering ? undefined : () => void ask(exchange.question)} />
            ))}
          </ol>
        </div>
      ) : null}

      <div className="flex items-end gap-2 px-3 pt-1 pb-2.5">
        <label className="side-panel-field flex min-h-8 min-w-0 flex-1 items-center bg-surface px-2.5 py-1.5 shadow-[inset_0_0_0_1px_var(--hairline)]">
          <span className="sr-only">{exchanges.length ? "Follow-up side question" : "Side question"}</span>
          <textarea
            ref={field}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={exchanges.length ? "Ask a follow-up…" : "Ask about this conversation…"}
            className="block max-h-[120px] min-w-0 flex-1 resize-none bg-transparent text-ui text-foreground outline-none placeholder:text-faint"
          />
          {tooLong ? <span className="ml-2 shrink-0 text-label text-caution tabular-nums">{question.length.toLocaleString()} / {SIDE_QUESTION_LIMIT.toLocaleString()}</span> : null}
        </label>
        {answering ? (
          <button
            type="button"
            aria-label="Stop the side answer"
            title="Stop the side answer"
            onClick={() => void acp.sideQuestion({ kind: "stop" }, conversation)}
            className="pressable flex size-8 shrink-0 items-center justify-center bg-foreground text-background hover:opacity-90 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <SquareIcon className="size-2.5 fill-current" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Ask"
            title="Ask"
            disabled={!question || tooLong}
            onClick={() => void ask(question)}
            className={cn(
              "pressable flex size-8 shrink-0 items-center justify-center focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-ring",
              "[transition:transform_var(--duration-press)_var(--ease-out),background-color_160ms_ease,opacity_160ms_ease]",
              question && !tooLong ? "bg-foreground text-background hover:opacity-90" : "bg-foreground/10 text-faint",
            )}
          >
            <ArrowUpIcon className="size-3.5" strokeWidth={2.2} />
          </button>
        )}
      </div>
      {!exchanges.length ? (
        <p className="flex items-center gap-1.5 px-3 pb-2.5 -mt-1 text-label text-faint">
          The answer stays here, out of the conversation. <Keys keys={["Esc"]} /> closes it.
        </p>
      ) : null}
    </section>
  )
}

function Exchange({ exchange, onRetry }: { exchange: SideExchange; onRetry?: () => void }) {
  const answering = exchange.status === "answering"
  return (
    <li data-side-exchange={exchange.status} className="side-exchange animate-enter">
      <p className="side-question text-ui font-medium text-foreground whitespace-pre-wrap">{exchange.question}</p>
      <div className="side-answer">
        {exchange.answer ? (
          <Prose text={exchange.answer} streaming={answering} className="side-prose" />
        ) : answering ? (
          <Shimmer text="Thinking…" className="text-ui" />
        ) : null}
        {exchange.status === "stopped" ? (
          <p className="mt-1 text-label text-faint">{exchange.answer ? "Stopped." : "Stopped before an answer."}</p>
        ) : null}
        {exchange.status === "failed" ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-label text-caution">
            <span>{exchange.error ?? "The side question failed."}</span>
            {onRetry ? (
              <button type="button" onClick={onRetry} className="pressable inline-flex items-center gap-1 rounded px-1 text-muted-foreground hover:bg-fill-hover hover:text-foreground">
                <RotateCcwIcon className="size-3" aria-hidden />
                Ask again
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** Who answers, in the words the header shows. */
function answerer(harness: string, side?: SideConversation): string {
  const standing = descriptorFor(threadsStore.get(), harness)?.features.sideQuestions.mako
  const by = side?.by ?? (standing?.state === "implemented" && standing.through === "mako" ? "fork" : "harness")
  return by === "fork"
    ? "A read-only copy of this conversation answers. Its turn keeps going."
    : `${harnessLabel(harness)} answers from this conversation. Its turn keeps going.`
}
