import assert from "node:assert/strict"
import { TerminalSaves } from "@mako/host/terminals/saves"

/**
 * The terminal daemon's saves (`npm run test:terminal`): within a beat of a change and never on a timer with nothing
 * changed, and a change made during a slow save is saved by the next, not left until the daemon stops.
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let version = 0
const saved: number[] = []
let slow = 0
const saves = new TerminalSaves(async () => {
  const seen = version
  if (slow) await pause(slow)
  saved.push(seen)
}, 10)

// Nothing changed: nothing saves.
await pause(40)
assert.deepEqual(saved, [], "no change, no save")

// A burst of changes: one save, a beat later.
version = 1
saves.changed()
saves.changed()
await pause(40)
assert.deepEqual(saved, [1], "one save for a burst")

// A change while a slow save runs is saved by the next one, without a further change or a stop.
slow = 60
version = 2
saves.changed()
await pause(20)
version = 3
saves.changed()
slow = 0
await pause(150)
assert.deepEqual(saved, [1, 2, 3], `the change made during the slow save is saved after it: ${saved.join(", ")}`)

// A failed save goes again.
let failures = 1
const retried: number[] = []
const flaky = new TerminalSaves(async () => {
  if (failures-- > 0) throw new Error("disk full")
  retried.push(1)
}, 10)
flaky.changed()
await pause(80)
assert.deepEqual(retried, [1], "a failed save goes again")

// A forced save (a stop) waits for one under way and then saves what's there.
slow = 40
version = 4
saves.changed()
await pause(15)
version = 5
await saves.save(true)
assert.equal(saved.at(-1), 5, "a stop saves what's there after the save under way")
saves.stop()
flaky.stop()
console.log("terminal saves: a beat after a change, none with nothing changed, a change during a slow save saved next, a failure retried, a stop saving last")
