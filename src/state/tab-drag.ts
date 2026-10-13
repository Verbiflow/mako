import { createHook, createStore } from "@/state/store"
import { onScreenSession, openInPane, openTabInPane, tabFor } from "@/state/session-panes"
import type { SessionTab } from "@/state/thread-sessions"
import { viewerStore, type PaneSession, type PaneSide } from "@/state/viewer"

/**
 * Dragging a Session tab onto the chat. Past a few pixels the tab lifts into
 * a ghost that follows the pointer and the panes show where it would land:
 * an edge opens it beside, the middle opens it here. The ghost moves on the
 * DOM directly; React hears only when the zone under the pointer changes.
 */

export type DropSide = PaneSide | "center"

/** Where a drag would land: a side of a pane, or the composer, for a sidebar row it can reference. */
export type DropZone = { paneId: string; side: DropSide } | { composer: true }

interface TabDrag {
  /** Absent for a sidebar row: its Thread opens on press, and the drop takes the Session that opened. */
  tab?: SessionTab
  thread: string
  title: string
  /** What the focused pane showed before the press, for a row that opens on press. */
  shown?: PaneSession
  /** The conversation's token, for a sidebar row: dropped on the composer, it becomes a chip there. */
  reference?: string
}

export const tabDragStore = createStore<{ drag: TabDrag | null; zone: DropZone | null }>({ drag: null, zone: null })
export const useTabDrag = createHook(tabDragStore)

/** Movement before a press becomes a drag, so a click stays a click. */
const THRESHOLD = 4
/** How far into a single pane an edge reaches, as a share of its size. */
const EDGE = 0.28

function zoneAt(x: number, y: number, drag: TabDrag): DropZone | null {
  const under = document.elementFromPoint(x, y)
  if (drag.reference && under?.closest("[data-composer]")) return { composer: true }
  // Over a tab strip the tab is still among tabs, not in a chat.
  if (under?.closest('[role="tablist"]')) return null
  const pane = under?.closest<HTMLElement>("[data-pane-id]")
  const paneId = pane?.dataset.paneId
  if (!pane || !paneId) return null
  const panes = viewerStore.get().panes
  // Two panes: the pane is the zone. One: its edges split it.
  if (panes.length > 1) return { paneId, side: "center" }
  const bounds = pane.getBoundingClientRect()
  const left = (x - bounds.left) / bounds.width
  const top = (y - bounds.top) / bounds.height
  const edges: [DropSide, number][] = [
    ["left", left],
    ["right", 1 - left],
    ["up", top],
    ["down", 1 - top],
  ]
  const [side, distance] = edges.reduce((nearest, edge) => (edge[1] < nearest[1] ? edge : nearest))
  return { paneId, side: distance < EDGE ? side : "center" }
}

function sameZone(left: DropZone | null, right: DropZone | null): boolean {
  if (!left || !right) return left === right
  if ("composer" in left || "composer" in right) return "composer" in left && "composer" in right
  return left.paneId === right.paneId && left.side === right.side
}

/**
 * A sidebar row dropped on the composer: the row opened its Thread on
 * press, so what was on screen comes back first, and the chip goes into
 * that composer once it is there, never into the dragged Thread's own.
 */
function reference(drag: TabDrag, token: string): void {
  const shown = drag.shown ? tabFor(drag.shown) : undefined
  const pane = viewerStore.get().focusedPaneId
  if (drag.shown && shown && pane) openTabInPane(pane, drag.shown.thread, shown)
  let frames = 0
  const insert = () => {
    const here = onScreenSession()
    const back = !drag.shown || (here?.thread === drag.shown.thread && here.tab === drag.shown.tab)
    // The composer follows the Session on screen a frame after it changes.
    if (!back && ++frames < 90) return void requestAnimationFrame(insert)
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:insert", { detail: `${token} ` })))
  }
  requestAnimationFrame(insert)
}

function draggedTab(drag: TabDrag): SessionTab | undefined {
  if (drag.tab) return drag.tab
  const opened = onScreenSession()
  return opened?.thread === drag.thread ? tabFor(opened) : undefined
}

function drop(drag: TabDrag, zone: DropZone): void {
  if ("composer" in zone) {
    if (drag.reference) reference(drag, drag.reference)
    return
  }
  const tab = draggedTab(drag)
  if (!tab) return
  const { panes, split } = viewerStore.get()
  if (panes.length > 1) {
    const first = panes[0]?.id === zone.paneId
    openInPane(tab, drag.thread, split === "right" ? (first ? "left" : "right") : first ? "up" : "down", drag.shown)
    return
  }
  if (zone.side === "center") openTabInPane(zone.paneId, drag.thread, tab)
  else openInPane(tab, drag.thread, zone.side, drag.shown)
}

/**
 * Watch a press on a tab and turn it into a drag once it moves. Returns
 * nothing; the listeners remove themselves on release or Esc.
 */
export function pressTab(event: PointerEvent | React.PointerEvent, drag: TabDrag, source: HTMLElement): void {
  if (event.button !== 0) return
  const startX = event.clientX
  const startY = event.clientY
  let ghost: HTMLElement | null = null

  const place = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate3d(${x + 10}px, ${y + 12}px, 0)`
  }
  const move = (moved: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < THRESHOLD) return
      ghost = document.createElement("div")
      ghost.className = "tab-drag-ghost"
      ghost.textContent = drag.title
      const icon = source.querySelector("svg")?.cloneNode(true)
      if (icon) ghost.prepend(icon)
      document.body.append(ghost)
      document.documentElement.dataset.tabDragging = ""
      tabDragStore.set({ drag, zone: null })
    }
    place(moved.clientX, moved.clientY)
    const zone = zoneAt(moved.clientX, moved.clientY, drag)
    if (!sameZone(zone, tabDragStore.get().zone)) tabDragStore.set({ zone })
  }
  const end = (commit: boolean) => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", release)
    window.removeEventListener("pointercancel", cancel)
    window.removeEventListener("keydown", key, true)
    const { zone } = tabDragStore.get()
    ghost?.remove()
    delete document.documentElement.dataset.tabDragging
    tabDragStore.set({ drag: null, zone: null })
    if (commit && ghost && zone) drop(drag, zone)
  }
  const release = () => end(true)
  const cancel = () => end(false)
  const key = (pressed: KeyboardEvent) => {
    if (pressed.key !== "Escape" || !ghost) return
    pressed.preventDefault()
    pressed.stopPropagation()
    end(false)
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", release)
  window.addEventListener("pointercancel", cancel)
  window.addEventListener("keydown", key, true)
}
