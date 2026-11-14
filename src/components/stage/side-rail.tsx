import { moveInRail } from "@/components/rail/rail-keys"
import { RailRow } from "@/components/rail/rail-row"
import type { SurfaceDefinition } from "@/extend/surfaces"
import { stage } from "@/state/stage"

/**
 * The right rail's top: the left rail's twin. One row a surface, in a fixed order, each with its quiet reading at the
 * end; what a row opens fills the rail under them. What's read at length (a diff, a file) opens as a tab, on purpose.
 */
export function SideRail({ surfaces, activeId }: { surfaces: SurfaceDefinition[]; activeId: string }) {
  return (
    <nav
      role="tablist"
      aria-label="Right rail"
      aria-orientation="vertical"
      data-side-rail
      className="flex shrink-0 flex-col gap-px px-2 pt-1.5 pb-2"
      onKeyDown={moveInRail}
    >
      {surfaces.map((surface) => (
        <SideRow key={surface.id} surface={surface} active={surface.id === activeId} />
      ))}
    </nav>
  )
}

/** A hook of each surface's own runs here, so a surface comes and goes without the list's order of hooks moving. */
function SideRow({ surface, active }: { surface: SurfaceDefinition; active: boolean }) {
  const offered = useOffered(surface)
  if (!offered && !active) return null
  const Icon = surface.icon
  const Reading = surface.reading
  return (
    <RailRow
      role="tab"
      aria-selected={active}
      aria-current={undefined}
      tabIndex={active ? 0 : -1}
      data-surface-id={surface.id}
      icon={Icon ? <Icon /> : null}
      label={surface.label}
      open={active}
      end={Reading ? <Reading /> : null}
      onClick={() => stage.open(surface.id)}
    />
  )
}

const always = () => true

function useOffered(surface: SurfaceDefinition): boolean {
  return (surface.useOffered ?? always)()
}
