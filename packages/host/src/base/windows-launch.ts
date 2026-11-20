import { existsSync, readFileSync } from "node:fs"
import { win32 } from "node:path"

const { dirname, extname, isAbsolute, join, resolve } = win32

/**
 * How Windows runs a batch file the host was asked to start. Node refuses to spawn a `.cmd` or `.bat` without a shell
 * (EINVAL, since its fix for CVE-2024-27980), and most agent CLIs reach Windows as npm's `.cmd` shims. A shim is run as
 * what it runs, Node on its script, so no shell parses anything; any other batch file goes through `ComSpec /d /s /c`
 * with each word escaped for cmd.exe twice, once for the command line and once for the `%*` the batch file passes on
 * (cross-spawn's rules). A batch file that passes `%*` on hears every word as given; one that reads `%1` itself sees it
 * still escaped once, the price of no word ever reaching cmd.exe as a command (CVE-2024-27980).
 */
export interface WindowsLaunch {
  file: string
  args: string[]
  /** The arguments are one command line already quoted for cmd.exe: Node must pass them as they are. */
  verbatim: boolean
}

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

/** The Node an npm shim prefers: one beside it, else the one on PATH (its `SET "_prog=node"`), else the host's own. */
function shimNode(shim: string, node: string): string {
  const beside = join(dirname(shim), "node.exe")
  return existsSync(beside) ? beside : node
}

/** One word for cmd.exe's command line, as the program it starts will split it again. */
export function cmdArgument(word: string, batch = true): string {
  // Backslashes before a quote, or before the closing quote added below, are doubled; the quote itself escaped.
  let quoted = word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")
  quoted = `"${quoted}"`.replace(CMD_META, "^$1")
  // A batch file hands its arguments to cmd.exe once more as it expands `%*`.
  return batch ? quoted.replace(CMD_META, "^$1") : quoted
}

/**
 * `file args` as Windows can start it: an npm shim as Node on its script, another batch file through ComSpec, anything
 * else unchanged. `node` is the Node to run a shim with when none is beside it.
 */
export function windowsLaunch(file: string, args: readonly string[], env: NodeJS.ProcessEnv, node: string): WindowsLaunch {
  if (!isBatchFile(file)) return { file, args: [...args], verbatim: false }
  let text: string | undefined
  try {
    text = isAbsolute(file) ? readFileSync(file, "utf8") : undefined
  } catch {
    text = undefined
  }
  const script = text === undefined ? undefined : npmShimScript(file, text)
  if (script && existsSync(script)) return { file: shimNode(file, node), args: [script, ...args], verbatim: false }
  const shell = env.ComSpec || env.COMSPEC || "cmd.exe"
  const line = [file.replace(CMD_META, "^$1"), ...args.map((arg) => cmdArgument(arg))].join(" ")
  return { file: shell, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true }
}
