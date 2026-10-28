import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideProps,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useRegistry } from "@/extend/registry"
import { noticeProducers, orderNotices, type ComposerNotice, type ComposerNoticeProps, type ComposerNoticeTone, type NoticeProducer, type NoticeRegistration } from "@/extend/notices"
import { cn } from "@/lib/utils"

const GLYPHS = {
  progress: { icon: Spinner, className: "text-muted-foreground" },
  info: { icon: InfoIcon, className: "text-muted-foreground" },
  success: { icon: CircleCheckIcon, className: "text-positive" },
  caution: { icon: TriangleAlertIcon, className: "text-caution" },
  danger: { icon: OctagonXIcon, className: "text-negative" },
} satisfies Record<ComposerNoticeTone, { icon: ComponentType<LucideProps>; className: string }>

/** The lip of the notice behind the front one, in that notice's tone. */
const LIPS = {
  danger: "bg-negative/30",
  caution: "bg-caution/30",
  progress: "bg-foreground/15",
  info: "bg-foreground/15",
  success: "bg-positive/25",
} satisfies Record<ComposerNoticeTone, string>

interface Entry {
  notice: ComposerNotice
  order: number
}

/**
 * What each producer answers now, by its id. Producers write here from a
 * layout effect, before paint, so a notice and the line it changes arrive in
 * the same frame; the stack reads it whole.
 */
class NoticeBoard {
  private entries = new Map<string, Entry>()
  private snapshot: Entry[] = []
  private listeners = new Set<() => void>()

