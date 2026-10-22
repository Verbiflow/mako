import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { JsonObject } from "./json.js"

/** Past this a journal moves to `<file>.1`, replacing the one before. */
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024
const FLUSH_MS = 250

/**
 * One JSON line per Local Control request, appended in batches so no call
 * waits on the disk. A failed write loses that batch, never a call.
 */
export function controlJournal(file: string) {
  let pending: string[] = []
  let timer: NodeJS.Timeout | undefined
  let writing: Promise<void> = Promise.resolve()
  let bytes: Promise<number> | undefined
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (!pending.length) return writing
    const text = pending.join("")
    pending = []
    writing = writing.then(async () => {
      bytes ??= mkdir(dirname(file), { recursive: true, mode: 0o700 })
        .then(() => stat(file))
        .then((found) => found.size, () => 0)
      let size = await bytes
      if (size > JOURNAL_MAX_BYTES) {
        await rename(file, `${file}.1`)
        size = 0
      }
      await appendFile(file, text, { mode: 0o600 })
      bytes = Promise.resolve(size + Buffer.byteLength(text))
    }).catch(() => {
      bytes = undefined
    })
    return writing
  }
  return {
    record(line: JsonObject) {
      pending.push(`${JSON.stringify(line)}\n`)
      if (!timer) {
        timer = setTimeout(() => void flush(), FLUSH_MS)
        timer.unref()
      }
    },
    flush,
  }
}
