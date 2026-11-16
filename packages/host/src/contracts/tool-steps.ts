/**
 * A running `mako-computer` `js` call's progress: the calls its program made
 * so far, the newest few with where each stands, and how many in all. It's
 * the whole state each time (`ControlSteps` in `@mako/control/program`, which
 * this must equal), at most one every `STEPS_EVERY_MS`, so the newest
 * replaces every one before it.
 */
export interface ToolStep {
  /** "activate e12", "screenshot", "navigate". */
  call: string
  phase: "running" | "done" | "failed"
  /** The same call made again and again in a row, as one step. */
  times?: number
}

export interface ToolSteps {
  /** The newest steps, oldest first. */
  steps: ToolStep[]
  /** Every call the program made so far, those no longer listed too. */
  total: number
}
