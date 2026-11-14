import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * A row of a rail's fixed top: an icon, a label and a quiet reading at its end. The left rail's New thread, Search and
 * Inbox are these, and so are the right rail's Changes and Files, which is what makes the two rails twins.
 */
export function RailRow({ icon, label, spoken, open, end, className, ...rest }: Omit<ComponentProps<"button">, "children"> & { icon: ReactNode; label: string; spoken?: string; open?: boolean; end?: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={spoken ?? label}
      aria-current={open ? "page" : undefined}
      data-open={open || undefined}
      className={cn(
        "pressable group/top flex h-7 w-full items-center gap-2 px-1.5 text-left text-ui text-foreground/85 transition-colors duration-100 hover:bg-fill-hover hover:text-foreground",
        open && "bg-raised text-foreground hover:bg-raised",
        className
      )}
      {...rest}
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
    </button>
  )
}
