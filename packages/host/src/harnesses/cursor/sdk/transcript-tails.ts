import { closeSync, fstatSync, ftruncateSync, openSync, readdirSync, readSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { withTranscriptLock, type LockOptions } from "./transcript-lock.js"

const BLOCK = 64 * 1024
/** An open waits this long for a child still writing a transcript: under the host's 20 s of silence. */
const REPAIR_WAIT_MS = 10_000
/** A full write staged beside its transcript by the patched SDK (`scripts/patch-cursor-sdk.mjs`), and its writer's pid. */
const STAGED = /\.mako-\d+\.tmp$/

/**
 * Where SDK 1.2.0 writes an agent's transcripts: under `CURSOR_DATA_DIR/projects`
 * or `~/.cursor/projects`, the workspace path with each run of other characters
 * as one `-`, then `agent-transcripts/<agent id>`, holding `<agent id>.jsonl`
 * and `subagents/<child id>.jsonl`.
 */
export function cursorTranscriptFolder(cwd: string, agentId: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const root = env.CURSOR_DATA_DIR?.trim() ? join(env.CURSOR_DATA_DIR, "projects") : join(home, ".cursor", "projects")
  const project = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
  const id = encodeURIComponent(agentId).replace(/%/g, "_").slice(0, 200)
  return join(root, project, "agent-transcripts", id)
}

/**
 * Makes one transcript whole after a process writing it died: deletes the
 * full write it staged, and cuts a torn append back to its last complete line,
 * since the SDK ends every line it writes with a newline. Only for a caller
 * holding the transcript's lock (`withTranscriptLock`): every writer holds it
 * while it writes, so what the holder finds unfinished, nobody is finishing.
 * Returns whether it cut the file.
 */
export function recoverTranscript(file: string): boolean {
  const prefix = `${basename(file)}.mako-`
  let names: string[] = []
  try {
    names = readdirSync(dirname(file))
  } catch {
    // No folder, nothing written.
  }
  for (const name of names) if (name.startsWith(prefix) && STAGED.test(name)) removeIfThere(join(dirname(file), name))
  return cutTornTail(file)
}

/**
 * The function the patched SDK runs each transcript write inside: the file's
 * lock, and the file made whole before the write, since a holder that died
 * leaves no sign that it did.
 */
export const transcriptLock = <T>(file: string, work: () => Promise<T>): Promise<T> =>
  withTranscriptLock(file, async () => {
    recoverTranscript(file)
    return work()
  })

/**
 * Makes the transcripts of the agent a child is about to open whole again
 * after a child was killed writing them, each under its own lock so a writer
 * still running in another child is waited for, never cut. Only this agent's
 * files: its transcript and its subagents'. Returns the transcripts it cut,
 * and throws, after trying every file, naming those it left because a writer
 * held them.
 */
export async function repairCursorTranscripts(folder: string, options: LockOptions = { waitMs: REPAIR_WAIT_MS }): Promise<string[]> {
  const files = new Set<string>()
  for (const dir of [folder, join(folder, "subagents")]) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const file = name.replace(STAGED, "")
      if (file.endsWith(".jsonl")) files.add(join(dir, file))
    }
  }
  const cut: string[] = []
  const left: string[] = []
  for (const file of files) {
    try {
      if (await withTranscriptLock(file, async () => recoverTranscript(file), options)) cut.push(file)
    } catch {
      left.push(file)
    }
  }
  if (left.length) throw new Error(`left ${left.join(", ")}: another process holds the lock`)
  return cut
}

const code = (cause: unknown) => (cause instanceof Error && "code" in cause ? cause.code : undefined)

function removeIfThere(path: string): void {
  try {
    unlinkSync(path)
  } catch (cause) {
    if (code(cause) !== "ENOENT") throw cause
  }
}

function cutTornTail(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, "r+")
  } catch (cause) {
    if (code(cause) === "ENOENT") return false
    throw cause
  }
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(BLOCK)
    for (let end = size; end > 0; end -= BLOCK) {
      const start = Math.max(0, end - BLOCK)
      readSync(fd, buffer, 0, end - start, start)
      const newline = buffer.subarray(0, end - start).lastIndexOf(10)
      if (newline < 0) continue
      if (start + newline + 1 === size) return false
      ftruncateSync(fd, start + newline + 1)
      return true
    }
    if (size === 0) return false
    ftruncateSync(fd, 0)
    return true
  } finally {
    closeSync(fd)
  }
}
