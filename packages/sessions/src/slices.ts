/**
 * Work over a whole history (a merge, a journal read, a fold of a harness's
 * store) written once as `Steps`: it stops (`yield`) every few items, and its
 * caller either runs it to the end at once (`atOnce`) or a slice at a time
 * between other work (`inSlices`). A conversation of 150MB read or merged in
 * one stretch held the host's loop for 0.3 to 1.2 seconds, and a window that
 * hears nothing that long decides its host is gone; the sync daemon's loop
 * answers the host's reads the same way.
 */
export type Steps<Result> = Generator<void, Result, void>

/** How long `inSlices` runs work before it lets other work run. */
export const SLICE_MS = 8

/** `steps` run to their end in one stretch, for a caller that can't wait. */
export function atOnce<Result>(steps: Steps<Result>): Result {
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/**
 * `steps` run a slice of `sliceMs` at a time, other work running between
 * slices. Once `stopping` says so between two slices, `StepsStopped` is
 * thrown into the steps where they stopped, so what they hold (a read
 * transaction, say) is let go as on any error, and out of here: work cut
 * by its host's stop ends at its next step, never holding the stop open.
 */
export async function inSlices<Result>(steps: Steps<Result>, sliceMs = SLICE_MS, stopping?: () => boolean): Promise<Result> {
  let until = performance.now() + sliceMs
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
    if (performance.now() >= until) {
      await new Promise((resolve) => setImmediate(resolve))
      if (stopping?.()) {
        steps.throw(new StepsStopped())
        // Steps that kept going past it stop all the same.
        throw new StepsStopped()
      }
      until = performance.now() + sliceMs
    }
  }
}

/** What `inSlices` throws, into the steps and out of itself, for work its `stopping` cut: not a failure. */
export class StepsStopped extends Error {
  constructor() {
    super("Stopped before it finished, as its host stopped")
    this.name = "StepsStopped"
  }
}
