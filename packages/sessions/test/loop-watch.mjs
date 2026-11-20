import assert from "node:assert/strict"
import { test } from "node:test"
import { namedWork, watchLoop, WorkUnderWay } from "../dist/loop-watch.js"

/**
 * A hold of the sync daemon's thread is said with what held it: the work under way, and work that began and ended
 * within the hold, by name. A request the daemon answered late once said only "The sync daemon request timed out".
 */

const spin = (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until);
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("a held loop names the work that held it, whether it's still under way or ended within the hold", async () => {
  const said = []
  const work = new WorkUnderWay()
  const stop = watchLoop(work, (ms, during) => said.push({ ms, during }), { everyMs: 20, heldMs: 200 })
  try {
    await tick(60)
    namedWork(work, "copy claude 33db0c6d", () => spin(300))
    await tick(60)
    assert.equal(said.length, 1, "one hold")
    assert.ok(said[0].ms >= 200, `held ${said[0].ms} ms`)
    assert.match(said[0].during, /copy claude 33db0c6d/, "named after it ended")

    const pushing = namedWork(work, "push cursor 0dc59ebb", async () => {
      await tick(10)
      spin(300)
      await tick(10)
    })
    await pushing
    await tick(60)
    assert.equal(said.length, 2)
    assert.match(said[1].during, /push cursor 0dc59ebb( \(\d+ ms\))?/, "async work, by name")
    assert.equal(work.describe(), "", "nothing left under way once it all ended and the watch looked again")

    await tick(100)
    assert.equal(said.length, 2, "no hold, nothing said")
  } finally {
    stop()
  }
})

test("work that throws or rejects is no longer under way; without names, work just runs", async () => {
  const work = new WorkUnderWay()
  assert.throws(() => namedWork(work, "request open", () => { throw new Error("no") }))
  await assert.rejects(namedWork(work, "request page", async () => { throw new Error("no") }))
  assert.doesNotMatch(work.describe(), /\(\d+ ms\)/)
  assert.equal(namedWork(undefined, "request ping", () => 7), 7)
})

test("an idle daemon's loop isn't looked at: work starts the watch, which stops a linger after the work ends", async () => {
  let looks = 0
  class CountedWork extends WorkUnderWay {
    looked() {
      looks++
      super.looked()
    }
  }
  const said = []
  const work = new CountedWork()
  const stop = watchLoop(work, (ms, during) => said.push({ ms, during }), { everyMs: 10, heldMs: 200, lingerMs: 50 })
  try {
    await tick(100)
    assert.equal(looks, 0, "no look while nothing has run")
    await namedWork(work, "request sync-status", async () => {
      await tick(30)
      spin(250)
      await tick(10)
    })
    await tick(150)
    assert.equal(said.length, 1, "a hold during the work is said")
    assert.match(said[0].during, /request sync-status/)
    const watched = looks
    assert.ok(watched > 0, "looked while the work ran")
    await tick(150)
    assert.equal(looks, watched, "no look once the work ended and the linger passed")
    namedWork(work, "scan sessions", () => spin(250))
    await tick(60)
    assert.equal(said.length, 2, "the next work starts the watch again")
    assert.match(said[1].during, /scan sessions/)
  } finally {
    stop()
  }
})

test("what samples the loop beside the watch hears it start and stop", async () => {
  const heard = []
  const work = new WorkUnderWay()
  const stop = watchLoop(work, () => {}, { everyMs: 10, heldMs: 200, lingerMs: 30, watching: (on) => heard.push(on) })
  try {
    await tick(50)
    assert.deepEqual(heard, [], "nothing while idle")
    namedWork(work, "request status", () => spin(5))
    await tick(120)
    assert.deepEqual(heard, [true, false], "on with the work, off a linger after it")
  } finally {
    stop()
  }
})
