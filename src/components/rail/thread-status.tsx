import { useState } from "react"
import { formatRelative } from "@/lib/format"
import { harnessLabel } from "@/components/rail/harness-meta"
import type { ThreadStatus } from "@/state/threads"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"

/** Slack for an answer that lands as its row is painted: still fresh. */
const REVIEW_FRESH_MS = 2_000

export function ThreadStatusMark({
  status,
  updatedAt,
}: {
  status: ThreadStatus
  updatedAt?: string
}) {
  // When this row was painted. An answer that finished after that is news
  // and its mark arrives; a row scrolling back into view with an old answer
  // paints the mark still.
  const [mountedAt] = useState(() => Date.now())
  if (status.kind === "idle")
    return updatedAt ? (
      <span className="tabular shrink-0 text-label text-faint">
        {formatRelative(updatedAt)}
      </span>
    ) : null
  // Open elsewhere: the time stays, and a hollow ring says a window is on it.
  // The app is named where a label would not fit.
  if (status.kind === "external-open") {
    const label = `Open in ${harnessLabel(status.app)}; no running turn reported`
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className="flex shrink-0 items-center gap-1.5 text-label text-faint"
      >
        <span aria-hidden className="size-1.5 rounded-full ring-1 ring-current" />
        {updatedAt ? <span className="tabular">{formatRelative(updatedAt)}</span> : null}
      </span>
    )
  }
  if (status.kind === "observed")
    return (
      <span
        title="The session changed; running state is unconfirmed"
        className="shrink-0 text-label text-faint"
      >
        Updated
      </span>
    )
  // An answer you have not read is the one state in this column that is
  // for you rather than about the agent, so it is the brightest thing a row
  // can carry: a small sphere in the text colour itself (`.review-dot`).
  // Hue would put a fourth warm tone beside ember, caution and negative in
  // a 200px column; a grey ring with a check once made it the dimmest state
  // here instead. Once read, the row shows its time again like any idle
  // thread. It arrives with a short scale only when the answer is fresh, so
  // rows scrolling back into view do not re-announce old news.
  if (status.kind === "review") {
    if (!status.unread)
      return updatedAt ? (
        <span className="tabular shrink-0 text-label text-faint">
          {formatRelative(updatedAt)}
        </span>
      ) : null
    return (
      <span
        role="status"
        aria-label="Answer ready to review"
        title="Answer ready to review"
        className="flex size-5 shrink-0 items-center justify-center"
      >
        <span
          aria-hidden
          className="review-dot"
          data-new={status.at >= mountedAt - REVIEW_FRESH_MS || undefined}
        />
      </span>
    )
  }
  const state: ActivityState =
    status.kind === "failed"
      ? "failed"
      : status.kind === "needs-permission"
        ? "waiting"
        : "working"
  const label =
    status.kind === "working"
      ? (status.detail ?? "Working in Mako")
      : status.kind === "external-active"
        ? `Working in ${status.app ?? "another app"}`
        : status.kind === "failed"
          ? (status.detail ?? "Failed")
          : (status.detail ?? "Needs your approval")
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center text-muted-foreground"
    >
      <ActivityMark state={state} size={20} />
    </span>
  )
}
