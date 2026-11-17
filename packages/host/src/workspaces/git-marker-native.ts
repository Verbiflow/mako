import { readdirSync, statSync, watch, type FSWatcher } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

/** Native Git-marker handles belong to the watcher child, never the host thread. */
export function watchGitMarkersHere(gitDir: string, changed: () => void, markers: readonly string[]) {
  let closed = false
  const watchers = new Map<string, FSWatcher>()
  const repairs = new Map<string, ReturnType<typeof setImmediate>>()
  const nearest = (path: string) => {
    let found = path
    while (!stamp(found) && found !== gitDir) found = dirname(found)
    return found
  }
  const arm = (path: string, previous?: string) => {
    clearImmediate(repairs.get(path))
    repairs.delete(path)
    watchers.get(path)?.close()
    watchers.delete(path)
    if (closed) return
    try {
      const seen = stamp(path)
      // A first push creates its remote ref (and sometimes its parent directories). Follow the nearest
      // existing parent until that exact marker exists; unrelated index/lock events cannot invalidate PRs.
      const watched = nearest(path)
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
      // Creation can also fall between that stamp and installing the replacement handle. Recheck both the
      // target and its nearest parent: a new intermediate directory needs a deeper watch even before the ref exists.
      if (!closed && watchers.get(path) === watcher && (stamp(path) !== seen || nearest(path) !== watched)) {
        const repair = setImmediate(() => {
          repairs.delete(path)
          if (!closed && watchers.get(path) === watcher) arm(path, seen)
        })
        repairs.set(path, repair)
        repair.unref() // Marker watches are non-persistent, including a repair queued as a CLI finishes reading.
      }
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
      for (const repair of repairs.values()) clearImmediate(repair)
      repairs.clear()
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
