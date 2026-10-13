/**
 * Line diffs for attribution: Myers' O(ND) algorithm over interned lines,
 * after trimming the common head and tail, which is all most edits leave.
 * Past `MAX_EDITS` (a formatter over a whole file) it anchors on the lines
 * that occur once on each side, in the longest order both keep, and diffs
 * the stretches between anchors the same way. Lines the rewrite left alone
 * stay their writers'. A stretch with no anchor and too many edits comes out
 * as one replacement, which is what happened to it.
 */

/** `before` lines `[a, a + removed)` became `after` lines `[b, b + added)`. */
export interface Hunk {
  a: number
  removed: number
  b: number
  added: number
}

/** Edits past this make a stretch anchor on its unique lines instead. */
const MAX_EDITS = 2_000
/** Anchoring inside stretches that were anchored already, at most this deep. */
const MAX_ANCHOR_DEPTH = 2

/** Lines with their endings, so joining them gives the text back byte for byte. */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (;;) {
    const end = text.indexOf("\n", start)
    if (end < 0) break
    lines.push(text.slice(start, end + 1))
    start = end + 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

export function diffLines(before: readonly string[], after: readonly string[]): Hunk[] {
  const ids = new Map<string, number>()
  const intern = (lines: readonly string[]) => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      let id = ids.get(line)
      if (id === undefined) ids.set(line, (id = ids.size))
      out[i] = id
    }
    return out
  }
  return diffIds(intern(before), intern(after))
}

export function diffIds(a: Int32Array, b: Int32Array, depth = 0): Hunk[] {
  let head = 0
  const shorter = Math.min(a.length, b.length)
  while (head < shorter && a[head] === b[head]) head++
  let tail = 0
  while (tail < shorter - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const n = a.length - head - tail
  const m = b.length - head - tail
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) return [{ a: head, removed: n, b: head, added: m }]
  const left = a.subarray(head, head + n)
  const right = b.subarray(head, head + m)
  const middle = myers(left, right) ?? (depth < MAX_ANCHOR_DEPTH ? anchored(left, right, depth + 1) : undefined)
  if (!middle) return [{ a: head, removed: n, b: head, added: m }]
  return middle.map((hunk) => ({ a: hunk.a + head, removed: hunk.removed, b: hunk.b + head, added: hunk.added }))
}

/**
 * Hunks through anchors: lines that occur once in `a` and once in `b`, the
 * longest run of them both keep in order (patience sorting, O(k log k)),
 * with each stretch between two anchors diffed on its own. Undefined when
 * no line anchors.
 */
function anchored(a: Int32Array, b: Int32Array, depth: number): Hunk[] | undefined {
  const seen = new Map<number, { a: number; b: number; inA: number; inB: number }>()
  for (let i = 0; i < a.length; i++) {
    const found = seen.get(a[i]!)
    if (found) found.inA++
    else seen.set(a[i]!, { a: i, b: -1, inA: 1, inB: 0 })
  }
  for (let j = 0; j < b.length; j++) {
    const found = seen.get(b[j]!)
    if (!found) continue
    found.inB++
    found.b = j
  }
  const pairs: { a: number; b: number }[] = []
  for (const found of seen.values()) if (found.inA === 1 && found.inB === 1) pairs.push({ a: found.a, b: found.b })
  if (!pairs.length) return undefined
  pairs.sort((x, y) => x.a - y.a)
  // The longest increasing run of `b` positions: `tops[k]` ends the best run of length k + 1.
  const tops: number[] = []
  const back = new Int32Array(pairs.length).fill(-1)
  for (let p = 0; p < pairs.length; p++) {
    let low = 0
    let high = tops.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (pairs[tops[mid]!]!.b < pairs[p]!.b) low = mid + 1
      else high = mid
    }
    if (low) back[p] = tops[low - 1]!
    tops[low] = p
  }
  const anchors: { a: number; b: number }[] = []
  for (let p = tops.at(-1)!; p >= 0; p = back[p]!) anchors.push(pairs[p]!)
  anchors.reverse()
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  for (const anchor of [...anchors, { a: a.length, b: b.length }]) {
    for (const hunk of diffIds(a.subarray(i, anchor.a), b.subarray(j, anchor.b), depth))
      hunks.push({ a: hunk.a + i, removed: hunk.removed, b: hunk.b + j, added: hunk.added })
    i = anchor.a + 1
    j = anchor.b + 1
  }
  return hunks
}

/** The shortest edit script, as hunks; undefined when it needs more than `MAX_EDITS` edits. */
function myers(a: Int32Array, b: Int32Array): Hunk[] | undefined {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  /** `v` after each step d, only its live diagonals `[-d, d]`. */
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1))
  }
  if (found < 0) return undefined
  // Walk back from the end, collecting each edit, then fold edits into hunks.
  const removed = new Uint8Array(n)
  const added = new Uint8Array(m)
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const previous = trace[d - 1]!
    const at = (k: number) => previous[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
    }
    if (down) added[prevY] = 1
    else removed[prevX] = 1
    x = prevX
    y = prevY
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && !removed[i] && !added[j]) {
      i++
      j++
      continue
    }
    const hunk = { a: i, removed: 0, b: j, added: 0 }
    while (i < n && removed[i]) {
      i++
      hunk.removed++
    }
    while (j < m && added[j]) {
      j++
      hunk.added++
    }
    // A run of removals can follow additions in the edit order; keep taking both.
    while ((i < n && removed[i]) || (j < m && added[j])) {
      if (i < n && removed[i]) {
        i++
        hunk.removed++
      } else {
        j++
        hunk.added++
      }
    }
    hunks.push(hunk)
  }
  return hunks
}
