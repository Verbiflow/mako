import { createHook, createStore } from "@/state/store"

/** Folds held open; past this many the oldest closes again. */
const HELD_OPEN = 400

/**
 * The settled turns a person opened, by transcript and exchange. A turn
 * leaves the screen and comes back (windowing, a released body, another
 * tab) remounted; it comes back the way it was left. Kept for the window's
 * life: a reopened app shows answers folded again.
 */
export const turnFoldsStore = createStore<{ open: ReadonlySet<string> }>({ open: new Set() })
export const useTurnFolds = createHook(turnFoldsStore)

export function turnFoldKey(source: string | undefined, exchange: string, part: number): string {
  return `${source ?? ""}\0${exchange}\0${part}`
}

export function setTurnFoldOpen(key: string, open: boolean): void {
  turnFoldsStore.set((state) => {
    if (state.open.has(key) === open) return {}
    const next = new Set(state.open)
    if (open) next.add(key)
    else next.delete(key)
    for (const oldest of next) {
      if (next.size <= HELD_OPEN) break
      next.delete(oldest)
    }
    return { open: next }
  })
}
