import assert from "node:assert/strict"
import { ViewRefetch, type RefetchClock, type RefetchLease } from "../src/lib/view-refetch"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { ViewHints } from "../packages/host/src/workspaces/view-hints"
import { ViewHintSchema, ViewHintsStatusSchema } from "@mako/host/contracts/view-hints"

class Clock implements RefetchClock {
  time = 0
  next = 0
  timers = new Map<number, { at: number; run: () => void }>()
  now = () => this.time
  after = (run: () => void, ms: number) => {
    const key = ++this.next
    this.timers.set(key, { at: this.time + ms, run })
    return () => { this.timers.delete(key) }
  }
  async tick(ms: number) {
    const end = this.time + ms
    for (;;) {
      await settle()
      const first = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!first || first[1].at > end) break
      this.time = first[1].at
      this.timers.delete(first[0])
      first[1].run()
    }
    this.time = end
    await settle()
  }
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }
const clock = new Clock()
const reads = new ViewRefetch(clock)
let calls = 0
let applied = 0
let hold: (() => void) | undefined
let held = false
const watch = (id = "detail", key = "/a", every: number | undefined = undefined): RefetchLease => reads.watch(id, {
  scope: "host", domain: "apps", key, fields: ["state"], every: () => every,
  read: async (current) => {
    calls++
    if (held) await new Promise<void>((resolve) => { hold = resolve })
    if (current()) applied++
  },
})
const first = watch()
await settle()
assert.equal(calls, 1, "initial mounted data is read immediately")
const duplicate = watch()
assert.equal(calls, 1, "two consumers share one complete query key")
for (let i = 0; i < 30; i++) reads.invalidate("host", "apps", ["/a"], ["state"])
await clock.tick(1999)
assert.equal(calls, 1)
await clock.tick(1)
assert.equal(calls, 2, "a burst becomes one read at the batch boundary")
reads.invalidate("host", "apps", ["/a"], ["diagnostics"])
await clock.tick(2000)
assert.equal(calls, 2, "a known unused field is ignored")
reads.invalidate("host", "apps", ["/elsewhere"], ["state"])
await clock.tick(2000)
assert.equal(calls, 2)
assert.equal(reads.readings().skippedRows, 1)
reads.invalidate("host", "apps", ["/a"], ["future-field"])
await clock.tick(0)
assert.equal(calls, 3, "unknown fields count as changed")
held = true
first.refresh({ immediate: true })
await clock.tick(0)
assert.equal(calls, 4)
reads.invalidate("host", "apps", ["/a"], ["state"])
await clock.tick(3000)
assert.equal(calls, 4, "dirty while reading does not start concurrent hint reads")
held = false; hold!()
await clock.tick(0)
assert.equal(calls, 5, "dirty while in flight gets one trailing read")
const periodic = watch("output", "/b", 500)
await settle()
reads.setVisible(false)
const hidden = calls
reads.invalidate("host", undefined)
periodic.refresh({ immediate: true })
await clock.tick(60_000)
assert.equal(calls, hidden, "hidden pages issue no data reads, including fallback peers")
reads.setVisible(true)
reads.setVisible(true)
await clock.tick(0)
assert.equal(calls, hidden + 2, "return catches up once per active query; duplicate return does nothing")
await clock.tick(500)
assert.equal(calls, hidden + 3, "visible fallback timers resume")
periodic.release()
held = true
first.refresh({ immediate: true, invalidate: true })
await clock.tick(0)
const stale = hold!
const before = applied
reads.setVisible(false)
reads.setVisible(true)
held = false
await clock.tick(0)
assert.equal(applied, before + 1, "a return need not wait on one retired read")
stale()
await settle()
assert.equal(applied, before + 1, "a retired answer cannot apply after return")
held = true
first.refresh({ immediate: true })
await clock.tick(0)
const old = hold!
first.refresh({ immediate: true, invalidate: true })
await clock.tick(0)
const next = hold!
const bounded = calls
for (let i = 0; i < 5; i++) { first.refresh({ immediate: true, invalidate: true }); await clock.tick(0) }
assert.equal(calls, bounded, "repeated invalidations cannot create unbounded requests")
held = false; old(); next()
await clock.tick(0)
assert.equal(calls, bounded + 1, "the latest invalidation is retained until a slot releases")
reads.setConnected("host", false)
const disconnected = calls
await clock.tick(100_000)
assert.equal(calls, disconnected)
reads.setConnected("host", true)
await clock.tick(0)
assert.equal(calls, disconnected + 1)
first.release(); duplicate.release()
await clock.tick(100_000)
assert.equal(reads.readings().activeKeys, 0)
assert.equal(reads.readings().pending, 0)
assert.equal(clock.timers.size, 0, "last release cancels the only timer")

let cadence = 10_000
let cadenceReads = 0
const cadenceRead = { scope: "host", domain: "sync" as const, fields: ["status"], every: () => cadence, read: async () => { cadenceReads++ } }
const slow = reads.watch("cadence", cadenceRead)
await settle()
cadence = 2_000
const fast = reads.watch("cadence", cadenceRead)
await clock.tick(2_000)
assert.equal(cadenceReads, 2, "a later faster consumer advances an already armed fallback timer")
fast.release(); slow.release()

let failures = 0
const failed = reads.watch("failure", { scope: "host", domain: "sync", fields: ["status"], every: () => undefined, read: async () => { failures++; throw new Error("offline") } })
await settle()
await clock.tick(1999)
assert.equal(failures, 1)
await clock.tick(1)
assert.equal(failures, 2)
await clock.tick(3999)
assert.equal(failures, 2)
await clock.tick(1)
assert.equal(failures, 3, "errors retry with bounded backoff even without periodic polling")
failed.release(); reads.dispose()

const emitted: HostEvent[] = []
const hints = new ViewHints((event) => emitted.push(event))
const status = ViewHintsStatusSchema.parse(hints.status())
hints.changed("apps", ["state"], ["/a"])
hints.changed("sync", ["status"])
const frames = emitted.map((event) => {
  assert.equal(event.type, "view-hint")
  if (event.type !== "view-hint") throw new Error("Unexpected host event")
  return ViewHintSchema.parse(event.hint)
})
assert.equal(frames[0].epoch, status.epoch)
assert.equal(frames[1].revision, frames[0].revision + 1)
assert.notEqual(new ViewHints(() => {}).status().epoch, status.epoch, "each host has its own incarnation")
assert.equal(ViewHintSchema.safeParse({ ...frames[0], fields: ["x".repeat(81)] }).success, false)
assert.equal(ViewHintSchema.safeParse({ ...frames[0], keys: Array(257).fill("a") }).success, false)
console.log("view refetch: batching, conservative fields, shared keys, hidden/return, pending races, bounded retries and host hint contracts pass")
