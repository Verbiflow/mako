import { useState, type ReactNode } from "react"
import {
  ChevronRightIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { Collapse } from "@/components/ui/collapse"
import { cn } from "@/lib/utils"

export type NoticeTone = "progress" | "info" | "success" | "caution" | "danger"

const GLYPHS = {
  progress: { icon: Loader2Icon, className: "animate-spin text-muted-foreground" },
  info: { icon: InfoIcon, className: "text-muted-foreground" },
  success: { icon: CircleCheckIcon, className: "text-positive" },
  caution: { icon: TriangleAlertIcon, className: "text-caution" },
  danger: { icon: OctagonXIcon, className: "text-destructive" },
} satisfies Record<NoticeTone, { icon: LucideIcon; className: string }>

interface NoticeProps {
  tone?: NoticeTone
  title: ReactNode
  description?: ReactNode
  /** Buttons under the text; use `NoticeAction`. */
  actions?: ReactNode
  /** Always shown under the actions. */
  children?: ReactNode
  /** Folded detail behind a disclosure in the title row. */
  details?: ReactNode
  detailsOpen?: boolean
  /** Small icon controls at the end of the title row. */
  trailing?: ReactNode
  onDismiss?(): void
  dismissLabel?: string
  /**
   * `card` stands alone above a pane's edge; `flush` sits among the rows of
   * a menu or popover, which already draws the surface.
   */
  surface?: "card" | "flush"
  role?: "status" | "alert"
  label?: string
  className?: string
  [data: `data-${string}`]: string | boolean | undefined
}

/**
 * One in-place notice: the same glyphs and surface as the app's toasts, for
 * the things that stay until they are dealt with. It enters like an overlay
 * and its details open in place rather than jumping.
 */
export function Notice({
  tone = "info",
  title,
  description,
  actions,
  children,
  details,
  detailsOpen = false,
  trailing,
  onDismiss,
  dismissLabel = "Dismiss",
  surface = "card",
  role = "status",
  label,
  className,
  ...data
}: NoticeProps) {
  const [open, setOpen] = useState(detailsOpen)
  const [openedFor, setOpenedFor] = useState(detailsOpen)
  if (detailsOpen !== openedFor) {
    setOpenedFor(detailsOpen)
    if (detailsOpen) setOpen(true)
  }
  const glyph = GLYPHS[tone]
  const Icon = glyph.icon
  return (
    <section
      role={role}
      aria-label={label}
      data-notice={tone}
      {...data}
      className={cn(
        "shrink-0 text-ui text-foreground",
        surface === "card"
          ? "rounded-[10px] bg-popover [box-shadow:inset_0_0_0_0.5px_var(--hairline)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-[var(--ease-out)]"
          : "rounded-md",
        className
      )}
    >
      <div className={cn("flex items-start gap-2.5", surface === "card" ? "px-3 py-2.5" : "px-2 py-2")}>
        <Icon aria-hidden className={cn("mt-[3px] size-3.5 shrink-0", glyph.className)} />
        <div className="min-w-0 flex-1">
          <p className="text-ui leading-5 text-foreground">{title}</p>
          {description ? (
            <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
          {actions ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div> : null}
          {children ? <div className="mt-2 text-label text-muted-foreground">{children}</div> : null}
        </div>
        {details ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="pressable -my-0.5 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            Details
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-200 ease-[var(--ease-out)]",
                open && "rotate-90"
              )}
            />
          </button>
        ) : null}
        {trailing ? <div className="-my-0.5 flex shrink-0 items-center gap-0.5">{trailing}</div> : null}
        {onDismiss ? (
          <button
            type="button"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={onDismiss}
            className="pressable -my-0.5 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      {details ? (
        <Collapse open={open}>
          <div
            className={cn(
              "max-h-56 overflow-y-auto pb-2.5 text-label leading-relaxed text-muted-foreground",
              surface === "card" ? "pr-3 pl-9" : "pr-2 pl-8"
            )}
          >
            {details}
          </div>
        </Collapse>
      ) : null}
    </section>
  )
}

export function NoticeAction({
  children,
  onClick,
  disabled,
  quiet = false,
  expanded,
}: {
  children: ReactNode
  onClick(): void
  disabled?: boolean
  /** A secondary action: text only, beside the primary one. */
  quiet?: boolean
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "pressable h-6 rounded-md px-2 text-label transition-colors duration-100 disabled:opacity-45",
        quiet
          ? "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
          : "bg-fill-hover text-foreground hover:bg-fill-selected"
      )}
    >
      {children}
    </button>
  )
}

/**
 * A line of text that opens what it summarises in place. The chevron turns
 * as the body grows, and the body stays mounted after the first open so a
 * second open is instant.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  tone,
  className,
  bodyClassName,
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  tone?: "danger" | "caution"
  className?: string
  bodyClassName?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "pressable group/disclosure -mx-1 flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-label transition-colors duration-100",
          tone === "danger"
            ? "text-destructive/90 hover:text-destructive"
            : tone === "caution"
              ? "text-caution/90 hover:text-caution"
              : "text-muted-foreground hover:text-foreground"
        )}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 opacity-60 transition-[transform,opacity] duration-200 ease-[var(--ease-out)] group-hover/disclosure:opacity-100",
            open && "rotate-90"
          )}
        />
      </button>
      <Collapse open={open}>
        <div className={cn("pt-1.5", bodyClassName)}>{children}</div>
      </Collapse>
    </div>
  )
}
