import { draftText, rememberDraft, clearSubmittedDraft } from "@/state/drafts"
import { useThreads } from "@/state/threads"
import { useLayoutEffect, useRef, useState } from "react"
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  PencilIcon,
  XIcon,
  CornerDownRightIcon,
} from "lucide-react"
import { acp, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { promptDelivery, type PendingPrompt } from "@/state/prompt-delivery"
import { editQueuedPrompt, type QueueTarget } from "@/state/acp-queue"
import { parsePlanContext } from "@/lib/proposed-plan"
import { stripThreadReferenceAppendix } from "@/lib/thread-references"
import { parseAttachmentAppendix } from "@/lib/attachments"
import { stripSkillAppendix } from "@/lib/skill-references"

const EMPTY: PendingPrompt[] = []

export function PromptQueue() {
  const liveDelivery = useAcp(
    (state) => {
      const current = activeAcp(state)
      return current
        ? promptDelivery({
            ...current,
            session:
              current.kind === "live"
                ? current.session
                : { status: "starting" },
          }).queued
        : EMPTY
    },
    (left, right) =>
      left.length === right.length &&
      left.every(
        (item, index) =>
          item.id === right[index]?.id &&
          item.text === right[index]?.text &&
          item.status === right[index]?.status &&
          item.attachments === right[index]?.attachments
      )
  )
  const id = useAcp((state) => activeAcp(state)?.key)
  const livePath = useAcp((state) => activeAcp(state)?.threadPath)
  const viewingPath = useThreads(
    (state) => state.opening?.ref.path ?? state.viewing?.ref.path
  )
  const nativeDelivery = useThreads(
    (state) => {
      if (!viewingPath || viewingPath === livePath) return EMPTY
      const requests = state.nativeRequests.filter(
        (request) => request.input.path === viewingPath
      )
      const queued = requests
        .filter(
          (request) => request.status === "queued" || request.status === "held"
        )
        .map((request) => ({
          ...request.input,
          status:
            request.status === "held" ? ("held" as const) : ("queued" as const),
        }))
      return queued[0]?.status === "held" ||
        state.working[viewingPath] ||
        requests.some((request) => request.status === "dispatching")
        ? queued
        : queued.slice(1)
    },
    (left, right) =>
      left.length === right.length &&
      left.every(
        (item, index) =>
          item.id === right[index]?.id &&
          item.text === right[index]?.text &&
          item.status === right[index]?.status &&
          item.attachments === right[index]?.attachments
      )
  )
  const native = Boolean(viewingPath && viewingPath !== livePath)
  const delivery = native ? nativeDelivery : liveDelivery
  const target: QueueTarget | null =
    native && viewingPath
      ? { kind: "native", path: viewingPath }
      : id
        ? { kind: "live", id }
        : null
  const accepted = useAcp((state) => activeLiveAcp(state)?.requests)
  const [expanded, setExpanded] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  if (!target || !delivery.length) return null
  const page = Math.min(
    pageIndex,
    Math.max(0, Math.ceil(delivery.length / 20) - 1)
  )
  const shown = expanded
    ? delivery.slice(page * 20, (page + 1) * 20)
    : delivery.slice(0, 2)
  return (
    <section
      aria-label="Queued messages"
      className="flex max-h-[min(240px,20dvh)] shrink-0 flex-col overflow-hidden rounded-none border-b border-hairline bg-raised/40"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-label text-faint">
        <CornerDownRightIcon className="size-3.5" />
        <span className="font-medium text-muted-foreground">Up next</span>
        <span>
          {delivery.length} {delivery.length === 1 ? "message" : "messages"}
        </span>
        <span className="ml-auto truncate">
          {delivery[0]?.status === "held"
            ? "Paused"
            : "After this turn"}
        </span>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {shown.map((request) => (
          <QueueRow
            key={request.id}
            target={target}
            request={request}
            editable={
              native ||
              Boolean(
                accepted?.some(
                  (item) =>
                    item.id === request.id &&
                    (item.status === "queued" || item.status === "held")
                )
              )
            }
          />
        ))}
      </div>
      {expanded && delivery.length > 20 ? (
        <div className="flex items-center justify-between border-t border-hairline px-3 py-1 text-label text-faint">
          <button
            type="button"
            disabled={page === 0}
            className="pressable rounded px-2 py-1 hover:bg-fill-hover disabled:opacity-30"
            onClick={() => setPageIndex(page - 1)}
          >
            Previous
          </button>
          <span>
            Messages {page * 20 + 1}–
            {Math.min((page + 1) * 20, delivery.length)} of {delivery.length}
          </span>
          <button
            type="button"
            disabled={(page + 1) * 20 >= delivery.length}
            className="pressable rounded px-2 py-1 hover:bg-fill-hover disabled:opacity-30"
            onClick={() => setPageIndex(page + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
      {delivery.length > 2 ? (
        <button
          type="button"
          className="pressable flex h-7 w-full items-center justify-center gap-1 border-t border-hairline text-label text-faint hover:bg-fill-hover hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDownIcon
            className={`size-3 ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show less" : `Show ${delivery.length - 2} more`}
        </button>
      ) : null}
    </section>
  )
}

function QueueRow({
  target,
  request,
  editable,
}: {
  target: QueueTarget
  request: PendingPrompt
  editable: boolean
}) {
  // The body must stay a prefix of the queued text: an edit is spliced onto
  // the appendices that follow it, so the placeholders a referenced
  // conversation left are kept here rather than restored to tokens.
  const rawBody = parsePlanContext(
    stripThreadReferenceAppendix(stripSkillAppendix(request.text))
  ).body
  const parsedBody = parseAttachmentAppendix(rawBody).body
  const body = request.text.startsWith(parsedBody) ? parsedBody : rawBody
  const [editing, setEditing] = useState(false)
  const [editingSource, setEditingSource] = useState<PendingPrompt>()
  const editKey = `queue:${target.kind === "live" ? target.id : target.path}:${request.id}`
  const [draft, setDraft] = useState(() => draftText(editKey) || body)
  const editButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus()
    wasEditing.current = editing
  }, [editing])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const canSteer = useAcp(
    (state) =>
      target.kind === "live" &&
      activeLiveAcp(state)?.key === target.id &&
      acp.canSteer()
  )
  async function sendNow() {
    setBusy(true)
    setError(undefined)
    try {
      if (!(await acp.steerQueued(request.id)))
        setError("The running turn did not take the message. It stays queued.")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  async function change(kind: "edit" | "remove" | "pause" | "resume") {
    setBusy(true)
    setError(undefined)
    try {
      await editQueuedPrompt(
        target,
        editing && editingSource && (kind === "edit" || kind === "resume")
          ? editingSource
          : request,
        kind === "edit"
          ? {
              kind,
              text: draft + (editingSource ?? request).text.slice(body.length),
            }
          : { kind }
      )
      if (kind === "pause") {
        const saved = draftText(editKey) || body
        setDraft(saved)
        rememberDraft(editKey, saved)
        setEditingSource(request)
        setEditing(true)
      } else {
        clearSubmittedDraft(editKey, draft)
        setEditing(false)
        if (kind === "remove")
          window.dispatchEvent(new CustomEvent("mako:focus-composer"))
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="group/queued contain-turn border-t border-hairline px-3 py-2">
      {editing ? (
        <div className="space-y-2">
          <textarea
            aria-label="Edit queued message"
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(event) => {
              setDraft(event.target.value)
              rememberDraft(editKey, event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                if (!busy) void change("resume")
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                if (!busy && draft.trim()) void change("edit")
              }
            }}
            rows={3}
            className="w-full resize-none rounded-md bg-surface px-2 py-1.5 text-ui leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-end gap-2 text-label">
            <button
              type="button"
              disabled={busy}
              onClick={() => void change("resume")}
              className="pressable rounded px-2 py-1 text-faint hover:bg-fill-hover hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || (!draft.trim() && !request.attachments.length)}
              onClick={() => void change("edit")}
              className="pressable flex items-center gap-1 rounded bg-fill-selected px-2 py-1 text-foreground disabled:opacity-40"
            >
              <CheckIcon className="size-3" />
              Save message
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-ui leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {body || `${request.attachments.length} attachments`}
          </p>
          <div className="flex shrink-0 items-center gap-0.5 text-faint">
            {request.status === "held" ? <button type="button" aria-label="Resume queued message" disabled={busy} onClick={() => void change("resume")} className="pressable h-6 rounded px-2 text-label text-foreground hover:bg-fill-hover disabled:opacity-40">Resume</button> : null}
            {canSteer ? (
              <button
                type="button"
                aria-label="Send now, into the running turn"
                title="Send now, into the running turn"
                disabled={!editable || busy}
                className="pressable grid size-6 place-items-center rounded hover:bg-fill-hover hover:text-foreground disabled:opacity-30"
                onClick={() => void sendNow()}
              >
                <ArrowUpIcon className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Edit queued message"
              title="Edit queued message"
              disabled={!editable || busy}
              className="pressable grid size-6 place-items-center rounded hover:bg-fill-hover hover:text-foreground disabled:opacity-30"
              ref={editButton}
              onClick={() => void change("pause")}
            >
              <PencilIcon className="size-3" />
            </button>
            <button
              type="button"
              aria-label="Remove queued message"
              title="Remove queued message"
              disabled={!editable || busy}
              className="pressable grid size-6 place-items-center rounded hover:bg-fill-hover hover:text-foreground disabled:opacity-30"
              onClick={() => void change("remove")}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      {request.status === "held" && !editing ? (
        <p className="mt-1 text-label text-faint">Paused until you resume or edit this message</p>
      ) : null}
      {request.attachments.length ? (
        <p className="mt-1 truncate text-label text-faint">
          {request.attachments.map((attachment) => attachment.name).join(", ")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-label text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
