export type ComposerActionKind = "send" | "queue" | "steer" | "stop"

export function composerTurnRunning({
  builtinRunning,
  livePresent,
  liveRunning,
  liveThreadPath,
  viewingPath,
  viewingRunning,
}: {
  builtinRunning: boolean
  livePresent: boolean
  liveRunning: boolean
  liveThreadPath?: string
  viewingPath?: string
  viewingRunning: boolean
}): boolean {
  if (viewingPath && (!livePresent || viewingPath !== liveThreadPath))
    return viewingRunning
  if (livePresent) return liveRunning
  return builtinRunning
}

export function composerActionKind({
  running,
  hasContent,
  steer = false,
}: {
  running: boolean
  hasContent: boolean
  /** The running turn takes messages now and the user prefers that over queueing. */
  steer?: boolean
}): ComposerActionKind {
  if (!running) return "send"
  if (!hasContent) return "stop"
  return steer ? "steer" : "queue"
}

export type ComposerEnterAction = "queue" | "steer"

/**
 * What Enter does while a turn runs. Steering needs a running turn the
 * provider can take a message into; otherwise Enter can only queue, whatever
 * the preference says.
 */
export function composerEnterAction({
  canSteer,
  steerOnEnter,
}: {
  canSteer: boolean
  steerOnEnter: boolean
}): ComposerEnterAction {
  return canSteer && steerOnEnter ? "steer" : "queue"
}

/**
 * The empty composer's promise while a turn runs. It names the Enter action
 * first and the modifier second, so the words on screen never contradict the
 * key that sends.
 */
export function composerRunningPlaceholder(
  harness: string,
  enter: ComposerEnterAction,
  canSteer: boolean
): string {
  if (enter === "steer") return `Steer ${harness} — Cmd+Enter queues instead`
  if (canSteer) return `Queue a message for ${harness} — Cmd+Enter steers instead`
  return `Queue a message for ${harness}`
}
