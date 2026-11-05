import { FileLockBusyError, withFileLock } from "../../../base/file-lock.js"

/**
 * The patched SDK (`scripts/patch-cursor-sdk.mjs`) runs every write of a
 * transcript file, an append or a full rewrite, inside the function stored
 * here, so one writer at a time touches a file and a recovery never cuts a
 * line another process is still writing. Without it installed the writes run
 * unlocked, as in the unpatched SDK.
 */
export const CURSOR_TRANSCRIPT_LOCK = Symbol.for("mako:cursor-transcript-lock")

/** One lock per transcript (`file-lock.ts`), beside it: a writer holds it for a whole streamed rewrite. */
const LOCK_SUFFIX = ".mako-lock"

export interface LockOptions {
  waitMs?: number
}

/**
 * Runs `work` holding the exclusive lock of the transcript at `file`, until
 * `work` ends. A holder that dies loses it at once, and leaves no mark that it
 * held it, so whatever it left half written is for the next holder to find.
 */
export async function withTranscriptLock<T>(file: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  try {
    return await withFileLock(`${file}${LOCK_SUFFIX}`, work, options)
  } catch (cause) {
    if (cause instanceof FileLockBusyError) throw new Error(`The transcript ${file} is being written by another process`, { cause })
    throw cause
  }
}
