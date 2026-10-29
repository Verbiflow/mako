import assert from "node:assert/strict"
import { test } from "node:test"
import { ATTENDED_WITHIN_SECONDS, attendable, CloudAttention } from "@mako/host/usage/cloud-attention"

/** A Mac whose person comes and goes: what the account is told, once a minute while they're here and once when they've gone. */
test("a Mac says its person is at it while they are, once when they leave, and nothing while they're away or signed out", async () => {
  let idle: number | undefined = 5
  let signedIn = true
  const said: boolean[] = []
  const attention = new CloudAttention({ idle: async () => idle, say: async (attending) => void said.push(attending), signedIn: () => signedIn, log: () => undefined })
  await attention.look()
  await attention.look()
  assert.deepEqual(said, [true, true], "here: said each look, as the account forgets it after two minutes")
  idle = ATTENDED_WITHIN_SECONDS + 1
  await attention.look()
  await attention.look()
  assert.deepEqual(said, [true, true, false], "gone: said once")
  idle = undefined
  await attention.look()
  assert.deepEqual(said, [true, true, false], "unreadable: nothing")
  idle = 1
  signedIn = false
  await attention.look()
  assert.deepEqual(said, [true, true, false], "signed out: nothing")
})

test("a failure to say it is logged once, and the next look tries again", async () => {
  const lines: string[] = []
  let fail = true
  const said: boolean[] = []
  const attention = new CloudAttention({
    idle: async () => 1,
    say: async (attending) => {
      if (fail) throw new Error("offline")
      said.push(attending)
    },
    signedIn: () => true,
    log: (message) => void lines.push(message),
  })
  await attention.look()
  await attention.look()
  assert.equal(lines.filter((line) => line.startsWith("couldn't")).length, 1)
  fail = false
  await attention.look()
  assert.deepEqual(said, [true])
})

test("only a Mac with a screen says its person is at it: a screenless host's banners nobody sees", () => {
  assert.equal(attendable({ kind: "present" }, true), true)
  assert.equal(attendable({ kind: "absent" }, true), false, "a proof's host on the person's own Mac never holds their notices")
  assert.equal(attendable({ kind: "present" }, false), false, "a Linux desktop says nothing yet")
})

test("the minute is a host job: looked at once at the start, then on the job's schedule, and cancelled at a stop", async () => {
  const scheduled: Array<{ name: string; everyMs: number; firstAfterMs: number | undefined; run: () => void | Promise<void> }> = []
  let cancelled = 0
  const jobs = {
    every: (name: string, everyMs: number, run: () => void | Promise<void>, options: { firstAfterMs?: number } = {}) => {
      scheduled.push({ name, everyMs, firstAfterMs: options.firstAfterMs, run })
      return () => void cancelled++
    },
  }
  const said: boolean[] = []
  const attention = new CloudAttention({ idle: async () => 1, say: async (attending) => void said.push(attending), signedIn: () => true, log: () => undefined })
  attention.start(jobs)
  attention.start(jobs)
  assert.equal(scheduled.length, 1, "started twice, scheduled once")
  assert.equal(scheduled[0]?.everyMs, 60_000)
  assert.equal(scheduled[0]?.firstAfterMs, 0, "the first look is at the start")
  await scheduled[0]?.run()
  assert.deepEqual(said, [true])
  attention.stop()
  assert.equal(cancelled, 1)
})
