/** Threads started from this phone a moment ago, by the ID the start answered: said as starting until they're listed. */
const startedHere = new Map<string, string>()

export function startedFromHere(threadId: string, where: string): void {
  startedHere.set(threadId, where)
}

/** Where a Thread this phone started runs, in words, while the list doesn't have it yet; a cloud start's ID says so too. */
export function startingWhere(threadId: string): string | undefined {
  return startedHere.get(threadId) ?? (threadId.startsWith("t-") ? "the cloud" : undefined)
}
