import { opendir, lstat } from "node:fs/promises"
import { join } from "node:path"

const excluded = new Set([".git", "node_modules", "vendor", "target", "dist", "build", ".next", ".cache", ".venv", "venv"])
export interface RepositoryDiscovery { roots: string[]; limited: boolean }

/** Workspace discovery, not Git's upward lookup. Never walk a repository's
 * contents or follow symlinks into unrelated trees. Worktree .git files count. */
export async function discoverRepositories(root: string, options: { maxDirectories?: number; maxEntries?: number; maxDepth?: number; maxRepositories?: number } = {}): Promise<RepositoryDiscovery> {
  const maxDirectories = options.maxDirectories ?? 2000
  const maxEntries = options.maxEntries ?? 20000
  const maxDepth = options.maxDepth ?? 8
  const maxRepositories = options.maxRepositories ?? 48
  const queue = [{ path: root, depth: 0 }]
  const roots: string[] = []
  let entries = 0
  let visited = 0
  let limited = false
  for (let index = 0; index < queue.length; index++) {
    if (++visited > maxDirectories || roots.length >= maxRepositories) { limited = true; break }
    const current = queue[index]!
    try {
      const marker = await lstat(join(current.path, ".git"))
      if (marker.isDirectory() || marker.isFile()) { roots.push(current.path); continue }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { limited = true; continue }
    }
    try {
      const directory = await opendir(current.path)
      for await (const entry of directory) {
        if (++entries > maxEntries) return { roots: roots.sort(), limited: true }
        if (!entry.isDirectory() || excluded.has(entry.name)) continue
        if (current.depth >= maxDepth || queue.length >= maxDirectories) { limited = true; continue }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
      }
    } catch { limited = true }
  }
  return { roots: roots.sort(), limited }
}
