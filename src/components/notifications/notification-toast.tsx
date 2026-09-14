import { XIcon } from "lucide-react"
import { toast } from "sonner"
import { AttentionRow } from "@/components/notifications/attention-row"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { NotificationItem } from "@/state/notifications"

/**
 * The in-app announcement for a thread that needs you, as a card you click
 * anywhere to go there. Sonner's own toast makes only its action button
 * clickable, so the card is a custom toast: one attention row with a dismiss
 * control where the time would sit. It stays as long as any actionable
 * toast; the rail's mark and the app icon's badge keep the fact after it
 * leaves.
 */
export function showNotificationToast(item: NotificationItem): void {
  toast.custom(
    (id) => (
      <div role="status" className="relative w-full p-1 text-popover-foreground">
        <AttentionRow item={item} time={false} onOpen={() => toast.dismiss(id)} />
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(id)}
          className="pressable absolute top-2.5 right-2.5 flex size-5 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    ),
    { id: item.subject.id, duration: ACTION_TOAST_MS }
  )
}
