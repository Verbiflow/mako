import type { HarnessMark } from "@mako/host/contracts/harness-presentation"
import { useId } from "react"
import { cn } from "@/lib/utils"

/** Draws a mark from its data; a gradient spans the viewBox top to bottom. */
export function DeclaredMark({ mark, tinted, className }: { mark: HarnessMark; tinted: boolean; className?: string }) {
  const gradient = useId()
  const [x = 0, y = 0, width = 0, height = 0] = mark.viewBox.split(" ").map(Number)
  const fill = mark.gradient ? `url(#${gradient})` : undefined
  return (
    <svg
      viewBox={mark.viewBox}
      fill="currentColor"
      className={cn("shrink-0", className)}
      style={tinted && !mark.gradient && mark.tint !== "currentColor" ? { color: mark.tint } : undefined}
      aria-hidden
    >
      {mark.gradient ? (
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={x + width / 2} x2={x + width / 2} y1={y} y2={y + height}>
            {mark.gradient.map((stop) => <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />)}
          </linearGradient>
        </defs>
      ) : null}
      {mark.paths.map((path, index) => <path key={index} d={path.d} fillRule={path.fillRule} fill={fill} />)}
    </svg>
  )
}

export function Initials({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] bg-foreground/10",
        "text-[7px] font-bold tracking-tight text-muted-foreground uppercase",
        className
      )}
      aria-hidden
    >
      {name.slice(0, 2)}
    </span>
  )
}
