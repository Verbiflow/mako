import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { fuzzy } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"

export interface SearchSelectOption {
  value: string
  label: string
  detail?: string
  keywords?: string
  icon?: ReactNode
}

export function SearchSelect({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose…",
  searchPlaceholder = "Search",
  className,
  disabled = false,
  allowCustom = false,
  customDetail = "Use this custom value",
  emptyMessage = "No matches.",
}: {
  value: string
  options: SearchSelectOption[]
  onChange: (value: string) => void
  label: string
  placeholder?: string
  searchPlaceholder?: string
  className?: string
  disabled?: boolean
  allowCustom?: boolean
  customDetail?: string
  emptyMessage?: string
}) {
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const selected = options.find((option) => option.value === value)
  const matching = useMemo(() => {
    const term = query.trim()
    if (!term) return options
    return options
      .flatMap((option) => {
        const scores = [
          option.label,
          option.value,
          option.keywords ?? option.detail ?? "",
        ].flatMap((text) => {
          const match = fuzzy(term, text)
          return match ? [match.score] : []
        })
        return scores.length ? [{ option, score: Math.max(...scores) }] : []
      })
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.option)
  }, [options, query])
  const shown = matching.slice(0, 100)
  if (
    allowCustom &&
    query.trim() &&
    !options.some((option) => option.value === query.trim())
  )
    shown.push({
      value: query.trim(),
      label: query.trim(),
      detail: customDetail,
    })
  const activeIndex = Math.min(highlighted, Math.max(0, shown.length - 1))
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, open, query])
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return
        setOpen(next)
        if (next) {
          setHighlighted(0)
          setQuery("")
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn(
            "pressable flex h-7 min-w-0 items-center gap-1.5 bg-raised px-2 text-ui text-foreground/90 ring-1 ring-hairline",
            "hover:bg-fill-hover aria-expanded:bg-fill-selected",
            className
          )}
        >
          {selected?.icon}
          <span className="min-w-0 flex-1 truncate text-left">
            {selected?.label ?? (allowCustom && value ? value : placeholder)}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="end"
          className="max-h-[var(--radix-popover-content-available-height)] w-[max(20rem,var(--radix-popover-trigger-width))] max-w-[var(--radix-popover-content-available-width)] gap-0 overflow-hidden p-0"
        >
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2.5">
            <SearchIcon className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={
                shown.length ? `${listId}-${activeIndex}` : undefined
              }
              maxLength={200}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setHighlighted(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setHighlighted(
                    Math.min(activeIndex + 1, Math.max(0, shown.length - 1))
                  )
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setHighlighted(Math.max(0, activeIndex - 1))
                } else if (event.key === "Enter") {
                  event.preventDefault()
                  event.stopPropagation()
                  if (shown[activeIndex]) choose(shown[activeIndex].value)
                }
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
            />
          </div>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            className="max-h-72 min-h-0 overflow-y-auto overscroll-contain p-1"
          >
            {shown.map((option, index) => {
              const active = option.value === value
              return (
                <button
                  key={option.value}
                  id={`${listId}-${index}`}
                  data-highlighted={index === activeIndex}
                  tabIndex={-1}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => choose(option.value)}
                  className={cn(
                    "pressable flex w-full items-center gap-2 px-2 py-1.5 text-left",
                    active
                      ? "bg-fill-selected"
                      : index === activeIndex
                        ? "bg-fill-hover"
                        : "hover:bg-fill-hover"
                  )}
                >
                  {option.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-foreground/90">
                      {option.label}
                    </span>
                    {option.detail ? (
                      <span className="block truncate text-label text-faint">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                  {active ? (
                    <CheckIcon className="size-3.5 shrink-0 text-foreground" />
                  ) : null}
                </button>
              )
            })}
            {shown.length === 0 ? (
              <p className="px-2 py-6 text-center text-ui text-faint">
                {emptyMessage}
              </p>
            ) : null}
          </div>
          <div className="shrink-0 border-t border-hairline px-2.5 py-1.5 text-label text-faint">
            {matching.length > 100
              ? `Showing 100 of ${matching.length} matches. Type to narrow the list.`
              : query.trim()
                ? `${matching.length} matches`
                : `${options.length} options`}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
