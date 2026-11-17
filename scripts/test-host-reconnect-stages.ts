import assert from "node:assert/strict"
import { mock } from "node:test"

// The window's words for a lost host link, by stage, on a mocked clock: quiet, then Try now, then Restart Mako.
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 })
const { hostConnectionStore, hostDisconnected, RECONNECT_QUIET_MS, RESTART_AFTER_MS } = await import("../src/state/host-connection.ts")
const stage = () => {
  const held = hostConnectionStore.get()
  return held.kind === "disconnected" ? held.stage : "connected"
}

hostDisconnected("lost")
assert.equal(stage(), "quiet", "a drop starts quiet: the title bar alone")
mock.timers.tick(RECONNECT_QUIET_MS - 1)
hostDisconnected("lost again")
assert.equal(stage(), "quiet", "a second word while lost doesn't restart the wait or move it on")
mock.timers.tick(1)
assert.equal(stage(), "long", "past the quiet time: the notice, with Try now")
mock.timers.tick(RESTART_AFTER_MS - RECONNECT_QUIET_MS)
assert.equal(stage(), "restart", "past the second bound: Restart Mako")

hostConnectionStore.set({ kind: "connected" })
hostDisconnected("lost")
mock.timers.tick(RECONNECT_QUIET_MS)
hostDisconnected("no host", true)
assert.equal(stage(), "restart", "the client found no host to reach: Restart Mako at once")

hostConnectionStore.set({ kind: "connected" })
hostDisconnected("lost")
hostConnectionStore.set({ kind: "connected" })
hostDisconnected("lost later")
mock.timers.tick(RECONNECT_QUIET_MS)
assert.equal(stage(), "long", "an earlier loss's timers never move a later one on")
mock.timers.tick(RESTART_AFTER_MS - RECONNECT_QUIET_MS - 1)
assert.equal(stage(), "long")
hostConnectionStore.set({ kind: "connected" })
mock.timers.tick(10 * RESTART_AFTER_MS)
assert.equal(stage(), "connected", "back: nothing more is said")
mock.timers.reset()
console.log("host reconnect stages: quiet at first, Try now past 10 s, Restart Mako past 60 s or when no host is found, each loss on its own clock")

// The client's way back (`HostReconnect`): a host still leaving keeps it quiet; only a host that couldn't be had says so.
{
  const { HostReconnect, endHungHost, HUNG_HOST_GRACE_MS } = await import("../electron/host-reconnect.ts")
  const { HostLaunchFailedError, HostLeavingError } = await import("@mako/host/transport/service")
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  const runNext = async () => {
    const next = timers.find((timer) => !timer.cancelled)
    assert.ok(next, "a try is scheduled")
    next.cancelled = true
    next.run()
    await new Promise((resolve) => setImmediate(resolve))
  }
  let attaches = 0
  let gone = 0
  let outcome: (() => Promise<void>)[] = []
  const reconnect = new HostReconnect({
    attach: () => { attaches += 1; return (outcome.shift() ?? (() => Promise.resolve()))() },
    gone: () => { gone += 1 },
    later: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } },
    wanted: () => true,
  })
  // A slow restart: the old host is still leaving (`settleRuntime`'s 10 s passed), then it's gone and a new one answers.
  const leaving = () => Promise.reject(new HostLeavingError("The shared Mako host is still shutting down and owns this profile."))
  outcome = [leaving, leaving, leaving]
  reconnect.lost()
  for (let at = 0; at < 3; at++) await runNext()
  assert.equal(gone, 0, "a host still leaving never says there's no host: the window stays quiet, its stages say the rest")
  assert.equal(timers.filter((timer) => !timer.cancelled).length, 1, "and it tries again")
  await runNext()
  assert.equal(attaches, 4, "until the new host answers")
  // A launch that failed is the one failure that says there's no host to reach, once per outage.
  const failed = () => Promise.reject(new HostLaunchFailedError("The shared Mako host (pid 1) quit during startup (exit 1)."))
  outcome = [failed, failed]
  reconnect.lost()
  await runNext()
  await runNext()
  assert.equal(gone, 1, "a host that couldn't be started says so once")
  reconnect.reconnected()
  outcome = [failed]
  reconnect.lost()
  await runNext()
  assert.equal(gone, 2, "and again in a later outage")
  // Try now while a try runs waits on it: it does nothing else, and the window says "Trying…" until it settles.
  let settle!: () => void
  outcome = [() => new Promise<void>((resolve) => { settle = resolve })]
  reconnect.lost()
  const first = reconnect.now()
  const again = reconnect.now()
  assert.equal(first, again, "Try now during a try is that try")
  const before = attaches
  settle()
  await first
  assert.equal(attaches, before, "no second attach")
  reconnect.dispose()

  // Restart Mako with a host that answers nothing ends it, and only a Mako host.
  const world = (over: Partial<Parameters<typeof endHungHost>[0]> & { quits?: "term" | "kill" | "never" }) => {
    const signals: string[] = []
    let alive = true
    const deps: Parameters<typeof endHungHost>[0] = {
      answers: async () => "silent",
      holder: async () => 4242,
      commandOf: async () => "/Applications/Mako.app/Contents/MacOS/Mako /Applications/Mako.app/Contents/Resources/app.asar/dist-electron/host/entry.js",
      entry: "/Applications/Mako.app/Contents/Resources/app.asar/dist-electron/host/entry.js",
      signal: (_pid, signal) => { signals.push(signal); if ((over.quits ?? "kill") === "term" || (signal === "SIGKILL" && over.quits !== "never")) alive = false },
      alive: () => alive,
      wait: async () => { mock.timers.tick(200) },
      log: () => {},
      ...over,
    }
    return { deps, signals }
  }
  mock.timers.enable({ apis: ["Date"], now: 2_000_000 })
  const answering = world({ answers: async () => "ready" })
  assert.equal(await endHungHost(answering.deps), "answering")
  assert.deepEqual(answering.signals, [], "a host that answers is left as it is")
  const polite = world({ quits: "term" })
  assert.equal(await endHungHost(polite.deps), "ended")
  assert.deepEqual(polite.signals, ["SIGTERM"], "a hung host asked to quit, which does, isn't killed")
  const hung = world({})
  assert.equal(await endHungHost(hung.deps), "ended")
  assert.deepEqual(hung.signals, ["SIGTERM", "SIGKILL"], `a hung host that doesn't quit within ${HUNG_HOST_GRACE_MS} ms is ended`)
  const stranger = world({ commandOf: async () => "/usr/bin/some-other-program" })
  assert.equal(await endHungHost(stranger.deps), "not-mako")
  assert.deepEqual(stranger.signals, [], "a pid that isn't this profile's Mako host is never signalled")
  const nobody = world({ holder: async () => null })
  assert.equal(await endHungHost(nobody.deps), "none")
  assert.deepEqual(nobody.signals, [])
  mock.timers.reset()
  console.log("host reconnect: quiet while the host leaves, gone only when one couldn't be started, Try now waits on its try, Restart ends only a hung Mako host")
}
