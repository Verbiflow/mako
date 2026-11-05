import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import { COLLECT_AFTER_BYTES, turnGarbage } from "@mako/host/harnesses/cursor/sdk/turn-garbage"

let collections = 0
const queued: Array<() => void> = []
const garbage = turnGarbage(() => { collections++ }, (run) => queued.push(run))
const drain = () => { for (const run of queued.splice(0)) run() }

garbage.read(COLLECT_AFTER_BYTES - 1)
assert.equal(queued.length, 0, "reads under the budget wait")
garbage.read(1)
garbage.read(COLLECT_AFTER_BYTES)
assert.equal(queued.length, 1, "reads past the budget ask once until that collection runs")
drain()
assert.equal(collections, 1)
garbage.read(COLLECT_AFTER_BYTES - 1)
assert.equal(queued.length, 0, "a collection starts the count again")
garbage.settled()
garbage.settled()
drain()
assert.equal(collections, 2, "a settled run collects once")

// The child's own collector, in a process started without --expose-gc.
const real = turnGarbage()
const held = (() => new WeakRef({ bytes: new Uint8Array(1024) }))()
await nextTurn()
real.settled()
await nextTurn()
await nextTurn()
assert.equal(held.deref(), undefined, "the collector reclaims what nothing holds")

console.log("Cursor turn garbage: a collection after each 64 MB read from the store and after a settled run, once each, with V8's gc whatever the child was started with")
