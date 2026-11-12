import { useEffect, type RefObject } from "react"

/** How often the stage's layout is read: a few rects, while the window is in front. */
const CHECK_EVERY_MS = 2_000
/** Off for this long before it's said: a split arriving or a window being resized settles well within it. */
const OFF_FOR_MS = 3_000
/** A composer this far above the bottom of its pane isn't sitting at the bottom. */
const COMPOSER_SLACK = 48
/** Panes this far short of their workbench don't fill it. */
const FILL_SLACK = 24
/** A pane this tall with nothing in it is a blank stretch of the window. */
const EMPTY_TALL = 120

interface PaneReading {
  id: string | undefined
  width: number
  height: number
  tabs: number
  shows: "chat" | "document" | "notice" | "nothing"
  transcript: boolean
  composer: boolean
  /** How far its composer's bottom sits above the pane's, when it holds the composer. */
  composerGap?: number
  empty: boolean
}

interface LayoutReading {
  window: { width: number; height: number }
  workbench: { width: number; height: number }
  split: "right" | "down"
  dock: number
  panes: PaneReading[]
  why: string[]
}

/**
 * What the stage holds as it's laid out: its workbench, each pane's size and what it shows (never its words), and
 * why it's off, when it is: panes that don't fill the workbench, a composer above the bottom of its pane, or a pane
 * with nothing in it.
 */
export function readStageLayout(stage: HTMLElement): LayoutReading | undefined {
  const workbench = stage.querySelector<HTMLElement>("[data-workbench]")
  if (!workbench) return undefined
  const box = workbench.getBoundingClientRect()
  const panes = [...workbench.querySelectorAll<HTMLElement>(".workbench-pane")]
  const rects = panes.map((pane) => pane.getBoundingClientRect())
  const split = rects.length > 1 && Math.abs(rects[0]!.top - rects[1]!.top) > 1 ? "down" : "right"
  const readings = panes.map((pane, index): PaneReading => {
    const rect = rects[index]!
    const strip = pane.querySelector<HTMLElement>(":scope > :first-child")
    const body = [...pane.children].filter((child) => child !== strip && child.getBoundingClientRect().height > 0)
    const transcript = Boolean(pane.querySelector("[data-transcript-viewport]"))
    const composer = pane.querySelector<HTMLElement>("[data-composer]")
    const notice = Boolean(pane.querySelector("[data-pane-notice], [data-pane-empty]"))
    const document = Boolean(pane.querySelector("[data-document-view], iframe, img, canvas, video, pre, code"))
    const filled = body.some((child) => child instanceof HTMLElement && child.innerText.trim() !== "") || document
    const bodyHeight = rect.bottom - (strip?.getBoundingClientRect().bottom ?? rect.top)
    return {
      id: pane.dataset.paneId,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      tabs: strip?.querySelectorAll('[role="tab"]').length ?? 0,
      shows: transcript || composer ? "chat" : notice ? "notice" : document ? "document" : "nothing",
      transcript,
      composer: Boolean(composer),
      ...(composer && { composerGap: Math.round(rect.bottom - composer.getBoundingClientRect().bottom) }),
      empty: !filled && bodyHeight > EMPTY_TALL,
    }
  })
  const reach = split === "down" ? Math.max(...rects.map((rect) => rect.bottom)) - box.top : Math.max(...rects.map((rect) => rect.right)) - box.left
  const span = split === "down" ? box.height : box.width
  const why: string[] = []
  if (rects.length && reach < span - FILL_SLACK) why.push("panes don't fill the workbench")
  for (const pane of readings) {
    if (pane.composerGap !== undefined && pane.composerGap > COMPOSER_SLACK) why.push(`a composer sits ${pane.composerGap}px above its pane's bottom`)
    if (pane.empty) why.push("a pane shows nothing")
  }
  const dock = stage.querySelector<HTMLElement>(".terminal-panel")
  return {
    window: { width: innerWidth, height: innerHeight },
    workbench: { width: Math.round(box.width), height: Math.round(box.height) },
    split,
    dock: Math.round(dock?.getBoundingClientRect().height ?? 0),
    panes: readings,
    why,
  }
}

/**
 * The desk says when its stage is laid out wrong, so the next time it happens there's evidence without anyone
 * catching it: a layout off for `OFF_FOR_MS` is logged once (`Stage layout off`, which the window's warnings carry to
 * the host's log, `renderer-health`) with the window's size, the workbench's, the dock's, and each pane's size and
 * what it shows, and said again only once the layout changes. A person saw the transcript squeezed into the top of
 * the window above blank space on 2026-11-11, and nothing recorded why.
 */
export function useStageLayoutWatch(stage: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let since: number | undefined
    let said = ""
    const check = () => {
      const node = stage.current
      const reading = node && document.visibilityState === "visible" ? readStageLayout(node) : undefined
      if (!reading?.why.length) {
        since = undefined
        return
      }
      const now = performance.now()
      since ??= now
      if (now - since < OFF_FOR_MS) return
      const key = JSON.stringify([reading.why, reading.window, reading.panes.map((pane) => [pane.shows, pane.height, pane.width])])
      if (key === said) return
      said = key
      console.warn(`Stage layout off ${JSON.stringify(reading)}`)
    }
    const timer = setInterval(check, CHECK_EVERY_MS)
    return () => clearInterval(timer)
  }, [stage])
}
