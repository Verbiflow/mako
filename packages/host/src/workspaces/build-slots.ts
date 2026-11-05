import { KeyedAdmission } from "../base/keyed-admission.js"

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

/** A place in line: `granted` resolves once the slot is this holder's; `release` leaves the line, or frees a slot held. */
export interface BuildTicket {
  granted: Promise<void>
  /** How many wait ahead of it now; 0 once it holds a slot. */
  ahead(): number
  held(): boolean
  /** It holds for a run the last host left, whose exit releases it, whoever else asked for that run. */
  survivor(): boolean
  release(): void
}

/**
 * The host's build slots (`fin-capacity.ts` keeps room for a few builds beside the Fins): a check run takes one for as
 * long as it runs, and the rest wait in line, first come first served across every Thread. Each holder is admitted as
 * a Fin's start is (`KeyedAdmission`): one ticket per key, the same ticket for a repeat, given back only by itself. A
 * run the last host left still going holds its slot (`recover`) before any is granted (`recovered`), and a slot that
 * frees, or one more slot, goes to the next in line in the same tick, never by a timer.
 */
export class BuildSlots {
  readonly #size: () => number
  readonly #entries = new KeyedAdmission<Entry>((entry) => entry.holder.key)
  readonly #holding = new Set<Entry>()
  readonly #line: Entry[] = []

  constructor(size: () => number) {
    this.#size = size
  }

  take(holder: BuildHolder): BuildTicket {
    const { record, joined } = this.#entries.open(holder.key, () => this.#entry(holder))
    if (!joined) {
      this.#line.push(record)
      this.#fill()
    }
    return record.ticket
  }

  /**
   * A run the last host left that's still going: it holds a slot from now, whatever the number, until it's released.
   * A caller that asked for that run while the last host's were being counted waits in line for it, so its place
   * becomes the run's. Undefined when it's counted already, or once this host's own runs hold their keys.
   */
  recover(holder: BuildHolder): BuildTicket | undefined {
    const { record, joined } = this.#entries.open(holder.key, () => this.#entry(holder))
    if (joined) {
      if (this.#entries.isRecovered || this.#holding.has(record)) return undefined
      this.#line.splice(this.#line.indexOf(record), 1)
    }
    this.#holding.add(record)
    record.survivor = true
    record.grant()
    return record.ticket
  }

  /** Every run the last host left is counted: from now on slots are granted. */
  recovered(): void {
    this.#entries.recovered()
    this.#fill()
  }

  /** Frees `key`'s slot or its place in line: its run ended, or never started. */
  release(key: string): void {
    const entry = this.#entries.get(key)
    if (entry) this.#release(entry)
  }

  /** Whether `key` holds a slot or waits for one. */
  has(key: string): boolean {
    return this.#entries.has(key)
  }

  /** How many wait ahead of `key`; 0 when it holds one or isn't in line. */
  ahead(key: string): number {
    const entry = this.#entries.get(key)
    return entry ? Math.max(0, this.#line.indexOf(entry)) : 0
  }

  /** There may be more slots now: the next in line take them at once. */
  changed(): void {
    this.#fill()
  }

  reading(): BuildSlotsReading {
    return { slots: this.#slots(), holders: [...this.#holding].map((entry) => entry.holder.label), waiting: this.#line.length }
  }

  #entry(holder: BuildHolder): Entry {
    let grant!: () => void
    const granted = new Promise<void>((resolve) => (grant = resolve))
    const entry: Entry = {
      holder,
      grant,
      survivor: false,
      ticket: {
        granted,
        ahead: () => Math.max(0, this.#line.indexOf(entry)),
        held: () => this.#holding.has(entry),
        survivor: () => entry.survivor,
        release: () => this.#release(entry),
      },
    }
    return entry
  }

  #release(entry: Entry): void {
    if (!this.#entries.retire(entry)) return
    if (!this.#holding.delete(entry)) this.#line.splice(this.#line.indexOf(entry), 1)
    this.#fill()
  }

  #fill(): void {
    if (!this.#entries.isRecovered) return
    while (this.#line.length && this.#holding.size < this.#slots()) {
      const next = this.#line.shift()!
      this.#holding.add(next)
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
  survivor: boolean
  ticket: BuildTicket
}
