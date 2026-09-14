import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { formatRelative } from "@/lib/format"
import { notificationHeadline } from "@/lib/notification-text"
import { openItem, type NotificationItem } from "@/state/notifications"

/**
 * One waiting thread as a row you click to go there. The titlebar once
 * carried a pill listing these; it put a standing count in the chrome that
 * the rail's own marks and its Status view already say. This is the
 * announcement now, and Cmd+Shift+U opens the next one.
 */
export function AttentionRow({
  item,
  onOpen,
  time = true,
}: {
  item: NotificationItem
  onOpen: () => void
  /** The relative time on the right; a toast that just arrived omits it. */
  time?: boolean
}) {
  const state: ActivityState =
    item.kind === "ask" ? "waiting" : item.kind === "failed" ? "failed" : "complete"
  return (
    <button
      type="button"
      onClick={() => {
        openItem(item)
        onOpen()
      }}
      className="pressable flex w-full items-start gap-2.5 rounded px-2 py-2 text-left hover:bg-fill-hover"
    >
      <span className="mt-0.5 flex shrink-0 items-center text-muted-foreground">
        <ActivityMark state={state} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
            {item.subject.title}
          </span>
          {time ? (
            <span className="tabular shrink-0 text-label text-faint">
              {formatRelative(item.at)}
            </span>
          ) : (
            // Room for the toast's dismiss control, which sits where the time would.
            <span aria-hidden className="w-5 shrink-0" />
          )}
        </span>
        <span className="text-label text-muted-foreground">
          {notificationHeadline(item.kind, item.subject.agent)}
          {item.subject.workspace ? ` · ${item.subject.workspace}` : ""}
        </span>
        <span className="line-clamp-2 text-label leading-snug text-faint">{item.body}</span>
      </span>
    </button>
  )
}
