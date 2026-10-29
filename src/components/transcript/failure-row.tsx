import { useContext, useEffect, useRef, useState } from "react"
import { FailedRequestsContext } from "./failed-requests"
import { ChevronRightIcon, CircleAlertIcon, MoreHorizontalIcon } from "lucide-react"
import { recoveryGlyph } from "./recovery-glyph"
import { compactionAvailable } from "@mako/host/contracts/recovery"
import { classifyProviderFailure } from "@mako/host/contracts/provider-failure"
import { Collapse } from "@/components/ui/collapse"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { useCopy } from "@/components/ui/use-copy"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import type { LiveRequest } from "@/lib/types"
import { cn } from "@/lib/utils"
import { acp, acpStore, useAcp } from "@/state/acp"
import { continueTurn, holdUntil, sendTo } from "@/state/acp-queue"
import { failureKey, noteFailureVisible } from "@/state/failure-visibility"
import { remindAtReset, useLimitReset } from "@/state/limit-reset"
import { recoveryLabel, requestRecovery, type RecoveryAction } from "@/state/request-recovery"
import { useTranscriptSource } from "./source-context"
import { descriptorFor } from "@/state/descriptors"
import { useThreads } from "@/state/threads"
import { turnWords } from "@/state/prompt-delivery"


/** The failure row an exchange ends on, when its request failed; nothing for every other exchange. */
export function ExchangeFailure({ requestId }: { requestId?: string }) {
  const request = useContext(FailedRequestsContext).get(requestId ?? "")
  const { liveId } = useTranscriptSource()
  if (!request || !liveId) return null
  return (
    <div className="mt-4">
      <FailureRow conversationId={liveId} request={request} />
    </div>
  )
}

/**
 * A turn that ended on an error a transcript recorded, with no live request
 * behind it to recover: the outcome in one line, named by the same rules a
 * live failure is (`classifyProviderFailure`), or the provider's own first
 * line when no rule knows it; what to do, when a rule says; the provider's
 * whole words behind Details.
 */
export function TurnError({ error }: { error: string }) {
  const [open, setOpen] = useState(false)
  const { liveId } = useTranscriptSource()
  useHarnessIdentity()
  const harness = useAcp((state) => {
    const conversation = liveId ? state.conversations[liveId] : undefined
    return conversation?.kind === "live" ? conversation.session.harness : undefined
  })
  const failure = classifyProviderFailure(error, harness ? harnessLabel(harness) : "The agent")
  const known = failure.kind !== "unknown"
  return (
    <div role="alert" data-event-error={failure.kind} className="flex items-start gap-2 text-ui">
      <CircleAlertIcon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-negative" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">{known ? failure.title : error.trim().split("\n", 1)[0]}</p>
        {known ? <p className="text-muted-foreground">{failure.guidance}</p> : null}
        <DetailsToggle className="-ml-1.5" open={open} onToggle={() => setOpen((value) => !value)} />
        <Collapse open={open}>
          <p data-provider-error className="mt-1.5 max-h-40 overflow-y-auto border-l border-hairline pl-3 font-mono text-code break-words whitespace-pre-wrap text-faint">{error}</p>
        </Collapse>
      </div>
    </div>
  )
}

function DetailsToggle({ open, onToggle, className }: { open: boolean; onToggle(): void; className?: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn("pressable flex h-6 items-center gap-1 rounded-md px-1.5 text-label text-faint transition-colors duration-100 hover:text-foreground", className)}
    >
      Details
      <ChevronRightIcon aria-hidden className={cn("size-3 transition-transform duration-200 ease-[var(--ease-out)]", open && "rotate-90")} />
    </button>
  )
}

/**
 * A message that ended without an answer, said where it ended.
 *
 * One line says the outcome and one what to do; the button is the one thing
 * most likely to work for this kind of failure (Send again only when a repeat
 * can, Sign in for a signed-out account, Compact and retry for a full
 * context, a new thread for a history the model refuses), and the rest wait
 * in its menu. Whether the agent got the message and the provider's own words
 * are kept behind Details: they decide what is safe to do, but they aren't
 * the headline. A usage limit with a known reset is a wait, in the warning
 * tone, and offers to send the message again then.
 *
 * `quoted` draws the message itself, for one that never reached the
 * transcript (refused before it was sent).
 */
