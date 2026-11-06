import { useHarnessIdentity } from "@/lib/harness-label"
import { useEffect, useRef, useState } from "react"
import { formatRelative } from "@/lib/format"
import type { ThreadStatus } from "@/state/threads"
import { LiveMark } from "@/components/ui/live-mark"
import { motionOf, threadMarkState, threadStatusLabel, type LiveMarkState } from "@/lib/live-mark-state"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { railAnnouncement, type RailAsk } from "@/lib/rail-announcement"

/** Slack for an answer that lands as its row is painted: still fresh. */
const REVIEW_FRESH_MS = 2_000

/**
 * A Thread's live mark: Mako's two-tone fin doing what the Thread does, its harness a corner badge (`LiveMark`). One mark at the start of a row
 * or tab says who and how; there's no second status mark at its end. An answer that finished after the mark was
 * painted is news and its dot arrives; a row scrolling back into view with an old answer paints it still.
 */
export function ThreadMark({ status, state, harness, lit, cut, size, label, className }: { status: ThreadStatus; state?: LiveMarkState; harness: string; lit?: boolean; cut?: string; size?: number; label?: string; className?: string }) {
  useHarnessIdentity()
  const [mountedAt] = useState(() => Date.now())
  return (
    <LiveMark
      state={state ?? threadMarkState(status)}
      motion={motionOf(status.kind === "working" ? status.detail : undefined)}
      lit={lit}
      fresh={status.kind === "review" && status.at >= mountedAt - REVIEW_FRESH_MS}
      cut={cut}
      size={size}
      label={label ?? threadStatusLabel(status, harness)}
      className={className}
    >
      <HarnessIcon harness={harness} />
    </LiveMark>
  )
}

/**
 * A row's one trailing slot: what asks for the person, in words, or else how long ago it moved. The mark at the
 * row's start already draws the state; this says the two that need the person by name.
 */
export function ThreadStatusEnd({ status, updatedAt }: { status: ThreadStatus; updatedAt?: string }) {
  if (status.kind === "needs-permission")
    return (
      <span data-status-end="needs" className="shrink-0 text-label font-medium text-attention">
        Needs you
      </span>
    )
  if (status.kind === "failed")
    return (
      <span data-status-end="failed" className="shrink-0 text-label text-negative">
        Failed
      </span>
    )
  if (status.kind === "observed")
    return (
      <span title={threadStatusLabel(status)} className="shrink-0 text-label text-faint">
        Updated
      </span>
    )
  return updatedAt ? <span className="tabular shrink-0 text-label text-faint">{formatRelative(updatedAt)}</span> : null
}

/**
 * The rail's one live region. Row marks are labelled images, so a list of
 * hundreds of rows doesn't speak every change; this says only what asks for
 * you, as it starts: a new approval or a failure. What was already asking
 * when the rail appeared isn't announced.
 */
export function RailAnnouncer({ asks }: { asks: readonly RailAsk[] }) {
  const [message, setMessage] = useState("")
  const seen = useRef<ReadonlyMap<string, RailAsk["kind"]> | null>(null)
  useEffect(() => {
    const previous = seen.current
    seen.current = new Map(asks.map((ask) => [ask.key, ask.kind]))
    const next = previous && railAnnouncement(previous, asks)
    if (next) setMessage(next)
  }, [asks])
  return <span aria-live="polite" className="sr-only">{message}</span>
}
