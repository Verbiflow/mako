import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** A move's steps in a row: those done checked, the one under way lit. */
export function MoveSteps({ steps, at }: { steps: ReadonlyArray<{ kind: string; words: string }>; at: number }) {
  return (
    <ol className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-label" aria-label="Steps">
      {steps.map((each, index) => (
        <li
          key={each.kind}
          aria-current={index === at ? "step" : undefined}
          className={cn("flex items-center gap-1 whitespace-nowrap", index < at ? "text-muted-foreground" : index === at ? "text-foreground" : "text-faint")}
        >
          {index < at ? <CheckIcon className="size-3" aria-hidden /> : <span aria-hidden className={cn("size-1.5 rounded-full", index === at ? "bg-foreground" : "bg-faint")} />}
          {each.words}
        </li>
      ))}
    </ol>
  )
}
