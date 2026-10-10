import { open } from "node:fs/promises"
import { basename } from "node:path"
import { z } from "zod"
import type { ProviderActivitySession } from "../../threads/index.js"

const CHUNK_BYTES = 64 * 1024
const RECORD_BYTES = 1024 * 1024
const SCAN_BYTES = 64 * 1024 * 1024
const lifecycle = z.object({
  type: z.literal("event_msg"),
  payload: z.object({ type: z.string() }),
})
interface Checkpoint {
  identity: string
  offset: number
  size: number
  modified: number
  status: "active" | "open"
}

/** An open rollout is a live session, not proof of a running turn. */
export class CodexSessionActivity {
  private readonly checkpoints = new Map<string, Checkpoint>()

  retain(paths: string[]): void {
    const current = new Set(paths)
    for (const path of this.checkpoints.keys())
      if (!current.has(path)) this.checkpoints.delete(path)
  }

  async read(
    path: string,
    signal: AbortSignal
  ): Promise<ProviderActivitySession> {
    signal.throwIfAborted()
    const handle = await open(path, "r")
    try {
      const info = await handle.stat()
      const identity = `${info.dev}:${info.ino}`
      const previous = this.checkpoints.get(path)
      const reusable =
        previous?.identity === identity &&
        info.size >= previous.size &&
        (info.size > previous.size || info.mtimeMs === previous.modified)
      let status = reusable ? previous.status : "open"
      let offset = reusable
        ? previous.offset
        : Math.max(0, info.size - SCAN_BYTES)
      if (info.size - offset > SCAN_BYTES) {
        offset = info.size - SCAN_BYTES
        status = "open"
      }
      let skipping = offset > 0 && !reusable
      let fragments: Buffer[] = []
      let retained = 0
      let complete = offset
      for (let cursor = offset; cursor < info.size;) {
        signal.throwIfAborted()
        const buffer = Buffer.allocUnsafe(
          Math.min(CHUNK_BYTES, info.size - cursor)
        )
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          cursor
        )
        if (!bytesRead) break
        let start = 0
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start)
          const end = newline >= 0 && newline < bytesRead ? newline : bytesRead
          const segment = buffer.subarray(start, end)
          if (!skipping) {
            retained += segment.length
            if (retained > RECORD_BYTES) {
              fragments = []
              skipping = true
              status = "open"
            } else fragments.push(Buffer.from(segment))
          }
          if (end === bytesRead) break
          if (!skipping) {
            const line = Buffer.concat(fragments, retained).toString("utf8")
            try {
              const event = lifecycle.safeParse(JSON.parse(line))
              if (event.success) {
                switch (event.data.payload.type) {
                  case "task_started":
                    status = "active"
                    break
                  case "task_complete":
                  case "turn_aborted":
                    status = "open"
                    break
                }
              }
            } catch {
              /* A torn record cannot prove a running turn. */
            }
          }
          fragments = []
          retained = 0
          skipping = false
          complete = cursor + end + 1
          start = end + 1
        }
        cursor += bytesRead
      }
      this.checkpoints.set(path, {
        identity,
        offset: complete,
        size: info.size,
        modified: info.mtimeMs,
        status,
      })
      // Resumed rollouts append a run UUID; the first UUID remains the native thread ID.
      const nativeId = basename(path).match(
        /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i
      )?.[0]
      return { path, nativeId, status }
    } finally {
      await handle.close()
    }
  }
}
