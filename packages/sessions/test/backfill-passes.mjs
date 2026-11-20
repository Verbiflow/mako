import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { backfillPasses } from "../dist/backfill-passes.js"

/**
 * The sync daemon's backfill passes start a process only when there's something to backfill: a machine with no
 * session started one every 10 minutes, a whole Node process, its catalog and a scan, to find nothing.
 */
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("no pass process while nothing is due; one once something is, then one after each ends", async () => {
  let due = false
  const spawned = []
  const passes = backfillPasses({
    spawnPass: () => {
      const child = Object.assign(new EventEmitter(), { pid: 100 + spawned.length, kill: () => true })
      spawned.push(child)
      return child
    },
    everyMs: 20,
    say: () => {},
    due: () => due,
  })
  try {
    passes.start()
    await tick(100)
    assert.equal(spawned.length, 0, "nothing to backfill, no process")
    due = true
    await tick(40)
    assert.equal(spawned.length, 1, "a pass once something is due")
    await tick(60)
    assert.equal(spawned.length, 1, "never two at once: the next waits for this one to end")
    spawned[0].emit("exit", 0, null)
    await tick(40)
    assert.equal(spawned.length, 2, "the next one everyMs after it ended")
  } finally {
    passes.stop()
  }
})
