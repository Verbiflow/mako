import assert from "node:assert/strict"
import { test } from "node:test"
import { HostStopping } from "@mako/host/base/host-stopping"
import { followHostLog } from "@mako/host/base/host-log"
import { Simulators } from "@mako/host/control/simulators/simulators"
import { accountBorrowing, BorrowedSimulators, LeaseEnded } from "@mako/host/control/simulators/borrowed"

const link = () => ({ gatewayUrl: "https://fixture.invalid", machine: "fixture-machine", credential: "fixture" })
const turn = () => new Promise((resolve) => setImmediate(resolve))
const lease = () => ({
  id: "fixture-lease", grant: "sims", grantVersion: 1,
  borrower: { account: "a", repository: "acme/web", thread: "t", place: { kind: "machine", machine: "m" } },
  resource: { kind: "operation", ref: "ios-simulator" }, source: { kind: "capable", requires: [{ capability: "ios-simulator" }] },
  mode: "relay", access: "run", version: "ready", issuedAt: 1, expiresAt: Date.now() + 3_600_000,
  delivery: { transfer: "none", secret: false }, device: "mac", session: { state: "running", heartbeatMs: 60_000, lastBeat: 1 },
})
const need = { kind: "operation", ref: "ios-simulator", why: "fixture", correlationId: "fixture-need" }
const methods = [
  ["need", (port) => port.need(need)],
  ["release", (port) => port.release("fixture-lease")],
  ["renew", (port) => port.renew("fixture-lease")],
  ["call", (port) => port.call("fixture-lease", "fixture operation")],
  ["artifact", (port) => port.artifact("fixture-lease", "a".repeat(64))],
  ["devices", (port) => port.devices("ios-simulator")],
]

// Every inert fixture has an explicit disposer. Signal-aware stalls model fetch/body cancellation without networking.
function stalls(t) {
  const active = new Set()
  t.after(() => {
    for (const dispose of [...active]) dispose()
    assert.equal(active.size, 0, "all fake I/O settled")
  })
  return {
    active,
    headers(signal) {
      signal.throwIfAborted()
      return new Promise((resolve, reject) => {
        const done = (value, error) => {
          if (!active.delete(dispose)) return
          signal.removeEventListener("abort", abort)
          if (error) reject(error)
          else resolve(value)
        }
        const dispose = () => done(new Response(null, { status: 204 }))
        const abort = () => done(undefined, signal.reason)
        active.add(dispose)
        signal.addEventListener("abort", abort, { once: true })
      })
    },
    body(signal, status = 200) {
      signal.throwIfAborted()
      let stream
      const done = (error) => {
        if (!active.delete(dispose)) return
        signal.removeEventListener("abort", abort)
        if (error) stream.error(error)
        else stream.close()
      }
      const dispose = () => done()
      const abort = () => done(signal.reason)
      active.add(dispose)
      signal.addEventListener("abort", abort, { once: true })
      return new Response(new ReadableStream({ start(controller) { stream = controller }, cancel() { done() } }), { status })
    },
  }
}

// Adopts the reviewer's inert-header counterexample, and also expects the now-intentional cancellation rejection.
test("borrowed HTTP observes its actual owner even when an injected fetch waits inertly", async () => {
  const stopping = new HostStopping()
  let seen, finish
  const request = new Promise((resolve) => { finish = resolve })
  const port = accountBorrowing(link, async (_url, options) => { seen = options.signal; return request })
  const release = stopping.run(() => port.release("fixture-lease")).catch((error) => error)
  try {
    await stopping.stop()
    assert.equal(seen.aborted, true)
    assert.equal(await release, stopping.signal.reason)
  } finally {
    finish(new Response(null, { status: 204 }))
    await release
  }
})

for (const [name, invoke] of methods) {
  test(`borrowed ${name} headers stop with their admitted host`, async (t) => {
    const fixture = stalls(t), stopping = new HostStopping()
    let seen
    const port = accountBorrowing(link, async (_url, options) => { seen = options.signal; return fixture.headers(seen) })
    const result = stopping.run(() => invoke(port)).catch((error) => error)
    try {
      await stopping.stop()
      assert.equal(seen.aborted, true)
      assert.equal(await result, stopping.signal.reason)
      assert.equal(fixture.active.size, 0)
    } finally { await stopping.stop(); await result }
  })
}

for (const [name, invoke] of methods.filter(([name]) => name !== "release")) {
  test(`borrowed ${name} response body stays owned after headers`, async (t) => {
    const fixture = stalls(t), stopping = new HostStopping()
    let seen, response
    const port = accountBorrowing(link, async (_url, options) => { seen = options.signal; response = fixture.body(seen); return response })
    const result = stopping.run(() => invoke(port)).catch((error) => error)
    try {
      await turn()
      assert.equal(response.body.locked, true, "the actual method is waiting for its body")
      assert.equal(seen.aborted, false)
      await stopping.stop()
      assert.equal(seen.aborted, true)
      assert.equal(await result, stopping.signal.reason)
      assert.equal(fixture.active.size, 0)
    } finally { await stopping.stop(); await result }
  })
}

