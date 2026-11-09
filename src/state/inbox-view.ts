import { createHook, createStore } from "@/state/store"

/** Whether the Inbox covers the conversation; independent of its background readings. */
export const inboxViewStore = createStore<{ open: boolean }>({ open: false })
export const useInboxView = createHook(inboxViewStore)

let intent = 0

/** Claim an explicit open before resolving its target, without hiding Inbox for an invalid target. */
function pendingOpen(): () => boolean {
  const mine = ++intent
  return () => mine === intent
}

/** Leave at input time; a delayed completion must still own this intent before changing selection. */
function beginOpen(): () => boolean {
  const current = pendingOpen()
  inboxViewStore.set({ open: false })
  return current
}

export const inboxView = {
  open: () => {
    intent += 1
    inboxViewStore.set({ open: true })
  },
  close: () => {
    beginOpen()
  },
  beginOpen,
  pendingOpen,
  toggle: () => {
    intent += 1
    inboxViewStore.set({ open: !inboxViewStore.get().open })
  },
}
