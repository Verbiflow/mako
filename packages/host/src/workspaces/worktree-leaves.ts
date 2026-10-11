interface Deps {
  /** Whether nothing in the conversation keeps it from moving now: its turn and what it was finishing have ended, or it closed. */
  quiet(conversationId: string): boolean
  remove(path: string): Promise<void>
  removed(): void
  failed(message: string): void
}

/**
 * Agents' removals of the worktree they work in. The agent is mid-turn when
 * it asks, so the removal waits for its turn to end, as an agent's move into
 * a worktree does; then the checkout's conversations go on in the main
 * checkout and the worktree goes (`ThreadWorktreeService.remove`).
 */
export class WorktreeLeaves {
  private readonly pending = new Map<string, string>()
  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  /** Remove the worktree at `path` once this conversation is quiet. */
  ask(conversationId: string, path: string): void {
    this.pending.set(conversationId, path)
    this.settled(conversationId)
  }

  /** A conversation changed: a removal waiting on it goes ahead once it's quiet. */
  settled(conversationId: string): void {
    const path = this.pending.get(conversationId)
    if (!path || !this.deps.quiet(conversationId)) return
    this.pending.delete(conversationId)
    void this.deps.remove(path).then(
      () => this.deps.removed(),
      (error: Error) => this.deps.failed(`This Thread's worktree wasn't removed. ${error.message}`),
    )
  }
}
