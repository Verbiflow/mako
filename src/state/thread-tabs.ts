import { createHook, createStore } from "@/state/store"

/**
 * The thread strip above the workbench: the sessions you have opened, in
 * open order. Tabs hold only paths — a title, a mark, or a live owner is
 * resolved against the threads list and the live store at draw time, so a
 * background turn never wakes the strip to carry news it only displays.
 */
export interface ThreadTabsState {
  tabs: string[]
}

export const threadTabsStore = createStore<ThreadTabsState>({ tabs: [] })
export const useThreadTabs = createHook(threadTabsStore)

/** A viewed thread joins the strip once; reopening it moves nothing. */
export function openThreadTab(path: string) {
  const { tabs } = threadTabsStore.get()
  if (tabs.includes(path)) return
  threadTabsStore.set({ tabs: [...tabs, path] })
}

/** Closing removes the tab; the thread itself stays where it was. */
export function closeThreadTab(path: string) {
  const { tabs } = threadTabsStore.get()
  if (!tabs.includes(path)) return
  threadTabsStore.set({ tabs: tabs.filter((tab) => tab !== path) })
}
