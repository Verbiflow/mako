import { cn } from "@/lib/utils"

/** A file name with its folder after it, faint, trimmed from the left so the nearest folders stay. */
export function PathLabel({ path, className, nameClassName }: { path: string; className?: string; nameClassName?: string }) {
  const slash = path.lastIndexOf("/")
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      <span className={cn("max-w-full shrink-0 truncate text-ui", nameClassName)}>{path.slice(slash + 1)}</span>
      {slash > 0 ? <span className="min-w-0 truncate text-label text-faint" dir="rtl"><bdi>{path.slice(0, slash)}</bdi></span> : null}
    </span>
  )
}
