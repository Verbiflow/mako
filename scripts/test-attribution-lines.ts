import assert from "node:assert/strict"
import { test } from "node:test"
import { diffLines, splitLines, type Hunk } from "@mako/host/attribution/line-diff"
import { applyHunks, baseMap, decodeMap, encodeMap, presentLines, presentRuns, rebase, UNKNOWN, type Run } from "@mako/host/attribution/line-map"
import { applyPatch } from "@mako/host/attribution/patch"

/** A deterministic generator, so a failure names its seed. */
function random(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

function apply(before: readonly string[], hunks: readonly Hunk[], after: readonly string[]): string[] {
  const out: string[] = []
  let at = 0
  for (const hunk of hunks) {
    out.push(...before.slice(at, hunk.a))
    out.push(...after.slice(hunk.b, hunk.b + hunk.added))
    at = hunk.a + hunk.removed
  }
  out.push(...before.slice(at))
  return out
}

/** Every present line's text is the line its run names, and the base lines run in order. */
function check(map: readonly Run[], versions: ReadonlyMap<number, readonly string[]>, current: readonly string[], base: readonly string[]): void {
  assert.equal(presentLines(map), current.length, "the map covers every line")
  for (const run of presentRuns(map))
    for (let i = 0; i < run.length; i++)
      assert.equal(versions.get(run.ins)?.[run.origin + i], current[run.start + i], `line ${run.start + i} is what entry ${run.ins} wrote at ${run.origin + i}`)
  const baseOrder = map.filter((run) => run.ins === 0).flatMap((run) => Array.from({ length: run.length }, (_, i) => run.origin + i))
  assert.deepEqual(baseOrder, base.map((_, i) => i), "every base line stays, in order")
}

test("diffs reproduce the new text, and find nothing between equal ones", () => {
  const next = random(7)
  for (let round = 0; round < 400; round++) {
    const size = Math.floor(next() * 60)
    const a = Array.from({ length: size }, () => `${Math.floor(next() * 8)}\n`)
    const b = a.filter(() => next() > 0.2).flatMap((line) => (next() > 0.8 ? [line, `${Math.floor(next() * 8)}\n`] : [line]))
    const hunks = diffLines(a, b)
    assert.deepEqual(apply(a, hunks, b), b, `round ${round}`)
    assert.deepEqual(diffLines(a, a), [])
  }
})

test("a rewrite past the edit budget anchors on unique lines, reproduces the text, and keeps untouched lines", () => {
  const next = random(11)
  for (let round = 0; round < 12; round++) {
    const size = 3_000 + Math.floor(next() * 3_000)
    // Mostly unique lines, with repeated ones (blank lines, braces) mixed in, as code has.
    const a = Array.from({ length: size }, (_, i) => (next() < 0.15 ? `${["}", "", "  return"][Math.floor(next() * 3)]}\n` : `line ${i}\n`))
    const b = a.flatMap((line) => (next() < 0.45 ? [`${line.trimEnd()} rewritten\n`] : next() < 0.02 ? [] : next() < 0.02 ? [line, "added\n"] : [line]))
    const started = performance.now()
    const hunks = diffLines(a, b)
    const ms = performance.now() - started
    assert.deepEqual(apply(a, hunks, b), b, `round ${round}`)
    const kept = b.length - hunks.reduce((sum, hunk) => sum + hunk.added, 0)
    const after = new Set(b)
    const untouched = a.filter((line) => line.startsWith("line") && after.has(line)).length
    assert.ok(kept >= untouched * 0.95, `round ${round}: ${kept} lines kept of ${untouched} unique untouched`)
    assert.ok(ms < 250, `round ${round}: ${ms.toFixed(1)} ms`)
  }
})

test("lines keep their last writer through random edits by many writers", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const next = random(seed)
    const base = Array.from({ length: 30 }, (_, i) => `base ${i}\n`)
    const versions = new Map<number, readonly string[]>([[0, base]])
    let map = baseMap(base.length)
    let current = base
    for (let entry = 1; entry <= 40; entry++) {
      const edited = current.flatMap((line) => {
        const roll = next()
        if (roll < 0.08) return []
        if (roll < 0.16) return [`e${entry} replaced\n`]
        if (roll < 0.22) return [line, `e${entry} added ${Math.floor(next() * 1000)}\n`]
        return [line]
      })
      map = applyHunks(map, diffLines(current, edited), entry)
      versions.set(entry, edited)
      current = edited
      check(map, versions, current, base)
      assert.deepEqual(decodeMap(encodeMap(map)), map, "a map survives the journal")
    }
  }
})

