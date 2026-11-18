import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"
import { onWindowShown, windowShown } from "@/lib/window-shown"
import { drawUndrawn } from "@/state/live-recovery"

/** What following needs of the bridge; a bridge from before `windowShown` (the web's, an older preload) has none. */
export type WindowShownBridge = Partial<Pick<MakoBridge, "windowShown">>

/** The follower: `renewed` when the window's stream was opened anew, `stop` when the window is done with it. */
export interface WindowShownFollower {
  renewed(): void
  stop(): void
}

/**
 * Keeps a hidden window cheap and a shown one current. Hidden, the host is told, so it sends this window nothing that
 * exists only to be painted (`live-ahead`); the batches still land and are kept, undrawn (`applyBatch`). Shown again,
 * the host is told first and the conversation on screen is drawn once from everything it took in (`drawUndrawn`).
 *
 * A stream starts out shown, so a reconnect while hidden says hidden again (`renewed`, which whoever hears the host's
 * events calls: the bridge's events have one reader), and nothing is said to a host that was never told otherwise. A
 * host from before the call refuses it, which is ignored: it goes on sending everything, and this window goes on
 * skipping what it doesn't draw.
 */
export function followWindowShown(bridge: WindowShownBridge): WindowShownFollower {
  let told = true
  const tell = () => {
    const shown = windowShown()
    if (shown === told || !bridge.windowShown) return
    told = shown
    void bridge.windowShown(shown).catch(() => undefined)
  }
  const unheard = onWindowShown((shown) => {
    tell()
    if (shown) drawUndrawn()
  })
  tell()
  return {
    renewed: () => {
      told = true
      tell()
    },
    stop: unheard,
  }
}
