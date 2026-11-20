import { performance } from "node:perf_hooks"

/**
 * What a catalog's process is doing, by name, while it does it, and a watch on its event loop that says what was
 * under way when the loop was held. The sync daemon answers the host's requests on the same thread that writes
 * reading copies, reads exports and captures records; a request it answers late fails on the host's side as "The sync
 * daemon request timed out", which says nothing of why. 2026-10-30, a Mac logged that 35 times in a day and a half
 * outside the record store's repacks, and only correlating the logs by hand found the two holders: a 146 MB Session's
 * reading copy, written in one go, and a 342,965-row Cursor chat's exports, read a row at a time.
 */
export class WorkUnderWay {
  readonly #running = new Map<string, { count: number; since: number }>()
  /** Work begun since the watch last looked, ended or not: work that held the loop and ended within the hold. */
  readonly #begun = new Set<string>()

  /** Runs `work` named `label`: a hold of the loop while it runs names it. */
  run<Value>(label: string, work: () => Value): Value {
    if (this.#begun.size >= 64) this.#begun.clear()
    this.#begun.add(label)
    const held = this.#running.get(label)
    if (held) held.count += 1
    else this.#running.set(label, { count: 1, since: performance.now() })
    const done = () => {
      const now = this.#running.get(label)
      if (!now) return
      now.count -= 1
      if (now.count <= 0) this.#running.delete(label)
    }
    try {
      const result = work()
      if (result instanceof Promise) {
        result.then(done, done)
        return result
      }
      done()
      return result
    } catch (error) {
      done()
      throw error
    }
  }

  /**
   * What's under way now, the longest-running first, at most `most`, with what began since the watch last looked:
   * "copy claude 33db0c6d (1840 ms), request sync-status (1203 ms), push cursor 0dc59ebb".
   */
  describe(most = 4): string {
    const now = performance.now()
    const named = [...this.#running.entries()]
      .sort(([, left], [, right]) => left.since - right.since)
      .map(([label, { since }]) => `${label} (${Math.round(now - since)} ms)`)
    for (const label of this.#begun) if (!this.#running.has(label)) named.push(label)
    return named.slice(0, most).join(", ")
  }

  /** The watch looked: what began before now is no longer news. */
  looked(): void {
    this.#begun.clear()
  }
}

/** `work` named `label` where there's a `WorkUnderWay` to name it to; just `work` where there isn't. */
export function namedWork<Value>(names: WorkUnderWay | undefined, label: string, work: () => Value): Value {
  return names ? names.run(label, work) : work()
}

/** The loop is looked at this often. */
const EVERY_MS = 100
/** A look this late is a hold worth a line: a third of the host's 3 s request timeout. */
const HELD_MS = 1_000

/**
 * Watches the event loop, and says each hold of `heldMs` or more with what was under way (`WorkUnderWay`). The
 * returned function stops it. Its timer never keeps the process alive.
 */
export function watchLoop(work: WorkUnderWay, say: (ms: number, during: string) => void, options: { everyMs?: number; heldMs?: number } = {}): () => void {
  const every = options.everyMs ?? EVERY_MS
  const held = options.heldMs ?? HELD_MS
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const late = now - last - every
    last = now
    if (late >= held) say(Math.round(late), work.describe() || "nothing named")
    work.looked()
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}
