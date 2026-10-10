import { existsSync, readdirSync } from "node:fs"
import { mkdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * Grok writes `<workspace>/<id>/updates.jsonl` (`chat_history.jsonl` before
 * 1.0) under Grok's home's `sessions`, one folder per URL-encoded launch directory;
 * the other folders are searched when the directory was spelled differently,
 * as a macOS temporary path is under /private.
 */
export const GROK_TRANSCRIPTS = ["updates.jsonl", "chat_history.jsonl"]

export function grokSessionSource(
  nativeId: string,
  cwd: string,
  root: string
): string | undefined {
  if (!/^[\w-]+$/.test(nativeId)) return undefined
  let workspaces: string[]
  try {
    workspaces = readdirSync(root)
  } catch {
    return undefined
  }
  const launched = encodeURIComponent(cwd)
  for (const workspace of [launched, ...workspaces.filter((name) => name !== launched)])
    for (const transcript of GROK_TRANSCRIPTS) {
      const path = join(root, workspace, nativeId, transcript)
      if (existsSync(path)) return path
    }
  return undefined
}

/**
 * Moves a session's folder under `to`'s workspace, where Grok's
 * `session/load` looks when launched there: Grok refuses a session saved
 * under another directory. Returns its transcript's new path, or nothing
 * when no saved session has this ID or one is already saved under `to`.
 */
export async function relocateGrokSession(input: { nativeId: string; to: string; root: string }): Promise<string | undefined> {
  const current = grokSessionSource(input.nativeId, input.to, input.root)
  if (!current) return undefined
  const folder = dirname(current)
  const target = join(input.root, encodeURIComponent(input.to), input.nativeId)
  if (folder === target) return current
  if (existsSync(target)) return undefined
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await rename(folder, target)
  return join(target, current.slice(folder.length + 1))
}
