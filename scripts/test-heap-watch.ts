import assert from "node:assert/strict"
import { test } from "node:test"
import { HEAP_PRESSURE, HeapWatch, heapLevel, readHeap, type HeapChange, type HeapLevel, type HeapReading } from "@mako/host/base/heap-watch"

/**
 * The host's heap watch: it says once when the heap crosses a pressure line,
 * once more at the next, and once when it has eased, never on every tick.
 */

const LIMIT = 4_000
const reading = (share: number): HeapReading => ({ used: Math.round(share * LIMIT), limit: LIMIT })

test("a level is the share of the limit the heap is at", () => {
  assert.equal(heapLevel(reading(0.1)), 0)
  assert.equal(heapLevel(reading(HEAP_PRESSURE[0])), 1)
  assert.equal(heapLevel(reading(0.7)), 1)
  assert.equal(heapLevel(reading(HEAP_PRESSURE[1])), 2)
  assert.equal(heapLevel({ used: 10, limit: 0 }), 0, "a limit V8 doesn't report is no pressure")
})

test("each crossing is said once, rising and easing, with room to spare before a line is said again", () => {
  let share = 0.2
  const said: Array<[HeapChange, HeapLevel, number]> = []
  const watch = new HeapWatch(() => reading(share), (change, level, read) => said.push([change, level, read.used]))
  assert.equal(watch.tick(), 0)
  assert.equal(watch.tick(), 0)
  share = 0.65
  assert.equal(watch.tick(), 1)
  assert.equal(watch.tick(), 1, "hovering past the line isn't said again")
  share = 0.85
  assert.equal(watch.tick(), 2)
  share = 0.75
  assert.equal(watch.tick(), 2, "dipping just under the second line isn't easing yet")
  share = 0.69
  assert.equal(watch.tick(), 1, "a tenth below it is")
  share = 0.55
  assert.equal(watch.tick(), 1, "and the first line needs the same room")
  share = 0.45
  assert.equal(watch.tick(), 0)
  assert.deepEqual(said, [["rising", 1, 2_600], ["rising", 2, 3_400], ["easing", 1, 2_760], ["easing", 0, 1_800]])
})

test("this process's heap reads as a share under one", () => {
  const read = readHeap()
  assert.ok(read.used > 0 && read.limit > read.used, `used ${read.used} of ${read.limit}`)
  assert.ok((read.rss ?? 0) > 0)
})
