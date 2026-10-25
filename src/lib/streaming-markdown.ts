/**
 * What a streaming answer draws, and where its parse may be cut.
 *
 * Both read the Markdown line by line and track code fences, the one block
 * whose inside is never Markdown. Neither renders anything; `Prose` feeds
 * what they return to the same parser a settled answer gets.
 */

/** An opening fence: three or more backticks or tildes, at most three spaces in. A backtick fence's info has no backtick. */
const OPENER = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})/
/** A closing fence: only the fence characters and trailing spaces. */
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** A table's delimiter row, whole: `| --- | :-: |` or `--- | ---`. */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
/** The start of a delimiter row still arriving: pipes, dashes, colons and spaces, with a dash or a pipe. */
const DELIMITER_START = /^ {0,3}[|:\- \t]*$/
/** A line that opens a table with a pipe. */
const PIPE_ROW = /^ {0,3}\|/
/**
 * A last line that is only marks so far: under a paragraph `-` or `=` turns
 * it into a heading, alone it is a rule, and one or two backticks may be a
 * fence on its way. Each settles with its next character.
 */
const MARKS_ONLY = /^ {0,3}(?:[-=*_]+[ \t]*|`{1,2}|~{1,2})$/
/**
 * A line outside code whose reach is the whole document: a link reference or
 * footnote definition (`[x]: …`, `[^1]: …`) changes text anywhere, and an
 * HTML block can swallow what looks like a fence.
 */
const NON_LOCAL_LINE = /^ {0,3}(?:\[[^\]]+\]:|<[A-Za-z/!?])/
/** A carriage return or a byte-order mark changes how every line is read. */
const NON_LOCAL_TEXT = /\r|\uFEFF/

interface Line {
  /** Offset of its first character. */
  start: number
  text: string
  /** Ends in a newline: nothing more will be added to it. */
  complete: boolean
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start < text.length) {
    const end = text.indexOf("\n", start)
    if (end < 0) {
      lines.push({ start, text: text.slice(start), complete: false })
      break
    }
    lines.push({ start, text: text.slice(start, end), complete: true })
    start = end + 1
  }
  return lines
}

interface Fence {
  mark: string
  length: number
  /** The opening line's index. */
  line: number
  /** At the left edge, so no list or quote can hold it. */
  topLevel: boolean
}

/** Whether `line` closes `fence`: the same character, at least as many. */
function closes(fence: Fence, line: string): boolean {
  const run = CLOSER.exec(line)?.[1]
  return run !== undefined && run[0] === fence.mark && run.length >= fence.length
}

function opens(line: string, index: number): Fence | undefined {
  const match = OPENER.exec(line)
  if (!match) return undefined
  const run = match[2]!
  return { mark: run[0]!, length: run.length, line: index, topLevel: match[1] === "" }
}

const blank = (line: string) => line.trim() === ""

/**
 * The part of a streaming answer to draw now. Everything stays live except
 * the trailing block's half-built structure, which would flash as something
 * it isn't: a table is drawn once its header and delimiter rows have arrived,
 * then a row at a time; a fence waits for the end of its opening line (after
 * that the code streams in it as code); and a last line that is only marks
 * so far waits for the character that says what it is. Paragraphs, lists and
 * headings stream word by word.
 */
export function streamingMarkdown(text: string): string {
  const lines = linesOf(text)
  let fence: Fence | undefined
  // The first line of the block still being written: after the last blank line outside a fence.
  let block = 0
  for (const [index, line] of lines.entries()) {
    if (fence) {
      if (closes(fence, line.text)) {
        fence = undefined
        block = index + 1
      }
      continue
    }
    fence = opens(line.text, index)
    if (fence) continue
    if (blank(line.text)) block = index + 1
  }
  if (fence) {
    const opener = lines[fence.line]!
    return opener.complete ? text : text.slice(0, opener.start)
  }
  const last = lines.at(-1)
  for (let index = block; index < lines.length; index++) {
    const line = lines[index]!
    const next = lines[index + 1]
    if (!line.text.includes("|")) continue
    // A row of pipes with nothing under it yet, or with its delimiter still arriving, is a table on its way.
    if (PIPE_ROW.test(line.text) && (!next || (!next.complete && DELIMITER_START.test(next.text))))
      return text.slice(0, line.start)
    if (next?.complete && DELIMITER_ROW.test(next.text)) {
      // A table: only its finished rows.
      return last && !last.complete ? text.slice(0, last.start) : text
    }
  }
  // A delimiter arriving under a header without pipes at its edge would draw the header as a heading meanwhile.
  if (last && !last.complete && (MARKS_ONLY.test(last.text) || (DELIMITER_START.test(last.text) && /-/.test(last.text))))
    return text.slice(0, last.start)
  return text
}

/**
 * The answer cut where its parse can be cached: after a closed fence at the
 * left edge and the blank line that follows it. A blank line alone is not
 * such a place (a list with spaced items would parse as several lists, a
 * setext heading would lose its underline), but nothing carries across a
 * closed fence: it ends any list or quote above it, and its own lines are
 * never Markdown. The pieces join back to `text` exactly. A document whose
 * context is not local (definitions or HTML blocks outside code, `\r`, a
 * byte-order mark) stays one piece.
 */
export function fenceSegments(text: string): string[] {
  if (NON_LOCAL_TEXT.test(text)) return [text]
  const lines = linesOf(text)
  const cuts: number[] = []
  let fence: Fence | undefined
  let closed = false
  for (const [index, line] of lines.entries()) {
    if (fence) {
      if (closes(fence, line.text)) {
        closed = fence.topLevel
        fence = undefined
      }
      continue
    }
    if (closed && blank(line.text) && line.complete) {
      const end = line.start + line.text.length + 1
      if (end < text.length) cuts.push(end)
    }
    closed = false
    if (NON_LOCAL_LINE.test(line.text)) return [text]
    fence = opens(line.text, index)
  }
  const segments: string[] = []
  let from = 0
  for (const cut of cuts) {
    segments.push(text.slice(from, cut))
    from = cut
  }
  segments.push(text.slice(from))
  return segments
}
