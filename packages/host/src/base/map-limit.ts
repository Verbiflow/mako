/**
 * `map` over `values` with at most `limit` running at once, results in order.
 *
 * A failure stops new work from starting, waits for every call already started to settle, and only then rejects with
 * the first error. A caller that cleans up after a failure (a move's rollback, a checkpoint's scratch folder) must see
 * the final state of everything it started: when this rejected at the first error, as `Promise.all` does, a move's
 * undo read a file whose write was still in flight, found nothing to put back, and the write then landed after the
 * rollback said every file was restored (test-turn-review, 15 of 30 runs on a 2-CPU Linux runner).
 */
export async function mapLimit<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async () => {
    while (!failure && next < values.length) {
      const index = next++
      try {
        results[index] = await map(values[index]!)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  if (failure) throw failure.error
  return results
}
