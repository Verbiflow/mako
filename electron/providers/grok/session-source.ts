import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

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
