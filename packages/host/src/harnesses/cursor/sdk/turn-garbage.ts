import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

/**
 * The patched SDK calls this with the size of each blob it reads from the
 * agent store (`scripts/patch-cursor-sdk.mjs`).
 */
export const CURSOR_SDK_READ_HOOK = Symbol.for("mako:cursor-sdk-read")

/**
 * Cursor's backend reads a conversation back from the child on every turn,
 * blob by blob: one turn on a 20-turn conversation read 5,000 blobs and
 * 160 MB from the store (2026-11-04). Under `ELECTRON_RUN_AS_NODE` V8 isn't
 * told about those buffers (`process.memoryUsage().arrayBuffers` reads 0), so
 * nothing makes it collect them: the child kept 350–520 MB after a turn, and
 * 87 MB once one collection ran. So the child collects after every
 * `COLLECT_AFTER_BYTES` read and when a run settles.
 */
export const COLLECT_AFTER_BYTES = 64 * 1024 * 1024

export interface TurnGarbage {
  read(bytes: number): void
  settled(): void
}

export function turnGarbage(collect = garbageCollector(), schedule: (run: () => void) => void = setImmediate): TurnGarbage {
  let unread = 0
  let pending = false
  const soon = () => {
    if (pending) return
    pending = true
    schedule(() => {
      pending = false
      unread = 0
      collect()
    })
  }
  return {
    read(bytes) {
      unread += bytes
      if (unread >= COLLECT_AFTER_BYTES) soon()
    },
    settled: soon,
  }
}

/** A context made after `--expose-gc` is set has V8's `gc`, whatever the child was started with. */
function garbageCollector(): () => void {
  setFlagsFromString("--expose-gc")
  const gc: () => void = runInNewContext("gc")
  return () => gc()
}
