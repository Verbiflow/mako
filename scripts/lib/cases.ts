/**
 * Runs a test file's cases in order, each known by its function's name: all of them, or only those `CASES` names
 * (comma-separated), so CI can spread one long file over several shards (`ci-gate.mjs`). `CASES_TIMED=1` prints each
 * case's time, which is how those shards are sized. A name no case has is refused, so a renamed case can't drop out of
 * CI unnoticed.
 */
export async function runCases(cases: readonly (() => void | Promise<void>)[], passed?: (name: string) => void): Promise<void> {
  const named = process.env.CASES?.split(",").map((each) => each.trim()).filter(Boolean)
  const unknown = named?.filter((name) => !cases.some((test) => test.name === name)) ?? []
  if (unknown.length) throw new Error(`CASES names no case ${unknown.join(", ")}; there are ${cases.map((test) => test.name).join(", ")}`)
  for (const test of cases) {
    if (named?.length && !named.includes(test.name)) continue
    const began = performance.now()
    await test()
    passed?.(test.name)
    if (process.env.CASES_TIMED) console.log(`case ${test.name}: ${Math.round(performance.now() - began)} ms`)
  }
}
