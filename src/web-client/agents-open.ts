import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { acpStore, activeLiveAcp } from "@/state/acp"
import { createHook, createStore } from "@/state/store"

/*
 * Agents in a laptop's browser, where Changes and Files go, and the Fin opened in its pane. The Fin is here rather than
 * in its Thread's page because Agents, beside the page, opens one too.
 */

export const agentsOpenStore = createStore<{ open: { conversation: string } | null }>({ open: null })
export const useAgentsOpen = createHook(agentsOpenStore)

/** The Fin the browser's pane shows and the Apex's conversation behind it, whose roster Agents goes on showing. */
export const deskFinStore = createStore<{ agent: NativeAgent | null; apex?: string }>({ agent: null })
export const useDeskFin = createHook(deskFinStore)

export function openAgents(conversation: string): void {
  agentsOpenStore.set({ open: { conversation } })
}

export function closeAgents(): void {
  if (agentsOpenStore.get().open) agentsOpenStore.set({ open: null })
}

/** Whose roster Agents shows: the Apex's while one of its Fins is open, else the conversation on hand. */
export function agentsConversation(conversation: string): string {
  return deskFinStore.get().apex ?? conversation
}

/** The composer's chip in the browser: Agents for the conversation on screen, or away again. */
export function toggleAgents(): void {
  if (agentsOpenStore.get().open) return closeAgents()
  const live = activeLiveAcp(acpStore.get())?.key
  if (live) openAgents(agentsConversation(live))
}
