import assert from "node:assert/strict"
import type { AppMark } from "@mako/host/contracts/thread-app"
import { ThreadAppSampler, WANTED_MS } from "@mako/host/workspaces/app-sampler"
import type { AppsLook } from "@mako/host/workspaces/environment-tools"

/**
 * The apps' marks are looked at once for every window and pushed only when they change: on 2026-11-12 the windows'
 * own looks, each reading the process table, were 17% of the person's held loop. While a window reads them the
 * sampler looks every second while an app settles, every four while one runs, every half minute with nothing running,
 * and at once after this host changed something. With nobody reading it doesn't look at all (looking for nobody took
 * main's idle host from 1.1–1.4% of a core to 3.5–4.5%), and the trace and the memory look keep their own times.
 */

let now = 0
let looks = 0
let traces = 0
let measures = 0
const pushed: AppMark[][] = []
/** What a look finds, less the signature the fake makes of it. */
type Standing = Omit<AppsLook, "signature">
let state: Standing = { marks: [{ checkout: "/work/shop", state: "running", port: 20_010 }], settling: false, alive: true }

const sampler = new ThreadAppSampler({
  look: async (): Promise<AppsLook> => {
    looks += 1
    return { ...state, signature: JSON.stringify(state) }
  },
  trace: async () => { traces += 1 },
  memory: async () => { measures += 1 },
  publish: (marks) => { pushed.push(marks) },
  now: () => now,
})

/** Ticks once a second for `seconds`, as the host's job does; `reading` has a window ask every 30 s, as windows do. */
async function run(seconds: number, reading: boolean): Promise<void> {
  for (let second = 0; second < seconds; second += 1) {
    if (reading && second % 30 === 0) sampler.wanted()
    await sampler.tick()
    now += 1_000
  }
}

// Nobody reads the apps, though one runs: no look and nothing pushed, while the trace and the memory look keep their times.
await run(120, false)
assert.equal(looks, 0, "no look with nobody reading")
assert.equal(pushed.length, 0)
assert.equal(traces, 6, "the trace every 20 seconds, as before the sampler")
assert.equal(measures, 4, "the memory look every 30 seconds, as before the sampler")
sampler.changed()
await run(5, false)
assert.equal(looks, 0, "a change here with nobody reading looks at nothing")

// A window opens: it reads the marks afresh, and from then the sampler looks for it.
assert.deepEqual(await sampler.current(), state.marks, "a window coming back reads the marks afresh")
assert.equal(looks, 1)
assert.equal(pushed.length, 1)

// Running: a look every four seconds, pushed only when something changed.
const runningLooks = looks
await run(60, true)
assert.equal(looks - runningLooks, 14, "a look every four seconds after the one just taken, while it runs and a window reads")
assert.equal(pushed.length, 1, "nothing pushed while nothing changed")

// This host starts another: the next tick looks at once and pushes it starting, then a look a second while it settles.
state = { marks: [...state.marks, { checkout: "/work/cart", state: "starting" }], settling: true, alive: true } satisfies Standing
sampler.changed()
const settlingFrom = looks
await run(5, true)
assert.equal(looks - settlingFrom, 5, "a look a second while it settles")
assert.deepEqual(pushed.at(-1), state.marks)

// Everything ends outside Mako: pushed, then one trace more closes its trace, and a look every half minute.
state = { marks: [], settling: false, alive: false } satisfies Standing
await run(5, true)
assert.deepEqual(pushed.at(-1), [], "the end is pushed")
const [endedTraces, endedLooks] = [traces, looks]
await run(60, true)
assert.ok(traces - endedTraces <= 1, "at most one trace after the last run went")
assert.equal(looks - endedLooks, 2, "a look every half minute with nothing running")

// The window closes: once its asks are older than WANTED_MS, nothing is looked at.
await run(WANTED_MS / 1000, false)
const quietLooks = looks
await run(120, false)
assert.equal(looks, quietLooks, "quiet once nobody reads")

console.log("app sampler: no look with nobody reading, the trace and memory look on their own times; while a window reads, one look for all of it, pushed only on change: a second while settling, four while running, 30 with nothing running and at once after a change here")
