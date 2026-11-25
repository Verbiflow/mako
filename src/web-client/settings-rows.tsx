import { use, type ReactNode } from "react"
import { ListCard, Toggle } from "@/components/ui/kit"
import { SectionTitleContext } from "@/components/settings/section-title"

/**
 * A group of Settings' rows, the desktop's own (`ListCard`): its title above, the rows parted by hairlines on the
 * shell's tone, a footnote below. On every form the same card; under a finger its rows are a thumb's height.
 */
export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  // In the desktop's panes, the section's own title already heads it.
  const section = use(SectionTitleContext)
  return (
    <section className="flex flex-col gap-2">
      {title && title !== section ? <h2 className="text-label font-medium text-faint">{title}</h2> : null}
      <ListCard className="flex flex-col px-0">{children}</ListCard>
      {footer ? <p className="text-label text-faint">{footer}</p> : null}
    </section>
  )
}

/** One row, as the desktop's `SettingRow` reads: its title, what it means under it, an icon before and a control after. */
export function Row({ label, detail, icon, end }: { label: string; detail?: string; icon?: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium">{label}</p>
        {detail ? <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">{detail}</p> : null}
      </div>
      {end}
    </div>
  )
}

/** An on/off switch: the desktop's `Toggle`, a size up and with a thumb's reach under a finger. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return <Toggle on={on} label={label} disabled={disabled} onChange={() => onChange(!on)} />
}
