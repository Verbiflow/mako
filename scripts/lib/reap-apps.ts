import type { ThreadProcesses } from "@mako/host/workspaces/thread-processes"

/**
 * Stops every app a test's records still hold running, with their whole
 * process trees. Mako starts an app detached, in a process group of its own,
 * so it outlives the host that started it; it outlives a test the same way.
 * A test that failed before its own `stop`, or was stopped, left `node -e`
 * fixtures and their shell wrappers running for weeks. Await the returned
 * function in `finally`; until then a SIGINT, SIGTERM or SIGHUP (a closed
 * terminal) reaps first too.
 */
export function reapApps(processes: ThreadProcesses): () => Promise<void> {
  const reap = async () => {
    for (const app of await processes.active().catch(() => [])) await processes.stop(app.app).catch(() => [])
  }
  const signals = new Map<NodeJS.Signals, number>([["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]])
  const signalled = (signal: NodeJS.Signals) => {
    void reap().finally(() => process.exit(128 + (signals.get(signal) ?? 15)))
  }
  for (const signal of signals.keys()) process.once(signal, signalled)
  return async () => {
    for (const signal of signals.keys()) process.off(signal, signalled)
    await reap()
  }
}
