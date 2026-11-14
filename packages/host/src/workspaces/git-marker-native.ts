import { readdirSync, statSync, watch, type FSWatcher } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

/** Native Git-marker handles belong to the watcher child, never the host thread. */
export function watchGitMarkersHere(gitDir: string, changed: () => void, markers: readonly string[]) {
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
