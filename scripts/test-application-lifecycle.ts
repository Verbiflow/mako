import assert from "node:assert/strict"
import { ApplicationLifecycle } from "../electron/application-lifecycle.js"
import type {
  LifecycleAction,
  LifecycleWork,
} from "../electron/contracts/app-lifecycle.js"

const first: LifecycleWork = {
  id: "one",
  token: "turn-one",
  title: "Test agent",
  cwd: "/fixture",
  provider: "fixture",
  status: "running",
  stoppable: true,
}
let work = [first]
const applied: LifecycleAction[] = []
let stops = 0
const lifecycle = new ApplicationLifecycle({
  work: () => work,
  ready: () => {},
  stop: async () => {
    stops++
    work = []
  },
  apply: async (action): Promise<void> => {
    assert.equal(lifecycle.blocked, true)
    applied.push(action)
  },
  changed: () => {},
})
await lifecycle.command({ kind: "wait", action: "install" })
assert.equal(lifecycle.snapshot().operation.kind, "waiting")
assert.deepEqual(applied, [])
assert.equal(lifecycle.blocked, false)
work = [{ ...first, status: "waiting" }]
await lifecycle.tick()
assert.deepEqual(applied, [])
await lifecycle.command({ kind: "cancel" })
work = []
await lifecycle.tick()
assert.deepEqual(applied, [])
work = [first]
const reviewed = lifecycle.snapshot().revision
work = [{ ...first, token: "turn-two" }]
await assert.rejects(
  lifecycle.command({ kind: "stop", action: "quit", revision: reviewed }),
  /changed/
)
assert.equal(stops, 0)
work = [{ ...first, status: "queued" }]
const queuedRevision = lifecycle.snapshot().revision
work = [first]
await assert.rejects(
  lifecycle.command({ kind: "stop", action: "quit", revision: queuedRevision }),
  /changed/
)
assert.equal(stops, 0)
work = [{ ...first, stoppable: false, status: "finishing" }]
await assert.rejects(
  lifecycle.command({
    kind: "stop",
    action: "quit",
    revision: lifecycle.snapshot().revision,
  }),
  /finishing/
)
work = [first]
await lifecycle.command({ kind: "wait", action: "install" })
work = []
await Promise.all([lifecycle.tick(), lifecycle.tick(), lifecycle.tick()])
assert.deepEqual(applied, ["install"])
await assert.rejects(
  lifecycle.command({ kind: "wait", action: "install" }),
  /already/
)
let fail = true
const failing = new ApplicationLifecycle({
  work: () => [],
  ready: () => {},
  stop: async () => {},
  apply: async () => {
    if (fail) throw new Error("Signature verification failed")
  },
  changed: () => {},
})
await failing.command({ kind: "wait", action: "install" })
assert.equal(failing.snapshot().operation.kind, "error")
assert.equal(failing.blocked, false)
fail = false
await failing.command({ kind: "wait", action: "install" })
assert.equal(failing.snapshot().operation.kind, "applying")
const refusing = new ApplicationLifecycle({
  work: () => [first],
  ready: () => {},
  stop: async () => {},
  apply: async () => {
    throw new Error("Must not install")
  },
  changed: () => {},
})
await refusing.command({
  kind: "stop",
  action: "install",
  revision: refusing.snapshot().revision,
})
assert.equal(refusing.snapshot().operation.kind, "error")
console.log(
  "Application lifecycle: deferred work, waiting input, cancellation, stale confirmation, protected work, idempotence, and failure recovery passed"
)
