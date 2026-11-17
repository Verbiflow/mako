import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * The host's link: there, or lost since `since`, with the transport's own words kept for diagnosis, not shown.
 * `stage` is how the window speaks of a loss: `quiet` at first, `long` past `RECONNECT_QUIET_MS`, `restart` past
 * `RESTART_AFTER_MS` or once the client found no host to reach (`gone`).
 */
type HostConnection =
  | { kind: "connected" }
  | { kind: "disconnected"; message: string; since: number; stage: ReconnectStage; gone?: true }
export type ReconnectStage = "quiet" | "long" | "restart"
export const hostConnectionStore = createStore<HostConnection>({
  kind: "connected",
})
export const useHostConnection = createHook(hostConnectionStore)

/**
 * How long the window says only "Reconnecting…" in its title bar before it says more: Mako reconnects and replays
 * what the window missed on its own, so a short drop is no news. Past it, one notice says it's still trying, with
 * Try now (as T3 Code's connection notice offers Retry now).
 */
export const RECONNECT_QUIET_MS = 10_000
/** Lost this long, trying again hasn't brought it back: the notice offers Restart Mako instead. */
export const RESTART_AFTER_MS = 60_000

/**
 * The link lost (`message`): kept from the first loss, so a second word while it's still lost doesn't restart the
 * wait. `gone`: the client found no host to reach, so the notice offers a restart at once.
 */
export function hostDisconnected(message: string, gone?: true): void {
  const held = hostConnectionStore.get()
  if (held.kind === "disconnected") {
    hostConnectionStore.set({ ...held, message, ...(gone && { gone, stage: "restart" }) })
    return
  }
  const since = Date.now()
  hostConnectionStore.set({ kind: "disconnected", message, since, stage: gone ? "restart" : "quiet", ...(gone && { gone }) })
  // Each bound moves the same loss on a stage; back meanwhile, or lost again since, says nothing.
  const later = (ms: number, stage: ReconnectStage) =>
    setTimeout(() => {
      const now = hostConnectionStore.get()
      if (now.kind === "disconnected" && now.since === since && rank(now.stage) < rank(stage)) hostConnectionStore.set({ ...now, stage })
    }, ms)
  later(RECONNECT_QUIET_MS, "long")
  later(RESTART_AFTER_MS, "restart")
}

const rank = (stage: ReconnectStage) => (stage === "quiet" ? 0 : stage === "long" ? 1 : 2)

/** How the window speaks of the link: connected, or a loss's stage. */
export function useReconnectStage(): ReconnectStage | undefined {
  return useHostConnection((state) => (state.kind === "disconnected" ? state.stage : undefined))
}

/** Try now: the client reconnects at once rather than at its next backoff, or waits on the try under way. No reload. Settles with that try. */
export async function reconnectHostNow(): Promise<void> {
  if (hasBridge()) await getMako().reconnectHost().catch(() => undefined)
}

/** Restart Mako: drafts saved, the client quits and opens again, attaching to its host or starting one. */
export function restartMako(): void {
  if (hasBridge()) void getMako().restartClient()
}
