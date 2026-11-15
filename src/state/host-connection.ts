import { createHook, createStore } from "@/state/store"

/**
 * The host's link: there, or lost since `since`, with the transport's own words kept for diagnosis, not shown. `long`:
 * lost for `RECONNECT_QUIET_MS` or more.
 */
type HostConnection =
  { kind: "connected" } | { kind: "disconnected"; message: string; since: number; long?: true }
export const hostConnectionStore = createStore<HostConnection>({
  kind: "connected",
})
export const useHostConnection = createHook(hostConnectionStore)

/**
 * How long the window says only "Reconnecting…" in its title bar before it says more: Mako reconnects and replays
 * what the window missed on its own, so a short drop is no news. Past it, one notice says it's still trying.
 */
export const RECONNECT_QUIET_MS = 10_000

/** The link lost (`message`): kept from the first loss, so a second word while it's still lost doesn't restart the wait. */
export function hostDisconnected(message: string): void {
  const held = hostConnectionStore.get()
  if (held.kind === "disconnected") {
    hostConnectionStore.set({ ...held, message })
    return
  }
  const since = Date.now()
  hostConnectionStore.set({ kind: "disconnected", message, since })
  // Still the same loss once the quiet time has passed: say more. Back meanwhile, or lost again since, says nothing.
  setTimeout(() => {
    const now = hostConnectionStore.get()
    if (now.kind === "disconnected" && now.since === since) hostConnectionStore.set({ ...now, long: true })
  }, RECONNECT_QUIET_MS)
}

/** Whether the link has been lost for `RECONNECT_QUIET_MS` or more. */
export function useReconnectingLong(): boolean {
  return useHostConnection((state) => state.kind === "disconnected" && state.long === true)
}
