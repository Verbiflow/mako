import { utimesSync } from "node:fs"

/**
 * Sets `path`'s modification time to `ms`, never a whole second: attribution reads one as a filesystem's coarse clock
 * and dates the change by when it was heard (`tracker.ts`), so a fake clock started at `Date.now()` lands a test's save
 * on one a run in a thousand, and it reads as someone else's.
 */
export function stampFile(path: string, ms: number): void {
  const at = (ms % 1000 === 0 ? ms + 1 : ms) / 1000
  utimesSync(path, at, at)
}
