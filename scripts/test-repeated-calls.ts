// A client making the same call, arguments and all, over and over is named once a minute by client, method and
// subject; a long read's parts, pages read one after another, other subjects and an ordinary pace are not.
import assert from "node:assert/strict"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"
import { RepeatedCalls } from "@mako/host/transport/repeated-calls"

const said: HostLogLine[] = []
const stop = followHostLog((line) => { if (line.scope === "rpc") said.push(line) })
const calls = new RepeatedCalls({ windowMs: 10_000, limit: 40 })
let now = 1_000_000
for (let n = 0; n < 200; n++) calls.note("desktop", "mako:live-read", ["c-1", { kind: "part", record: "r", offset: n }], undefined, now)
for (let n = 0; n < 39; n++) calls.note("desktop", "mako:live-read", ["c-2", { kind: "snapshot" }], undefined, now += 250)
for (let n = 0; n < 90; n++) calls.note("desktop", "mako:live-read", ["c-3", { kind: "earlier", token: "t", before: { blocks: 0, base: 7000 - 80 * n } }], undefined, now += 50)
assert.equal(said.length, 0, "a long read's parts, pages one after another and fewer calls than the limit say nothing")
now += 11_000
for (let n = 0; n < 45; n++) calls.note("desktop", "mako:live-read", ["c-2", { kind: "snapshot" }], `call-${n}`, now += 200)
assert.equal(said.length, 1, "the same read 40 times within ten seconds is said once")
assert.deepEqual([said[0]!.message, said[0]!.fields?.client, said[0]!.fields?.channel, said[0]!.fields?.subject], ["a client keeps making the same call", "desktop", "mako:live-read", "c-2 snapshot"])
for (let n = 0; n < 45; n++) calls.note("desktop", "mako:live-read", ["c-2", { kind: "snapshot" }], undefined, now += 200)
assert.equal(said.length, 1, "while it lasts, at most once a minute")
now += 61_000
for (let n = 0; n < 40; n++) calls.note("desktop", "mako:live-read", ["c-2", { kind: "snapshot" }], undefined, now += 100)
assert.equal(said.length, 2, "and again a minute later")
stop()
console.log("PASS: a client repeating one call is named by client, method and subject, once a minute")
