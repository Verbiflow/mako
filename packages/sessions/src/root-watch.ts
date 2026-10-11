import { readFileSync, watch, type FSWatcher } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join, sep } from "node:path"
import { onLinux } from "./platform.js"

export interface RootWatch {
  close(): void
}

/** A quarter of the user's inotify watches: editors and other apps need the rest. */
function inotifyBudget(): number {
  let limit = 8192
  try {
    limit = Number.parseInt(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8"), 10) || limit
  } catch {
    // Not Linux, or /proc isn't mounted: assume the old kernel default.
  }
  return Math.floor(limit / 4)
}

/**
 * The watches one catalog holds over its roots. On Linux they share one
 * budget of folders, read from the kernel at the first watch unless given.
 */
export class FolderWatches {
  private budget: number | undefined
  private watched = 0

  constructor(budget?: number) {
    this.budget = budget
  }

  /** Folders the Linux watches hold across every root. */
  get count(): number {
    return this.watched
  }

  /**
   * Hear every file written under `root`. Throws when the root can't be
   * watched; `onError` means a running watch went away.
   *
   * On macOS and Windows a recursive watch is one native stream. On Linux
   * Node builds one by reading the whole tree synchronously and adding an
   * inotify watch for every file as well as every folder: 11,805 watches,
   * 34 MB and a 105 ms stall for one user's harness folders, against 923
   * watches, 8 MB and 2 ms here. A folder's inotify watch already reports
   * writes to the files in it, so on Linux only folders are watched.
   */
  watchRoot(root: string, onChange: (path: string) => void, onError: () => void): RootWatch {
    if (onLinux()) return this.watchFolders(root, onChange, onError)
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name) onChange(join(root, name.toString()))
    })
    watcher.on("error", onError)
    return watcher
  }

  /**
   * Past the budget, folders go unwatched and periodic discovery finds what
   * they hold. A folder that appears later is walked, and the files already
   * in it are reported: they were written before its watch existed.
   */
  watchFolders(root: string, onChange: (path: string) => void, onError: () => void): RootWatch {
    const watchers = new Map<string, FSWatcher>()
    let closed = false

    const forget = (folder: string) => {
      for (const [path, watcher] of watchers) {
        if (path !== folder && !path.startsWith(folder + sep)) continue
        watcher.close()
        watchers.delete(path)
        this.watched -= 1
      }
    }

    const settle = async (path: string) => {
      const info = await lstat(path).catch(() => null)
      if (closed) return
      if (info?.isDirectory()) add(path, true)
      else if (!info) forget(path)
    }

    const add = (folder: string, announce: boolean) => {
      this.budget ??= inotifyBudget()
      if (closed || watchers.has(folder) || this.watched >= this.budget) return
      let watcher: FSWatcher
      try {
        watcher = watch(folder, (event, name) => {
          if (closed || watchers.get(folder) !== watcher || !name) return
          const path = join(folder, name.toString())
          onChange(path)
          if (event === "rename") void settle(path)
        })
      } catch (error) {
        if (folder === root) throw error
        return
      }
      watcher.on("error", () => {
        if (watchers.get(folder) !== watcher) return
        forget(folder)
        if (folder !== root || closed) return
        closed = true
        onError()
      })
      watchers.set(folder, watcher)
      this.watched += 1
      void readdir(folder, { withFileTypes: true }).then((entries) => {
        if (closed || watchers.get(folder) !== watcher) return
        for (const entry of entries) {
          const path = join(folder, entry.name)
          if (entry.isDirectory()) add(path, announce)
          else if (announce) onChange(path)
        }
      }, () => {})
    }

    add(root, false)
    return {
      close() {
        closed = true
        forget(root)
      },
    }
  }
}
