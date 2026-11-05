import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"

/**
 * The patched SDK (`scripts/patch-cursor-sdk.mjs`) runs every write of a
 * transcript file, an append or a full rewrite, inside the function stored
 * here, so one writer at a time touches a file and a recovery never cuts a
 * line another process is still writing. Without it installed the writes run
 * unlocked, as in the unpatched SDK.
 */
export const CURSOR_TRANSCRIPT_LOCK = Symbol.for("mako:cursor-transcript-lock")

/**
 * A SQLite database beside the transcript, created empty, whose exclusive
 * transaction is the lock. SQLite locks it with the operating system's file
 * locks (`fcntl` here, `LockFileEx` on Windows), which the kernel drops the
 * moment the holder exits, however it exits, and which also exclude a second
 * connection in the same process. The file and the journal SQLite keeps
 * beside it while the lock is held stay on disk: removing a lock file another
 * process has open would let two processes each lock a file of their own.
 */
const LOCK_SUFFIX = ".mako-lock"
/** How long a write waits for another process's write to the same file. */
const WAIT_MS = 30_000
const SQLITE_BUSY = 5

export interface LockOptions {
  waitMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const busy = (cause: unknown) => (cause as { errcode?: number }).errcode === SQLITE_BUSY

/**
 * Runs `work` holding the exclusive lock of the transcript at `file`, until
 * `work` ends. A holder that dies loses it at once, and leaves no mark that it
 * held it, so whatever it left half written is for the next holder to find.
 */
export async function withTranscriptLock<T>(file: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const path = `${file}${LOCK_SUFFIX}`
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    const deadline = Date.now() + (options.waitMs ?? WAIT_MS)
    for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
      try {
        db.exec("BEGIN EXCLUSIVE")
        break
      } catch (cause) {
        if (!busy(cause)) throw cause
        if (Date.now() > deadline) throw new Error(`The transcript ${file} is being written by another process`)
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
