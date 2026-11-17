/** How the bench's host ended, apart from the bench's own process and its performance budgets. */
export interface HostLoadExit {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

/** `--report-only` relaxes performance budgets; a host that crashed or didn't quit always fails the run (#760). */
export function hostLoadOutcome(exit: HostLoadExit, budgetFailures: readonly string[], reportOnly: boolean) {
  const failedExit = exit.timedOut ? "the host did not exit within its shutdown deadline"
    : exit.code !== 0 || exit.signal !== null ? `the host exited with code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"}` : undefined
  return {
    failures: failedExit ? [...budgetFailures, failedExit] : [...budgetFailures],
    code: failedExit || (!reportOnly && budgetFailures.length) ? 1 : 0,
  }
}
