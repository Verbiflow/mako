import { createHook, createStore } from "@/state/store"

/**
 * Which failure rows are on screen, by `conversation:request`. A failure the
 * reader can see needs no second line above the composer; one scrolled away,
 * or in a turn not drawn, does.
 */
export const failureVisibilityStore = createStore<{ visible: ReadonlySet<string> }>({ visible: new Set() })
export const useFailureVisibility = createHook(failureVisibilityStore)

export function failureKey(conversation: string, request: string): string {
  return `${conversation}:${request}`
}

export function noteFailureVisible(key: string, visible: boolean): void {
  const current = failureVisibilityStore.get().visible
  if (current.has(key) === visible) return
  const next = new Set(current)
  if (visible) next.add(key)
  else next.delete(key)
  failureVisibilityStore.set({ visible: next })
}

/** Bring a failure row into view, in whichever transcript draws it. */
export function revealFailure(key: string): boolean {
  const row = document.querySelector(`[data-failure-key="${CSS.escape(key)}"]`)
  if (!row) return false
  row.scrollIntoView({ block: "center", behavior: "smooth" })
  return true
}
