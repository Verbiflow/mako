import { useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react"
import { TabBarFitContext, TabWordsContext, useTabBarFit, useTabFit, useTabWords } from "@/components/stage/side-tab-fit"
import { cn } from "@/lib/utils"

/**
 * One tab of the right panel's bar: its word and, where it asks for the eye, a small reading after it. Active sits on
 * the raised surface; the rest are muted with a hover fill. No icons: the words are short and the bar is one line.
 * The desktop's panel and the browser's (`web-client/side-rail.tsx`) draw the same tab. What a reading stands for is
 * in the tab's name and, once the bar has had to shorten it, its tooltip.
 */
export function SideTab({ label, active, reading, touch = false, className, ...rest }: Omit<ComponentProps<"button">, "children"> & {
  label: string
  active: boolean
  reading?: ReactNode
  /** A tablet's or phone's sheet: the same tab at a finger's height. */
  touch?: boolean
}) {
  const { fit, changed } = useContext(TabBarFitContext)
  const [words, setWords] = useState<string>()
  // A label or a reading's words changing is what can change the bar's widths; the bar's own fit changing is not.
  useLayoutEffect(() => changed(), [changed, label, words])
  const named = words ? `${label}, ${words}` : label
  return (
    <button
      type="button"
      role="tab"
      aria-label={named}
      title={words && fit !== "words" ? named : undefined}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-open={active || undefined}
      data-fit={fit}
      className={cn(
        "pressable flex shrink-0 items-center gap-1.5 text-ui whitespace-nowrap transition-colors duration-100",
        touch ? "h-10" : "h-7",
        fit === "tight" ? "px-1.5" : "px-2.5",
        active ? "bg-raised text-foreground" : "text-muted-foreground hover:bg-fill-hover hover:text-foreground",
        className
      )}
      {...rest}
    >
      {label}
      {/* Kept mounted whatever the fit, so a reading's words stay in the tab's name while it shows none of them. */}
      {reading ? <TabWordsContext.Provider value={setWords}><span className={fit === "bare" || fit === "tight" ? "hidden" : "contents"}>{reading}</span></TabWordsContext.Provider> : null}
    </button>
  )
}

/**
 * A tab's reading, as the bar has room for it: its words, then only its count (in the same hue), then nothing. The words
 * go to the tab's name and tooltip whichever is shown.
 */
export function TabReading({ words, count, attention = false, title }: {
  words: string
  /** What it shortens to when the bar is tight; left out, it goes with the words. */
  count?: string
  attention?: boolean
  title?: string
}) {
  const fit = useTabFit()
  useTabWords(words)
  const shown = fit === "words" ? words : fit === "count" ? count : undefined
  if (!shown) return null
  return (
    <span data-tab-reading={fit} title={title} className={cn("tabular shrink-0 text-label", attention ? "font-medium text-attention" : "text-faint")}>
      {shown}
    </span>
  )
}

/**
 * The bar the tabs sit in: 40px, one line, never scrolling or clipping. As its real width runs out the readings say
 * less (`useTabBarFit`): their words, a count, nothing, then tighter tabs.
 */
export function SideTabs({ label, touch = false, children }: { label: string; touch?: boolean; children: ReactNode }) {
  const bar = useRef<HTMLElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const { fit, changed } = useTabBarFit(bar, row)
  const value = useMemo(() => ({ fit, changed }), [fit, changed])
  return (
    <nav
      ref={bar}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      data-side-rail
      data-fit={fit}
      className={cn("flex shrink-0 items-center overflow-hidden px-2", touch ? "h-12" : "h-10")}
      onKeyDown={moveInTabs}
    >
      <div ref={row} className="flex w-max shrink-0 items-center gap-0.5">
        <TabBarFitContext.Provider value={value}>{children}</TabBarFitContext.Provider>
      </div>
    </nav>
  )
}

const KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"]

/** Arrows along the tabs: each opens what it opens, and focus goes with it (the ARIA tabs pattern, automatic activation). */
function moveInTabs(event: KeyboardEvent<HTMLElement>): void {
  if (!KEYS.includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")]
  const index = tabs.findIndex((tab) => tab === event.target)
  if (index < 0) return
  event.preventDefault()
  const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
  if (!next) return
  next.click()
  next.focus()
}