test("a commit makes the taken lines base and keeps the rest with their writers", () => {
  const base = ["a\n", "b\n", "c\n", "d\n"]
  let map = baseMap(4)
  const one = ["a\n", "B1\n", "c\n", "d\n"]
  map = applyHunks(map, diffLines(base, one), 1)
  const two = ["a\n", "B1\n", "c\n", "D2\n", "e2\n"]
  map = applyHunks(map, diffLines(one, two), 2)
  // The commit took entry 1's line and not entry 2's.
  const committed = ["a\n", "B1\n", "c\n", "d\n"]
  const { map: after, authors } = rebase(map, two, base, committed)
  assert.deepEqual([...authors], [0, 1, 0, 0], "who wrote each committed line")
  assert.deepEqual(presentRuns(after).map((run) => [run.start, run.length, run.ins]), [[0, 3, 0], [3, 2, 2]])
  // "d" is still deleted in the working tree, by entry 2.
  assert.deepEqual(after.filter((run) => run.del).map((run) => [run.origin, run.del]), [[3, 2]])
  // A later commit drops entry 1's line while the disk keeps it: entry 1's again, and the commit's other lines keep their writers.
  const dropped = rebase(after, two, committed, base, authors)
  assert.deepEqual(presentRuns(dropped.map).map((run) => [run.start, run.length, run.ins]), [[0, 1, 0], [1, 1, 1], [2, 1, 0], [3, 2, 2]])
  assert.deepEqual([...dropped.authors], [0, 0, 0, 0])
  // Without the earlier commit's writers, the same line is unknown.
  assert.equal(presentRuns(rebase(after, two, committed, base).map)[1]!.ins, UNKNOWN)
})

test("a reported patch applies to exactly the text after", () => {
  assert.equal(applyPatch("x\ny\nz\n", "@@ -2 +2,2 @@\n-y\n+Y\n+Y2\n"), "x\nY\nY2\nz\n")
  assert.equal(applyPatch("a\nb", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"), "a\nc")
  assert.equal(applyPatch("a\n", "@@ -1 +1 @@\n-missing\n+x\n"), undefined)
  assert.deepEqual(splitLines("a\r\nb\nc"), ["a\r\n", "b\n", "c"])
})

test("a change to a 5,000-line file is diffed and its writers updated in well under 5 ms", () => {
  const base = Array.from({ length: 5000 }, (_, i) => `const line${i} = ${i * 7} // some ordinary source text\n`)
  let map = baseMap(base.length)
  let current = base
  const times: number[] = []
  for (let entry = 1; entry <= 200; entry++) {
    const at = (entry * 37) % 4900
    const edited = [...current.slice(0, at), `changed by ${entry}\n`, `added by ${entry}\n`, ...current.slice(at + 1)]
    const started = performance.now()
    map = applyHunks(map, diffLines(current, edited), entry)
    times.push(performance.now() - started)
    current = edited
  }
  times.sort((a, b) => a - b)
  const p50 = times[100]!
  const p95 = times[190]!
  console.log(`5,000-line file: diff and line map per change p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${times.at(-1)!.toFixed(3)} ms, ${map.length} runs`)
  assert.ok(p95 < 5, `p95 ${p95} ms`)
})
