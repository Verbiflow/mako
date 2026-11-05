import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { link, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { withFileLockBriefly, withFileLockSync } from "./file-lock.js"
import { onWindows } from "./platform.js"

/**
 * Mako's one way to write a whole file that must survive a crash: the bytes go
 * to a file of their own beside it, which is synced and then renamed over the
 * file (or linked into place, for one that must not exist yet), and then the
 * folder is synced, so a process killed mid-write leaves the old file and a
 * machine that loses power keeps the rename.
 *
 * Staging takes as long as the bytes take, and nothing is locked while it does:
 * every write stages under a name of its own, so writers into one folder, or
 * to one file, never wait for each other's bytes. Only the rename or link is
 * taken under the file's own lock (`file-lock.ts`), a lock held for the one
 * system call and never across an await, so a synchronous save beside an
 * asynchronous write can't wait on it. A writer that died leaves its staged
 * file, and the next writer into that folder deletes it once its process is
 * gone (a live one's is never touched).
 */
export interface PublishOptions {
  /** The file's mode when it is created; the staged file is always new, so this is its mode after a replace too. */
  mode?: number
  /** The mode of any folder made for it. */
  dirMode?: number
  /** Fail with `EEXIST` when the file is already there, as `flag: "wx"` does, instead of replacing it. */
  exclusive?: boolean
  /** How long to wait for another process to finish placing the same file. */
  waitMs?: number
  /**
   * The folder is another program's (a harness's own home, maybe the person's): no lock file is left in it, and only
   * this write's staged file is cleaned up. The caller keeps its writers from overlapping, as the harness's own lock
   * or a queue in this process does.
   */
  foreignFolder?: boolean
}

/** The lock of one file's placement, a hidden file beside it that listings of Mako's folders skip (`publisherFile`). */
const PLACE_LOCK = ".mako-place-lock"
const STAGED = /\.mako-(\d+)-[0-9a-f]{8}\.tmp$/
/** A synchronous write blocks its thread while another process places the same file, which takes a system call. */
const SYNC_WAIT_MS = 5_000

const staged = (path: string) => `${path}.mako-${process.pid}-${randomUUID().slice(0, 8)}.tmp`
const placeLock = (path: string) => `${path}${PLACE_LOCK}`
const code = (cause: unknown) => (cause instanceof Error && "code" in cause ? cause.code : undefined)

/** Windows can't open a folder as a file, and makes a rename durable without it. */
const noFolderToOpen = (cause: unknown) => onWindows() && (code(cause) === "EISDIR" || code(cause) === "EPERM")
/** A file system that can't sync a folder says so; the rename stands as it is. */
const noFolderSync = (cause: unknown) => { const found = code(cause); return found === "EINVAL" || found === "ENOTSUP" || found === "EOPNOTSUPP" }

/**
 * Whether `name` is a staged file whose writer is gone. A process that exists, whoever's it is, keeps its file: a
 * write in flight stages under no lock, so only the writer's death says its file is garbage.
 */
function abandoned(name: string): boolean {
  const owner = STAGED.exec(name)?.[1]
  if (owner === undefined || Number(owner) === process.pid) return false
  try {
    process.kill(Number(owner), 0)
    return false
  } catch (cause) {
    return code(cause) === "ESRCH"
  }
}

/** Puts the staged file where it goes: the one step two writers take turns at. */
function place(temporary: string, path: string, exclusive: boolean | undefined): void {
  if (exclusive) linkSync(temporary, path)
  else renameSync(temporary, path)
}

/** A large write can stream its bytes; a synchronous one takes them whole. */
export async function publishFile(path: string, data: string | Uint8Array | AsyncIterable<Uint8Array>, options: PublishOptions = {}): Promise<void> {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, ...options.dirMode !== undefined && { mode: options.dirMode } })
  if (!options.foreignFolder) for (const name of await readdir(folder)) if (abandoned(name)) await rm(join(folder, name), { force: true })
  const temporary = staged(path)
  try {
    const handle = await open(temporary, "wx", options.mode)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options.foreignFolder) {
      if (options.exclusive) await link(temporary, path)
      else await rename(temporary, path)
    } else {
      await withFileLockBriefly(placeLock(path), () => place(temporary, path, options.exclusive), options)
    }
  } finally {
    await rm(temporary, { force: true })
  }
  await syncFolder(folder)
}

export function publishFileSync(path: string, data: string | Uint8Array, options: PublishOptions = {}): void {
  const folder = dirname(path)
  mkdirSync(folder, { recursive: true, ...options.dirMode !== undefined && { mode: options.dirMode } })
  if (!options.foreignFolder) for (const name of readdirSync(folder)) if (abandoned(name)) rmSync(join(folder, name), { force: true })
  const temporary = staged(path)
  try {
    const fd = openSync(temporary, "wx", options.mode)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (options.foreignFolder) place(temporary, path, options.exclusive)
    else withFileLockSync(placeLock(path), () => place(temporary, path, options.exclusive), { waitMs: options.waitMs ?? SYNC_WAIT_MS })
  } finally {
    rmSync(temporary, { force: true })
  }
  syncFolderSync(folder)
}

async function syncFolder(folder: string): Promise<void> {
  let handle
  try {
    handle = await open(folder, "r")
  } catch (cause) {
    if (noFolderToOpen(cause)) return
    throw cause
  }
  try {
    await handle.sync()
  } catch (cause) {
    if (!noFolderSync(cause)) throw cause
  } finally {
    await handle.close()
  }
}

/** Makes a rename into `folder` survive a power loss, for a file moved into place some other way than `publishFile`. */
export function syncFolderSync(folder: string): void {
  let fd
  try {
    fd = openSync(folder, "r")
  } catch (cause) {
    if (noFolderToOpen(cause)) return
    throw cause
  }
  try {
    fsyncSync(fd)
  } catch (cause) {
    if (!noFolderSync(cause)) throw cause
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether `name` is the publisher's own bookkeeping in a folder: a file's placement lock, the lock's journal, or a
 * staged write, whether one that took a lock or one in another program's folder.
 */
export function publisherFile(name: string): boolean {
  const base = basename(name)
  return base.endsWith(PLACE_LOCK) || base.endsWith(`${PLACE_LOCK}-journal`) || STAGED.test(base)
}
