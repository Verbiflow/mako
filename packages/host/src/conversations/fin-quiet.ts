import { QUIET_MS } from "../contracts/children.js"

export interface QuietWatchDeps {
  now(): number
  /** A timer that runs `run` once after `ms`, and its cancel (`AgentsDeps.later`). */
  later(ms: number, run: () => void): () => void
  /**
   * Whether the Fin reads as working now on Mako's live driver, with nothing that explains a pause (the person's
   * answer, its own Fins, its move): the only Fins whose quiet means anything. Read when a deadline comes, never on activity.
   */
  working(child: string): boolean
  /** The tree a Fin is in, by its top Apex: each tree has one deadline. Asked once a Fin. */
  tree(child: string): string
  /** A working Fin had no activity since `since`, for at least `QUIET_MS`: its Apex hears it, once a quiet stretch. */
  quiet(child: string, since: number): void
  /** A quiet stretch it told of ended: the Fin did something, or left work. How it reads changes back. */
  heard?(child: string): void
  quietMs?: number
}

/**
 * Notices a Fin that reads as working and does nothing. The live engine's activity (its output, a step, a turn
 * starting, a report) stamps the Fin's last moment, which costs a map write and nothing else; a tree's one timer waits
 * for the earliest moment any of its Fins would have been quiet for `QUIET_MS`. Then each Fin past it that still works
 * is told once for that quiet stretch, and the timer waits for the next. Activity after a notice starts a new stretch,
 * which may be told again. A Fin that stopped working (its turn ended, it's idle, stopped or ended) leaves the watch
 * when its deadline comes, told nothing. No polling: no timer runs for a tree with no Fin heard from.
 */
export class QuietWatch {
  private readonly deps: QuietWatchDeps
  private readonly quietMs: number
  /** Each watched Fin's last activity. */
  private readonly last = new Map<string, number>()
  /** The quiet stretch each Fin was told of, by the activity it began after. */
  private readonly told = new Map<string, number>()
  /** Each watched Fin's tree, and each tree's Fins. */
  private readonly treeOf = new Map<string, string>()
  private readonly members = new Map<string, Set<string>>()
  /** Each tree's deadline and its cancel. */
  private readonly deadlines = new Map<string, { at: number; cancel: () => void }>()
  private stopped = false

  constructor(deps: QuietWatchDeps) {
    this.deps = deps
    this.quietMs = deps.quietMs ?? QUIET_MS
  }

  /** A Fin did something: its quiet starts again from `at`. */
  activity(child: string, at = this.deps.now()): void {
    if (this.stopped) return
    const wasQuiet = this.quietSince(child) !== undefined
    this.last.set(child, at)
    if (wasQuiet) this.deps.heard?.(child)
    let tree = this.treeOf.get(child)
    if (tree === undefined) {
      tree = this.deps.tree(child)
      this.treeOf.set(child, tree)
      let members = this.members.get(tree)
      if (!members) this.members.set(tree, (members = new Set()))
      members.add(child)
    }
    // A deadline already set comes no later than this one: it re-reads every Fin of the tree when it does.
    if (!this.deadlines.has(tree)) this.arm(tree, at + this.quietMs)
  }

  /** A Fin left work (its turn ended, it stopped): it's no longer watched. */
  forget(child: string): void {
    const wasQuiet = this.quietSince(child) !== undefined
    const tree = this.treeOf.get(child)
    this.last.delete(child)
    this.told.delete(child)
    this.treeOf.delete(child)
    if (wasQuiet) this.deps.heard?.(child)
    if (tree === undefined) return
    const members = this.members.get(tree)
    members?.delete(child)
    if (members?.size) return
    this.members.delete(tree)
    this.deadlines.get(tree)?.cancel()
    this.deadlines.delete(tree)
  }

  /**
   * When the quiet stretch it told of began, while that stretch holds: nothing from the Fin since, past `QUIET_MS`.
   * Undefined before the window or once the Fin did anything, so a row reading it is never quiet longer than it is.
   */
  quietSince(child: string): number | undefined {
    const last = this.last.get(child)
    return last !== undefined && this.told.get(child) === last ? last : undefined
  }

  /** Whether the quiet stretch that began at `since` still holds: nothing from the Fin since, and it still works. */
  stillQuiet(child: string, since: number): boolean {
    return this.last.get(child) === since && this.deps.working(child)
  }

  /** How many trees have a deadline set: what a test reads to see that nothing waits. */
  get waiting(): number {
    return this.deadlines.size
  }

  stop(): void {
    this.stopped = true
    for (const { cancel } of this.deadlines.values()) cancel()
    this.deadlines.clear()
  }

  private arm(tree: string, at: number): void {
    const cancel = this.deps.later(Math.max(0, at - this.deps.now()), () => this.due(tree))
    this.deadlines.set(tree, { at, cancel })
  }

  private due(tree: string): void {
    this.deadlines.delete(tree)
    if (this.stopped) return
    const now = this.deps.now()
    let next = Infinity
    // Who stopped working leaves after the walk: forgetting changes the tree's set.
    const left: string[] = []
    for (const child of this.members.get(tree) ?? []) {
      const last = this.last.get(child)
      if (last === undefined) continue
      if (!this.deps.working(child)) {
        left.push(child)
        continue
      }
      const at = last + this.quietMs
      if (at > now) {
        next = Math.min(next, at)
        continue
      }
      if (this.told.get(child) === last) continue
      this.told.set(child, last)
      this.deps.quiet(child, last)
    }
    for (const child of left) this.forget(child)
    if (next !== Infinity && this.members.has(tree)) this.arm(tree, next)
  }
}
