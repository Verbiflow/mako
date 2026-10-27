import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { Foreground } from "@mako/host/base/foreground"
import { HostJobs } from "@mako/host/base/host-jobs"
import { watchWake, type WakeSource } from "@mako/host/base/wake"

/** The host notices it was away from its own clock, and folds the desktop's notices into the same wake. */
let clock = 1_000_000
const wakes: WakeSource[] = []
const watch = watchWake(new HostJobs(), (source) => wakes.push(source), { tickMs: 20, gapMs: 200, quietMs: 1_000, now: () => clock })
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
} finally {
  watch.stop()
}

// A start that holds the foreground longer than the gap is no wake: the watch ticks through it, as the clock does.
// Held back with the host's routine work, a start's 60 s read as a sleep, and the wake dropped every pooled connection.
const foreground = new Foreground()
const startWakes: WakeSource[] = []
let startClock = 1_000_000
const during = watchWake(new HostJobs(undefined, foreground), (source) => startWakes.push(source), { tickMs: 20, gapMs: 200, quietMs: 1_000, now: () => startClock })
try {
  const release = foreground.hold("start opencode", 60_000)
  for (let i = 0; i < 20; i++) {
    startClock += 20
    await delay(35)
  }
  release()
  await delay(35)
  assert.deepEqual(startWakes, [], "Ticks go on while a start holds the foreground, so its length is never a gap")
  startClock += 5_000
  await delay(35)
  assert.deepEqual(startWakes, ["clock"], "A real gap is still a wake")
} finally {
  during.stop()
}
console.log("Wake: clock gaps, the desktop's resume and unlock, one wake for several notices, stopping, and a long start being no wake passed")
