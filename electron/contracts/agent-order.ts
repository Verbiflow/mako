/**
 * The signed-in harnesses, best first: those in `recent` (most recent first)
 * ahead of the rest, then by `order`, the person's harness order
 * (`harness-defaults.ts`). Setting a project up, naming Threads and drafting
 * commit messages pass no `recent`; the composer's first pick passes this
 * Mac's history.
 */
export function agentOrder(input: {
  signedIn: readonly string[]
  order: readonly string[]
  /** Harnesses by most recent use, most recent first; repeats are ignored. */
  recent?: readonly string[]
}): string[] {
  const signedIn = new Set(input.signedIn)
  const order: string[] = []
  const add = (harness: string) => {
    if (signedIn.has(harness) && !order.includes(harness)) order.push(harness)
  }
  for (const harness of input.recent ?? []) add(harness)
  for (const harness of input.order) add(harness)
  for (const harness of input.signedIn) add(harness)
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
