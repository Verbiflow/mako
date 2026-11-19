/** A line of an edit as a tool row draws it. */
export interface DiffLine {
  kind: "context" | "add" | "remove"
  text: string
  oldLine?: number
  newLine?: number
}

/**
 * Line diff by common prefix/suffix trimming. It is O(n) instead of an LCS,
 * which is exactly right here: an edit's old and new text already share their
 * head and tail, and the transcript only needs to show what moved.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n")
  const right = after.split("\n")

  let head = 0
  while (
    head < left.length &&
    head < right.length &&
    left[head] === right[head]
  )
    head += 1

  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1
  }

  const lines: DiffLine[] = []
  const context = 2
  for (let i = Math.max(0, head - context); i < head; i += 1) {
    lines.push({ kind: "context", text: left[i], oldLine: i + 1, newLine: i + 1 })
  }
  for (let i = head; i < left.length - tail; i += 1) {
    lines.push({ kind: "remove", text: left[i], oldLine: i + 1 })
  }
  for (let i = head; i < right.length - tail; i += 1) {
    lines.push({ kind: "add", text: right[i], newLine: i + 1 })
  }
  for (
    let i = left.length - tail;
    i < Math.min(left.length, left.length - tail + context);
    i += 1
  ) {
    lines.push({ kind: "context", text: left[i], oldLine: i + 1, newLine: right.length - left.length + i + 1 })
  }
  return lines
}

/** Every line of a file a call wrote, as added. */
export function writtenLines(content: string): DiffLine[] {
  return content.split("\n").map((text, index) => ({ kind: "add" as const, text, newLine: index + 1 }))
}

/**
 * `read` with its last few results kept by what they were read from. An open Edit or Write row drew again with its
 * turn (every paced frame while the turn streams) and split and compared both texts each time; its lines are the
 * same for as long as its texts are. Few are kept: only rows a reader has open ask.
 */
export function keptLines(read: (before: string, after: string) => DiffLine[], kept = 24): (before: string, after: string) => DiffLine[] {
  const held: { before: string; after: string; lines: DiffLine[] }[] = []
  return (before, after) => {
    const at = held.findIndex((entry) => entry.before === before && entry.after === after)
    if (at >= 0) {
      const [entry] = held.splice(at, 1)
      held.push(entry!)
      return entry!.lines
    }
    const lines = read(before, after)
    held.push({ before, after, lines })
    if (held.length > kept) held.shift()
    return lines
  }
}

/** An edit's lines, read once per pair of texts. */
export const editLines = keptLines(diffLines)
/** A written file's lines, read once per content. */
export const fileLines = keptLines((_before, content) => writtenLines(content))
