import { useState } from "react"
import { Notice, NoticeAction } from "@/components/ui/notice"
import { reconnectHostNow, restartMako, useReconnectStage } from "@/state/host-connection"

/**
 * The host's link lost for longer than a moment, as T3 Code's connection notice says it: one notice, one action. At
 * first (`long`) Mako is still trying by itself, and Try now asks the client to reconnect at once, never a reload.
 * Past `RESTART_AFTER_MS`, or once the client found no host to reach, trying again won't do: Restart Mako.
 * Until `RECONNECT_QUIET_MS` the title bar alone says "Reconnecting…" (`ConnectionPill`), and the two are never shown at
 * once. The transport's own words stay out of it; the host's log keeps them.
 */
export function HostConnectionNotice() {
  const stage = useReconnectStage()
  // Try now waits on the try it ran, or the one under way: pressing again then would do nothing, so it says so.
  const [trying, setTrying] = useState(false)
  const tryNow = () => {
    setTrying(true)
    void reconnectHostNow().finally(() => setTrying(false))
  }
  if (stage === "long")
    return (
      <Notice
        role="status"
        tone="progress"
        title="Reconnecting to Mako…"
        description="Mako keeps trying by itself and catches this window up once it's back. You're seeing the last known state; your drafts are saved."
        actions={<NoticeAction onClick={tryNow} disabled={trying}>{trying ? "Trying…" : "Try now"}</NoticeAction>}
        className="mx-3 my-2"
      />
    )
  if (stage === "restart")
    return (
      <Notice
        role="status"
        tone="caution"
        title="Mako isn't answering"
        description="Trying again hasn't brought it back. Restarting Mako saves your drafts and opens this window again."
        actions={<NoticeAction onClick={restartMako}>Restart Mako</NoticeAction>}
        className="mx-3 my-2"
      />
    )
  return null
}
