import type { StoreStandingRow } from "@mako/host/contracts/store-formats"
import { storeLine } from "@/lib/store-formats"
import { cn } from "@/lib/utils"
import { useUpdateMakoAction } from "./use-update-mako"

/**
 * One quiet line for a shared store a newer Mako changed, with Update
 * (`update` false in a list whose first line already offers it). It
 * never blocks: the rail and Diagnostics go on below it, and nothing about
 * it is red, because nothing is lost.
 */
export function StoreFormatLine({ row, className, update = true }: { row: StoreStandingRow; className?: string; update?: boolean }) {
  const line = storeLine(row)
  if (!line) return null
  return (
    <div data-store-format={row.store} data-store-access={row.access} className={cn("flex items-start gap-2 text-label leading-relaxed text-muted-foreground", className)}>
      <p className="min-w-0 flex-1">{line}</p>
      {update ? <UpdateMako /> : null}
    </div>
  )
}

/**
 * Mako's own update, as Settings › Updates runs it: install one that's
 * ready, check for one on a release build, and otherwise open Updates,
 * where a local or development build says how it updates.
 */
export function UpdateMako() {
  const { label, disabled: busy, onClick: act } = useUpdateMakoAction()
  return (
    <button
      type="button"
      data-update-mako=""
      disabled={busy}
      onClick={act}
      className="pressable -my-0.5 h-5 shrink-0 rounded px-1.5 text-label font-medium text-foreground/80 hover:bg-fill-hover hover:text-foreground disabled:opacity-50"
    >
      {label}
    </button>
  )
}
