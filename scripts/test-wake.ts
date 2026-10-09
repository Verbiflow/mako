import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { watchWake, type WakeSource } from "../electron/wake.ts"

/** The host notices it was away from its own clock, and folds the desktop's notices into the same wake. */
let clock = 1_000_000
const wakes: WakeSource[] = []
const watch = watchWake((source) => wakes.push(source), { tickMs: 20, gapMs: 200, quietMs: 1_000, now: () => clock })
const tick = async (advance: number) => {
  clock += advance
  await delay(35)
}
try {
  for (let i = 0; i < 5; i++) await tick(20)
  assert.deepEqual(wakes, [], "Ordinary ticks are no wake")
  await tick(5_000)
  assert.deepEqual(wakes, ["clock"], "A jump in the clock between ticks is a wake: the machine slept or the process was paused")
  watch.notify("resume")
  watch.notify("unlock-screen")
  assert.deepEqual(wakes, ["clock"], "The desktop's resume and unlock right after are the same wake")
  clock += 2_000
  watch.notify("unlock-screen")
  assert.deepEqual(wakes, ["clock", "unlock-screen"], "An unlock later on is a wake of its own, with no gap in the clock")
  clock += 60_000
  watch.notify("resume")
  await tick(20)
  assert.deepEqual(wakes, ["clock", "unlock-screen", "resume"], "After a sleep the desktop's resume makes the wake immediate; the clock's notice at its next tick joins it")
  watch.stop()
  await tick(60_000)
  assert.equal(wakes.length, 3, "A stopped watch hears nothing")
  console.log("Wake: clock gaps, the desktop's resume and unlock, one wake for several notices, and stopping passed")
} finally {
  watch.stop()
}
