import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ComponentProps, ReactNode } from "react"

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

const base =
  "pressable no-drag inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-md " +
  "text-ui font-medium whitespace-nowrap " +
  "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease,color_120ms_ease,opacity_120ms_ease] " +
  "disabled:pointer-events-none disabled:opacity-40 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0"

const tones = {
  ghost:
    "text-muted-foreground hover:not-disabled:bg-fill-hover hover:not-disabled:text-foreground data-[on=true]:bg-fill-selected data-[on=true]:text-foreground",
  quiet: "text-foreground/80 hover:not-disabled:bg-fill-hover hover:not-disabled:text-foreground",
  solid: "bg-primary text-primary-foreground hover:not-disabled:opacity-90",
  outline: "border border-border text-foreground hover:not-disabled:bg-fill-hover",
  danger: "text-negative hover:not-disabled:bg-negative/12",
} as const

const sizes = {
  xs: "h-6 px-1.5 [&_svg]:size-3.5",
  sm: "h-7 px-2 [&_svg]:size-3.5",
  md: "h-8 px-2.5 [&_svg]:size-4",
} as const

export function Action({
  className,
  tone = "ghost",
  size = "sm",
  ...props
}: ComponentProps<"button"> & { tone?: keyof typeof tones; size?: keyof typeof sizes }) {
  return <button type="button" className={cn(base, tones[tone], sizes[size], className)} {...props} />
}

export function IconAction({
  className,
  tone = "ghost",
  size = "sm",
  label,
  keys,
  side = "bottom",
  ...props
}: ComponentProps<"button"> & {
  tone?: keyof typeof tones
  size?: keyof typeof sizes
  label: string
  keys?: string[]
  side?: "top" | "bottom" | "left" | "right"
}) {
  const square = size === "xs" ? "size-6" : size === "sm" ? "size-7" : "size-8"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(base, tones[tone], sizes[size], "px-0", square, className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side={side} className="gap-2">
        {label}
        {keys?.length ? <Keys keys={keys} inverted /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

/* ------------------------------------------------------------------ */
/* Text bits                                                           */
/* ------------------------------------------------------------------ */

export function Keys({ keys, inverted }: { keys: string[]; inverted?: boolean }) {
  if (!keys.length) return null
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          data-slot="kbd"
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] px-1 font-sans text-label leading-none",
            inverted
              ? "bg-background/15 text-background"
              : "bg-raised text-faint ring-1 ring-hairline ring-inset"
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}

export function Chip({
  className,
  tone = "neutral",
  children,
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "positive" | "negative" | "caution" }) {
  const palette = {
    neutral: "bg-raised text-muted-foreground ring-hairline",
    positive: "bg-positive/12 text-positive ring-positive/25",
    negative: "bg-negative/12 text-negative ring-negative/25",
    caution: "bg-caution/12 text-caution ring-caution/25",
  }[tone]
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-label font-medium ring-1 ring-inset",
        palette,
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

/**
 * A section label. Sentence case and unremarkable on purpose — uppercase
 * micro-labels with letterspacing are the single most recognisable tell of a
 * generated interface, and they cost legibility at this size for nothing.
 */
export function Eyebrow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("px-1 text-label font-medium text-faint", className)} {...props} />
  )
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

export function Toggle({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string
  on: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "pressable flex h-4 w-7 shrink-0 items-center rounded-full p-[2px]",
        "[transition:background-color_150ms_ease]",
        "disabled:pointer-events-none disabled:opacity-40",
        on ? "bg-foreground/80" : "bg-foreground/15"
      )}
    >
      <span
        className={cn(
          "block size-3 rounded-full bg-background",
          "[transition:transform_180ms_var(--ease-out)]",
          on ? "translate-x-3" : "translate-x-0"
        )}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <div role="group" aria-label={label} className="flex h-6 shrink-0 items-center rounded-md bg-raised p-[2px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[4px] px-2 text-label font-medium disabled:pointer-events-none disabled:opacity-40",
            "[transition:background-color_120ms_ease,color_120ms_ease]",
            value === option.value
              ? "bg-surface text-foreground"
              : "text-faint hover:text-muted-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** One setting: a name and an explanation on the left, its control on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
}: {
  title: string
  description?: string
  htmlFor?: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-10 py-3">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-ui font-medium">
            {title}
          </label>
        ) : (
          <div className="text-ui font-medium">{title}</div>
        )}
        {description ? (
          <p className="mt-0.5 max-w-[34rem] text-label leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/** A quietly recessed container that groups rows into one card. */
export function ListCard({ className, children }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-[10px] bg-shell/55 px-4 [box-shadow:inset_0_0_0_0.5px_var(--hairline)] divide-y divide-hairline",
        className
      )}
    >
      {children}
    </div>
  )
}

export function ListCardRow({ className, children }: ComponentProps<"div">) {
  return (
    <div className={cn("py-3 first:pt-3.5 last:pb-3.5", className)}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export interface BlankHint {
  label: string
  keys?: string[]
  onSelect: () => void
}

/**
 * An empty state that launches instead of shrugging. The hints are ghost
 * action rows — the next thing worth doing, with its chord — because a
 * blank pane that only describes its own emptiness is a dead end.
 */
export function Blank({
  icon,
  title,
  body,
  action,
  hints,
}: {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
  hints?: BlankHint[]
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      {icon ? (
        <div className="mb-1 flex size-8 items-center justify-center rounded-lg bg-raised text-faint [&_svg]:size-4">
          {icon}
        </div>
      ) : null}
      <p className="text-ui font-medium text-foreground">{title}</p>
      {body ? <p className="max-w-[30ch] text-ui leading-relaxed text-faint">{body}</p> : null}
      {action}
      {hints?.length ? (
        <div className="mt-3 flex w-full max-w-[19rem] flex-col gap-0.5">
          {hints.map((hint) => (
            <button
              key={hint.label}
              type="button"
              onClick={hint.onSelect}
              className="pressable flex h-9 items-center justify-between rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
            >
              {hint.label}
              {hint.keys ? <Keys keys={hint.keys} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Horizontal usage bar — context window, diff ratio, anything 0..1. */
export function Meter({
  value,
  tone = "neutral",
  className,
}: {
  value: number
  tone?: "neutral" | "caution" | "negative" | "positive"
  className?: string
}) {
  const color = {
    neutral: "bg-foreground/45",
    caution: "bg-caution",
    negative: "bg-negative",
    positive: "bg-positive",
  }[tone]
  return (
    <span className={cn("block h-[3px] w-full overflow-hidden rounded-full bg-raised", className)}>
      <span
        className={cn("block h-full rounded-full transition-[width] duration-500", color)}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}
