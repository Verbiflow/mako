import { readdirSync, statSync, watch, type FSWatcher } from "node:fs"
import { realpath } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { locateGitDir } from "../base/checkout-location.js"

/** What moves on every commit, add, reset or checkout, and nothing else does. */
const MARKERS = ["index", join("logs", "HEAD")]
/**
 * What moves only when a checkout's HEAD does: a commit, checkout, reset, merge or rebase. The index also moves when
 * any `git status` refreshes its stat cache, as a Changes panel's does on every edit.
 */
export const HEAD_MARKER = ["HEAD", join("logs", "HEAD")]
/** Shared ref changes, including a push/fetch that leaves the worktree HEAD alone. */
export const REF_MARKERS = ["packed-refs", "FETCH_HEAD", join("refs", "remotes")]
/** What moves when what's staged does, and on any `git status` that refreshes the index's stat cache. */
export const INDEX_MARKER = ["index"]

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
 *
 * Every Git read, even with `--no-optional-locks`, updates the index's access
 * time, and the watch reports that too. Announcing it would make each status
 * read schedule the next one, forever, so an event that leaves the file's
 * inode, size, mtime and ctime as they were is not a change.
 */
export function watchOutsideGitDir(folder: string, changed: () => void): GitDirWatch {
  let markers: GitDirWatch | undefined
  let closed = false
  const ready = (async () => {
    const [gitDir, root] = await Promise.all([
      locateGitDir(folder).then((found) => found && realpath(found)).catch(() => null),
      realpath(folder).catch(() => null),
    ])
    if (closed || !gitDir || !root || gitDir.startsWith(root + sep)) return
    markers = watchGitMarkers(gitDir, changed)
  })()
  return {
    ready,
    close() {
      closed = true
      markers?.close()
    },
  }
}

/**
 * A Git directory's markers (`MARKERS`, or those given) watched as files, wherever the directory is: each event that
 * changed one moves the watch to the file now there, then says so. A read that only touched the index's access time
 * says nothing.
 */
export function watchGitMarkers(gitDir: string, changed: () => void, markers: readonly string[] = MARKERS): GitDirWatch {
  let closed = false
  const watchers = new Map<string, FSWatcher>()
  const arm = (path: string, previous?: string) => {
    watchers.get(path)?.close()
    watchers.delete(path)
    if (closed) return
    try {
      const seen = stamp(path)
      // A first push creates its remote ref (and sometimes its parent directories). Follow the nearest
      // existing parent until that exact marker exists; unrelated index/lock events cannot invalidate PRs.
      let watched = path
      while (!stamp(watched) && watched !== gitDir) watched = dirname(watched)
      const child = watched === path ? undefined : relative(watched, path).split(sep)[0]
      const watcher = watch(watched, { persistent: false }, (_event, filename) => {
        if (watchers.get(path) !== watcher || child && filename && filename.toString() !== child) return
        const next = stamp(path)
        if (next === seen && watched === path) return
        arm(path, next)
        if (next !== seen) changed()
      })
      watcher.on("error", () => {
        if (watchers.get(path) !== watcher) return
        watcher.close()
        watchers.delete(path)
      })
      watchers.set(path, watcher)
      // A first push can create the missing target after the callback's stamp, before rearming it.
      if (previous !== undefined && seen !== previous) changed()
    } catch {
      // Not there yet (a checkout with no commits has no reflog) or no handles
      // left: the tree watch and explicit refreshes still cover it.
    }
  }
  for (const marker of markers) arm(join(gitDir, marker))
  return {
    ready: Promise.resolve(),
    close() {
      closed = true
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}

function stamp(path: string): string {
  try {
    const stats = statSync(path)
    const own = `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
    // Ref contents can change without their directory changing. Compare direct entries too, while ignoring
    // read-only access times and temporary Git locks; nested branches have their own directory marker.
    return stats.isDirectory() ? `${own}:${readdirSync(path).filter(name => !name.endsWith(".lock")).sort().map(name => {
      const entry = statSync(join(path, name))
      return `${name}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`
    }).join("|")}` : own
  } catch {
    return ""
  }
}
