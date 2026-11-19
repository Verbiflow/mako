import { useCallback, useSyncExternalStore } from "react"
import { scrollReaderTo } from "@/lib/reader-scroll"

/**
 * Whether an Apex's Shiver card is on screen. The card registers itself; the
 * dock reads it, so a Fin's ask is drawn in one place. `null` means this
 * Thread has no card mounted, and the dock keeps its own asks.
 */
type Seen = { thread: string; visible: boolean }

let seen: Seen | null = null
const listeners = new Set<() => void>()

function publish(next: Seen | null) {
  if (seen?.thread === next?.thread && seen?.visible === next?.visible) return
  seen = next
  for (const listener of listeners) listener()
}

export function mountShiverCard(thread: string, visible: boolean) {
  publish({ thread, visible })
}

export function unmountShiverCard(thread: string) {
  if (seen?.thread === thread) publish(null)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const absent = () => null

/** `true` in view, `false` mounted but scrolled away, `null` when no card is drawn. */
export function useShiverCardVisible(thread: string | undefined): boolean | null {
  const get = useCallback(() => {
    if (!thread || seen?.thread !== thread) return null
    return seen.visible
  }, [thread])
  return useSyncExternalStore(subscribe, get, absent)
}

/** Bring the card's Needs you group back into the transcript. */
export function scrollShiverNeedsIntoView() {
  const card = document.querySelector("[data-shiver]")
  if (!card) return
  const scroller = card.querySelector<HTMLElement>("[data-shiver-scroller]")
  if (scroller) scroller.scrollTop = 0
  scrollReaderTo(card, { block: "start" })
}
