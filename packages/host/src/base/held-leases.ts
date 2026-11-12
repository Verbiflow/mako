import type { Lease } from "@mako/protocol/borrow"

/** How many ended leases are remembered against late word of them. */
const ENDED_KEPT = 256

/** A point in a holder's changes: what an async step began at, so its result can be fenced against what came since. */
export type HeldGeneration = number

/**
 * The leases a place holds, as either side of borrowing holds them (the source serving, the borrower using), under one
 * set of lifecycle rules:
 * - every async step (an acquisition, a renewal, a re-read of the broker's list) takes a generation as it begins, and
 *   its result counts only while nothing it would undo happened since (`take` with that generation);
 * - a lease that ended here stays ended: late word of it (its issue, its renewal) holds nothing;
 * - a lease held again only adopts a later expiry, the broker's renewal, never an earlier one, and takes no other place;
 * - a lease past its expiry ends here, whether or not anyone said so (`expired`);
 * - a release is kept until the broker confirms it (`releasing`, `released`), so a failed one can be tried again.
 */
export class HeldLeases {
  readonly #held = new Map<string, { lease: Lease; at: HeldGeneration }>()
  readonly #ended = new Set<string>()
  readonly #releasing = new Set<string>()
  #generation: HeldGeneration = 0

  /** Now, as a generation: what an async step begins at. */
  begin(): HeldGeneration {
    return this.#generation
  }

  /**
   * Holds `lease`, as word of it arrives: `held` when it's new here, `renewed` when held already and this is a later
   * expiry, `same` when held already and it isn't. `stale` when it ended here, has expired, or when `since` is given and
   * the holder changed since (a release, an end, another lease taken): what began then can't hold anything now.
   */
  take(lease: Lease, now: number, since?: HeldGeneration): "held" | "renewed" | "same" | "stale" {
    if (this.#ended.has(lease.id) || (since !== undefined && since !== this.#generation)) return "stale"
    const held = this.#held.get(lease.id)
    if (held) {
      if (lease.expiresAt <= held.lease.expiresAt) return "same"
      held.lease = lease
      return "renewed"
    }
    if (lease.expiresAt <= now) return "stale"
    this.#generation += 1
    this.#held.set(lease.id, { lease, at: this.#generation })
    return "held"
  }

  /** A lease ends here, held or not yet: what it held is returned, and later word of it holds nothing. */
  end(lease: string): Lease | undefined {
    this.#generation += 1
    this.#ended.add(lease)
    if (this.#ended.size > ENDED_KEPT) this.#ended.delete(this.#ended.values().next().value!)
    const held = this.#held.get(lease)
    this.#held.delete(lease)
    return held?.lease
  }

  /** Every step under way is fenced off: nothing it brings back is held (a release, a close). */
  invalidate(): void {
    this.#generation += 1
  }

  /** The held leases past their expiry, ended here and returned. */
  expired(now: number): Lease[] {
    return [...this.#held.values()].filter(({ lease }) => lease.expiresAt <= now).map(({ lease }) => this.end(lease.id)!)
  }

  /** The held leases taken before `since`: what a list read from then can say ended. */
  heldBefore(since: HeldGeneration): Lease[] {
    return [...this.#held.values()].filter(({ at }) => at <= since).map(({ lease }) => lease)
  }

  get(lease: string): Lease | undefined {
    return this.#held.get(lease)?.lease
  }

  has(lease: string): boolean {
    return this.#held.has(lease)
  }

  ended(lease: string): boolean {
    return this.#ended.has(lease)
  }

  leases(): Lease[] {
    return [...this.#held.values()].map(({ lease }) => lease)
  }

  /** A release asked of the broker: kept until it's confirmed, so a failure can be tried again. */
  releasing(lease: string): void {
    this.#releasing.add(lease)
  }

  /** The broker confirmed a release, or the lease is known ended there. */
  released(lease: string): void {
    this.#releasing.delete(lease)
  }

  /** The releases not yet confirmed. */
  unreleased(): string[] {
    return [...this.#releasing]
  }
}
