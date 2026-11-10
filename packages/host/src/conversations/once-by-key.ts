/** How many actions a tool remembers: more than any agent repeats within a retry. */
const REMEMBERED = 512

/**
 * The first outcome of each action, by who asked and their key: a repeat gets that outcome and runs nothing, for what a
 * host call can't settle by an id of its own (an install, a run). It lives as long as the host, so a tool whose repeat
 * would cost something also says so in its replay policy.
 */
export class OnceByKey<Result> {
  readonly #outcomes = new Map<string, Promise<Result>>()

  run(key: string, act: () => Promise<Result>): Promise<Result> {
    const known = this.#outcomes.get(key)
    if (known) return known
    const outcome = act()
    this.#outcomes.set(key, outcome)
    for (const oldest of this.#outcomes.keys()) {
      if (this.#outcomes.size <= REMEMBERED) break
      this.#outcomes.delete(oldest)
    }
    return outcome
  }
}
