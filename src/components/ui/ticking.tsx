import { useEffect, useLayoutEffect, useRef } from "react"
import { everyWhileShown } from "@/lib/window-shown"
import { cn } from "@/lib/utils"

const ticks = new Set<() => void>()
let timer: (() => void) | undefined

/** One interval for every clock on screen, so they tick together and cost one timer, and none while the window is hidden. */
function everySecond(tick: () => void): () => void {
  ticks.add(tick)
  timer ??= everyWhileShown(1_000, () => {
    for (const each of ticks) each()
  })
  return () => {
    ticks.delete(tick)
    if (ticks.size > 0 || timer === undefined) return
    timer()
    timer = undefined
  }
}

/**
 * Words that change every second without rendering anything: a turn's
 * "Working for 1m 12s", a retry's countdown. React draws the span once and
 * the shared tick writes its text, so a running clock never wakes the
 * transcript; the span is React's only as an empty element, which keeps a
 * render from ever meeting text it didn't write.
 */
export function Ticking({ words, className }: { words: (now: number) => string; className?: string }) {
  const node = useRef<HTMLSpanElement>(null)
  const latest = useRef(words)
  useLayoutEffect(() => {
    latest.current = words
    if (node.current) node.current.textContent = words(Date.now())
  })
  useEffect(
    () =>
      everySecond(() => {
        if (node.current) node.current.textContent = latest.current(Date.now())
      }),
    []
  )
  return <span ref={node} className={cn("tabular", className)} />
}
