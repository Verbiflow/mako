import type { BrowserConnection } from "./browser-connection.js"

/** Target-local focus emulation shared by input and live capture. Never activates a tab. */
export class BrowserFocus {
  private tail: Promise<void> = Promise.resolve()
  private users = 0
  private enabled = false
  private closed = false
  private dialogOpen = false

  constructor(
    private readonly connection: Pick<BrowserConnection, "send">,
    private readonly sessionId: string
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async disable() {
    if (!this.enabled) return
    try {
      await this.connection.send(
        "Emulation.setFocusEmulationEnabled",
        { enabled: false },
        AbortSignal.timeout(2000),
        this.sessionId
      )
      this.enabled = false
    } catch (error) {
      // An unconfirmed reset cannot leave a live attachment holding fake focus.
      this.closed = true
      await this.connection
        .send(
          "Target.detachFromTarget",
          { sessionId: this.sessionId },
          AbortSignal.timeout(2000)
        )
        .catch(() => {})
      throw error
    }
  }

  /** Modal handlers block focus-reset acknowledgements. Keep the target-local
   * hold until the dialog closes; session teardown still resets or detaches. */
  setDialogOpen(open: boolean): Promise<void> {
    this.dialogOpen = open
    if (open) return Promise.resolve()
    return this.enqueue(async () => {
      if (!this.closed && !this.dialogOpen && this.users === 0)
        await this.disable()
    })
  }

  async acquire(
    signal = AbortSignal.timeout(5000)
  ): Promise<() => Promise<void>> {
    await this.enqueue(async () => {
      signal.throwIfAborted()
      if (this.closed) throw new Error("The tab's focus attachment ended")
      if (!this.enabled) {
        // A lost response may still have changed the browser. Always reset it.
        this.enabled = true
        try {
          await this.connection.send(
            "Emulation.setFocusEmulationEnabled",
            { enabled: true },
            signal,
            this.sessionId
          )
          signal.throwIfAborted()
          if (this.closed) throw new Error("The tab's focus attachment ended")
        } catch (error) {
          await this.disable().catch(() => {})
          throw error
        }
      }
      this.users++
    })
    let released = false
    return () => {
      if (released) return Promise.resolve()
      released = true
      return this.enqueue(async () => {
        if (this.closed) return
        if (--this.users === 0 && !this.dialogOpen) await this.disable()
      })
    }
  }

  close(): Promise<void> {
    this.closed = true
    return this.enqueue(async () => {
      this.users = 0
      await this.disable()
    })
  }
}
