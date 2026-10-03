// A preview owns its parser. At most two document/diagnostic jobs run at once; queued jobs
// disappear when their preview closes. Neither competes with streamed prose.
let running = 0
const waiting = new Set<() => void>()
let startedJobs = 0
let releasedJobs = 0
/** Bounded public counters for acceptance checks and local debugging. */
export function fileInspectionStats() {
  return { running, queued: waiting.size, startedJobs, releasedJobs }
}
export function scheduleFileInspection(
  start: () => () => void,
  reject: () => void
): () => void {
  let active = true
  if (waiting.size >= 16) {
    queueMicrotask(() => { if (active) reject() })
    return () => { active = false }
  }
  let cancel: (() => void) | undefined
  const run = () => {
    if (!active || running >= 2) return
    waiting.delete(run)
    running++
    startedJobs++
    cancel = start()
  }
  waiting.add(run)
  queueMicrotask(run)
  return () => {
    if (!active) return
    active = false
    waiting.delete(run)
    if (!cancel) return
    cancel()
    running--
    releasedJobs++
    for (const next of waiting) {
      if (running >= 2) break
      next()
    }
  }
}
