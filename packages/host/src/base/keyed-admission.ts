/** The record `open` found under way to join, or made. */
export interface Opened<R> {
  record: R
  joined: boolean
}

/**
 * Admission of keyed work into bounded room, as Fin starts and build slots both take it. Each operation has one
 * record per key, made before its first await, so a repeat of the key joins it rather than starting again; only the
 * record itself gives its key back (`retire`), so a late settle can't free what its successor holds. Nothing is
 * granted until what the last host left running is counted (`recovered`), and room a release frees goes to what
 * waits in the same tick, by the owner's own drain.
 */
export class KeyedAdmission<R> {
  readonly #keyOf: (record: R) => string
  readonly #live = new Map<string, R>()
  #recovered = false
  #recover: () => void = () => {}
  /** Settles once what the last host left is counted: a grant waits for it. */
  readonly recovery: Promise<void>

  constructor(keyOf: (record: R) => string) {
    this.#keyOf = keyOf
    this.recovery = new Promise<void>((resolve) => (this.#recover = resolve))
  }

  /** The operation under way for `key`, to join, or `make`'s, in place now: open it before awaiting anything. */
  open(key: string, make: () => R): Opened<R> {
    const live = this.#live.get(key)
    if (live) return { record: live, joined: true }
    const record = make()
    this.#live.set(key, record)
    return { record, joined: false }
  }

  /** Gives `record`'s key back while it's still its own; false once another record holds it. */
  retire(record: R): boolean {
    const key = this.#keyOf(record)
    if (this.#live.get(key) !== record) return false
    this.#live.delete(key)
    return true
  }

  get(key: string): R | undefined {
    return this.#live.get(key)
  }

  has(key: string): boolean {
    return this.#live.has(key)
  }

  values(): IterableIterator<R> {
    return this.#live.values()
  }

  get size(): number {
    return this.#live.size
  }

  /** What the last host left is counted: from now on room may be granted. */
  recovered(): void {
    if (this.#recovered) return
    this.#recovered = true
    this.#recover()
  }

  get isRecovered(): boolean {
    return this.#recovered
  }
}
