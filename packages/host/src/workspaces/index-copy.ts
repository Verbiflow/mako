import { copyFile, stat, utimes } from "node:fs/promises"

/**
 * A copy of a Git index that Git reads as it reads the original. Git trusts an entry's stat (to the whole second on
 * macOS) except where the entry is no older than the index file itself: then it reads the file again, since it may
 * have changed in the second the index was written. A copy made later would take that second away, and an edit made
 * then, at the same size, would read as unchanged: left out of a move's checkpoint, a rewind's snapshot or a move's
 * backup. So the copy keeps the original's time, rounded down, which can only make Git look again more often.
 */
export async function copyGitIndex(from: string, to: string): Promise<void> {
  await copyFile(from, to)
  const { atimeMs, mtimeMs } = await stat(from)
  await utimes(to, Math.floor(atimeMs) / 1000, Math.floor(mtimeMs) / 1000)
}
