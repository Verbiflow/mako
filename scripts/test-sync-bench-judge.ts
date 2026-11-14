import assert from "node:assert/strict"
import { failures, type Check } from "./lib/sync-bench-judge"

const time = (name: string, ok = true): Check => ({ name, kind: "time", value: ok ? 5 : 50, limit: 10, ok })
const count = (name: string, ok = true): Check => ({ name, kind: "count", value: ok ? 0 : 1, limit: 0, ok })
const names = (checks: Check[]) => checks.map((item) => item.name)
const hop = "live.secondMac.p50"
const words = "reconnect.phone link cut.phone.wordsMissed"

assert.deepEqual(names(failures([time(hop), count(words)])), [], "a first run that met every budget passes")
assert.deepEqual(names(failures([time(hop, false), count(words)])), [hop], "with no second run, a time over stands")
assert.deepEqual(names(failures([time(hop), count(words, false)])), [words], "and so does a count")
assert.deepEqual(names(failures([time(hop, false), count(words)], [time(hop), count(words)])), [], "a time over once passes when a second run met every budget, whole")
assert.deepEqual(names(failures([time(hop, false), count(words)], [time(hop, false), count(words)])), [hop], "and fails when it's over in both")
assert.deepEqual(names(failures([time(hop, false), count(words)], [time(hop), count(words, false)])), [hop, words], "a word lost in the second run fails, the first's time beside it: neither run passed")
assert.deepEqual(names(failures([time(hop, false), time("status.start.phone.p50")], [time(hop), time("status.start.phone.p50", false)])), [hop, "status.start.phone.p50"], "two runs each over a different time aren't one run that passed")
assert.deepEqual(names(failures([time(hop, false), count(words, false)], [time(hop), count(words)])), [words], "a count over in the first run fails however the second went")
assert.deepEqual(names(failures([time(hop, false), count(words)], [time(hop)])), [hop, words], "a second run that left a check unmeasured isn't a whole run that passed")
assert.deepEqual(names(failures([time(hop, false)], [time(hop), count("cost.cloud.beyondFrames", false)])), [hop, "cost.cloud.beyondFrames"], "a count only the second run read fails too")

const first = [time(hop, false), count(words)]
failures(first, [{ ...time(hop), value: 7 }, { ...count(words), value: 0 }])
assert.deepEqual(first.map((item) => item.again), [7, 0], "each check carries what the second run read of it")
console.log("PASS: the sync bench passes on a run that met every budget, whole; a count fails in any run, and only a time gets a second try")
