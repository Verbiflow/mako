import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { link, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { withFileLock, withFileLockSync } from "./file-lock.js"
import { onWindows } from "./platform.js"

/**
 * Mako's one way to write a whole file that must survive a crash: the bytes go
 * to a file of their own beside it, which is synced and then renamed over the
 * file (or linked into place, for one that must not exist yet), and then the
 * folder is synced, so a process killed mid-write leaves the old file and a
 * machine that loses power keeps the rename. Every write holds its folder's
 * lock (`file-lock.ts`), so writers into one folder take turns, and whatever a
 * dead writer staged there is deleted by the next one.
 */
export interface PublishOptions {
  /** The file's mode when it is created; the staged file is always new, so this is its mode after a replace too. */
  mode?: number
  /** The mode of any folder made for it. */
  dirMode?: number
  /** Fail with `EEXIST` when the file is already there, as `flag: "wx"` does, instead of replacing it. */
  exclusive?: boolean
  /** How long to wait for another writer into the same folder. */
  waitMs?: number
  /**
   * The folder is another program's (a harness's own home, maybe the person's): no lock file is left in it, and only
   * this write's staged file is cleaned up. The caller keeps its writers from overlapping, as the harness's own lock
   * or a queue in this process does.
   */
  foreignFolder?: boolean
}

/** The folder's lock, a hidden file every listing of Mako's folders already skips. */
const FOLDER_LOCK = ".mako-lock"
const STAGED = /\.mako-\d+\.tmp$/
/** A synchronous write blocks its thread while it waits, so it gives up sooner. */
const SYNC_WAIT_MS = 5_000

const staged = (path: string) => `${path}.mako-${process.pid}.tmp`
/** Unlocked writes to one file can overlap, so each stages under a name of its own. */
const stagedAlone = (path: string) => `${path}.mako-${process.pid}-${randomUUID().slice(0, 8)}.tmp`
const code = (cause: unknown) => (cause instanceof Error && "code" in cause ? cause.code : undefined)

/** Windows can't open a folder as a file, and makes a rename durable without it. */
const noFolderToOpen = (cause: unknown) => onWindows() && (code(cause) === "EISDIR" || code(cause) === "EPERM")
/** A file system that can't sync a folder says so; the rename stands as it is. */
const noFolderSync = (cause: unknown) => { const found = code(cause); return found === "EINVAL" || found === "ENOTSUP" || found === "EOPNOTSUPP" }

/** A large write can stream its bytes; a synchronous one takes them whole. */
export async function publishFile(path: string, data: string | Uint8Array | AsyncIterable<Uint8Array>, options: PublishOptions = {}): Promise<void> {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, ...options.dirMode !== undefined && { mode: options.dirMode } })
  if (options.foreignFolder) return write(stagedAlone(path))
  await withFileLock(join(folder, FOLDER_LOCK), async () => {
    for (const name of await readdir(folder)) if (STAGED.test(name)) await rm(join(folder, name), { force: true })
    await write(staged(path))
  }, options)

  async function write(temporary: string): Promise<void> {
    try {
      const handle = await open(temporary, "wx", options.mode)
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (options.exclusive) await link(temporary, path)
      else await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    await syncFolder(folder)
  }
}

export function publishFileSync(path: string, data: string | Uint8Array, options: PublishOptions = {}): void {
  const folder = dirname(path)
  mkdirSync(folder, { recursive: true, ...options.dirMode !== undefined && { mode: options.dirMode } })
  if (options.foreignFolder) return write(stagedAlone(path))
  withFileLockSync(join(folder, FOLDER_LOCK), () => {
    for (const name of readdirSync(folder)) if (STAGED.test(name)) rmSync(join(folder, name), { force: true })
    write(staged(path))
  }, { waitMs: options.waitMs ?? SYNC_WAIT_MS })

  function write(temporary: string): void {
    try {
      const fd = openSync(temporary, "wx", options.mode)
      try {
        writeFileSync(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (options.exclusive) linkSync(temporary, path)
      else renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
    syncFolderSync(folder)
  }
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

/** Whether `name` is the publisher's own bookkeeping in a folder: its lock, the lock's journal, or a staged write. */
export function publisherFile(name: string): boolean {
  const base = basename(name)
  return base === FOLDER_LOCK || base === `${FOLDER_LOCK}-journal` || STAGED.test(base)
}
