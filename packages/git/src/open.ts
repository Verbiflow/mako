import { existsSync } from "node:fs"
import { join } from "node:path"
import { locate, Repository } from "./repository.js"

/** Repositories kept open at once; one a watcher reports for is never let go. */
const OPEN_LIMIT = 64
/** Folders remembered as being in a repository, so asking again spawns nothing. */
const FOLDER_LIMIT = 512

const open = new Map<string, Repository>()
/**
 * A folder as callers name it (often through a symlink such as macOS's
 * `/var`) to its repository's root, and whether the folder had a `.git` of
 * its own then.
 */
const folders = new Map<string, { root: string; own: boolean }>()
const locating = new Map<string, Promise<Repository | null>>()

/**
 * The repository `cwd` is in, or null outside one. Every caller asking about
 * the same working tree shares one `Repository`, so its status, previews and
 * write queue are one. After the first answer for a folder, this resolves
 * without starting Git.
 */
export async function openRepository(cwd: string, signal?: AbortSignal): Promise<Repository | null> {
  signal?.throwIfAborted()
  const known = knownRepository(cwd)
  if (known) return known
  // Callers share one lookup, so none of their signals may cancel it; each stops waiting on its own.
  let pending = locating.get(cwd)
  if (!pending) {
    pending = find(cwd).finally(() => locating.delete(cwd))
    locating.set(cwd, pending)
  }
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * The repository `cwd` is in when it is already open, without waiting. A
 * write started through it joins the repository's queue in the same tick,
 * so writes keep the order they were asked for in.
 */
export function knownRepository(cwd: string): Repository | undefined {
  const folder = folders.get(cwd)
  const root = folder?.root ?? cwd
  const repository = open.get(root)
  if (!repository) return undefined
  // A deleted repository, or one made inside the folder since, is looked up again.
  if (!existsSync(repository.gitDir) || (folder && !folder.own && existsSync(join(cwd, ".git")))) {
    folders.delete(cwd)
    return undefined
  }
  touch(cwd, root, repository)
  return repository
}

async function find(cwd: string): Promise<Repository | null> {
  const location = await locate(cwd)
  if (!location) return null
  let repository = open.get(location.root)
  if (!repository || repository.gitDir !== location.gitDir) {
    repository?.close()
    repository = new Repository(location)
  }
  touch(cwd, location.root, repository)
  for (const [root, oldest] of open) {
    if (open.size <= OPEN_LIMIT) break
    if (oldest.watched) continue
    oldest.close()
    open.delete(root)
  }
  return repository
}

function touch(cwd: string, root: string, repository: Repository): void {
  open.delete(root)
  open.set(root, repository)
  if (cwd === root) return
  const own = folders.get(cwd)?.own ?? existsSync(join(cwd, ".git"))
  folders.delete(cwd)
  folders.set(cwd, { root, own })
  if (folders.size > FOLDER_LIMIT) folders.delete(folders.keys().next().value!)
}

/** Ends every repository's helper process, for a host that is quitting. */
export function closeRepositories(): void {
  for (const repository of open.values()) repository.close()
  open.clear()
  folders.clear()
}
