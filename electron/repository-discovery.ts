import { opendir, lstat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { git } from "@mako/git"
import { chatsRoot } from "./chat-folders.js"

const excluded = new Set([
  ".git", "node_modules", "vendor", "target", "dist", "build", ".next", ".cache", ".venv", "venv",
  ".turbo", ".gradle", "Pods", "DerivedData", "coverage", "__pycache__", ".pnpm-store", ".terraform", ".tox",
])
export interface RepositoryDiscovery { roots: string[]; limited: boolean }

/** A project folder of more repositories than this reads as a folder of projects. */
export const MAX_PROJECT_REPOSITORIES = 12

/** Workspace discovery, not Git's upward lookup. Never walk a repository's
 * contents or follow symlinks into unrelated trees. Worktree .git files count. */
export async function discoverRepositories(root: string, options: { maxDirectories?: number; maxEntries?: number; maxDepth?: number; maxRepositories?: number } = {}): Promise<RepositoryDiscovery> {
  // The disk, the home folder and the Chats folder hold other people's and other chats' repositories, never this workspace's.
  const target = resolve(root)
  if (target === sep || target === resolve(homedir()) || target === chatsRoot()) return { roots: [], limited: false }
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

export type ProjectRepositories = { roots: string[] } | { refusal: string }

/**
 * The repositories a project folder that isn't one holds, as its Threads'
 * checkouts mirror them: those `discoverRepositories` finds (a folder with
 * a `.git`, never one inside another repository), less a linked worktree
 * of one already listed, since Git keeps the Thread's branch in one checkout
 * at a time. None, too many, or a folder too large to look through is
 * refused with what to do instead.
 */
export async function projectRepositories(source: string): Promise<ProjectRepositories> {
  const found = await discoverRepositories(source)
  const name = basename(source)
  if (!found.roots.length)
    return { refusal: `${name} isn't in a Git repository and holds none, so it can't have a worktree. Choose Project folder to work in the folder itself.` }
  if (found.limited)
    return { refusal: `${name} holds more folders than Mako looks through, so it reads as a folder of projects. Add the repository you mean as its own project, or choose Project folder.` }
  const kept = new Map<string, { root: string; main: boolean }>()
  for (const root of found.roots) {
    const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => root)
    const main = Boolean((await lstat(join(root, ".git")).catch(() => undefined))?.isDirectory())
    const held = kept.get(common)
    if (!held || (main && !held.main)) kept.set(common, { root, main })
  }
  const roots = [...kept.values()].map(({ root }) => root).sort()
  if (roots.length > MAX_PROJECT_REPOSITORIES)
    return { refusal: `${name} holds ${roots.length} repositories, so it reads as a folder of projects. Add the repository you mean as its own project, or choose Project folder.` }
  return { roots }
}
