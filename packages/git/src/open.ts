import { existsSync } from "node:fs"
import { join } from "node:path"
import { PreviewBudget } from "./preview-cache.js"
import { locate, Repository } from "./repository.js"
import type { Git } from "./run.js"

/** Repositories kept open at once; one a watcher reports for is never let go. */
const OPEN_LIMIT = 64
/** Folders remembered as being in a repository, so asking again spawns nothing. */
const FOLDER_LIMIT = 512
/** A repository nobody watches or asked for in this long is closed, with its status and previews. */
const IDLE_MS = 5 * 60_000

/** The repositories one `Git` keeps open, by root, and the folders known to be in them. */
export class Repositories {
  readonly #git: Git
  readonly #previews = new PreviewBudget()
  readonly #open = new Map<string, Repository>()
  /** When each open repository was last asked for, by `Date.now()`. */
  readonly #used = new Map<Repository, number>()
  /**
   * A folder as callers name it (often through a symlink such as macOS's
   * `/var`) to its repository's root, and whether the folder had a `.git` of
   * its own then.
   */
  readonly #folders = new Map<string, { root: string; own: boolean }>()
  readonly #locating = new Map<string, Promise<Repository | null>>()
  #sweeping: NodeJS.Timeout | undefined

  constructor(git: Git) {
    this.#git = git
  }

  get size(): number {
    return this.#open.size
  }

  get previewBytes(): number {
    return this.#previews.bytes
  }

  async open(cwd: string, signal?: AbortSignal): Promise<Repository | null> {
    signal?.throwIfAborted()
    const known = this.known(cwd)
    if (known) return known
    // Callers share one lookup, so none of their signals may cancel it; each stops waiting on its own.
    let pending = this.#locating.get(cwd)
    if (!pending) {
      pending = this.#find(cwd).finally(() => this.#locating.delete(cwd))
      this.#locating.set(cwd, pending)
    }
    if (!signal) return pending
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  }

  known(cwd: string): Repository | undefined {
    const folder = this.#folders.get(cwd)
    const root = folder?.root ?? cwd
    const repository = this.#open.get(root)
    if (!repository) return undefined
    // A deleted repository, or one made inside the folder since, is looked up again.
    if (!existsSync(repository.gitDir) || (folder && !folder.own && existsSync(join(cwd, ".git")))) {
      this.#folders.delete(cwd)
      return undefined
    }
    this.#touch(cwd, root, repository)
    return repository
  }

  sweep(now: number): void {
    for (const [root, repository] of this.#open) {
      if (repository.watched || repository.busy || now - (this.#used.get(repository) ?? 0) < IDLE_MS) continue
      this.#forget(root, repository)
    }
    if (this.#open.size === 0 && this.#sweeping) {
      clearInterval(this.#sweeping)
      this.#sweeping = undefined
    }
  }

  close(): void {
    for (const repository of this.#open.values()) repository.close()
    this.#open.clear()
    this.#used.clear()
    this.#folders.clear()
    clearInterval(this.#sweeping)
    this.#sweeping = undefined
  }

  async #find(cwd: string): Promise<Repository | null> {
    const location = await locate(this.#git, cwd)
    if (!location) return null
    let repository = this.#open.get(location.root)
    if (!repository || repository.gitDir !== location.gitDir) {
      if (repository) this.#forget(location.root, repository)
      repository = new Repository(location, this.#git, this.#previews)
    }
    this.#touch(cwd, location.root, repository)
    for (const [root, oldest] of this.#open) {
      if (this.#open.size <= OPEN_LIMIT) break
      if (oldest.watched || oldest.busy) continue
      this.#forget(root, oldest)
    }
    return repository
  }

  #touch(cwd: string, root: string, repository: Repository): void {
    this.#open.delete(root)
    this.#open.set(root, repository)
    this.#used.set(repository, Date.now())
    if (!this.#sweeping) {
      this.#sweeping = setInterval(() => this.sweep(Date.now()), IDLE_MS / 5)
      this.#sweeping.unref()
    }
    if (cwd === root) return
    const own = this.#folders.get(cwd)?.own ?? existsSync(join(cwd, ".git"))
    this.#folders.delete(cwd)
    this.#folders.set(cwd, { root, own })
    if (this.#folders.size > FOLDER_LIMIT) this.#folders.delete(this.#folders.keys().next().value!)
  }

  #forget(root: string, repository: Repository): void {
    repository.close()
    this.#open.delete(root)
    this.#used.delete(repository)
    for (const [cwd, folder] of this.#folders) if (folder.root === root) this.#folders.delete(cwd)
  }
}
