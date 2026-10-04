/**
 * The agents Mako hands work to, best first: the person's pick while it is
 * signed in, then the signed-in agents by when this Mac last used them, then
 * by each harness's declared first-run priority. Setting a project up,
 * naming Threads and drafting commit messages all read this one order; they
 * differ only in the model each asks its agent for.
 */
export function agentOrder(input: {
  signedIn: readonly string[]
  priority: Readonly<Record<string, number>>
  /** Harnesses by most recent use, most recent first; repeats are ignored. */
  recent?: readonly string[]
  picked?: string
}): string[] {
  const signedIn = new Set(input.signedIn)
  const order: string[] = []
  const add = (harness: string | undefined) => {
    if (harness && signedIn.has(harness) && !order.includes(harness)) order.push(harness)
  }
  add(input.picked)
  for (const harness of input.recent ?? []) add(harness)
  const rank = (harness: string) => input.priority[harness] ?? Number.POSITIVE_INFINITY
  for (const harness of [...signedIn].sort((left, right) => rank(left) - rank(right))) add(harness)
  return order
}

/** Each harness once, by its rows' latest `updatedAt`, most recent first. */
export function harnessesByRecency(rows: Iterable<{ harness: string; updatedAt?: string }>): string[] {
  const latest = new Map<string, string>()
  for (const row of rows) {
    const at = row.updatedAt ?? ""
    const seen = latest.get(row.harness)
    if (seen === undefined || seen < at) latest.set(row.harness, at)
  }
  return [...latest].sort(([, left], [, right]) => right.localeCompare(left)).map(([harness]) => harness)
}
