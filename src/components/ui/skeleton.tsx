import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="skeleton" aria-hidden className={cn("skeleton", className)} {...props} />
}

export { Skeleton }
