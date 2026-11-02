import { cn } from "@/lib/utils"

/** An Apex: a stem that branches to its Fins, worn on its row's badge, its strip's count, its panel and its chips. */
export function ApexMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="none" className={cn("size-3.5 shrink-0", className)}>
      <circle cx="4" cy="3.5" r="1.75" fill="currentColor" />
      <circle cx="12" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4 5.5V11a2 2 0 0 0 2 2h4.25M4 6a2 2 0 0 0 2 2h4.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
