import type { ReactNode } from "react"
import { acp } from "@/state/acp"
import type { AcpPresence } from "@/state/acp-presence"
import { createHook, createStore } from "@/state/store"

/**
 * How a window opens what its rail and its tab strip point at. The desktop
 * opens a conversation in place (`acp.activate`) and its workbench holds it.
 * The web app in a laptop's browser draws the same rail and strip, but a
 * Session there is an address: these routes take it to the Thread's page,
 * whose own reader opens the conversation through the gateway.
 *
 * Unset, everything opens as on the desktop. A window that routes has no
 * workbench of its own behind the strip: no panes to split, no viewer, and no
 * host of its own to archive a Session through, so those controls aren't
 * offered and its own menu (`threadMenu`) stands in for the host's.
 */
export interface WindowRoutes {
  /** A listed conversation, from its rail row or its tab. */
  open(presence: AcpPresence): void
  /** The Thread on screen's new tab; false when it can't have one. */
  newSession(): boolean
  /** A new Thread in this project folder. */
  newThreadIn(cwd: string): void
  /** A Thread's menu, from its row's `…` or a right-click, in place of the host's: by its Thread, or its conversation. */
  threadMenu(thread: string | undefined, conversation: string | undefined): ReactNode
}

export const windowRoutesStore = createStore<{ routes: WindowRoutes | null }>({ routes: null })
export const useWindowRoutes = createHook(windowRoutesStore)

/** Routes this window's opening through `routes` until the returned function is called. */
export function routeWindow(routes: WindowRoutes): () => void {
  windowRoutesStore.set({ routes })
  return () => {
    if (windowRoutesStore.get().routes === routes) windowRoutesStore.set({ routes: null })
  }
}

/** Open a listed conversation: in place on the desktop, at its address where the window routes. */
export function openConversation(presence: AcpPresence): void {
  const { routes } = windowRoutesStore.get()
  if (routes) routes.open(presence)
  else acp.activate(presence.key)
}
