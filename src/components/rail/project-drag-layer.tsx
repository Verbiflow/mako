import { createPortal } from "react-dom"
import { ProjectAvatar } from "@/components/rail/rail-avatars"
import { movableSections, useProjectDrag } from "@/components/rail/project-drag"

/** The lifted project under the pointer, the line where it would land, and what a drop did, said to a screen reader. */
export function ProjectDragLayer() {
  const drag = useProjectDrag((state) => state.drag)
  const said = useProjectDrag((state) => state.said)
  const announcer = <span aria-live="polite" className="sr-only">{said}</span>
  if (!drag) return announcer
  const sections = movableSections()
  const target = sections[drag.over]
  const last = sections.at(-1)
  const line = target ? target.getBoundingClientRect().top - 3 : last ? last.getBoundingClientRect().bottom - 5 : null
  const rail = document.querySelector(".thread-jump-scope [data-rail-scroller]")?.getBoundingClientRect()
  return (
    <>
      {announcer}
      {rail
        ? createPortal(
            <>
              {line !== null ? <span aria-hidden data-drop-line className="pointer-events-none fixed z-50 h-0.5 bg-foreground/45" style={{ top: line, left: rail.left + 10, width: rail.width - 20 }} /> : null}
              <span
                aria-hidden
                data-drag-ghost
                className="card-floating pointer-events-none fixed z-50 flex h-7 items-center gap-2 px-2 text-ui font-medium text-foreground"
                style={{ top: drag.y - 14, left: rail.left + 8, width: rail.width - 16 }}
              >
                <ProjectAvatar name={drag.name} folder={drag.folder} />
                {drag.name}
              </span>
            </>,
            document.body
          )
        : null}
    </>
  )
}
