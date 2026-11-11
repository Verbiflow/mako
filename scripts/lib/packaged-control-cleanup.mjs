/** Fixture-only teardown. A timed-out close may finish later; it never schedules a later root removal here. */
export async function finishControlFixture({ owner, workers, removeRoot, primaryFailed = false, primary, report, timeoutMs = 5000 }) {
  const failures = []
  // Observe rejection immediately, even when another close is still pending.
  // This is the returned session's own exit signal, not a numeric-PID guess.
  const exit = Promise.resolve().then(() => owner?.exited).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  )
  async function attempt(stage, action) {
    let timer
    const work = Promise.resolve().then(action).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, kind: "rejected", error })
    )
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, kind: "timeout", error: new Error(`Control fixture ${stage} cleanup did not settle before its deadline`) }), timeoutMs)
    })
    try {
      const result = await Promise.race([work, deadline])
      if (!result.ok) failures.push({ stage, kind: result.kind, error: result.error })
      return result
    } finally {
      clearTimeout(timer)
    }
  }
  const closedOwner = owner ? await attempt("owner-close", () => owner.close()) : { ok: false }
  const closedWorkers = await attempt("workers-close", () => workers.close())
  const ended = await attempt("owner-exit", async () => {
    const result = await exit
    if (!result.ok) throw result.error
    return result.value
  })
  const terminationKnown = ended.ok && (ended.value === "stopped" || ended.value === "failed")
  if (ended.ok && !terminationKnown)
    failures.push({ stage: "owner-exit", kind: "unconfirmed", error: new Error("Control fixture owner termination is unconfirmed; private root retained") })

  let root = "retained"
  // A successful close alone is not proof. Even with a known exit, any close
  // failure conservatively retains the outer root for its owning controller.
  if (closedOwner.ok && closedWorkers.ok && terminationKnown) {
    const removed = await attempt("root-remove", removeRoot)
    root = removed.ok ? "removed" : "removal-unconfirmed"
  }
  const result = { failures, root, terminationKnown }
  if (report) await attempt("cleanup-report", () => report(result))
  // A separate boolean preserves every possible rejection value, including
  // undefined/null/0, without wrapping, mutating, coercing or formatting it.
  if (primaryFailed) throw primary
  if (failures.length) throw new AggregateError(failures.map(({ error }) => error), "Control fixture cleanup was incomplete")
  return result
}
