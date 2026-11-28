import type { ComponentProps, ReactNode, RefObject } from "react"
import { ChevronDownIcon, SearchIcon } from "lucide-react"
import { Collapse } from "@/components/ui/collapse"
import { Keys } from "@/components/ui/kit"
import { cn } from "@/lib/utils"

/*
 * The list pages' one grammar (the Inbox, Automations, pull requests): a page whose title, summary and toolbar sit in
 * the content's own centred column and stay as it scrolls; sections under a quiet header that folds; rows of one
 * height, told apart by a fill (`--fill-hover` under the pointer, `--fill-selected` for the keyboard's row) and never
 * a box. Optional cells hide by the list's own width (`@container/list`), not the window's. `useListKeys` gives every
 * page the same keys.
 */

/** A row's title, its quiet facts, and its age at the end: the three text cells every row is built from. */
export const ROW_TITLE = "min-w-0 truncate text-ui text-foreground"
export const ROW_META = "min-w-0 truncate text-label text-faint"
export const ROW_AGE = "tabular w-10 shrink-0 text-right text-label text-faint"

/** The page: a scroller whose column holds the sticky header (title, summary, toolbar) and the list under it. */
export function ListPage({
  title,
  summary,
  summaryTone = "faint",
  actions,
  toolbar,
  scrollRef,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode
  summary?: ReactNode
  summaryTone?: "faint" | "attention"
  /** Beside the title, at the column's right edge: New, a menu. */
  actions?: ReactNode
  /** Under the summary: view chips and search (`ListToolbar`). */
  toolbar?: ReactNode
  scrollRef?: RefObject<HTMLDivElement | null>
}) {
  return (
    <div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)} {...props}>
      <div className="@container/list mx-auto flex w-full max-w-[760px] flex-col px-6 pb-16">
        <header data-list-header className="sticky top-0 z-10 flex flex-col bg-surface pt-4 pb-1">
          <div className="flex min-h-8 items-center gap-3 px-2">
            <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">{title}</h1>
            {actions}
          </div>
          {summary ? (
            <p data-list-summary className={cn("px-2 text-label", summaryTone === "attention" ? "text-attention" : "text-faint")}>
              {summary}
            </p>
          ) : null}
          {toolbar}
        </header>
        {children}
      </div>
    </div>
  )
}

/** The row under the title: view chips on the left, search and the page's controls on the right. */
export function ListToolbar({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div data-list-toolbar className={cn("flex min-h-11 items-center gap-1", className)} {...props}>
      {children}
    </div>
  )
}

export interface ListView<V extends string> {
  value: V
  label: string
  count?: number
  /** A count in the attention hue: what waits on the person. */
  attention?: boolean
}

/** A page's views as chips; number keys 1–9 pick them (`useListKeys`'s `views`). The chosen one is a fill, not a box. */
export function ViewChips<V extends string>({ views, value, onChange, label = "Show" }: { views: readonly ListView<V>[]; value: V; onChange: (value: V) => void; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {views.map((view, index) => (
        <button
          key={view.value}
          type="button"
          role="tab"
          data-list-view={view.value}
          aria-selected={view.value === value}
          title={index < 9 ? `${view.label} (${index + 1})` : view.label}
          onClick={() => onChange(view.value)}
          className={cn(
            "pressable flex h-7 shrink-0 items-center gap-1.5 px-2 text-label font-medium transition-colors duration-100",
            view.value === value ? "bg-fill-selected text-foreground" : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
          )}
        >
          {view.label}
          {view.count ? <span className={cn("tabular font-normal", view.attention ? "text-attention" : "text-faint")}>{view.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** The page's search: a quiet field, filled only under the pointer or while typing; `/` reaches it. */
export function ListSearch({ ref, className, ...props }: ComponentProps<"input">) {
  return (
    <label className={cn("ml-auto flex h-7 w-52 min-w-0 items-center gap-1.5 px-2 text-faint transition-colors duration-100 hover:bg-fill-hover focus-within:bg-fill-hover", className)}>
      <SearchIcon aria-hidden className="size-3.5 shrink-0" />
      <input ref={ref} type="text" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-label text-foreground placeholder:text-faint focus:outline-none" {...props} />
      <Keys keys={["/"]} />
    </label>
  )
}

/**
 * A section: its header (the label, a count, an action at the end) and its rows. With `onFold` the header folds it,
 * the chevron turned when closed; folded rows leave the keyboard's walk.
 */
export function ListSection({
  label,
  count,
  attention,
  folded = false,
  onFold,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "onToggle"> & {
  label: string
  count?: number
  attention?: boolean
  folded?: boolean
  onFold?: () => void
  action?: ReactNode
}) {
  const heading = (
    <>
      {onFold ? <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0 text-faint transition-transform duration-150", folded && "-rotate-90")} /> : null}
      <span className="truncate">{label}</span>
      {count !== undefined ? <span className={cn("tabular font-normal", attention ? "text-attention" : "text-faint")}>{count}</span> : null}
    </>
  )
  return (
    <section aria-label={label} data-list-section={label} data-folded={folded || undefined} className={cn("flex flex-col pt-3 first:pt-1", className)} {...props}>
      <h2 className="group/heading flex h-8 items-center gap-1.5 text-label font-medium text-muted-foreground">
        {onFold ? (
          <button type="button" aria-expanded={!folded} onClick={onFold} className="pressable flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left hover:text-foreground">
            {heading}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2">{heading}</span>
        )}
        {action}
      </h2>
      {onFold ? <Collapse open={!folded}>{children}</Collapse> : children}
    </section>
  )
}

/**
 * One row: `h-10` by default, its cells in a line; the keyboard's row is filled and holds focus (`useListKeys` moves
 * it), so Enter and the row's own keys reach it. `rowKey` names it for the walk and for the store that keeps it.
 */
export function ListRow({
  rowKey,
  selected,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { rowKey: string; selected: boolean }) {
  return (
    <div
      data-list-row={rowKey}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      tabIndex={selected ? 0 : -1}
      className={cn(
        "group/row relative flex h-10 min-w-0 cursor-default items-center gap-2.5 px-2 outline-none transition-colors duration-100 hover:bg-fill-hover data-[selected]:bg-fill-selected",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/** The row's last cell: its age at rest, its actions in the same place under the pointer or the keyboard, so nothing shifts. */
export function RowEnd({ age, actions, className }: { age: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <span className={cn("relative flex shrink-0 items-center justify-end", className)}>
      <span className={cn("flex items-center justify-end", actions && "group-hover/row:opacity-0 group-data-[selected]/row:opacity-0")}>{age}</span>
      {actions ? (
        <span
          data-row-actions
          onClick={(event) => event.stopPropagation()}
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-data-[selected]/row:pointer-events-auto group-data-[selected]/row:opacity-100"
        >
          {actions}
        </span>
      ) : null}
    </span>
  )
}
