import { createHook, createStore } from "@/state/store"

/**
 * Setup in a laptop's browser, where Changes, Files and Agents go: the Thread on screen's own place and its asks. Whether
 * it's open is all it keeps; whose Setup it shows follows from what's on screen.
 */
export const setupOpenStore = createStore<{ open: boolean }>({ open: false })
export const useSetupOpen = createHook(setupOpenStore)

export function openSetup(): void {
  setupOpenStore.set({ open: true })
}

export function closeSetup(): void {
  if (setupOpenStore.get().open) setupOpenStore.set({ open: false })
}
