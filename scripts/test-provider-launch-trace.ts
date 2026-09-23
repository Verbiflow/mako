import assert from "node:assert/strict"
import { ProviderLaunchTrace, type ProviderLaunchRecord } from "../electron/provider-launch.js"

const records: ProviderLaunchRecord[] = []
let now = 0
const trace = new ProviderLaunchTrace({ provider: "future-provider", conversation: "same-conversation" }, {
  now: () => now, report: record => records.push(record),
})
const secret = new Error("private account credentials")
await assert.rejects(trace.step("launch", async () => {
  await trace.step("account", () => { now = 10; return { secret: "never log this" } })
  await trace.step("human-sign-in", async () => { now = 80 })
  await trace.step("session-open", () => { now = 100; throw secret })
}), error => error === secret, "tracing must preserve the original failure object")
assert.equal(records[0]?.phase, "launch")
assert.equal(records[0]?.state, "started")
assert.equal(records.at(-1)?.state, "failed")
assert.deepEqual(records.filter(record => record.phase === "human-sign-in").map(record => record.state), ["waiting", "done"])
assert.ok(!JSON.stringify(records).includes("private account"))
assert.ok(!JSON.stringify(records).includes("never log"))
assert.equal(new Set(records.map(record => record.attempt)).size, 1)
assert.equal(new Set(records.map(record => record.step)).size, 4)
const root = records.at(-1)
assert.ok(root?.state === "failed")
assert.equal(root.durationMs, 100, "total includes nested work, without summing overlapping spans")

let release: (() => void) | undefined
const pending = trace.step("runtime-discovery", () => new Promise<void>(resolve => { release = resolve }))
assert.equal(records.at(-1)?.state, "started", "a hung preparation must leave a started record before settling")
const second = new ProviderLaunchTrace({ provider: "future-provider", conversation: "same-conversation" }, {
  now: () => now, report: record => records.push(record),
})
const sentinel = {}
assert.equal(second.sync("spawn", () => sentinel), sentinel, "spawn must return synchronously so error handlers attach immediately")
const secondAttempt = records.at(-1)?.attempt
assert.notEqual(secondAttempt, records[0]?.attempt, "overlapping launches on one conversation must remain distinguishable")
release?.()
await pending
assert.notEqual(records.at(-1)?.attempt, secondAttempt, "late completion retains its original attempt")
assert.throws(() => second.sync("configuration", () => { throw secret }), error => error === secret)

console.log("Launch tracing: pre-spawn failure, pending work, human wait, overlapping attempts, synchronous spawn and payload exclusion passed")
