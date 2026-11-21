import assert from "node:assert/strict"
import { saidParts } from "./lib/said-parts.ts"

/**
 * A long suite's parts (`saidParts`): each is said with its time as it ends, a failure in one goes on to its caller
 * and leaves nothing watched, and a part that doesn't end in its limit fails the suite by name, with the other parts
 * still running, what was being waited for inside, and what holds the loop, after the suite's cleanup has run.
 */
const said: string[] = []
const failed: string[] = []
let cleaned = 0
const parts = saidParts("suite", { limitMs: 300, cleanup: () => { cleaned += 1 }, say: (line) => said.push(line), fail: (line) => failed.push(line) })

assert.equal(await parts.part("first", async () => 7), 7, "a part answers what it ran")
assert.match(said[0] ?? "", /^suite: first in \d+\.\d s$/)
await assert.rejects(parts.part("broken", async () => { throw new Error("no") }), /no/)
assert.equal(said.length, 1, "a part that failed isn't said to have ended")

const never = new Promise<void>(() => {})
void parts.part("stuck", () => never)
let release = () => {}
const slow = parts.part("slow", () => new Promise<void>((resolve) => { release = resolve }))
const waited = parts.waitingFor("the message on its destination")
parts.waitingFor("one that ended")()
// The watch looks every second: by the second look "stuck" is past its limit and "slow", started with it, too.
await new Promise((resolve) => setTimeout(resolve, 1_500))
assert.equal(failed.length, 1, "the suite failed once")
assert.equal(cleaned, 1, "after its cleanup")
const [headline, ...rest] = failed[0]!.split("\n")
assert.match(headline!, /^suite: waited 0\.3 s on stuck, slow, which haven't ended$/)
assert.ok(rest.some((line) => /^ {2}waiting for: the message on its destination \(\d+\.\d s\)$/.test(line)), failed[0])
assert.ok(rest.some((line) => line.startsWith("  the loop is held by: ") && line.includes("Timeout")), failed[0])
assert.ok(!failed[0]!.includes("broken") && !failed[0]!.includes("one that ended"), "what ended isn't named")
waited()
release()
await slow
parts.end()
console.log("said parts: each part said as it ends, and one that doesn't end named with what it waits for")
