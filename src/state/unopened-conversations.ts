import type { UnopenedConversation } from "@mako/host/contracts/unopened-conversations"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Saved conversations the host couldn't open as it started (`UnopenedConversation`): the rail says how many, and
 * Settings › Diagnostics lists each with its kept journal, so none just vanishes from the list.
 */
export const unopenedStore = createStore<{ conversations: readonly UnopenedConversation[] }>({ conversations: [] })
export const useUnopened = createHook(unopenedStore)

/** Read once at boot: the host learns them only as it starts. A host without the reading has none to say. */
export async function loadUnopened(): Promise<void> {
  if (!hasBridge()) return
  unopenedStore.set({ conversations: await getMako().unopenedConversations() })
}
