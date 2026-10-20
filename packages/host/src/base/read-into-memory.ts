import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Reads each path once, a file or a folder with everything in it, and keeps nothing: the kernel keeps what was read
 * in its page cache. A cloud machine does it before its snapshot, so a copy finds a harness's binary in memory instead
 * of reading it from its disk, which took a second or more each. A path that's gone is skipped.
 */
export async function readIntoMemory(paths: readonly string[]): Promise<{ files: number; bytes: number }> {
  const buffer = Buffer.allocUnsafe(4 << 20)
  let files = 0
  let bytes = 0
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined)
    if (!info) continue
    const each = info.isDirectory()
      ? (await readdir(path, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
      : [path]
    for (const file of each) {
      const handle = await open(file, "r").catch(() => undefined)
      if (!handle) continue
      try {
        let read = (await handle.read(buffer, 0, buffer.length, null)).bytesRead
        while (read > 0) {
          bytes += read
          read = (await handle.read(buffer, 0, buffer.length, null)).bytesRead
        }
        files += 1
      } finally {
        await handle.close()
      }
    }
  }
  return { files, bytes }
}
