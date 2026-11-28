import { createHook, createStore } from "@/state/store"
import type { BoardKind } from "@mako/host/contracts/project-pulls"

/**
 * Where the person is in the Pull requests panel and page: the view (pull requests or issues), the keyboard's row,
 * which sections they folded or opened, and the page's grouping and preview. Kept for the window, so each comes back
 * as it was left.
 */

export type BoardPlace = "panel" | "page"
export type BoardGrouping = "state" | "repository"

export interface PlaceView {
  view: BoardKind
  selected?: string
  /** Sections the person folded or opened, by `view:section`; one not here folds as its section says. */
  folded: Readonly<Record<string, boolean>>
  grouping: BoardGrouping
  /** The page's previewed row. */
  preview?: string
}

const fresh = (): PlaceView => ({ view: "pulls", folded: {}, grouping: "state" })

export const pullsViewStore = createStore<Record<BoardPlace, PlaceView>>({ panel: fresh(), page: fresh() })
export const usePullsView = createHook(pullsViewStore)

export function setPullsView(place: BoardPlace, patch: Partial<PlaceView>): void {
  pullsViewStore.set((state) => ({ [place]: { ...state[place], ...patch } }))
}

export function toggleFolded(place: BoardPlace, key: string, folded: boolean): void {
  pullsViewStore.set((state) => ({ [place]: { ...state[place], folded: { ...state[place].folded, [key]: !folded } } }))
}