export function FailureRow({ conversationId, request, quoted = false, compact = false }: {
  conversationId: string
  request: LiveRequest
  quoted?: boolean
  /** A row in the saved messages list: no Details, the menu holds everything. */
  compact?: boolean
}) {
  useHarnessIdentity()
  const harness = useAcp((state) => {
    const conversation = state.conversations[conversationId]
    return conversation?.kind === "live" ? conversation.session.harness : undefined
  })
  const compacted = useAcp((state) => {
    const conversation = state.conversations[conversationId]
    return conversation?.kind === "live" && (conversation.control?.actions?.some((action) =>
      action.input.kind === "compact" && action.input.requestId === request.id && action.state.kind === "completed") ?? false)
  })
  const idle = useAcp((state) => {
    const live = state.conversations[conversationId]
    return live?.kind === "live" && compactionAvailable(live.session, live.control?.actions ?? [],
      live.requests?.some((item) => item.status === "queued" || item.status === "dispatching") ?? false)
  })
  // Sent again already: a later request carries the same words, or a timed send waits for this one.
  const followed = useAcp((state) => {
    const live = state.conversations[conversationId]
    if (live?.kind !== "live") return undefined
    const requests = live.requests ?? []
    const index = requests.findIndex((item) => item.id === request.id)
    const later = requests.slice(index + 1)
    const waiting = later.find((item) => item.status === "held" && item.wake?.after === request.id)
    if (waiting?.wake) return { kind: "waiting" as const, at: waiting.wake.at }
    return later.some((item) => item.status === "completed") ? { kind: "answered" as const } : undefined
  }, (left, right) => left?.kind === right?.kind && (left?.kind !== "waiting" || right?.kind !== "waiting" || left.at === right.at))
  // The harness compacts on Mako's request; one that can't, or does it on its own, gets the new thread instead.
  const compactable = useThreads((state) => descriptorFor(state, harness)?.capabilities.compaction.state === "implemented")
  const resetAt = useLimitReset(conversationId)
  const provider = harness ? harnessLabel(harness) : "The agent"
  const recovery = requestRecovery(request, { provider, compacted, canCompact: compactable, resetAt })
  const text = request.displayText ?? request.text
  // Which message it was, by its words; a continuation says Mako's words to the agent, so it is named by the turn it continued.
  const quote = useAcp((state) => {
    const live = state.conversations[conversationId]
    return quoted && live?.kind === "live" ? turnWords(live.requests ?? [], request) : text
  })
  const { copy, copied } = useCopy(text)
  const [busy, setBusy] = useState<RecoveryAction["kind"] | null>(null)
  const [done, setDone] = useState<RecoveryAction["kind"] | null>(null)
  const [open, setOpen] = useState(false)
  const key = failureKey(conversationId, request.id)
  const root = useVisibility(key)

  const run = async (action: RecoveryAction) => {
    if (busy) return
    switch (action.kind) {
      case "copy":
        await copy()
        return
      case "restore": {
        const event = new CustomEvent("mako:restore-saved-message", { cancelable: true, detail: { conversationId, requestId: request.id } })
        if (!window.dispatchEvent(event)) setDone("restore")
        return
      }
      case "settings":
        window.dispatchEvent(new CustomEvent("mako:settings", { detail: action.section }))
        return
      case "sign-in":
        window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
        return
      case "remind-at":
        remindAtReset(conversationId, action.at)
        setDone("remind-at")
        return
    }
    setBusy(action.kind)
    const settled =
      action.kind === "continue" ? await continueTurn(conversationId, action.reason)
        : action.kind === "resend" ? await sendTo(conversationId, request.text, request.attachments)
        : action.kind === "resume-at" ? await holdUntil(conversationId, request.id, action.at)
          : action.kind === "fresh" ? await acp.recoverFresh(conversationId, request.id)
            : await compactAndRetry(conversationId, request)
    setBusy(null)
    if (settled) setDone(action.kind)
  }

  const label = (action: RecoveryAction) =>
    busy === action.kind ? busyLabel(action)
      : done === action.kind || (action.kind === "copy" && copied) ? doneLabel(action)
        : recoveryLabel(action)
  // A row whose message went again says so instead of offering it twice.
  const primary = followed?.kind === "waiting" || (followed?.kind === "answered" && recovery.primary?.kind !== "restore") ? undefined : recovery.primary
  const glyph = recoveryGlyph(recovery)
  const Glyph = glyph.icon
  const evidence = request.nativeDelivery?.evidence.kind ?? "unknown"

  return (
    <div
      ref={root}
      role="group"
      aria-label={recovery.title}
      data-failure-row={request.id}
      data-failure-key={key}
      data-failure={request.failure}
      data-request-recovery={request.id}
      data-failure-tone={recovery.tone}
      className={cn("flex items-start gap-2 text-ui", !compact && "animate-enter")}
    >
      <Glyph aria-hidden className={cn("mt-[3px] size-3.5 shrink-0", glyph.className)} />
      <div className="min-w-0 flex-1">
        <p className="min-w-0 text-foreground">
          {recovery.title}
          {recovery.description ? <span className="text-muted-foreground"> · {recovery.description}</span> : null}
        </p>
        {quoted && quote ? <p className="mt-0.5 line-clamp-2 text-label text-muted-foreground">“{quote}”</p> : null}
        {followed ? (
          <p data-failure-followed={followed.kind} className="mt-0.5 text-label text-muted-foreground">
            {followed.kind === "waiting" ? `Sends again at ${new Date(followed.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. It waits in the queue below.` : "A later message went through."}
          </p>
        ) : recovery.guidance ? (
          <p className="mt-0.5 text-label text-muted-foreground">{recovery.guidance}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {primary ? (
            <button
              type="button"
              data-recovery-primary={primary.kind}
              disabled={busy !== null || ((primary.kind === "resend" || primary.kind === "compact" || primary.kind === "continue") && !idle) || done === primary.kind}
              onClick={() => void run(primary)}
              className="pressable h-6 rounded-md bg-fill-selected px-2 text-label font-medium text-foreground transition-colors duration-100 hover:bg-foreground/15 disabled:opacity-45"
            >
              {label(primary)}
            </button>
          ) : null}
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label="More ways to recover this message"
                title="More"
                className="pressable grid size-6 place-items-center rounded-md text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </button>
            </MenuTrigger>
            <MenuContent align="start" side="bottom" className="min-w-52">
              {recovery.more.map((action) => (
                <MenuItem
                  key={action.kind}
                  disabled={busy !== null || (action.kind === "resend" && !idle) || (action.kind !== "copy" && done === action.kind)}
                  onSelect={() => void run(action)}
                  className="text-ui"
                >
                  {label(action)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {compact ? null : <DetailsToggle open={open} onToggle={() => setOpen((value) => !value)} />}
        </div>
        {compact ? null : (
          <Collapse open={open}>
            <div className="mt-1.5 space-y-1.5 border-l border-hairline pl-3 text-label leading-relaxed text-muted-foreground">
              <p data-delivery-evidence={evidence}>{recovery.delivery}</p>
              {request.error ? (
                <p data-provider-error className="max-h-40 overflow-y-auto font-mono text-code break-words whitespace-pre-wrap text-faint">{request.error}</p>
              ) : null}
            </div>
          </Collapse>
        )}
      </div>
    </div>
  )
}

function busyLabel(action: RecoveryAction): string {
  switch (action.kind) {
    case "resend":
      return "Sending…"
    case "continue":
      return "Continuing…"
    case "compact":
      return "Compacting…"
    case "fresh":
      return "Starting…"
    default:
      return recoveryLabel(action)
  }
}

function doneLabel(action: RecoveryAction): string {
  switch (action.kind) {
    case "resend":
      return "Sent again"
    case "continue":
      return "Continued"
    case "resume-at":
      return "Waiting for reset"
    case "remind-at":
      return "Mako will tell you at reset"
    case "fresh":
      return "Started in a new thread"
    case "restore":
      return "Restored to composer"
    case "copy":
      return "Copied"
    default:
      return recoveryLabel(action)
  }
}

/** The height of one notice above the composer, with its gap. */
const NOTICE_LINE_PX = 64

/** Reports whether the row is on screen, so the composer's notice speaks only for one that isn't. */
function useVisibility(key: string) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = root.current
    if (!node) return
    // The notice this decides takes a line from the transcript's bottom: a row only that line would hide still
    // counts as seen, so the notice can't hide the row that then brings the notice back.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) noteFailureVisible(key, entry.isIntersecting)
    }, { rootMargin: `0px 0px ${NOTICE_LINE_PX}px 0px` })
    observer.observe(node)
    return () => {
      observer.disconnect()
      noteFailureVisible(key, false)
    }
  }, [key])
  return root
}

/**
 * Compact the conversation for this request, then send it again once the
 * compaction finished; a compaction that fails or is refused sends nothing.
 */
function compactAndRetry(conversationId: string, request: LiveRequest): Promise<boolean> {
  return acp.compact(request.id).then((accepted) => accepted ? new Promise<boolean>((resolve) => {
    const settled = () => {
      const live = acpStore.get().conversations[conversationId]
      const action = live?.kind === "live"
        ? live.control?.actions?.findLast((item) => item.input.kind === "compact" && item.input.requestId === request.id)
        : undefined
      if (!live || live.kind !== "live") return false
      if (action?.state.kind === "completed") {
        stop()
        void sendTo(conversationId, request.text, request.attachments).then(resolve)
        return true
      }
      if (action && action.state.kind !== "accepted" && action.state.kind !== "dispatching") {
        stop()
        resolve(false)
        return true
      }
      return false
    }
    const stop = acpStore.subscribe(() => void settled())
    settled()
  }) : false)
}
