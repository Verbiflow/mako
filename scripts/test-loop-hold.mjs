import assert from "node:assert/strict"
import { mock } from "node:test"
import { longestHold as measureHold } from "./lib/loop-hold.ts"
import { atOnce as runAtOnce, inSlices, StepsStopped } from "../packages/sessions/src/slices.ts"

const longestHold = async (work) => (await measureHold(work)).ms

/** Virtual time keeps the observation window and its quarter-ratio controls independent of runner speed. */
let now = 0
let next = 0
const timers = new Map()
const mocks = [
  mock.method(performance, "now", () => now),
  mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++next
    timers.set(id, { callback, at: now + delay })
    return id
  }),
  mock.method(globalThis, "clearTimeout", (id) => timers.delete(id)),
]
const turn = () => {
  const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
  assert.ok(first, "a pending timer can turn")
  const [id, timer] = first
  timers.delete(id)
  now = Math.max(now, timer.at)
  timer.callback()
}
const block = (ms) => { now += ms }
/** Drain only until the work's measurement resolves, letting later timers expose an over-wide window. */
async function drain(promise) {
  let settled = false
  let value
  let failure
  promise.then((answer) => { value = answer; settled = true }, (error) => { failure = error; settled = true })
  for (let step = 0; step < 1_000 && !settled; step++) {
    for (let microtask = 0; microtask < 10; microtask++) await Promise.resolve()
    if (!settled) turn()
  }
  assert.ok(settled, "the measurement settled")
  if (failure) throw failure
  return value
}
try {
  const atOnce = await longestHold(async () => block(512))
  const sliced = await longestHold(async () => {
    for (let index = 0; index < 64; index++) {
      block(8)
      turn()
    }
  })
  assert.equal(atOnce, 512, "one synchronous stretch is measured even before the first timer fires")
  assert.equal(sliced, 8, "each yielded stretch counts on its own")
  assert.ok(sliced < atOnce / 4, "the original quarter bound still passes sliced work")
  assert.equal(timers.size, 0, "the sampler leaves no callback behind")
  let laterRan = false
  const later = setTimeout(() => { laterRan = true; block(136) }, 20)
  const beforeLater = await drain(longestHold(async () => block(8)))
  assert.equal(beforeLater, 8, "a 136 ms task after resume is outside its measurement")
  assert.equal(laterRan, false, "the measurement does not wait for unrelated later work")
  assert.equal(timers.size, 1, "only the caller's later task remains")
  clearTimeout(later)

  const blocked = await longestHold(async () => {
    block(8)
    turn()
    block(136)
  })
  assert.equal(blocked, 136, "the last blocking stretch counts even with no timer after it")
  assert.ok(blocked >= atOnce / 4, "a blocking regression still fails the original quarter bound")
  let steps = 0
  let released = false
  function* reading() {
    try {
      for (let index = 0; index < 8; index++) {
        steps++
        block(4)
        yield
      }
      return steps
    } finally {
      released = true
    }
  }
  const observed = new Promise((resolve) => setImmediate(() => resolve(steps)))
  const read = inSlices(reading(), 8)
  assert.equal(steps, 2, "the real runner yields as its slice reaches its budget")
  assert.equal(await observed, 2, "another event-loop callback runs before the rest is read")
  assert.equal(await read, 8)
  assert.ok(released)
  steps = 0
  assert.equal(runAtOnce(reading()), 8, "the same generator at once runs all steps without yielding")

  steps = 0
  released = false
  let stopping = false
  setImmediate(() => { stopping = true })
  await assert.rejects(inSlices(reading(), 8, () => stopping), StepsStopped)
  assert.equal(steps, 2, "a stop at the first yielded turn prevents the remaining steps")
  assert.ok(released, "the stopped generator releases its transaction")

  const failed = new Error("work failed")
  await assert.rejects(longestHold(async () => { throw failed }), (error) => error === failed)
  assert.equal(timers.size, 0, "failed work also cancels its sampler")
} finally {
  for (const each of mocks) each.mock.restore()
}
console.log("Real slice runner yields at its budget, matches at-once results and releases on stop; loop hold: synchronous, sliced and final blocking stretches measured; later work excluded and timers cancelled on success or failure")
