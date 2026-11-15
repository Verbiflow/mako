import { constants } from "node:fs"
import { open, realpath, stat, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve, sep } from "node:path"

/**
 * Folders whose files are a person's keys wherever a root would let them be read: never opened for another device,
 * whichever Thread's folder holds them.
 */
const SECRET_FOLDERS = [".ssh", ".aws", ".gnupg"]
const KEYCHAINS = `${sep}Library${sep}Keychains${sep}`

/** A file opened for another device: its descriptor, and the path it was verified at. */
export interface ConfinedFile {
  handle: FileHandle
  real: string
}

/**
 * The roots another device may read under, each resolved: those at or above the home folder are dropped (a Thread
 * whose folder is `~`, or `/`, opens nothing of it), as are any that don't exist.
 */
export async function confinedRoots(roots: readonly (string | null | undefined)[], home = homedir()): Promise<string[]> {
  const realHome = await realpath(home).catch(() => resolve(home))
  const kept: string[] = []
  for (const root of roots) {
    if (!root) continue
    const folder = await realpath(resolve(root)).catch(() => undefined)
    if (!folder || folder === realHome || realHome.startsWith(folder + sep) || folder === sep) continue
    kept.push(folder)
  }
  return kept
}

/** Whether a resolved path is in a folder of keys (`.ssh`, `.aws`, `.gnupg`, a keychain). */
export function secretPath(real: string): boolean {
  const parts = real.split(sep)
  return parts.some((part) => SECRET_FOLDERS.includes(part)) || real.includes(KEYCHAINS)
}

/**
 * `path` opened for another device, or undefined when it may not be: resolved through its symlinks, it must be a file
 * inside one of `roots` (`confinedRoots`) and in no folder of keys. It's opened without following a link, and the
 * descriptor is then held to the path re-resolved (the same device and inode), so a link swapped in between reads
 * nothing: Node has no `F_GETPATH`, and this is what it gives in its place. Every read goes through the descriptor.
 */
export async function openConfined(path: string, roots: readonly string[]): Promise<ConfinedFile | undefined> {
  const real = await realpath(path).catch(() => undefined)
  if (!real || secretPath(real) || !roots.some((root) => real === root || real.startsWith(root + sep))) return undefined
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
  if (!handle) return undefined
  try {
    const opened = await handle.stat()
    const again = await realpath(real).catch(() => undefined)
    const named = again === real ? await stat(real).catch(() => undefined) : undefined
    if (!opened.isFile() || !named || named.dev !== opened.dev || named.ino !== opened.ino) {
      await handle.close()
      return undefined
    }
    return { handle, real }
  } catch {
    await handle.close()
    return undefined
  }
}
