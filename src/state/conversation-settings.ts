import type { ConversationSettings } from "@mako/host/contracts/turn-continuation"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * The person's conversation settings the host keeps, because the host acts on
 * them with no window open (`LiveRestarts`): whether Mako continues the turns
 * its own quit, restart or update cut short. Null until read.
 */
export const conversationSettingsStore = createStore<{ settings: ConversationSettings | null }>({ settings: null })
export const useConversationSettings = createHook(conversationSettingsStore)

export const conversationSettings = {
  async load(): Promise<void> {
    if (!hasBridge()) return
    const settings = await getMako().conversationSettings().catch(() => null)
    conversationSettingsStore.set({ settings })
  },
  async set(change: Partial<ConversationSettings>): Promise<void> {
    const before = conversationSettingsStore.get().settings
    if (!before) return
    conversationSettingsStore.set({ settings: { ...before, ...change } })
    try {
      conversationSettingsStore.set({ settings: await getMako().setConversationSettings({ ...before, ...change }) })
    } catch {
      conversationSettingsStore.set({ settings: before })
    }
  },
  /** The host's word on them, from any window. */
  settled(settings: ConversationSettings): void {
    conversationSettingsStore.set({ settings })
  },
}
