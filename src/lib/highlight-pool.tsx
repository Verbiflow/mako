import type { ReactNode } from "react"
import { WorkerPoolContextProvider } from "@pierre/diffs/react"
import HighlightWorker from "@pierre/diffs/worker/worker.js?worker"
import { DIFF_THEME } from "@/lib/diff-theme"

/**
 * Highlighting off the window's thread: the file viewer's source is tokenized in a small pool of workers, so a
 * twenty-thousand-line file scrolls while its colours arrive, and the window never waits on the highlighter. The
 * renderer draws the plain text first and the tokens as each worker answers.
 */
const poolOptions = {
  workerFactory: () => new HighlightWorker(),
  poolSize: Math.max(1, Math.min(3, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2))),
}
const highlighterOptions = { theme: DIFF_THEME }

export function HighlightPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  )
}
