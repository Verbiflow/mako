import { closeSync, fstatSync, ftruncateSync, openSync, readdirSync, readSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const BLOCK = 64 * 1024
/** A full write staged beside its transcript by the patched SDK (`scripts/patch-cursor-sdk.mjs`), and its writer's pid. */
const STAGED = /\.mako-(\d+)\.tmp$/

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
 * Makes an agent's transcripts whole again after a child was killed writing
 * them. A full write is renamed into place whole, so only its staged file can
 * be left behind, and is deleted once its writer is gone. An append can stop
 * inside a line: the SDK ends every line it writes with a newline, so a file
 * that doesn't end in one is cut back to its last complete line. Returns the
 * transcripts it cut.
 */
export function repairCursorTranscripts(folder: string): string[] {
  const cut: string[] = []
  for (const dir of [folder, join(folder, "subagents")]) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(dir, name)
      const staged = STAGED.exec(name)
      if (staged) {
        if (!alive(Number(staged[1]))) unlinkSync(path)
      } else if (name.endsWith(".jsonl") && cutTornTail(path)) cut.push(path)
    }
  }
  return cut
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

function cutTornTail(path: string): boolean {
  const fd = openSync(path, "r+")
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
