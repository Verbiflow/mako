import { SideTab, SideTabs } from "@/components/stage/side-tab"
import type { SurfaceDefinition } from "@/extend/surfaces"
import { stage } from "@/state/stage"

/**
 * The right panel's top: one 40px bar of tabs, a surface each in a fixed order, the open one raised. A tab carries a
 * reading only when it asks for the eye (who needs the person, a live control); Changes says its size in its own
 * header. What a tab opens fills the panel under it. What's read at length (a diff, a file) opens as a tab, on purpose.
 */
export function SideRail({ surfaces, activeId }: { surfaces: SurfaceDefinition[]; activeId: string }) {
  return (
    <SideTabs label="Right rail">
      {surfaces.map((surface) => (
        <SideRow key={surface.id} surface={surface} active={surface.id === activeId} />
      ))}
    </SideTabs>
  )
}

/** A hook of each surface's own runs here, so a surface comes and goes without the list's order of hooks moving. */
function SideRow({ surface, active }: { surface: SurfaceDefinition; active: boolean }) {
  const offered = useOffered(surface)
  const label = useLabel(surface)
  if (!offered && !active) return null
  const Reading = surface.reading
  return (
    <SideTab
      label={label}
      active={active}
      data-surface-id={surface.id}
      reading={Reading ? <Reading /> : null}
      onClick={() => stage.open(surface.id)}
    />
  )
}

const always = () => true

function useOffered(surface: SurfaceDefinition): boolean {
  return (surface.useOffered ?? always)()
}

function useLabel(surface: SurfaceDefinition): string {
  const named = (surface.useLabel ?? never)()
  return named ?? surface.label
}

const never = () => undefined
