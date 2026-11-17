import { existsSync, readdirSync } from "node:fs"
import { mkdir, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { publishFile } from "../../base/published-files.js"

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
 * under another directory. Then points what Grok replays to the model at
 * `to` (`retargetGrokSession`). Returns its transcript's new path, or
 * nothing when no saved session has this ID or one is already saved under `to`.
 */
export async function relocateGrokSession(input: { nativeId: string; to: string; root: string }): Promise<string | undefined> {
  const current = grokSessionSource(input.nativeId, input.to, input.root)
  if (!current) return undefined
  const folder = dirname(current)
  const target = join(input.root, encodeURIComponent(input.to), input.nativeId)
  if (folder !== target) {
    if (existsSync(target)) return undefined
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(folder, target)
  }
  await retargetGrokSession(target, input.to)
  return join(target, current.slice(folder.length + 1))
}

const GrokSummary = z.object({ info: z.object({ cwd: z.string() }).loose() }).loose()

/** Each spelling of `path` a macOS process may have written: with and without `/private` before a temporary folder. */
function spellings(path: string): string[] {
  const bare = path.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, "")
  return bare === path ? [path, `/private${path}`] : [path, bare]
}

/** A path as JSON spells it inside a string, and as a `file://` URI spells it. */
const asJson = (path: string) => JSON.stringify(path).slice(1, -1)
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Before a path: the start, whitespace (or JSON's escaped `\n`, `\r`, `\t`), a quote, `=`, `:`, `(`, `<`, a backtick,
 * or `file://`. A path inside a longer one (`/Volumes/b/Users/k/main` holding `/Users/k/main`) is never taken.
 */
const BEFORE = String.raw`(?<=^|[\s"'=:(<\x60]|\\[nrt]|file://)`
/** After a path: its end, or a character no folder name continues with (`main` is not `main2` or `main.old`). */
const AFTER = String.raw`(?=$|[^\w.%-])`

/**
 * Grok keeps the model's context beside the transcript, in
 * `chat_history.jsonl`, and replays it on `session/load`: its first user
 * message is a `<user_info>` naming "Workspace Path: <the folder it started
 * in>", and calls' results name paths under it, the text of files a tool
 * returned included, since all of it is what the model reads again. Loaded
 * in another folder (a Thread moved into its worktree), the model was told
 * the first folder still, and could read or write there. Every whole path
 * under the folder `summary.json` saved (`info.cwd`) becomes the same path
 * under `to`, in that context and in `summary.json`'s own `cwd` and
 * `git_root_dir`, which the catalog lists the session under, as JSON spells
 * it and as a `file://` URI does. `updates.jsonl`, the transcript Mako draws,
 * keeps what happened.
 *
 * Both folders' spellings go into one pattern, longest first, and only a
 * match of the old folder is rewritten: a path already under `to` stays, so a
 * folder under the old one (`/repo` to `/repo/sub`) moves once, a rerun after
 * a crash changes nothing, and a move back (`/repo/sub` to `/repo`) takes the
 * longer, more specific folder. Each file is published whole (`publishFile`,
 * in Grok's own folder), before Grok opens the session.
 */
export async function retargetGrokSession(folder: string, to: string): Promise<void> {
  const summaryFile = join(folder, "summary.json")
  const summary = GrokSummary.safeParse(JSON.parse(await readFile(summaryFile, "utf8").catch(() => "null"))).data
  const from = summary?.info.cwd.replace(/\/+$/, "")
  const destination = to.replace(/\/+$/, "")
  if (!from || spellings(from).includes(destination)) return
  const forms = (path: string) => [...new Set([asJson(path), asJson(encodeURI(path))])]
  const choices = [
    ...spellings(destination).flatMap((path) => forms(path).map((text) => ({ text, keep: true, uri: false }))),
    ...spellings(from).flatMap((path) => [
      { text: asJson(path), keep: false, uri: false },
      { text: asJson(encodeURI(path)), keep: false, uri: true },
    ]),
  ].sort((left, right) => right.text.length - left.text.length)
  const pattern = new RegExp(`${BEFORE}(?:${choices.map(({ text }) => `(${escaped(text)})`).join("|")})${AFTER}`, "g")
  const replace = (match: string, ...groups: (string | undefined)[]) => {
    const choice = choices[groups.findIndex((group, index) => index < choices.length && group !== undefined)]
    if (!choice || choice.keep) return match
    return choice.uri ? asJson(encodeURI(destination)) : asJson(destination)
  }
  for (const name of ["chat_history.jsonl", "summary.json"]) {
    const file = join(folder, name)
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const moved = text.replace(pattern, replace)
    if (moved === text) continue
    await publishFile(file, moved, { foreignFolder: true, mode: 0o600 })
  }
}
