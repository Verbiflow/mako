import { Notice } from "@/components/ui/notice"
import { useReconnectingLong } from "@/state/host-connection"

/**
 * The host's link lost for longer than a moment (`RECONNECT_QUIET_MS`): one notice that Mako is still at it, by itself.
 * Mako reconnects and replays what this window missed, so there's nothing to press: no reload, which would only start
 * the same reconnect over. Until then the title bar alone says "Reconnecting…" (`ConnectionPill`), and the two are
 * never shown at once. The transport's own words stay out of it; the host's log keeps them.
 */
export function HostConnectionNotice() {
  const long = useReconnectingLong()
  if (!long) return null
  return (
    <Notice
      role="status"
      tone="progress"
      title="Reconnecting to Mako…"
      description="Mako keeps trying by itself and catches this window up once it's back. You're seeing the last known state; your drafts are saved."
      className="mx-3 my-2"
    />
  )
}
