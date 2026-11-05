import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"

/**
 * Mako's one lock between processes: an exclusive SQLite transaction on a
 * database at `path`, created empty. SQLite holds it with the operating
 * system's file locks (`fcntl` here, `LockFileEx` on Windows), which the kernel
 * drops the moment the holder exits, however it exits, and which also exclude
 * a second connection in the same process. A stopped holder keeps it. Nothing
 * else (a pid, a start time, a file's age) says who holds it.
 *
 * The file, and the journal SQLite keeps beside it while the lock is held,
 * stay on disk: removing a lock file another process has open would let two
 * processes each lock a file of their own.
 */
const SQLITE_BUSY = 5
/** How long a caller waits for another holder by default. */
const WAIT_MS = 30_000

export interface FileLockOptions {
  waitMs?: number
}

export class FileLockBusyError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`Another process holds ${path}`)
    this.path = path
  }
}

const busy = (cause: unknown) => cause instanceof Error && "errcode" in cause && cause.errcode === SQLITE_BUSY
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function open(path: string, timeout: number): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  return new DatabaseSync(path, { timeout })
}

/** Runs `work` holding the lock at `path`, waiting up to `waitMs` for another holder, polled so the event loop runs. */
export async function withFileLock<T>(path: string, work: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const db = open(path, 0)
  try {
    const deadline = Date.now() + (options.waitMs ?? WAIT_MS)
    for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
      try {
        db.exec("BEGIN EXCLUSIVE")
        break
      } catch (cause) {
        if (!busy(cause)) throw cause
        if (Date.now() > deadline) throw new FileLockBusyError(path)
        await sleep(delay)
      }
    }
    try {
      return await work()
    } finally {
      db.exec("ROLLBACK")
    }
  } finally {
    db.close()
  }
}

/**
 * Runs the synchronous `work` holding the lock at `path`, waiting for another holder up to `waitMs` with the event
 * loop running. The lock is taken and dropped with no await between, so this process never holds it while its event
 * loop is free: a synchronous caller (`withFileLockSync`) can't meet this process as the holder, only another one,
 * and only for as long as `work` takes.
 */
export async function withFileLockBriefly<T>(path: string, work: () => T, options: FileLockOptions = {}): Promise<T> {
  const db = open(path, 0)
  try {
    const deadline = Date.now() + (options.waitMs ?? WAIT_MS)
    for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
      try {
        db.exec("BEGIN EXCLUSIVE")
      } catch (cause) {
        if (!busy(cause)) throw cause
        if (Date.now() > deadline) throw new FileLockBusyError(path)
        await sleep(delay)
        continue
      }
      try {
        return work()
      } finally {
        db.exec("ROLLBACK")
      }
    }
  } finally {
    db.close()
  }
}

/** The same for a caller that can't wait asynchronously: SQLite's own busy wait blocks this thread for up to `waitMs`. */
export function withFileLockSync<T>(path: string, work: () => T, options: FileLockOptions = {}): T {
  const db = open(path, options.waitMs ?? WAIT_MS)
  try {
    try {
      db.exec("BEGIN EXCLUSIVE")
    } catch (cause) {
      throw busy(cause) ? new FileLockBusyError(path) : cause
    }
    try {
      return work()
    } finally {
      db.exec("ROLLBACK")
    }
  } finally {
    db.close()
  }
}
