// Explicit fixture page: /scripts/highlight-pool.html, for test-highlight-pool-ui.mjs. Never imported by Mako.
import { Suspense, useContext } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { WorkerPoolContext } from "@pierre/diffs/react"
import type { WorkerPoolManager } from "@pierre/diffs/worker"
import { HighlightPool, IDLE_MS } from "@/lib/highlight-pool"

/**
 * The real pool's lifetime under React: a render that reads it and never commits (it suspends and its root goes), a
 * view that commits and holds it, and that view leaving. The pool's idle waits are held here rather than run, so each
 * step can say which are pending, and run them.
 */
async function check() {
  const pending = new Map<number, () => void>()
  let next = 1
  const setTimer = window.setTimeout
  const clearTimer = window.clearTimeout
  // SAFETY: setTimeout's own shape: a callback, its delay, its arguments; the pool's idle waits are held, the rest pass.
  window.setTimeout = ((run: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== IDLE_MS) return setTimer(run, ms, ...rest)
    const id = next++
    pending.set(id, () => run())
    return id
  }) as typeof window.setTimeout
  // SAFETY: clearTimeout's own shape: an id this check made, or one the window's timer did.
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined && pending.delete(id)) return
    clearTimer(id)
  }) as typeof window.clearTimeout
  const elapse = () => {
    const due = [...pending.values()]
    pending.clear()
    for (const run of due) run()
  }
  const workers = (pool: WorkerPoolManager | undefined) => pool?.getStats().totalWorkers ?? 0
  const host = document.createElement("div")
  document.body.append(host)
  let seen: WorkerPoolManager | undefined
  function Read({ suspend }: { suspend: boolean }) {
    seen = useContext(WorkerPoolContext)
    if (suspend) throw new Promise(() => {})
    return <span>held</span>
  }
  try {
    let root = createRoot(host)
    flushSync(() => root.render(<Suspense fallback={null}><HighlightPool><Read suspend /></HighlightPool></Suspense>))
    const abandoned = seen
    await abandoned?.initialize()
    flushSync(() => root.unmount())
    const afterAbandoned = { workers: workers(abandoned), pending: pending.size }
    elapse()
    const abandonedExpired = { workers: workers(abandoned) }

    root = createRoot(host)
    flushSync(() => root.render(<HighlightPool><Read suspend={false} /></HighlightPool>))
    const held = seen
    await held?.initialize()
    elapse()
    const whileHeld = { workers: workers(held), pending: pending.size }
    flushSync(() => root.unmount())
    const afterLeaving = { pending: pending.size }
    elapse()
    const leftExpired = { workers: workers(held) }
    return { afterAbandoned, abandonedExpired, whileHeld, afterLeaving, leftExpired }
  } finally {
    window.setTimeout = setTimer
    window.clearTimeout = clearTimer
    host.remove()
  }
}

async function run() {
  try {
    return await check()
  } catch (error) {
    return { error: String(error) }
  }
}

Reflect.set(window, "poolCheck", run())
