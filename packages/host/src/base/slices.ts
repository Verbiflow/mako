/**
 * Work over a whole history (a merge, a journal read) written once as `Steps`:
 * it stops (`yield`) every few hundred items, and its caller either runs it to
 * the end at once (`atOnce`) or a slice at a time between other work
 * (`inSlices`). A conversation of 150MB read or merged in one stretch held the
 * host's loop for 0.3 to 1.2 seconds, and a window that hears nothing that long
 * decides its host is gone.
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

/** `steps` run a slice of `sliceMs` at a time, other work running between slices. */
export async function inSlices<Result>(steps: Steps<Result>, sliceMs = SLICE_MS): Promise<Result> {
  let until = performance.now() + sliceMs
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
    if (performance.now() >= until) {
      await new Promise((resolve) => setImmediate(resolve))
      until = performance.now() + sliceMs
    }
  }
}