  set(id: string, entry: Entry | null): void {
    if (entry) this.entries.set(id, entry)
    else if (!this.entries.delete(id)) return
    this.snapshot = [...this.entries.values()]
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  read = () => this.snapshot
}

/**
 * The notices above the composer, one line at a time.
 *
 * Every condition worth saying before a send (a harness too old, an account
 * signed out, a message that failed out of sight) is one item from a
 * registered producer (`registerNotice`). Only the most urgent is drawn; the
 * next one's tone shows as a lip behind it, and hovering or focusing the
 * stack, or its "more" count, opens the rest above it over the transcript, so
 * the composer never grows by more than one line. Escape folds them again.
 * A line too long for the width, or one with more to say, opens its whole
 * text from the line's info button.
 */
export function ComposerNotices({ meta, draftKey }: ComposerNoticeProps) {
  const registry = useRegistry(noticeProducers)
  const [board] = useState(() => new NoticeBoard())
  const entries = useSyncExternalStore(board.subscribe, board.read, board.read)
  const ordered = useMemo(() => orderNotices(entries), [entries])
  return (
    <>
      {registry.list().map((registration) => (
        <NoticeSource key={registration.id} registration={registration} meta={meta} draftKey={draftKey} board={board} />
      ))}
      {ordered.length ? <NoticeStack entries={ordered} /> : null}
    </>
  )
}

/**
 * One producer's notice drawn as the stack draws it, alone: for a page or a
 * check that shows a single notice outside the composer.
 */
export function ProducedNotice({ use, meta, draftKey = "" }: { use: NoticeProducer; meta?: ComposerNoticeProps["meta"]; draftKey?: string }) {
  const notice = use({ meta, draftKey })
  return notice ? <NoticeStack entries={[{ notice, order: 0 }]} /> : null
}

const NoticeSource = memo(function NoticeSource({
  registration,
  meta,
  draftKey,
  board,
}: ComposerNoticeProps & { registration: NoticeRegistration; board: NoticeBoard }) {
  const notice = registration.use({ meta, draftKey })
  useLayoutEffect(() => {
    board.set(registration.id, notice ? { notice, order: registration.order } : null)
  }, [board, registration, notice])
  useLayoutEffect(() => () => board.set(registration.id, null), [board, registration.id])
  return null
})

/** How long the pointer may leave the stack before it folds; crossing the gap to the open list keeps it open. */
const FOLD_DELAY_MS = 160

function NoticeStack({ entries }: { entries: readonly Entry[] }) {
  const [open, setOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const fold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  const shown = entries.filter((entry) => !leaving.has(entry.notice.id) || entries.length === 1)
  const front = shown[0] ?? entries[0]!
  const rest = entries.filter((entry) => entry !== front)
  const next = rest.find((entry) => !leaving.has(entry.notice.id))
  const expanded = (open || detailOpen !== null) && rest.length > 0
  // The stack arrives whole, its bar and words together; only a later front fades its words in, in a bar already there.
  const [arrival] = useState(front.notice.id)

  useEffect(() => () => clearTimeout(fold.current), [])
  // A notice that went away on its own takes its open detail with it.
  if (detailOpen && !entries.some((entry) => entry.notice.id === detailOpen)) setDetailOpen(null)

  const dismiss = useCallback((notice: ComposerNotice) => {
    if (!notice.onDismiss) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      notice.onDismiss()
      return
    }
    setLeaving((current) => new Set(current).add(notice.id))
  }, [])
  const left = useCallback((notice: ComposerNotice) => {
    notice.onDismiss?.()
    setLeaving((current) => {
      const nextSet = new Set(current)
      nextSet.delete(notice.id)
      return nextSet
    })
  }, [])

  const row = (entry: Entry, place: "front" | "list") => (
    <NoticeRow
      key={entry.notice.id}
      notice={entry.notice}
      place={place}
      replacing={place === "front" && entry.notice.id !== arrival}
      leaving={leaving.has(entry.notice.id)}
      more={place === "front" && !expanded ? rest.length : 0}
      onMore={() => setOpen(true)}
      detailOpen={detailOpen === entry.notice.id}
      onDetail={(value) => setDetailOpen(value ? entry.notice.id : null)}
      onDismiss={dismiss}
      onLeft={left}
    />
  )

  return (
    <div
      ref={root}
      role="region"
      aria-label="Notices"
      data-composer-notices={entries.length}
      data-expanded={expanded || undefined}
      className="relative shrink-0 px-2 pt-2"
      onPointerEnter={() => {
        clearTimeout(fold.current)
        setOpen(true)
      }}
      onPointerLeave={() => {
        clearTimeout(fold.current)
        fold.current = setTimeout(() => setOpen(false), FOLD_DELAY_MS)
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return
        event.stopPropagation()
        setOpen(false)
        setDetailOpen(null)
      }}
    >
      {rest.length ? (
        <div
          inert={!expanded}
          data-notice-list
          className={cn(
            "overlay-panel absolute inset-x-2 bottom-full z-20 mb-1 flex flex-col-reverse gap-px p-1",
            "transition-[opacity,translate] duration-150 ease-[var(--ease-out)] motion-reduce:transition-none",
            expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
          )}
        >
          {rest.map((entry) => row(entry, "list"))}
        </div>
      ) : null}
      {next && !expanded ? (
        <span
          aria-hidden
          data-notice-peek={next.notice.tone}
          className={cn("absolute inset-x-5 top-[3px] h-3 rounded-t-md transition-colors duration-150", LIPS[next.notice.tone])}
        />
      ) : null}
      <div className={cn("relative rounded-lg bg-raised [box-shadow:inset_0_0_0_0.5px_var(--hairline)]", ARRIVE)}>
        {row(front, "front")}
      </div>
    </div>
  )
}

/** How a notice comes in: up from the composer as it fades in. */
const ARRIVE = "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-[var(--ease-out)]"

function NoticeRow({
  notice,
  place,
  replacing,
  leaving,
  more,
  onMore,
  detailOpen,
  onDetail,
  onDismiss,
  onLeft,
}: {
  notice: ComposerNotice
  place: "front" | "list"
  /** The front notice that took another's place, in a bar already drawn. */
  replacing: boolean
  leaving: boolean
  more: number
  onMore(): void
  detailOpen: boolean
  onDetail(open: boolean): void
  onDismiss(notice: ComposerNotice): void
  onLeft(notice: ComposerNotice): void
}) {
  const line = useRef<HTMLParagraphElement>(null)
  const words = notice.description ? `${notice.title} · ${notice.description}` : notice.title
  const clipped = useClipped(line, words)
  const glyph = GLYPHS[notice.tone]
  const Glyph = glyph.icon
  return (
    <div
      role={place === "front" ? "status" : undefined}
      data-notice-row={notice.id}
      data-notice-tone={notice.tone}
      data-notice-place={place}
      {...notice.data}
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget && event.propertyName === "opacity") onLeft(notice)
      }}
      className={cn(
        "flex min-h-9 min-w-0 items-center gap-2 rounded-md py-1 pr-1 pl-2.5 text-ui",
        "transition-[opacity,translate] duration-200 ease-[var(--ease-swift)]",
        replacing && ARRIVE,
        leaving && "-translate-y-1 opacity-0"
      )}
    >
      <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5", !notice.icon && glyph.className)}>
        {notice.icon ?? <Glyph />}
      </span>
      <p ref={line} className="min-w-0 flex-1 truncate" title={clipped ? undefined : words}>
        <span className="text-foreground">{notice.title}</span>
        {notice.description ? <span className="text-muted-foreground"> · {notice.description}</span> : null}
      </p>
      {more ? (
        <button
          type="button"
          onClick={onMore}
          className="pressable shrink-0 rounded px-1 text-label text-faint hover:text-foreground"
        >
          {more} more
        </button>
      ) : null}
      {notice.actions?.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={action.disabled}
          title={action.title}
          onClick={action.onClick}
          className={cn(
            "pressable h-6 shrink-0 rounded-md px-2 text-label transition-colors duration-100 disabled:opacity-45",
            action.primary
              ? "bg-fill-selected font-medium text-foreground hover:bg-foreground/15"
              : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
          )}
        >
          {action.label}
        </button>
      ))}
      {clipped || notice.detail ? (
        <NoticeDetail notice={notice} open={detailOpen} onOpenChange={onDetail} />
      ) : null}
      {notice.onDismiss ? (
        <button
          type="button"
          aria-label={notice.dismissLabel ?? "Dismiss"}
          title={notice.dismissLabel ?? "Dismiss"}
          onClick={() => onDismiss(notice)}
          className="pressable grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/** The whole of a notice: its line unclipped, and whatever it keeps for later. */
function NoticeDetail({ notice, open, onOpenChange }: { notice: ComposerNotice; open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More about this"
          title="More about this"
          className="pressable grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-96 max-w-[calc(100vw-2rem)] gap-1.5 p-3 text-ui">
        <p className="text-ui text-foreground">{notice.title}</p>
        {notice.description ? <p className="text-label leading-relaxed text-muted-foreground">{sentence(notice.description)}</p> : null}
        {notice.detail ? <NoticeBody>{notice.detail}</NoticeBody> : null}
      </PopoverContent>
    </Popover>
  )
}

/** The line's continuation, said on its own: a capital to start it. */
function sentence(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function NoticeBody({ children }: { children: ReactNode }) {
  return <div className="max-h-72 overflow-y-auto pt-1 text-label leading-relaxed text-muted-foreground">{children}</div>
}

/** Whether the line is cut at its end, measured when its words change and as the pane resizes. */
function useClipped(line: RefObject<HTMLElement | null>, words: string): boolean {
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const node = line.current
    if (!node) return
    // Observing reports the first size at once, so a change of words is measured too.
    const observer = new ResizeObserver(() => setClipped(node.scrollWidth > node.clientWidth + 1))
    observer.observe(node)
    return () => observer.disconnect()
  }, [line, words])
  return clipped
}
