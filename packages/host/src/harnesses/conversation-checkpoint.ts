import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { nativeCheckpoint, type NativeCheckpoint } from "./native-continuation.js"

/**
 * Where a session's conversation stands, for the resume verdict: the record
 * up to its last conversation line, not the file's last byte.
 *
 * Some harnesses append lines that say nothing of the conversation after a
 * turn ends and as their process exits: Claude Code its `cost-state` and
 * `last-prompt` records, Grok its Stop and SessionEnd hooks' runs. Mako
 * closes a harness's process when the conversation switches to another
 * harness, so a checkpoint over the whole file read the session as moved
 * when the person switched back, and the switch back started a new session
 * from the transcript instead of resuming the harness's own. Lines the
 * harness's `bookkeeping` names at the end of the file are left out; the
 * first line from the end that it doesn't name ends the conversation.
 *
 * `<prefix><inode>:<end>:<digest of the 64 KB before end>`. A checkpoint of
 * another form is compared in its own form (`nativeCheckpoint`), so a
 * binding saved before reads as it did.
 */
export function conversationCheckpoint(prefix: string, bookkeeping: (line: string) => boolean): NativeCheckpoint {
  return async (path, previous) => {
    if (previous !== undefined && !previous.startsWith(prefix)) return nativeCheckpoint(path, previous)
    try {
      const handle = await open(path, "r")
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile()) return undefined
        const end = await conversationEnd(handle, Number(before.size), bookkeeping)
        const length = Math.min(end, TAIL_BYTES)
        const tail = Buffer.alloc(length)
        await handle.read(tail, 0, length, end - length)
        const after = await handle.stat({ bigint: true })
        if (after.ino !== before.ino || after.size < before.size) return undefined
        return `${prefix}${before.ino}:${end}:${createHash("sha256").update(tail).digest("hex").slice(0, 32)}`
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }
}

const TAIL_BYTES = 64 * 1024
/** A bookkeeping line is short; one longer than this is taken for conversation without parsing it. */
const BOOKKEEPING_BYTES = 16 * 1024
const CHUNK = 64 * 1024
const NEWLINE = 0x0a

type Handle = Awaited<ReturnType<typeof open>>

/** The byte just past the last line that isn't bookkeeping, reading back from `size` a chunk at a time. */
async function conversationEnd(handle: Handle, size: number, bookkeeping: (line: string) => boolean): Promise<number> {
  let end = size
  let carry = Buffer.alloc(0)
  for (let at = size; at > 0;) {
    const start = Math.max(0, at - CHUNK)
    const chunk = Buffer.alloc(at - start)
    await handle.read(chunk, 0, chunk.length, start)
    let text = Buffer.concat([chunk, carry])
    at = start
    // Each whole line in what's held, last first; what starts before it waits for the next chunk.
    for (;;) {
      const trimmed = text.length && text[text.length - 1] === NEWLINE ? text.subarray(0, -1) : text
      const newline = trimmed.lastIndexOf(NEWLINE)
      if (newline < 0 && at > 0) {
        if (trimmed.length > BOOKKEEPING_BYTES) return end
        carry = text
        break
      }
      const line = trimmed.subarray(newline + 1)
      if (line.length && (line.length > BOOKKEEPING_BYTES || !bookkeeping(line.toString("utf8").trim()))) return end
      end -= text.length - (newline + 1)
      text = text.subarray(0, newline + 1)
      if (newline < 0) return end
    }
  }
  return end
}
