import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import type { KeptOutputs, OutputKey, OutputOrigin } from "../kept-outputs.js"
import { OUTPUT_TAIL_BYTES, outputTail } from "../provider-turn.js"

/** What a background shell's terminal file says of how it ended, and the end of what it printed. */
export interface CursorTerminalEnd {
  exitCode?: number
  durationMs?: number
  output?: string
  /** Where it was read: the terminal file, or the copy kept of it once Cursor removed the file. */
  from?: OutputOrigin
}

/** The footer Cursor writes when the shell ends: `---\nexit_code: 0\nelapsed_ms: 15470\nended_at: …\n---`. */
const FOOTER = /\n---\n((?:[a-z_]+: [^\n]*\n)+)---\s*$/

/**
 * How a background shell ended, from the file Cursor keeps its output in
 * (`~/.cursor/projects/<project>/terminals/<task>.txt`), while the file is
 * still there. The path comes from the task notification, so only a regular
 * file in a `terminals` folder of Cursor's own projects folder is opened,
 * and only its end is read: a header that may be cut, the output, then the
 * footer. What was read is kept (`KeptOutputs`), and read back once Cursor
 * has removed the file.
 */
export function cursorTerminalEnd(path: string | undefined, home = homedir(), kept?: KeptOutputs): CursorTerminalEnd | undefined {
  if (!path || !/^\d+\.txt$/.test(basename(path)) || basename(dirname(path)) !== "terminals") return undefined
  // The terminal's identity: Cursor's folder for the project, and the terminal's number.
  const key: OutputKey = { harness: "cursor", session: basename(dirname(dirname(path))), task: basename(path, ".txt") }
  const end = terminalFile(path, home)
  if (end) {
    kept?.keep(key, end)
    return { ...end, from: "output-file" }
  }
  const copy = kept?.read(key)
  return copy ? { ...copy, from: "kept-copy" } : undefined
}

function terminalFile(path: string, home: string): CursorTerminalEnd | undefined {
  let file: number | undefined
  try {
    if (!lstatSync(path).isFile()) return undefined
    const real = realpathSync(path)
    if (!real.startsWith(join(realpathSync(home), ".cursor", "projects") + sep)) return undefined
    file = openSync(real, "r")
    const size = fstatSync(file).size
    const length = Math.min(size, OUTPUT_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const read = readSync(file, buffer, 0, length, size - length)
    const text = buffer.toString("utf8", 0, read)
    const footer = FOOTER.exec(text)
    const fields = new Map(Array.from(footer?.[1]?.matchAll(/^([a-z_]+): (.*)$/gm) ?? [], (match) => [match[1]!, match[2]!.trim()]))
    // The output runs from the header's closing `---` (when the tail still holds it) to the footer.
    const body = footer ? text.slice(0, footer.index) : text
    const header = /^---\n[\s\S]*?\n---\n/.exec(body)
    const output = outputTail(header ? body.slice(header[0].length) : body, size > length && !header)
    const end: CursorTerminalEnd = {}
    const exit = /^-?\d+$/.exec(fields.get("exit_code") ?? "")?.[0]
    const elapsed = /^\d+$/.exec(fields.get("elapsed_ms") ?? "")?.[0]
    if (exit !== undefined) end.exitCode = Number(exit)
    if (elapsed !== undefined) end.durationMs = Number(elapsed)
    if (output) end.output = output
    return end
  } catch {
    return undefined
  } finally {
    if (file !== undefined) closeSync(file)
  }
}
