/**
 * A turn's writes, held until its checkpoint holds the workspace. A harness
 * that runs Mako's code before each of its agent's tools and waits for it
 * (`ProviderLiveDriver.firstWrite`) asks here before a tool that may write;
 * the conversation's checkpoints hold that answer while the turn's "before"
 * capture is still reading the workspace. So the message goes to the agent at
 * once, and the checkpoint is still taken before anything the agent changes.
 *
 * Keyed by the provider binding a driver was started for (its
 * `conversationId`). One per host, which its harnesses and its live
 * conversations share.
 */
export class WriteHolds {
  private readonly holds = new Map<string, Promise<void>>()

  /** The binding's tools that may write wait on `until`. Returns what ends the hold; a later hold replaces it. */
  hold(binding: string, until: Promise<void>): () => void {
    this.holds.set(binding, until)
    return () => {
      if (this.holds.get(binding) === until) this.holds.delete(binding)
    }
  }

  /** Before a tool that may write runs: waits while the binding's hold stands. A binding with none goes at once. */
  beforeWrite(binding: string): Promise<void> | undefined {
    return this.holds.get(binding)
  }
}
