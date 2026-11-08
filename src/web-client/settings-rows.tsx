import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Settings' rounded group of rows, with its title above and a footnote below. */
export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title ? <h2 className="px-1 text-label font-medium text-faint">{title}</h2> : null}
      <div className="flex flex-col overflow-hidden bg-surface ring-1 ring-hairline [&>*+*]:border-t [&>*+*]:border-hairline">{children}</div>
      {footer ? <p className="px-1 text-label text-faint">{footer}</p> : null}
    </section>
  )
}

/** One row: its words, an icon before them and a control after. */
export function Row({ label, detail, icon, end }: { label: string; detail?: string; icon?: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-ui">{label}</p>
        {detail ? <p className="text-label text-faint">{detail}</p> : null}
      </div>
      {end}
    </div>
  )
}

/** An on/off switch, as iOS draws one. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cn("web-switch", on && "web-switch-on")}>
      <span aria-hidden />
    </button>
  )
}
