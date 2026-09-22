import type { ReactNode } from "react"
import { XIcon, TriangleAlertIcon } from "lucide-react"

/** Shared presentation: dismissal hides an occurrence, never changes delivery. */
export function RecoveryNotice({
  title,
  description,
  actions,
  children,
  onDismiss,
}: {
  title: string
  description: string
  actions: ReactNode
  children?: ReactNode
  onDismiss(): void
}) {
  return (
    <section
      aria-label="Message recovery"
      className="bg-fill/40 mx-3 mb-2 shrink-0 rounded-xl border border-hairline px-3 py-2.5 text-foreground"
      data-recovery-notice
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlertIcon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium">{title}</p>
          <p className="mt-0.5 text-label text-muted-foreground">
            {description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {actions}
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss error"
          title="Dismiss error"
          onClick={onDismiss}
          className="pressable -mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="max-h-52 overflow-y-auto text-label text-muted-foreground">
        {children}
      </div>
    </section>
  )
}
