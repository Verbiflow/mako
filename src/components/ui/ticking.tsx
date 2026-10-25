import { useEffect, useLayoutEffect, useRef } from "react"
import { cn } from "@/lib/utils"

const ticks = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** One interval for every clock on screen, so they tick together and cost one timer. */
function everySecond(tick: () => void): () => void {
  ticks.add(tick)
  timer ??= setInterval(() => {
    for (const each of ticks) each()
  }, 1_000)
  return () => {
    ticks.delete(tick)
    if (ticks.size > 0 || timer === undefined) return
    clearInterval(timer)
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
