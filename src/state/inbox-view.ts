import { createHook, createStore } from "@/state/store"

/** Whether the Inbox covers the conversation; independent of its background readings. */
export const inboxViewStore = createStore<{ open: boolean }>({ open: false })
export const useInboxView = createHook(inboxViewStore)

export const inboxView = {
  open: () => inboxViewStore.set({ open: true }),
  close: () => inboxViewStore.set({ open: false }),
  toggle: () => inboxViewStore.set({ open: !inboxViewStore.get().open }),
}
