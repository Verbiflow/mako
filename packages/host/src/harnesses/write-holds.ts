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
 * Where the person's own code runs beside Mako's hook (`attend`'s `everyTool`: their hooks, plugins or helper commands
 * in a Claude Code session), the message still goes at once, and every tool waits, reads included (`beforeTool`), so
 * nothing their code does after a tool runs ahead of the checkpoint either. Their code that runs with no tool, or
 * beside Mako's hook rather than after it (a SessionStart, UserPromptSubmit or Stop hook, their own hook on a tool, a
 * status line), isn't held: a write it makes before the checkpoint holds the workspace lands in the checkpoint, not
 * in the turn's changes. That is the person's choice of 2026-11-17, over every send waiting for the checkpoint.
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
  /** Bindings whose every tool waits, not only those that may write (`attend`'s `everyTool`). */
  private readonly everyTool = new Set<string>()
  private readonly holds = new Map<string, TurnHold>()

  /**
   * The binding's launch passes every write through `beforeWrite`, or doesn't (`held` false), until it's forgotten.
   * `everyTool`: the person's own code runs beside Mako's hook, so its tools that never write wait too (`beforeTool`).
   */
  attend(binding: string, held: boolean, options: { everyTool?: boolean } = {}): void {
    if (held) this.attended.add(binding)
    else this.attended.delete(binding)
    if (held && options.everyTool) this.everyTool.add(binding)
    else this.everyTool.delete(binding)
  }

  /** Whether the binding's writes are held: a turn of it may go before its checkpoint holds the workspace. */
  attends(binding: string): boolean {
    return this.attended.has(binding)
  }

  /** Its launch ended. */
  forget(binding: string): void {
    this.attended.delete(binding)
    this.everyTool.delete(binding)
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
   *
   * `withinMs`: where the harness lets the tool go on its own past a time (a command hook's timeout), Mako lets it go
   * first, so the write it then makes is counted as early rather than missed.
   */
  async beforeWrite(binding: string, signal?: AbortSignal, withinMs?: number): Promise<void> {
    const early = await this.wait(binding, signal, withinMs)
    early?.wrote()
  }

  /**
   * Before a tool that never writes runs: where the binding holds every tool (`attend`'s `everyTool`), it waits as a
   * write does, but going before the checkpoint held the workspace doesn't make it late, since the tool itself wrote
   * nothing. Elsewhere it goes at once.
   */
  async beforeTool(binding: string, signal?: AbortSignal): Promise<void> {
    if (this.everyTool.has(binding)) await this.wait(binding, signal)
  }

  /** Waits while the binding's turn holds; the hold it waited on when it was let go, uncancelled, before that held. */
  private async wait(binding: string, signal?: AbortSignal, withinMs?: number): Promise<TurnHold | undefined> {
    const hold = this.holds.get(binding)
    if (!hold || hold.frozen()) return undefined
    if (signal?.aborted) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = () => {}
    await new Promise<void>((resolve) => {
      cancel = () => {
        cancelled = true
        resolve()
      }
      signal?.addEventListener("abort", cancel, { once: true })
      if (withinMs !== undefined) timer = setTimeout(resolve, withinMs)
      void hold.until.then(resolve)
    }).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    })
    return !cancelled && !hold.frozen() ? hold : undefined
  }
}
