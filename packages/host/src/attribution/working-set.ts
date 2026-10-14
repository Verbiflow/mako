import { dirname } from "node:path"
import { within } from "./paths.js"

/** What the journal keeps of a call, turn or background work that says where it worked. */
export interface WorkedActivity {
  cwd?: string
  named: readonly string[]
  effects?: readonly ({ kind: string; path?: string; from?: string; to?: string; cwd?: string; named?: readonly string[] })[]
}

/** Paths one Thread's set holds at most; past it, new ones are dropped and what's held still answers. */
const MAX_PATHS = 50_000

/**
 * Where each Thread's own work has been: the paths its calls named, read or
 * wrote, each written or read file's folder, and the folders its commands
 * ran in. A change only timing ties to a Thread is its best guess when this
 * reaches the file. A Thread's set is read from the journal the first time
 * it's asked for, then kept up as its calls come in.
 */
export class WorkingSets {
  private readonly sets = new Map<string, Set<string>>()
  private readonly history?: (thread: string) => Iterable<WorkedActivity>

  constructor(history?: (thread: string) => Iterable<WorkedActivity>) {
    this.history = history
  }

  add(thread: string, activity: WorkedActivity): void {
    const set = this.set(thread)
    const keep = (path: string | undefined) => {
      if (path && set.size < MAX_PATHS) set.add(path)
    }
    const touched = (path: string | undefined) => {
      if (!path) return
      keep(path)
      keep(dirname(path))
    }
    keep(activity.cwd)
    for (const named of activity.named) keep(named)
    for (const effect of activity.effects ?? []) {
      if (effect.kind === "command") {
        keep(effect.cwd)
        for (const named of effect.named ?? []) keep(named)
      } else if (effect.kind === "rename") {
        touched(effect.from)
        touched(effect.to)
      } else touched(effect.path)
    }
  }

  /**
   * How `thread`'s work reached `path`: the path itself, or a folder holding
   * it strictly below `root`. A repository's own root is where nearly every
   * command runs, so it says nothing about one file; without a root only the
   * file's own folder counts.
   */
  reached(thread: string, path: string, root?: string): "path" | "folder" | undefined {
    const set = this.set(thread)
    if (set.has(path)) return "path"
    if (!root) return set.has(dirname(path)) ? "folder" : undefined
    for (let folder = dirname(path); folder !== root && within(root, folder); folder = dirname(folder))
      if (set.has(folder)) return "folder"
    return undefined
  }

  private set(thread: string): Set<string> {
    let set = this.sets.get(thread)
    if (set) return set
    set = new Set<string>()
    this.sets.set(thread, set)
    for (const activity of this.history?.(thread) ?? []) this.add(thread, activity)
    return set
  }
}
