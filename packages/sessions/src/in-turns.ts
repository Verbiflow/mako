/**
 * `work` over `items`, at most `limit` at once. A failure starts nothing new, waits for everything already started to
 * settle, and only then rejects with the first error: a caller that answers a failure (a restore reporting it, a retry)
 * must not do so while writes it started are still landing. As `@mako/host`'s `mapLimit`, which this package can't import.
 */
export async function inTurns<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failure: { error: unknown } | undefined
  const turn = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!
      try {
        await work(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, turn))
  if (failure) throw failure.error
}
