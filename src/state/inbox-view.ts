import { createHook, createStore } from "@/state/store"

/**
 * What covers the conversation: the Inbox, Automations or Pull requests, each independent of its background readings.
 * One at a time; whatever leaves the Inbox for a Thread (a row, a notification, a new Thread) leaves the others too.
 */
export const inboxViewStore = createStore<{ open: boolean; automations: boolean; pulls: boolean }>({ open: false, automations: false, pulls: false })
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
  inboxViewStore.set({ open: false, automations: false, pulls: false })
  return current
}

export const inboxView = {
  open: () => {
    intent += 1
    inboxViewStore.set({ open: true, automations: false, pulls: false })
  },
  close: () => {
    beginOpen()
  },
  beginOpen,
  pendingOpen,
  toggle: () => {
    intent += 1
    inboxViewStore.set({ open: !inboxViewStore.get().open, automations: false, pulls: false })
  },
}

/** Automations over the conversation, as the Inbox is: opening it closes the Inbox, and leaving for a Thread closes it. */
export const automationsPane = {
  open: () => {
    intent += 1
    inboxViewStore.set({ open: false, automations: true, pulls: false })
  },
  close: () => {
    intent += 1
    inboxViewStore.set({ automations: false })
  },
}

/**
 * Where the Inbox's keyboard stands, kept while it's closed so it comes back where it was: the selected row, and
 * whether "Read today" is folded.
 */
export const inboxListStore = createStore<{ selected?: string; readFolded: boolean }>({ readFolded: true })
export const useInboxList = createHook(inboxListStore)

/** Pull requests across every project over the conversation, as Automations is. */
export const pullsPane = {
  open: () => {
    intent += 1
    inboxViewStore.set({ open: false, automations: false, pulls: true })
  },
  close: () => {
    intent += 1
    inboxViewStore.set({ pulls: false })
  },
}
