import { useSyncExternalStore, type ReactNode } from "react"
import { WorkerPoolContext } from "@pierre/diffs/react"
import { WorkerPoolManager } from "@pierre/diffs/worker"
import HighlightWorker from "@pierre/diffs/worker/worker.js?worker"
import { DIFF_THEME } from "@/lib/diff-theme"

/**
 * Highlighting off the window's thread: every view that draws code (the file viewer, the Changes panel's diffs, the
 * review's) tokenizes in one small pool of workers, so a twenty-thousand-line file scrolls while its colours arrive
 * and opening a Thread never waits on its diff's highlighting. The renderer draws the plain text first and the tokens
 * as each worker answers. The pool outlives its last view by `IDLE_MS`: closing a file and opening the next, or
 * moving between Threads, keeps the workers and what they've highlighted rather than starting them again.
 */
const IDLE_MS = 30_000
const POOL_SIZE = Math.max(1, Math.min(3, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2)))

let shared: { pool: WorkerPoolManager; views: number; idle?: ReturnType<typeof setTimeout> } | undefined

/** The pool, made on its first read: a view's first render already highlights in it. */
function current() {
  return (shared ??= {
    pool: new WorkerPoolManager({ workerFactory: () => new HighlightWorker(), poolSize: POOL_SIZE }, { theme: DIFF_THEME }),
    views: 0,
  })
}

/** Held by each mounted view; the last to let go starts the idle wait. */
function hold(changed: () => void): () => void {
  const entry = current()
  clearTimeout(entry.idle)
  entry.idle = undefined
  entry.views += 1
  changed()
  return () => {
    entry.views -= 1
    if (entry.views > 0) return
    entry.idle = setTimeout(() => {
      entry.pool.terminate()
      if (shared === entry) shared = undefined
    }, IDLE_MS)
  }
}

export function HighlightPool({ children }: { children: ReactNode }) {
  const pool = useSyncExternalStore(hold, () => current().pool, () => undefined)
  return <WorkerPoolContext value={pool}>{children}</WorkerPoolContext>
}
