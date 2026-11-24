import { useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { ComposerPlace } from "@/components/composer/composer-routing"
import { STATUS_COMPACT_LEVELS, useCompactRow } from "@/components/composer/use-compact-row"

/**
 * The composer's geometry, shared by the focused composer and a pane's resting one so they are the same box in every
 * view: a column the transcript's width, centred in its pane; the box (a hairline frame on the pane's surface) with the
 * draft and one control row; the status line under it.
 */
export const COMPOSER_COLUMN = "mx-auto flex min-h-0 w-full max-w-content flex-col"
export const COMPOSER_BOX = "composer-box relative mx-3 flex min-h-0 flex-col bg-surface"
export const COMPOSER_INPUT = "composer-input relative block min-h-12 w-full resize-none overflow-hidden bg-transparent px-4 pt-3.5 pb-1 font-sans text-prose leading-[1.6] placeholder:text-faint focus:outline-none"
export const COMPOSER_CONTROLS = "flex min-h-11 shrink-0 items-center gap-1 pr-2.5 pb-2.5 pl-2"
export const COMPOSER_ROUTING = "composer-routing flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"

/**
 * Under the box, where and how the work runs (`ComposerPlace`), and the context reading at the end, below the send it
 * prices. Quiet text a size down from the controls; each fact is still the control it was. It is drawn even when it
 * has nothing to say, so the composer keeps one height whatever the Thread.
 */
export function ComposerStatus({ place = true, still = false, trailing }: {
  place?: boolean
  /** A pane's resting composer: drawn, not pressed (the press focuses the pane). */
  still?: boolean
  trailing?: ReactNode
}) {
  const row = useRef<HTMLDivElement>(null)
  useCompactRow(row, STATUS_COMPACT_LEVELS)
  return (
    <div data-composer-status className={cn("mx-3 mb-1.5 flex h-8 shrink-0 items-center gap-2 pl-1", still && "[&_button]:pointer-events-none")}>
      <div
        ref={row}
        className="composer-status flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
      >
        {place ? <ComposerPlace /> : null}
      </div>
      {trailing ? <div className="composer-status flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  )
}
