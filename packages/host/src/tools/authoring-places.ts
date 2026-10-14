import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { AuthoringSupport } from "../contracts/native-authoring.js"

/**
 * Where harnesses look for project configuration: the repository a folder
 * is in, every folder from its root down to the folder, and for a linked
 * worktree the main checkout some harnesses read instead.
 */

export const WRITABLE: AuthoringSupport = { supported: true }

export function readOnly(reason: string): AuthoringSupport {
  return { supported: false, reason }
}

/** The nearest folder at or above `cwd` that holds `.git` (a folder, or a linked worktree's file), or null. */
export async function gitRoot(cwd: string): Promise<string | null> {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    if (await stat(join(folder, ".git")).then(() => true, () => false)) return folder
    if (dirname(folder) === folder) return null
  }
}

/** A linked worktree's main checkout, read from its `.git` file; null for a main checkout or none. */
export async function mainCheckout(root: string): Promise<string | null> {
  const pointer = await readFile(join(root, ".git"), "utf8").catch(() => null)
  const gitdir = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim() : undefined
  if (!gitdir) return null
  const absolute = isAbsolute(gitdir) ? gitdir : resolve(root, gitdir)
  const marker = join(".git", "worktrees")
  const index = absolute.lastIndexOf(marker)
  return index > 0 ? absolute.slice(0, index - 1) : null
}

/** `root` and every folder below it down to `cwd`, outermost first; just `cwd` when it isn't inside `root`. */
export function foldersDown(root: string, cwd: string): string[] {
  const path = relative(root, resolve(cwd))
  if (path.startsWith("..") || isAbsolute(path)) return [resolve(cwd)]
  const folders = [root]
  for (const segment of path.split(/[\\/]/).filter(Boolean)) folders.push(join(folders.at(-1) ?? root, segment))
  return folders
}

/** The real path, or the path itself when it doesn't exist. */
export async function realOr(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

/** `path` with the home folder written `~`, as people read paths. */
export function tilde(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}