test("borrowed LeaseEnded error-body read is owned too", async (t) => {
  const fixture = stalls(t), stopping = new HostStopping()
  const port = accountBorrowing(link, async (_url, options) => fixture.body(options.signal, 410))
  const result = stopping.run(() => port.call("fixture-lease", "fixture operation")).catch((error) => error)
  await turn()
  await stopping.stop()
  assert.equal(await result, stopping.signal.reason)
  assert.equal(fixture.active.size, 0)
})

test("stop-before-start uses the explicit production owner outside ambient call context", async () => {
  const stopping = new HostStopping()
  let fetched = 0
  const port = accountBorrowing(link, async () => { fetched++; return new Response(null, { status: 204 }) }, stopping.signal)
  await stopping.stop()
  for (const [, invoke] of methods) await assert.rejects(invoke(port), (error) => error === stopping.signal.reason)
  assert.equal(fetched, 0)
  const cleanup = new AbortController()
  cleanup.abort(new Error("cleanup already ended"))
  await assert.rejects(port.release("fixture-lease", cleanup.signal), /cleanup already ended/)
  assert.equal(fetched, 0)
})

test("default fetch and captured construction owner remain owned outside the original run", async (t) => {
  const fixture = stalls(t), stopping = new HostStopping()
  let seen
  t.mock.method(globalThis, "fetch", async (_url, options) => { seen = options.signal; return fixture.headers(seen) })
  const port = stopping.run(() => accountBorrowing(link))
  const result = port.release("fixture-lease").catch((error) => error)
  await stopping.stop()
  assert.equal(seen.aborted, true)
  assert.equal(await result, stopping.signal.reason)
  assert.equal(fixture.active.size, 0)
})

test("concurrent admitted work keeps separate host owners on the same transport", async (t) => {
  const fixture = stalls(t), a = new HostStopping(), b = new HostStopping(), seen = []
  let finishB
  const port = accountBorrowing(link, async (_url, options) => {
    seen.push(options.signal)
    if (seen.length === 1) return fixture.headers(options.signal)
    return new Promise((resolve) => { finishB = resolve })
  })
  const first = a.run(() => port.call("first", "fixture operation")).catch((error) => error)
  const second = b.run(() => port.call("second", "fixture operation")).catch((error) => error)
  try {
    await a.stop()
    assert.equal(await first, a.signal.reason)
    assert.equal(seen[0].aborted, true)
    assert.equal(seen[1].aborted, false)
    finishB(new Response("legitimate answer"))
    assert.equal(await second, "legitimate answer")
    assert.equal(b.signal.aborted, false)
  } finally { finishB(new Response("fixture settled")); await b.stop(); await first; await second }
})

test("legitimate answers and typed lease end survive full response consumption", async () => {
  const stopping = new HostStopping(), signals = []
  const port = accountBorrowing(link, async (url, options) => {
    signals.push(options.signal)
    const path = new URL(url).pathname
    if (options.method === "DELETE") return new Response(null, { status: 204 })
    if (path.endsWith("/call")) return new Response("legitimate answer")
    if (path.includes("/artifacts/")) return new Response(new Uint8Array([1, 2, 3]))
    if (path.endsWith("/devices")) return Response.json({ devices: [{ id: "mac", name: "Mac", online: true, lastSeen: 1 }] })
    return Response.json({ lease: lease() })
  }, stopping.signal)
  assert.equal((await port.need(need)).lease.id, "fixture-lease")
  assert.equal((await port.renew("fixture-lease")).lease.id, "fixture-lease")
  assert.equal(await port.call("fixture-lease", "fixture operation"), "legitimate answer")
  assert.deepEqual(await port.artifact("fixture-lease", "a".repeat(64)), new Uint8Array([1, 2, 3]))
  assert.equal((await port.devices("ios-simulator"))[0].id, "mac")
  await port.release("fixture-lease")
  assert.equal(stopping.signal.aborted, false)
  assert.ok(signals.every((signal) => signal.aborted), "completed requests release their transport/body too")
  const gone = accountBorrowing(link, async () => new Response("fixture lease ended", { status: 410 }))
  await assert.rejects(gone.call("fixture-lease", "fixture operation"), (error) => error instanceof LeaseEnded && error.message === "fixture lease ended")
  await gone.release("fixture-lease")
})

