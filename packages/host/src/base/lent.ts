/** One operation this device runs for another place's Thread, under a session lease: what it is, and for whom, in words. */
export type LentOperation = { lease: string; what: string; for: string; since: number }

/**
 * What this device lends now: each session lease it serves takes one of its Fins' places (one pool, so the Mac never
 * runs more than it can between its own Fins and another place's work), and Settings › Fins says what holds it.
 */
export class LentHere {
  readonly #lent = new Map<string, LentOperation>()
  readonly #listeners = new Set<() => void>()

  /** A lease this device serves now; the same lease again changes nothing. */
  add(operation: LentOperation): void {
    if (this.#lent.has(operation.lease)) return
    this.#lent.set(operation.lease, operation)
    this.#changed()
  }

  /** The lease ended, however it ended: its place is free. */
  remove(lease: string): void {
    if (this.#lent.delete(lease)) this.#changed()
  }

  has(lease: string): boolean {
    return this.#lent.has(lease)
  }

  count(): number {
    return this.#lent.size
  }

  /** Each operation as Settings › Fins says it, oldest first: "an iOS simulator for a cloud Thread". */
  words(): string[] {
    return [...this.#lent.values()].sort((left, right) => left.since - right.since).map((operation) => `${operation.what} for ${operation.for}`)
  }

  /** Hears each change: what waits for this device's room looks again, and its advertisement says its room. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #changed(): void {
    for (const listener of this.#listeners) listener()
  }
}
