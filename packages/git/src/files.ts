import { existsSync } from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * What Git keeps in plain files, read without starting Git: a ref's commit, a configuration file's values, and a
 * file's stamp to tell when either changed. The host asked Git for these by a process a time, hundreds a minute, for
 * answers that sat in files it could read itself.
 */

const OBJECT_ID = /^[a-f0-9]{40,64}$/

/** A file by its path, size and modification time; `none` when it isn't there. */
export async function fileStamp(path: string): Promise<string> {
  const found = await lstat(path).catch(() => null)
  return `${path}:${found ? `${found.size}:${found.mtimeMs}` : "none"}`
}

/**
 * The configuration files Git reads for the person, as this process's environment places them: `GIT_CONFIG_GLOBAL`
 * alone when it is set, else `.gitconfig` in the home folder and `git/config` under the XDG folder.
 */
export function personalGitConfigFiles(): string[] {
  if (process.env.GIT_CONFIG_GLOBAL) return [process.env.GIT_CONFIG_GLOBAL]
  return [join(homedir(), ".gitconfig"), join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "config")]
}

/** A file's text, trimmed; null when it isn't there, undefined when it can't be read. */
export async function gitFileText(path: string): Promise<string | null | undefined> {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" ? null : undefined
  }
}

/**
 * The commit a ref every checkout shares points at, from the files under `commonDir`: the ref's own file, or its line
 * in `packed-refs` once Git has packed it. Git writes the packed line before it removes the file, so looking in that
 * order never misses a ref. Null when there is no such ref; undefined when the files can't say, and Git must be asked:
 * a reftable repository, a ref that names another ref, a file that can't be read.
 */
export async function storedRef(commonDir: string, ref: string): Promise<string | null | undefined> {
  if (!ref.startsWith("refs/") || ref.split("/").includes("..") || existsSync(join(commonDir, "reftable"))) return undefined
  const loose = await gitFileText(join(commonDir, ref))
  if (loose === undefined) return undefined
  if (loose !== null) return OBJECT_ID.test(loose) ? loose : undefined
  const packed = await gitFileText(join(commonDir, "packed-refs"))
  if (packed === undefined) return undefined
  // One ref a line, its commit before its name; a tag's peeled line and the header name no ref this way.
  const lines = `\n${packed ?? ""}\n`
  const at = lines.indexOf(` ${ref}\n`)
  if (at < 0) return null
  const commit = lines.slice(lines.lastIndexOf("\n", at) + 1, at)
  return OBJECT_ID.test(commit) ? commit : undefined
}

/**
 * A Git configuration file's values, by `section.key` or `section.subsection.key` as `git config` names them (section
 * and key in lower case, a subsection as written), each with every value given it in order. Only this file: one it
 * includes isn't followed, and what another file or `url.*.insteadOf` would change isn't applied.
 */
export function parseGitConfig(text: string): Map<string, string[]> {
  const values = new Map<string, string[]>()
  let section = ""
  const lines = text.split("\n")
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    if (line.startsWith("[")) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
      if (!header) {
        section = ""
        continue
      }
      // The old `[section.subsection]` form names its subsection in any case; a quoted one is as written.
      section = header[2] === undefined ? header[1]!.toLowerCase() : `${header[1]!.toLowerCase()}.${header[2].replace(/\\(.)/g, "$1")}`
      continue
    }
    const named = /^([A-Za-z][A-Za-z0-9-]*)\s*(=\s*)?/.exec(line)
    if (!section || !named) continue
    let raw = named[2] === undefined ? "" : line.slice(named[0].length)
    // A line ending in a backslash goes on in the next.
    while (/(^|[^\\])(\\\\)*\\$/.test(raw) && at + 1 < lines.length) raw = `${raw.slice(0, -1)}${lines[++at]!.replace(/\r$/, "")}`
    const key = `${section}.${named[1]!.toLowerCase()}`
    const value = named[2] === undefined ? "true" : configValue(raw)
    const known = values.get(key)
    if (known) known.push(value)
    else values.set(key, [value])
  }
  return values
}

/** The character a backslash before `char` stands for: Git's three named escapes, or the character itself. */
function escaped(char: string): string {
  return char === "n" ? "\n" : char === "t" ? "\t" : char === "b" ? "\b" : char
}

/** One value as Git reads it: quotes taken off, escapes applied, a comment and the space around it left out. */
function configValue(raw: string): string {
  let value = ""
  let quoted = false
  // Space outside quotes counts only between words: what trails the last one is dropped.
  let kept = 0
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at]!
    if (char === "\\" && at + 1 < raw.length) {
      value += escaped(raw[++at]!)
      kept = value.length
    } else if (char === '"') {
      quoted = !quoted
      kept = value.length
    } else if (!quoted && (char === "#" || char === ";")) break
    else {
      value += char
      if (quoted || !/\s/.test(char)) kept = value.length
    }
  }
  return value.slice(0, kept)
}
