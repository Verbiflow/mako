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
