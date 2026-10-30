import { createHook, createStore } from "@/state/store"

/** Access changes on their way, by conversation: the chip shows the choice, and Send waits for it. */
const switchStore = createStore({ pending: new Map<string, { mode: string }>() })
export const useSwitching = createHook(switchStore)

export function setPending(conversation: string, mode: string | undefined): void {
  const pending = new Map(switchStore.get().pending)
  if (mode) pending.set(conversation, { mode })
  else pending.delete(conversation)
  switchStore.set({ pending })
}

