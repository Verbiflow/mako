import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { formatRelative } from "@/lib/format"
import { attentionLabel, notificationHeadline } from "@/lib/notification-text"
import { cn } from "@/lib/utils"
import {
  markAllSeen,
  openItem,
  unseenCounts,
  unseenItems,
  useNotifications,
  type NotificationItem,
} from "@/state/notifications"
import { shallowEqual } from "@/state/store"

/**
 * What happened while you were elsewhere, in the titlebar's right cluster.
 *
 * It reads "2 threads need you" or "3 answers ready" and opens a list, most
 * urgent first, that jumps to the thread. It is absent when nothing is
 * waiting: a permanent bell would be reporting the same nothing forever. The
 * badge on the app icon counts the same threads, so the two never disagree.
 */
export function AttentionPill() {
  const counts = useNotifications((state) => unseenCounts(state.items), shallowEqual)
  const [open, setOpen] = useState(false)
  const total = counts.ask + counts.failed + counts.ready
  if (total === 0) return null
  const urgent = counts.ask + counts.failed > 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${attentionLabel(counts)}; open the list`}
          className="no-drag pressable flex h-6 items-center gap-1.5 rounded px-1.5 text-label text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-selected data-[state=open]:text-foreground"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              urgent ? "bg-caution" : "bg-foreground/45"
            )}
          />
          {attentionLabel(counts)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 gap-0 p-1">
        <AttentionList onOpen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function AttentionList({ onOpen }: { onOpen: () => void }) {
  const items = useNotifications((state) => unseenItems(state.items), sameItems)
  return (
    <>
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
        <span className="text-label font-medium text-faint">Waiting for you</span>
        <button
          type="button"
          onClick={() => {
            markAllSeen()
            onOpen()
          }}
          className="pressable rounded px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
        >
          Clear all
        </button>
      </div>
      <ul className="flex max-h-96 flex-col overflow-y-auto">
        {items.map((item) => (
          <li key={item.id}>
            <AttentionRow item={item} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * One waiting thread as a row you click to go there. The pill's list and the
 * in-app toast render the same row, so a notification looks the same in the
 * corner as it does in the list it lands in.
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

function sameItems(left: NotificationItem[], right: NotificationItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
