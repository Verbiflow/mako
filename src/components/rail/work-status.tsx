import type { WorkStatus } from "@mako/host/contracts/thread-marks"
import { cn } from "@/lib/utils"

/**
 * Where a Thread's work stands, as Linear draws it: a dashed circle for Backlog, a circle filling as it goes for In
 * progress and In review, a filled check for Done. In the text's faint tone: how far along, never a hue.
 */
export function WorkGlyph({ status, className }: { status: WorkStatus; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" data-work-status={status} className={cn("size-3 shrink-0", status === "done" ? "text-muted-foreground" : "text-faint", className)} aria-hidden>
      {status === "backlog" ? <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2.12" /> : null}
      {status === "in-progress" || status === "in-review" ? (
        <>
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={status === "in-progress" ? "M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" : "M7 3.5 A3.5 3.5 0 1 1 3.5 7 L7 7 Z"} fill="currentColor" />
        </>
      ) : null}
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="var(--shell)" strokeWidth="1.6" strokeLinecap="square" />
        </>
      ) : null}
    </svg>
  )
}

/** A row's ⌘N while ⌘ is held, where its time was: the first nine rows open with ⌘1–9. Its digit is set by the rail. */
export function JumpCap() {
  return <span data-jump-cap aria-hidden className="tabular hidden h-[18px] min-w-[26px] shrink-0 items-center justify-center bg-fill-selected px-1 text-label text-muted-foreground" />
}
