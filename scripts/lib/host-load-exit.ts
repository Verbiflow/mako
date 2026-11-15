/** The actual host exit, distinct from the benchmark process and its performance budgets. */
export interface HostLoadExit {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

/** Report-only relaxes performance budgets; a crashed or unclosed host is always a failed run. */
export function hostLoadOutcome(exit: HostLoadExit, budgetFailures: readonly string[], reportOnly: boolean) {
  const failedExit = exit.timedOut ? "the host did not exit within its shutdown deadline"
    : exit.code !== 0 || exit.signal !== null ? `the host exited with code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"}` : undefined
  return {
    failures: failedExit ? [...budgetFailures, failedExit] : [...budgetFailures],
    code: failedExit || (!reportOnly && budgetFailures.length) ? 1 : 0,
  }
}
