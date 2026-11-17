import type { ContinueRepository } from "@mako/protocol/continues"
import type { JobDemand } from "../base/host-jobs.js"
import { hostLog } from "../base/host-log.js"

export type ListedRepositoriesOptions = {
  /** The folder's origin on GitHub and the branch it pushes to (`folderRepository`), or null where it has none. */
  read(folder: string): Promise<ContinueRepository | null>
  /** The rows are made again: a reading moved. */
  changed(): void
  againMs: number
  /**
   * On while a branch can move under Mako's eye (a window, agents at work): read again every `againMs` only then, and
   * all at once as it comes back on, so an idle host runs no Git on a timer. Absent, always.
   */
  needed?: JobDemand
}

/**
 * Each Thread worktree's origin on GitHub and the branch it pushes to, as last read: what a cloud Thread continuing
 * one of its Sessions while this Mac is off clones. The rows ask as they're made (`of`, inside `listing`); every folder
 * their last making asked for is read again each `againMs`, so a branch pushed or tracked since is said even when
 * nothing else about its row changes, and they're made again only when a reading moved.
 */
export class ListedRepositories {
  readonly #options: ListedRepositoriesOptions
  readonly #known = new Map<string, ContinueRepository | null>()
  readonly #reading = new Set<string>()
  #asked = new Set<string>()
  #asking: Set<string> | undefined
  #timer: NodeJS.Timeout | undefined
  readonly #stopNeeded: (() => void) | undefined

  constructor(options: ListedRepositoriesOptions) {
    this.#options = options
    const needed = options.needed
    if (!needed) this.#start()
    else {
      this.#stopNeeded = needed.onChange((on) => {
        if (!on) return this.#pause()
        this.#readAll()
        this.#start()
      })
      if (needed.on) this.#start()
    }
  }

  #start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => this.#readAll(), this.#options.againMs)
    this.#timer.unref()
  }

  #pause(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  #readAll(): void {
    for (const folder of this.#asked) void this.#read(folder)
  }

  /** The rows' making, `undefined` while they can't be made: the folders `of` is asked for in it are the ones read again. */
  listing<T>(make: () => T | undefined): T | undefined {
    const asking = new Set<string>()
    this.#asking = asking
    try {
      const rows = make()
      if (rows !== undefined) this.#asked = asking
      return rows
    } finally {
      this.#asking = undefined
    }
  }

  /** The folder's repository as last read; the first ask reads it, and the rows are made again once it's in. */
  of(folder: string): ContinueRepository | undefined {
    this.#asking?.add(folder)
    if (!this.#known.has(folder)) void this.#read(folder)
    return this.#known.get(folder) ?? undefined
  }

  stop(): void {
    this.#stopNeeded?.()
    this.#pause()
  }

  async #read(folder: string): Promise<void> {
    if (this.#reading.has(folder)) return
    this.#reading.add(folder)
    const found = await this.#options.read(folder).catch(() => null)
    this.#reading.delete(folder)
    const had = this.#known.has(folder)
    const before = this.#known.get(folder)
    this.#known.set(folder, found)
    if (before?.url === found?.url && before?.branch === found?.branch) return
    if (had) hostLog("cloud-conversations", "a Thread worktree's branch on GitHub changed; its row says so now", { folder, from: before?.branch ?? null, to: found?.branch ?? null })
    this.#options.changed()
  }
}
