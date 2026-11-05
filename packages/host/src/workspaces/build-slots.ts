/** Who holds or waits for a build slot: a check run, by its app and tier, and how the person reads it. */
export interface BuildHolder {
  key: string
  /** "the full check of fin:deploy's Thread". */
  label: string
}

/** How the slots stand, as a waiting check and a shell's note say it. */
export interface BuildSlotsReading {
  slots: number
  holders: string[]
  waiting: number
}

/** A place in line: `granted` resolves once the slot is this holder's; `cancel` leaves the line, or frees a slot held. */
export interface BuildTicket {
  granted: Promise<void>
  /** How many wait ahead of it now; 0 once it holds a slot. */
  ahead(): number
  held(): boolean
  release(): void
}

/**
 * The host's build slots (`fin-capacity.ts` keeps room for a few builds beside the Fins): a check run takes one for as
 * long as it runs, and the rest wait in line, first come first served across every Thread. A slot that frees, or one
 * more slot, goes to the next in line in the same tick, never by a timer. A holder already in line or holding is the
 * same ticket again, so a check called twice waits once.
 */
export class BuildSlots {
  readonly #size: () => number
  readonly #holding = new Map<string, Entry>()
  readonly #line: Entry[] = []

  constructor(size: () => number) {
    this.#size = size
  }

  take(holder: BuildHolder): BuildTicket {
    const known = this.#holding.get(holder.key) ?? this.#line.find((entry) => entry.holder.key === holder.key)
    if (known) return known.ticket
    let grant!: () => void
    const granted = new Promise<void>((resolve) => (grant = resolve))
    const entry: Entry = {
      holder,
      grant,
      ticket: {
        granted,
        ahead: () => Math.max(0, this.#line.indexOf(entry)),
        held: () => this.#holding.get(holder.key) === entry,
        release: () => this.#release(entry),
      },
    }
    this.#line.push(entry)
    this.#fill()
    return entry.ticket
  }

  /** Frees `key`'s slot or its place in line: its run ended, or never started. */
  release(key: string): void {
    const entry = this.#holding.get(key) ?? this.#line.find((each) => each.holder.key === key)
    if (entry) this.#release(entry)
  }

  /** Whether `key` holds a slot or waits for one. */
  has(key: string): boolean {
    return this.#holding.has(key) || this.#line.some((entry) => entry.holder.key === key)
  }

  /** How many wait ahead of `key`; 0 when it holds one or isn't in line. */
  ahead(key: string): number {
    return Math.max(0, this.#line.findIndex((entry) => entry.holder.key === key))
  }

  /** There may be more slots now: the next in line take them at once. */
  changed(): void {
    this.#fill()
  }

  reading(): BuildSlotsReading {
    return { slots: this.#slots(), holders: [...this.#holding.values()].map((entry) => entry.holder.label), waiting: this.#line.length }
  }

  #release(entry: Entry): void {
    if (this.#holding.get(entry.holder.key) === entry) this.#holding.delete(entry.holder.key)
    else {
      const at = this.#line.indexOf(entry)
      if (at >= 0) this.#line.splice(at, 1)
    }
    this.#fill()
  }

  #fill(): void {
    while (this.#line.length && this.#holding.size < this.#slots()) {
      const next = this.#line.shift()!
      this.#holding.set(next.holder.key, next)
      next.grant()
    }
  }

  #slots(): number {
    return Math.max(1, Math.floor(this.#size()))
  }
}

interface Entry {
  holder: BuildHolder
  grant: () => void
  ticket: BuildTicket
}
