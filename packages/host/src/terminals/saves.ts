/**
 * When the terminal daemon saves its sessions: within `delayMs` of a change, once for everything changed meanwhile,
 * and never on a timer with nothing changed. One save runs at a time; a change made while one runs is saved by the
 * next, which goes once that one ends, so a slow save never leaves a change unsaved until the daemon stops.
 */
export class TerminalSaves {
  readonly #write: () => Promise<void>
  readonly #delayMs: number
  #dirty = false
  #timer: NodeJS.Timeout | undefined
  #saving: Promise<void> | null = null

  /** `write` saves what the daemon holds now; a rejection means it wasn't saved and goes again. */
  constructor(write: () => Promise<void>, delayMs: number) {
    this.#write = write
    this.#delayMs = delayMs
  }

  /** Something changed: a save goes within `delayMs`. */
  changed(): void {
    this.#dirty = true
    if (this.#timer || this.#saving) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.save()
    }, this.#delayMs)
    this.#timer.unref()
  }

  /** Saves what changed, or, with `force`, whatever there is; waits for a save under way first. */
  async save(force = false): Promise<void> {
    if (this.#saving) {
      await this.#saving
      // The save that ended takes what changed meanwhile itself (below); a forced one goes now regardless.
      if (!force) return
    }
    if (!this.#dirty && !force) return
    this.#dirty = false
    this.#saving = this.#write()
      .catch(() => {
        // Not saved: it goes again.
        this.#dirty = true
      })
      .finally(() => {
        this.#saving = null
        // What changed while it ran, or what it failed to save, goes next.
        if (this.#dirty) this.changed()
      })
    return this.#saving
  }

  stop(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
