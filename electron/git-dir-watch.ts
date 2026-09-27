import { watch, type FSWatcher } from "node:fs"
import { realpath } from "node:fs/promises"
import { join, sep } from "node:path"
import { locateGitDir } from "./checkout-heads.js"

/** What moves on every commit, add, reset or checkout, and nothing else does. */
const MARKERS = ["index", join("logs", "HEAD")]

export interface GitDirWatch {
  /** Settles once the markers are watched, or once it's clear there's nothing to watch. */
  readonly ready: Promise<void>
  close(): void
}

/**
 * A checkout whose Git directory is outside the folder a workspace watch
 * covers: a linked worktree (its index and reflog live in the main
 * checkout's `.git/worktrees/<name>`), a submodule, or a project opened at a
 * subfolder. A commit there changes no file under the folder, so it would go
 * unheard. The two marker files are watched themselves, which on macOS is a
 * kqueue handle rather than another FSEvents stream. Git replaces the index
 * by renaming over it, which ends a watch on the old file, so each event
 * moves the watch to the new file before announcing the change.
 */
export function watchOutsideGitDir(folder: string, changed: () => void): GitDirWatch {
  let closed = false
  const watchers = new Map<string, FSWatcher>()
  const arm = (path: string) => {
    watchers.get(path)?.close()
    watchers.delete(path)
    if (closed) return
    try {
      const watcher = watch(path, { persistent: false }, () => {
        if (watchers.get(path) !== watcher) return
        arm(path)
        changed()
      })
      watcher.on("error", () => {
        if (watchers.get(path) !== watcher) return
        watcher.close()
        watchers.delete(path)
      })
      watchers.set(path, watcher)
    } catch {
      // Not there yet (a checkout with no commits has no reflog) or no handles
      // left: the tree watch and explicit refreshes still cover it.
    }
  }
  const ready = (async () => {
    const [gitDir, root] = await Promise.all([
      locateGitDir(folder).then((found) => found && realpath(found)).catch(() => null),
      realpath(folder).catch(() => null),
    ])
    if (closed || !gitDir || !root || gitDir.startsWith(root + sep)) return
    for (const marker of MARKERS) arm(join(gitDir, marker))
  })()
  return {
    ready,
    close() {
      closed = true
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
