import { createHook, createStore } from "@/state/store"

/** The Settings section for projects' apps; its id is part of the `mako:settings` deep link. */
export const APPS_SECTION = "apps"

interface AppSetupState {
  /** The project Settings shows, by its root; none shows the list. */
  chosen?: string
}

export const appSetupStore = createStore<AppSetupState>({})
export const useAppSetup = createHook(appSetupStore)

/** Settings, open on one project's app, or on the list of them. */
export function openAppSetup(root?: string): void {
  appSetupStore.set({ chosen: root })
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: APPS_SECTION }))
}
