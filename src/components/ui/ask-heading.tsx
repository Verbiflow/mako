import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * An ask's heading, as every card that shows an ask draws it: what it wants on its own line, said whole and wrapping if
 * it must, and under it who asked and how long ago, where a long Thread title gives way first. A person never answers
 * an ask whose card cut off what it's for.
 */
export function AskHeading({ mark, want, who, age, className }: { mark?: ReactNode; want: ReactNode; who: string; age?: string; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      {mark ? <span className="mt-px shrink-0">{mark}</span> : null}
      <div className="min-w-0 flex-1">
        <p data-ask-want className="text-ui leading-snug text-foreground [overflow-wrap:anywhere]">{want}</p>
        <p data-ask-who className="mt-0.5 flex min-w-0 items-center gap-1.5 text-label text-muted-foreground">
          <span className="min-w-0 truncate">{who}</span>
          {age ? <span className="shrink-0 tabular-nums text-faint">· {age}</span> : null}
        </p>
      </div>
    </div>
  )
}
