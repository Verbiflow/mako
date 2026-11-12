import assert from "node:assert/strict"
import type { AppMark } from "@mako/host/contracts/thread-app"
import { ThreadAppSampler } from "@mako/host/workspaces/app-sampler"
import type { AppsLook } from "@mako/host/workspaces/environment-tools"

/**
 * The apps' marks are looked at once for every window and pushed only when they change: on 2026-11-12 the windows'
 * own looks, each reading the process table, were 17% of the person's held loop. The sampler looks every second while
 * an app settles, every four while one runs, every half minute with nothing running, and at once after this host
 * changed something; the trace and the memory look ride on it, and run only while something runs (and one trace
 * more, to close an app's as it stops).
 */

let now = 0
let looks = 0
let traces = 0
let measures = 0
const pushed: AppMark[][] = []
/** What a look finds, less the signature the fake makes of it. */
type Standing = Omit<AppsLook, "signature">
let state: Standing = { marks: [], settling: false, alive: false }

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

/** Ticks once a second for `seconds`, as the host's job does. */
async function run(seconds: number): Promise<void> {
  for (let second = 0; second < seconds; second += 1) {
    await sampler.tick()
    now += 1_000
  }
}

// Nothing runs: one look to begin, then one every half minute, and nothing pushed again while nothing changed.
await run(60)
assert.equal(looks, 2, "with nothing running, a look every half minute")
assert.equal(pushed.length, 1, "the first look is pushed, and nothing after while nothing changed")
assert.equal(traces, 1, "one trace, to close any app's left from before")
assert.equal(measures, 0, "no memory look with nothing running")

// This host starts an app: the next tick looks at once and pushes it starting.
state = { marks: [{ checkout: "/work/shop", state: "starting" }], settling: true, alive: true } satisfies Standing
sampler.changed()
await run(1)
assert.equal(pushed.length, 2)
assert.deepEqual(pushed.at(-1), state.marks)

// Settling: a look a second, pushed only when something changed.
const settlingFrom = looks
await run(5)
assert.equal(looks - settlingFrom, 5, "a look a second while it settles")
assert.equal(pushed.length, 2, "nothing pushed while nothing changed")

// Running: a look every four seconds; its trace every 20 and its memory every 30.
state = { marks: [{ checkout: "/work/shop", state: "running", port: 20_010 }], settling: false, alive: true } satisfies Standing
await run(1)
assert.deepEqual(pushed.at(-1), state.marks, "running is pushed")
const [runningLooks, runningTraces, runningMeasures] = [looks, traces, measures]
await run(60)
assert.equal(looks - runningLooks, 15, "a look every four seconds while it runs")
assert.equal(traces - runningTraces, 3, "a trace every 20 seconds while it runs")
assert.equal(measures - runningMeasures, 2, "a memory look every 30 seconds while it runs")
assert.deepEqual(await sampler.current(), state.marks, "a window starting reads the marks as last looked at")

// It ends outside Mako: the next look sees it, pushes it, and one more trace closes its trace.
state = { marks: [], settling: false, alive: false } satisfies Standing
await run(5)
assert.deepEqual(pushed.at(-1), [], "the end is pushed")
const endedTraces = traces
await run(60)
assert.ok(traces - endedTraces <= 1, "at most one trace after the last run went")
const quietTraces = traces
await run(60)
assert.equal(traces, quietTraces, "no trace while nothing runs")

console.log("app sampler: one look for every window, pushed only on change; a look a second while settling, four while running, 30 with nothing running and at once after a change here; the trace and the memory look ride on it only while something runs")
