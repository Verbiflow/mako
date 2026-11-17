/**
 * A turn's writes, held until its checkpoint holds the workspace. A harness that runs Mako's code before each of its
 * agent's tools and waits for it (`ProviderLiveDriver.firstWrite`) says so per launch (`attend`), and only where
 * nothing else the person set up can write on the session's behalf. Its tools that may write then ask here first
 * (`beforeWrite`), and the conversation's checkpoints hold the answer while the turn's "before" capture still reads the
 * workspace. So the message goes to the agent at once, and the checkpoint is taken before anything the agent changes.
 *
 * A turn's checkpoint is late only if a write was let go before it held the workspace (`TurnHold.wrote`): a turn
 * that writes nothing keeps its checkpoint however long the capture takes.
 *
 * Keyed by the provider binding a driver was started for (its `conversationId`). One per host, which its harnesses and
 * its live conversations share.
 */
export interface TurnHold {
  /** What a write waits on: the checkpoint holding the workspace, its capture ending, or the longest a write waits. */
  until: Promise<void>
  /** Whether the checkpoint holds the workspace yet. */
  frozen(): boolean
  /** A write was let go before it did: the checkpoint can't be the turn's "before". */
  wrote(): void
}

export class WriteHolds {
  private readonly attended = new Set<string>()
  private readonly holds = new Map<string, TurnHold>()

  /** The binding's launch passes every write through `beforeWrite`, or doesn't (`held` false), until it's forgotten. */
  attend(binding: string, held: boolean): void {
    if (held) this.attended.add(binding)
    else this.attended.delete(binding)
  }

  /** Whether the binding's writes are held: a turn of it may go before its checkpoint holds the workspace. */
  attends(binding: string): boolean {
    return this.attended.has(binding)
  }

  /** Its launch ended. */
  forget(binding: string): void {
    this.attended.delete(binding)
    this.holds.delete(binding)
  }

  /** The binding's turn holds its writes. Returns what ends the hold; a later hold replaces it. */
  hold(binding: string, hold: TurnHold): () => void {
    this.holds.set(binding, hold)
    return () => {
      if (this.holds.get(binding) === hold) this.holds.delete(binding)
    }
  }

  /**
   * Before a tool that may write runs: waits while the binding's turn holds its writes, and says the write went
   * early if the checkpoint still didn't hold the workspace when it's let go. A tool cancelled meanwhile (`signal`)
   * goes at once and wrote nothing. A binding with no hold goes at once.
   */
  async beforeWrite(binding: string, signal?: AbortSignal): Promise<void> {
    const hold = this.holds.get(binding)
    if (!hold || hold.frozen()) return
    if (signal?.aborted) return
    let cancelled = false
    await new Promise<void>((resolve) => {
      const cancel = () => {
        cancelled = true
        resolve()
      }
      signal?.addEventListener("abort", cancel, { once: true })
      void hold.until.then(() => {
        signal?.removeEventListener("abort", cancel)
        resolve()
      })
    })
    if (!cancelled && !hold.frozen()) hold.wrote()
  }
}
