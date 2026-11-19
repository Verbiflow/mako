import { createHook, createStore } from "@/state/store"

/**
 * What covers the conversation: the Inbox, or Automations, each independent of its background readings. One at a
 * time; whatever leaves the Inbox for a Thread (a row, a notification, a new Thread) leaves Automations too.
 */
export const inboxViewStore = createStore<{ open: boolean; automations: boolean }>({ open: false, automations: false })
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
  inboxViewStore.set({ open: false, automations: false })
  return current
}

export const inboxView = {
  open: () => {
    intent += 1
    inboxViewStore.set({ open: true, automations: false })
  },
  close: () => {
    beginOpen()
  },
  beginOpen,
  pendingOpen,
  toggle: () => {
    intent += 1
    inboxViewStore.set({ open: !inboxViewStore.get().open, automations: false })
  },
}

/** Automations over the conversation, as the Inbox is: opening it closes the Inbox, and leaving for a Thread closes it. */
export const automationsPane = {
  open: () => {
    intent += 1
    inboxViewStore.set({ open: false, automations: true })
  },
  close: () => {
    intent += 1
    inboxViewStore.set({ automations: false })
  },
}
