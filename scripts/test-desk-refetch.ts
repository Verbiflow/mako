import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { AppSamplingDemand } from "@mako/host/contracts/thread-app"
import { ViewRefetch } from "../src/lib/view-refetch"
import { DeskRefetch, DESK_SCOPE, type DeskHintBridge } from "../src/state/desk-refetch"

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const listeners = new Set<(event: HostEvent) => void>()
const sends: AppSamplingDemand[] = []
let epoch = randomUUID()
const connection = randomUUID()
let generation = 41
let handshake: (() => void) | undefined
let holdHandshake = true
let holdAck = false
let ack: (() => void) | undefined
let capabilities = 0
const bridge = {
  onEvent: (listener: (event: HostEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  viewHints: async () => { capabilities++; return { version: 1, epoch, domains: ["apps", "sync"] } },
  followThreadApps: async (demand?: AppSamplingDemand) => {
    if (!demand) {
      if (holdHandshake) await new Promise<void>((resolve) => { handshake = resolve })
      return { kind: "ready", connection, generation }
    }
    sends.push(demand)
    assert.equal(demand.connection, connection)
    assert.ok(demand.generation > generation)
    generation = demand.generation
    if (holdAck) await new Promise<void>((resolve) => { ack = resolve })
    return { kind: "following" }
  },
} satisfies DeskHintBridge
let time = 0
const timers = new Set<() => void>()
const reads = new ViewRefetch({ now: () => time, after: (run) => { timers.add(run); return () => { timers.delete(run) } } })
const run = async () => {
  const due = [...timers]; timers.clear()
  for (const timer of due) timer()
  await flush()
}
const owner = new DeskRefetch(bridge, reads)
let looked = 0
const lease = reads.watch("app", { scope: DESK_SCOPE, domain: "apps", key: "/a", fields: ["state"], every: () => owner.appFollowing() ? undefined : 30_000, read: async () => { looked++ } })
await flush()
assert.ok(handshake)
reads.setVisible(false)
holdHandshake = false
handshake!()
await flush()
assert.equal(sends.at(-1)?.visible, false, "hide during handshake still relinquishes the legacy lease")
assert.equal(owner.appFollowing(), false)
reads.setVisible(true)
await flush(); await run()
assert.equal(sends.at(-1)?.visible, true)
assert.equal(owner.appFollowing(), true)
assert.equal(timers.size, 0, "following suppresses this reader's fallback timer")
const emit = (event: HostEvent) => { for (const listener of listeners) listener(event) }
const hint = (revision: number, fields: string[] = ["state"], eventEpoch = epoch): HostEvent => ({ type: "view-hint", hint: { epoch: eventEpoch, revision, domain: "apps", keys: ["/a"], fields } })
const before = owner.readings().hints
emit(hint(1)); emit(hint(1)); emit(hint(0))
assert.equal(owner.readings().hints, before + 1)
assert.equal(owner.readings().ignoredHints, 2)
time += 2000
await run()
const afterHint = looked
emit(hint(2, ["diagnostics"]))
await run()
assert.equal(looked, afterHint)
holdAck = true
reads.setVisible(false)
await flush()
const oldAck = ack!
assert.equal(sends.at(-1)?.visible, false)
holdAck = false
reads.setVisible(true)
await flush(); await run()
assert.equal(owner.appFollowing(), true)
oldAck(); await flush()
assert.equal(owner.appFollowing(), true, "a superseded hidden acknowledgement cannot disable current visible demand")
const priorEpoch = epoch
epoch = randomUUID()
emit({ type: "host-disconnected", message: "test reconnect" })
assert.equal(reads.connected(DESK_SCOPE), false)
emit({ type: "host-reconnected" })
await flush(); await run()
assert.equal(capabilities, 2)
const count = owner.readings().hints
emit(hint(500, ["state"], priorEpoch))
assert.equal(owner.readings().hints, count, "old-host frames cannot replace the new incarnation")
lease.release(); await flush()
assert.equal(sends.at(-1)?.visible, false, "last app reader releases sampler demand")
owner.close(); reads.dispose()
assert.equal(listeners.size, 0)

const fallback = new ViewRefetch()
const old = new DeskRefetch({ onEvent: () => () => {} } satisfies DeskHintBridge, fallback)
await flush()
assert.equal(old.supports("apps"), false)
assert.equal(old.supports("sync"), false)
old.close(); fallback.dispose()
console.log("desk refetch: capability fallback, generation floor, hidden handshake, stale ACK, epoch retirement and last-reader demand release pass")
