import type { PointerEvent as ReactPointerEvent } from "react"
import { createHook, createStore } from "@/state/store"
import { placeProject } from "@/state/project-order"

/**
 * Projects reorder by hand: hold a project's header and move past 4 px, and it lifts; a line says where it lands
 * between the others, the list scrolls when the pointer nears its edge, and letting go keeps that order
 * (`placeProject`, which follows the account). Escape puts it back. Rows inside a project still order themselves.
 */
const SLOP = 4
/** How near the list's top or bottom edge the pointer scrolls it, and how fast at the edge, px a frame. */
const EDGE = 28
const EDGE_SPEED = 10

export interface ProjectDrag {
  key: string
  name: string
  /** The project folder, for its avatar. */
  folder: string
  /** Where it would land: the index among the movable projects, `length` for last. */
  over: number
  y: number
}

export const projectDragStore = createStore<{ drag: ProjectDrag | null; said: string }>({ drag: null, said: "" })
export const useProjectDrag = createHook(projectDragStore)

/** The projects that move, as listed: those with a folder, the Chats group and Hidden staying where they are. */
export function movableSections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".thread-jump-scope [data-project-section][data-project-movable]")].filter((section) => !section.closest("[inert]"))
}

function landing(y: number, sections: readonly HTMLElement[]): number {
  const index = sections.findIndex((section) => {
    const head = section.querySelector("[data-flip-key^='folder:']")?.getBoundingClientRect() ?? section.getBoundingClientRect()
    return y < head.top + head.height / 2
  })
  return index < 0 ? sections.length : index
}

export function startProjectDrag(event: ReactPointerEvent, project: { key: string; name: string; folder: string }): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const startX = event.clientX
  const startY = event.clientY
  let lifted = false
  let lastY = startY
  let frame = 0
  const scroller = document.querySelector<HTMLElement>(".thread-jump-scope [data-rail-scroller]")
  const place = (y: number) => {
    const drag = projectDragStore.get().drag
    if (drag) projectDragStore.set({ drag: { ...drag, over: landing(y, movableSections()), y } })
  }
  const edgeScroll = () => {
    frame = 0
    if (!lifted || !scroller) return
    const box = scroller.getBoundingClientRect()
    const step = lastY < box.top + EDGE ? -EDGE_SPEED : lastY > box.bottom - EDGE ? EDGE_SPEED : 0
    if (!step) return
    scroller.scrollTop += step
    place(lastY)
    frame = requestAnimationFrame(edgeScroll)
  }
  const move = (moved: PointerEvent) => {
    lastY = moved.clientY
    if (!lifted) {
      if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < SLOP) return
      lifted = true
      projectDragStore.set({ drag: { ...project, over: 0, y: moved.clientY } })
    }
    place(moved.clientY)
    if (!frame) frame = requestAnimationFrame(edgeScroll)
  }
  const stop = () => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", drop)
    window.removeEventListener("pointercancel", cancel)
    window.removeEventListener("keydown", escape, true)
    cancelAnimationFrame(frame)
  }
  const cancel = () => {
    stop()
    if (lifted) projectDragStore.set({ drag: null, said: `${project.name} stayed where it was` })
  }
  const drop = () => {
    stop()
    const drag = projectDragStore.get().drag
    if (!lifted || !drag) return
    // The click that ends a drag isn't a fold of the project.
    window.addEventListener("click", (click) => click.stopPropagation(), { capture: true, once: true })
    const sections = movableSections()
    const shown = sections.map((section) => section.dataset.projectSection ?? "")
    const before = sections.slice(drag.over).map((section) => section.dataset.projectSection ?? "").find((key) => key !== drag.key) ?? null
    placeProject(drag.key, before, shown)
    const beforeName = before ? sections.find((section) => section.dataset.projectSection === before)?.dataset.projectName : undefined
    projectDragStore.set({ drag: null, said: beforeName ? `Moved ${drag.name} before ${beforeName}` : `Moved ${drag.name} to the end` })
  }
  const escape = (key: KeyboardEvent) => {
    if (key.key !== "Escape" || !lifted) return
    key.preventDefault()
    key.stopPropagation()
    cancel()
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", drop)
  window.addEventListener("pointercancel", cancel)
  window.addEventListener("keydown", escape, true)
}

/** Move up or down, from a project's menu: the same order as a drag, for a keyboard or a hand that can't hold. */
export function nudgeProject(key: string, by: -1 | 1): void {
  const shown = movableSections().map((section) => section.dataset.projectSection ?? "")
  const at = shown.indexOf(key)
  if (at < 0) return
  const target = at + by
  if (target < 0 || target >= shown.length) return
  const before = by < 0 ? shown[target]! : (shown[target + 1] ?? null)
  placeProject(key, before, shown)
}
