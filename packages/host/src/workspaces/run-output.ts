import { stripVTControlCharacters } from "node:util"

/**
 * A run's output as an agent reads it: everything the run wrote, less what
 * carries nothing. Terminal colour and cursor codes go, a line redrawn in
 * place (a progress bar) keeps only its final text, and a line repeated back
 * to back is written once with its count. Nothing else is dropped.
 *
 * A reply has to fit a model's context and the harness's own cap on a tool
 * result, which cuts blindly. Output longer than OUTPUT_BUDGET keeps every
 * line that names an error or a file location, with the lines around it, and
 * the last lines of the run; it says how much it left out and where the whole
 * log is, which the agent can read with its own file tools.
 */
export const OUTPUT_BUDGET = { lines: 2_000, chars: 100_000 }
const TAIL_LINES = 200
const AROUND = 2

const ERROR_LINE =
  /\b(?:error|errors|fail|failed|failing|failure|panic|panicked|exception|traceback|fatal|assert(?:ion)?|cannot|unable|not found|denied|refused|timed out|timeout)\b|[✗✖×]|\S+\.[A-Za-z]{1,6}:\d+/i

/** The output with only its noise removed. */
export function cleanOutput(raw: string): string {
  const lines = stripVTControlCharacters(raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const redrawn = line.split("\r").filter((part) => part.trim() !== "")
      return printable(redrawn.at(-1) ?? "").trimEnd()
    })
  const kept: string[] = []
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!
    let end = index + 1
    while (end < lines.length && lines[end] === line) end += 1
    const count = end - index
    kept.push(count > 1 && line !== "" ? `${line}  [repeated ${count} times]` : line)
    index = end
  }
  while (kept.length && kept[0] === "") kept.shift()
  while (kept.length && kept.at(-1) === "") kept.pop()
  return kept.join("\n")
}

/** Without control characters other than tab, such as a bell or a backspace. */
function printable(line: string): string {
  return [...line].filter((character) => {
    const code = character.codePointAt(0) ?? 0
    return code === 9 || (code >= 32 && code !== 127)
  }).join("")
}

function fits(lines: string[], budget: typeof OUTPUT_BUDGET): boolean {
  return lines.length <= budget.lines && lines.reduce((sum, line) => sum + line.length + 1, 0) <= budget.chars
}

/**
 * The output for a tool reply: all of it when it fits, otherwise every
 * error line with its surroundings and the run's last lines, each gap marked
 * with what it left out, and the path of the whole log. Several outputs in
 * one reply share it by each taking a smaller `budget`.
 */
export function presentOutput(raw: string, log: string, budget = OUTPUT_BUDGET): string {
  const text = cleanOutput(raw)
  if (!text) return "(no output)"
  const lines = text.split("\n")
  if (fits(lines, budget)) return text
  const tail = Math.min(TAIL_LINES, Math.floor(budget.lines / 2))
  const shown = new Set<number>()
  lines.forEach((line, index) => {
    if (!ERROR_LINE.test(line)) return
    for (let near = Math.max(0, index - AROUND); near <= Math.min(lines.length - 1, index + AROUND); near += 1) shown.add(near)
  })
  for (let index = Math.max(0, lines.length - tail); index < lines.length; index += 1) shown.add(index)
  const out: string[] = []
  let chars = 0
  let gap = 0
  let unshown = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (!shown.has(index)) {
      gap += 1
      continue
    }
    const line = lines[index]!
    if (out.length >= budget.lines || chars + line.length + 1 > budget.chars) {
      unshown = [...shown].filter((at) => at >= index).length
      break
    }
    if (gap) out.push(`[${gap} line${gap === 1 ? "" : "s"} with no error left out]`)
    gap = 0
    out.push(line)
    chars += line.length + 1
  }
  const note = unshown
    ? `${lines.length} lines of output, more errors than fit in a reply: these are the first; ${unshown} more lines naming errors or the run's end are in ${log}.`
    : `${lines.length} lines of output; shown are every line naming an error or a file location, with ${AROUND} lines around each, and the last ${tail}. All of it is in ${log}.`
  return [note, ...out].join("\n")
}
