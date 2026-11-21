import { existsSync, readFileSync } from "node:fs"
import { win32 } from "node:path"
import { windowsComSpec } from "./system-tools.js"

const { dirname, extname, isAbsolute, join, resolve } = win32

/**
 * How Windows runs a batch file the host was asked to start. Node refuses to spawn a `.cmd` or `.bat` without a shell
 * (EINVAL, since its fix for CVE-2024-27980), and most agent CLIs reach Windows as npm's `.cmd` shims. A shim is run as
 * what it runs, Node on its script, so no shell parses anything; any other batch file goes through `ComSpec /d /s /c`
 * with each word escaped for cmd.exe twice, once for the command line and once for the `%*` the batch file passes on
 * (cross-spawn's rules). A batch file that passes `%*` on hears every word as given; one that reads `%1` itself sees it
 * still escaped once, the price of no word ever reaching cmd.exe as a command (CVE-2024-27980). A batch file is run
 * only by its whole path, with delayed expansion off (`/v:off`), and no word may hold a line break or NUL, which
 * cmd.exe would end the command at, dropping what follows or running it as another.
 */
export interface WindowsLaunch {
  file: string
  args: string[]
  /** The arguments are one command line already quoted for cmd.exe: Node must pass them as they are. */
  verbatim: boolean
  /** The environment to start it with, when it must differ: Electron's own executable runs a shim only as Node. */
  env?: NodeJS.ProcessEnv
}

/** A batch file Windows can't be asked to run as asked: by no whole path, or with a word cmd.exe would split a line at. */
export class BatchLaunchError extends Error {}

const BATCH = new Set([".cmd", ".bat"])
/** cmd.exe's own characters, each escaped with `^` where it isn't to be read. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export const isBatchFile = (file: string): boolean => BATCH.has(extname(file).toLowerCase())

/**
 * The script an npm shim runs (cmd-shim's `"%_prog%"  "%dp0%\…\cli.js" %*`, or the older `"%~dp0\node.exe"
 * "%~dp0\…\cli.js" %*`), when `text` is one: a JavaScript file beside it.
 */
export function npmShimScript(shim: string, text: string): string | undefined {
  const target = /"%(?:_prog|~dp0\\node\.exe)%?"\s+"%~?dp0%?\\([^"]+\.[cm]?js)"\s+%\*/i.exec(text)?.[1]
  return target ? resolve(dirname(shim), target) : undefined
}

/**
 * The Node an npm shim prefers: one beside it, else the one on PATH (its `SET "_prog=node"`), else the host's own,
 * which under Electron runs as Node only when told to.
 */
function shimNode(shim: string, node: string | null, env: NodeJS.ProcessEnv): Pick<WindowsLaunch, "file" | "env"> {
  const beside = join(dirname(shim), "node.exe")
  if (existsSync(beside)) return { file: beside }
  if (node) return { file: node }
  return process.versions.electron ? { file: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } } : { file: process.execPath }
}

/** One word for cmd.exe's command line, as the program it starts will split it again. */
export function cmdArgument(word: string, batch = true): string {
  // Backslashes before a quote, or before the closing quote added below, are doubled; the quote itself escaped.
  let quoted = doubledBeforeQuotes(word)
  quoted = `"${quoted}"`.replace(CMD_META, "^$1")
  // A batch file hands its arguments to cmd.exe once more as it expands `%*`.
  return batch ? quoted.replace(CMD_META, "^$1") : quoted
}

/**
 * `file args` as Windows can start it: an npm shim as Node on its script, another batch file through ComSpec, anything
 * else unchanged. `node` is the Node to run a shim with when none is beside it.
 */
export function windowsLaunch(file: string, args: readonly string[], env: NodeJS.ProcessEnv, node: string | null): WindowsLaunch {
  if (!isBatchFile(file)) return { file, args: [...args], verbatim: false }
  if (!isAbsolute(file)) throw new BatchLaunchError(`A batch file runs only by its whole path, not ${file}`)
  let text: string | undefined
  try {
    text = readFileSync(file, "utf8")
  } catch {
    text = undefined
  }
  const script = text === undefined ? undefined : npmShimScript(file, text)
  if (script && existsSync(script)) {
    const shim = shimNode(file, node, env)
    return { file: shim.file, args: [script, ...args], verbatim: false, ...(shim.env && { env: shim.env }) }
  }
  if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new BatchLaunchError(`${file} can't be given a word with a line break or NUL in it`)
  const line = [file.replace(CMD_META, "^$1"), ...args.map((arg) => cmdArgument(arg))].join(" ")
  return { file: windowsComSpec(env), args: ["/d", "/v:off", "/s", "/c", `"${line}"`], verbatim: true }
}

/**
 * A word with each quote escaped and the backslashes before a quote, or at its end, doubled: what the C runtime's
 * argument rules ask of a word about to be wrapped in quotes. One pass, so a long run of backslashes costs its length.
 */
function doubledBeforeQuotes(word: string): string {
  let result = ""
  let backslashes = 0
  for (const character of word) {
    if (character === "\\") {
      backslashes += 1
      continue
    }
    result += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character
    backslashes = 0
  }
  return result + "\\".repeat(backslashes * 2)
}
