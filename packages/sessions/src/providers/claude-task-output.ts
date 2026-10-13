import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import type { KeptOutputs, OutputKey, OutputOrigin } from "../kept-outputs.js"
import { OUTPUT_TAIL_BYTES, outputTail } from "../provider-turn.js"

/** Claude Code's own temporary folders for this user: `/tmp/claude-<uid>` and the same under the system's temporary folder. */
function claudeTemporaryRoots(): string[] {
  const uid = process.getuid?.()
  if (uid === undefined) return []
  const roots = new Set<string>()
  for (const parent of ["/tmp", tmpdir()]) {
    try {
      roots.add(join(realpathSync(parent), `claude-${uid}`) + sep)
    } catch {
      // A missing temporary folder holds no output.
    }
  }
  return [...roots]
}

/** Claude Code names a task's output file `<project>/<session>/tasks/<task>.output`; anything else is not one. */
function taskFile(path: string | undefined, taskId: string | undefined): OutputKey | undefined {
  if (!path || !taskId || basename(path) !== `${taskId}.output` || basename(dirname(path)) !== "tasks") return undefined
  const session = basename(dirname(dirname(path)))
  return session ? { harness: "claude", session, task: taskId } : undefined
}

/**
 * The last lines a background command printed, read from the file Claude
 * Code writes its output to, while that file still exists (Claude Code
 * keeps it under a temporary folder the system clears). The path comes from
 * the session transcript, so only a regular file named for the task, in a
 * `tasks` folder under Claude Code's own temporary folder for this user, is
 * opened: an agent's output file is a link to its transcript and is never
 * followed. Only its end is read (`outputTail`).
 */
export function claudeTaskOutputTail(path: string | undefined, taskId: string | undefined): string | undefined {
  if (!path || !taskFile(path, taskId)) return undefined
  let file: number | undefined
  try {
    if (!lstatSync(path).isFile()) return undefined
    const real = realpathSync(path)
    if (!claudeTemporaryRoots().some((root) => real.startsWith(root))) return undefined
    file = openSync(real, "r")
    const size = fstatSync(file).size
    if (!size) return undefined
    const length = Math.min(size, OUTPUT_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const read = readSync(file, buffer, 0, length, size - length)
    return outputTail(buffer.toString("utf8", 0, read), size > length)
  } catch {
    return undefined
  } finally {
    if (file !== undefined) closeSync(file)
  }
}

/** A command's output as a body shows it, and where it was read. */
export interface TaskOutput {
  output: string
  from: OutputOrigin
}

/**
 * The end of a background command's output: from its file while the file
 * is there, keeping a copy of what was read under the task's identity
 * (session and task id, from the file's own path), and from that copy once
 * the file is gone, after a reboot or Claude Code's own cleanup.
 */
export function claudeTaskOutput(path: string | undefined, taskId: string | undefined, kept?: KeptOutputs): TaskOutput | undefined {
  const key = taskFile(path, taskId)
  if (!key) return undefined
  const output = claudeTaskOutputTail(path, taskId)
  if (output) {
    kept?.keep(key, { output })
    return { output, from: "output-file" }
  }
  const copy = kept?.read(key)?.output
  return copy ? { output: copy, from: "kept-copy" } : undefined
}
