import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { acpStore, activeLiveAcp } from "@/state/acp"
import { createHook, createStore } from "@/state/store"

/*
 * Agents in a laptop's browser, where Changes and Files go, and the Fin opened in its pane. The Fin is here rather than
 * in its Thread's page because Agents, beside the page, opens one too.
 *
 * Neither holds a conversation to go stale. Whether Agents is open is all it keeps: whose roster it shows follows from
 * what's on screen (`useAgentsRoster`). An Apex is held only inside its open Fin, so none outlives it.
 */

export const agentsOpenStore = createStore<{ open: boolean }>({ open: false })
export const useAgentsOpen = createHook(agentsOpenStore)

export interface DeskFin {
  agent: NativeAgent
  /** The Thread of the Apex behind it: its page is where the Fin stands. */
  thread: string
  /** The Apex's conversation, whose roster Agents goes on showing. */
  apex: string
}

export const deskFinStore = createStore<{ fin: DeskFin | null }>({ fin: null })
export const useDeskFin = createHook(deskFinStore)

/** A Fin with no conversation on its device yet has nothing to open. */
export function openDeskFin(agent: NativeAgent, thread: string, apex: string): void {
  if (agent.child?.conversation) deskFinStore.set({ fin: { agent, thread, apex } })
}

export function closeDeskFin(): void {
  if (deskFinStore.get().fin) deskFinStore.set({ fin: null })
}

export function openAgents(): void {
  agentsOpenStore.set({ open: true })
}

export function closeAgents(): void {
  if (agentsOpenStore.get().open) agentsOpenStore.set({ open: false })
}

/** The composer's chip in the browser: Agents, or away again. */
export function toggleAgents(): void {
  if (agentsOpenStore.get().open) closeAgents()
  else if (activeLiveAcp(acpStore.get())) openAgents()
}
