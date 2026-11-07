import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { actions, useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import type { ThinkingLevel } from "@/lib/types"
import { CheckIcon } from "lucide-react"

/**
 * Reasoning effort.
 *
 * Only the levels the *selected model* advertises are offered, so a model
 * that cannot do "max" never shows a dead option.
 * The trigger is a four-bar gauge because effort is ordinal: you should be
 * able to read the current setting without reading a word.
 */

const DESCRIPTIONS = {
  off: "No reasoning tokens. Fastest, cheapest.",
  minimal: "A brief look before answering.",
  low: "Light reasoning for routine work.",
  medium: "Balanced. A good default for real tasks.",
  high: "Deliberate. For tricky bugs and design work.",
  xhigh: "Extended reasoning. Slow and expensive.",
  max: "Everything the model has. Reserve for hard problems.",
} satisfies Record<ThinkingLevel, string>

const RANK = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 4,
  max: 4,
} satisfies Record<ThinkingLevel, number>

export function EffortPicker({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const level = useSession((state) => state.meta?.thinkingLevel ?? "off")
  const levels = useSession((state) => state.meta?.thinkingLevels)
  const supported = levels ?? ["off"]

  // A model with no reasoning support gets no control at all rather than a
  // disabled one — an inert affordance is worse than an absent one.
  if (supported.length <= 1) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Reasoning effort: ${level}`}
          className={cn(
            "pressable no-drag flex h-7 items-center gap-1.5 px-2 text-ui font-medium",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:not-disabled:bg-fill-hover aria-expanded:bg-fill-selected disabled:opacity-40",
            level === "off" ? "text-faint" : "text-foreground/85"
          )}
        >
          <Gauge level={level} />
          <span className="capitalize">{level}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[17rem] gap-0 p-1">
        {supported.map((option) => {
          const active = option === level
          return (
            <button
              key={option}
              type="button"
              onClick={() => {
                void actions.setThinking(option)
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors duration-100",
                "hover:bg-fill-hover",
                active && "bg-fill-selected"
              )}
            >
              <Gauge level={option} className="mt-[3px]" />
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium capitalize">{option}</span>
                <span className="block text-label leading-snug text-faint">
                  {DESCRIPTIONS[option]}
                </span>
              </span>
              {active ? <CheckIcon className="mt-1 size-3.5 shrink-0 text-foreground" /> : null}
            </button>
          )
        })}
        <div className="mt-1 flex items-center justify-end gap-1 border-t border-hairline px-2 pt-1.5 text-label text-faint">
          cycle
          <Keys keys={formatChord("mod+.")} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Gauge({ level, className }: { level: ThinkingLevel; className?: string }) {
  const filled = RANK[level]
  return (
    <span className={cn("flex items-end gap-[1.5px]", className)} aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className={cn(
            "w-[2px] transition-colors duration-150",
            index < filled ? "bg-foreground" : "bg-foreground/20"
          )}
          style={{ height: 4 + index * 2 }}
        />
      ))}
    </span>
  )
}
