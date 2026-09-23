import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Content that opens and closes by its own height. The row track animates
 * from `0fr` to `1fr`, so nothing is measured and nothing jumps when the
 * content changes size while open. It mounts on first open and stays, so a
 * closed section costs nothing until someone asks for it and closing it
 * keeps what was scrolled or typed inside.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean
  children: ReactNode
  className?: string
}) {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return (
    <div
      inert={!open}
      className={cn(
        "grid motion-safe:transition-[grid-template-rows,opacity]",
        open
          ? "grid-rows-[1fr] opacity-100 duration-200 ease-[var(--ease-out)]"
          : "grid-rows-[0fr] opacity-0 duration-150 ease-[var(--ease-swift)]",
        className
      )}
    >
      <div className="min-h-0 overflow-hidden">{opened ? children : null}</div>
    </div>
  )
}