test("release and refusal cancel unread bodies instead of leaving I/O after headers", async (t) => {
  const fixture = stalls(t)
  const released = accountBorrowing(link, async (_url, options) => fixture.body(options.signal))
  await released.release("fixture-lease")
  assert.equal(fixture.active.size, 0)
  const refused = accountBorrowing(link, async (_url, options) => fixture.body(options.signal, 503))
  await assert.rejects(refused.release("fixture-lease"), /503/)
  assert.equal(fixture.active.size, 0)
})

function closingWorld(t, release, throughSimulators = false) {
  const stopping = new HostStopping(), requests = [], warnings = []
  t.after(followHostLog((line) => { if (line.level === "warn") warnings.push(line) }))
  const port = accountBorrowing(link, async (url, options) => {
    requests.push({ url: String(url), options })
    if (options.method === "DELETE") return release(options.signal)
    if (new URL(url).pathname.endsWith("/devices")) return Response.json({ devices: [] })
    return Response.json({ lease: lease() })
  }, stopping.signal)
  const borrowed = new BorrowedSimulators({ port, shots: "fixture-no-artifacts-written" })
  const closed = { streams: 0, hosts: 0 }
  const cleanup = throughSimulators ? new Simulators({
    hosts: [{ id: "fixture", close: async () => { closed.hosts++ } }],
    consent: async () => [], agent: () => undefined, borrowing: borrowed,
    streams: { close: async () => { closed.streams++ } },
  }) : borrowed
  stopping.register("browser and computer calls", () => cleanup.close())
  return { stopping, port, borrowed, requests, warnings, cleanup, closed }
}

test("close grace aborts losing release I/O, logs unconfirmed IDs and joins teardown once", async (t) => {
  const fixture = stalls(t)
  let seen
  const world = closingWorld(t, (signal) => { seen = signal; return fixture.headers(signal) })
  await world.borrowed.ensure("fixture look")
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const stopped = world.stopping.stop()
  const same = world.borrowed.close()
  assert.equal(world.borrowed.close(), same)
  let settled = false
  stopped.then(() => { settled = true })
  await turn()
  assert.equal(world.stopping.signal.aborted, true)
  assert.equal(seen.aborted, false, "shutdown gets an intentional bounded final DELETE")
  t.mock.timers.tick(4_999)
  await turn()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await stopped
  assert.equal(seen.aborted, true)
  assert.equal(fixture.active.size, 0)
  assert.deepEqual(world.borrowed.unreleased(), ["fixture-lease"])
  assert.equal(world.requests.filter(({ options }) => options.method === "DELETE").length, 1)
  assert.ok(world.warnings.some((line) => line.fields?.leases === "fixture-lease" && /grace ended/.test(line.fields.error)))
  const count = world.requests.length
  await assert.rejects(world.port.renew("fixture-lease"), (error) => error === world.stopping.signal.reason)
  assert.equal(world.requests.length, count, "normal work cannot start after the host stops")
})

test("close can confirm its bounded final release after host cancellation", async (t) => {
  let seen
  const world = closingWorld(t, (signal) => { seen = signal; return new Response(null, { status: 204 }) })
  await world.borrowed.ensure("fixture look")
  await world.stopping.stop()
  assert.equal(seen.aborted, true, "the completed cleanup scope is closed too")
  assert.deepEqual(world.borrowed.unreleased(), [])
  assert.equal(world.warnings.length, 0)
  assert.equal(world.requests.filter(({ options }) => options.method === "DELETE").length, 1)
})

test("failed close release keeps its unconfirmed lease and cancels its error body", async (t) => {
  const fixture = stalls(t)
  const world = closingWorld(t, (signal) => fixture.body(signal, 503))
  await world.borrowed.ensure("fixture look")
  await world.stopping.stop()
  assert.deepEqual(world.borrowed.unreleased(), ["fixture-lease"])
  assert.ok(world.warnings.some((line) => line.fields?.leases === "fixture-lease" && /503/.test(line.fields.error)))
  assert.equal(fixture.active.size, 0)
})


test("actual Simulators teardown joins the bounded borrowed release before closing streams and hosts", async (t) => {
  const fixture = stalls(t)
  const world = closingWorld(t, (signal) => fixture.headers(signal), true)
  await world.borrowed.ensure("fixture look")
  const close = t.mock.method(world.cleanup, "close", world.cleanup.close.bind(world.cleanup))
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const stopped = world.stopping.stop()
  assert.equal(world.stopping.stop(), stopped)
  await turn()
  assert.equal(close.mock.callCount(), 1)
  assert.deepEqual(world.closed, { streams: 0, hosts: 0 })
  t.mock.timers.tick(5_000)
  await stopped
  assert.equal(close.mock.callCount(), 1)
  assert.deepEqual(world.closed, { streams: 1, hosts: 1 })
  assert.deepEqual(world.borrowed.unreleased(), ["fixture-lease"])
  assert.equal(fixture.active.size, 0)
})
