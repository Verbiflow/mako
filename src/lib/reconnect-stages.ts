/**
 * How every surface speaks of a link it lost, the desk's window and the phone alike, so the two never say different
 * things at the same moment: `quiet` at first (Mako reconnects by itself, so a short drop is no news and offers nothing
 * to press), `long` past `RECONNECT_QUIET_MS` (still trying, with Try now), `restart` past `RESTART_AFTER_MS` (trying
 * again hasn't brought it back: Restart Mako on the desk, Reload on the phone).
 */
export type ReconnectStage = "quiet" | "long" | "restart"

/** How long a loss says only "Reconnecting…", with nothing to press, before it offers Try now. */
export const RECONNECT_QUIET_MS = 10_000
/** Lost this long, trying again hasn't brought it back: a restart (the phone's reload) instead. */
export const RESTART_AFTER_MS = 60_000

/** The stage of a loss `lostFor` milliseconds old. */
export function reconnectStageAt(lostFor: number): ReconnectStage {
  if (lostFor >= RESTART_AFTER_MS) return "restart"
  if (lostFor >= RECONNECT_QUIET_MS) return "long"
  return "quiet"
}

export function reconnectStageRank(stage: ReconnectStage): number {
  return stage === "quiet" ? 0 : stage === "long" ? 1 : 2
}
