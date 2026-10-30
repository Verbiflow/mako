import type { ThreadMachineNotice } from "@mako/host/contracts/cloud-threads"
import { createHook, createStore } from "@/state/store"

/**
 * The cloud's word to a cloud Thread's person, as its object says it in the Thread's stream (`cloud-machine-notice`), by
 * the conversation it's shown for: only when their own work is affected (changes that couldn't be kept, a Thread that
 * can't start again). The gateway owns the truth; this mirrors the newest word, so every window and every device says
 * the same. A person's dismissal is of that word only: a newer one shows again.
 */
interface CloudMachinesState {
  notices: Record<string, { notice: ThreadMachineNotice; dismissed?: true }>
}

export const cloudMachinesStore = createStore<CloudMachinesState>({ notices: {} })
export const useCloudMachines = createHook(cloudMachinesStore)

export function machineNoticed(conversationIds: readonly string[], notice: ThreadMachineNotice): void {
  cloudMachinesStore.set((state) => {
    const notices = { ...state.notices }
    let changed = false
    for (const id of conversationIds) {
      const held = notices[id]
      // A replay of the stream, or a notice from before the one shown, changes nothing.
      if (held && held.notice.at >= notice.at) continue
      notices[id] = { notice }
      changed = true
    }
    return changed ? { notices } : state
  })
}

export function dismissMachineNotice(conversationId: string): void {
  cloudMachinesStore.set((state) => {
    const held = state.notices[conversationId]
    return held && !held.dismissed ? { notices: { ...state.notices, [conversationId]: { ...held, dismissed: true } } } : state
  })
}
