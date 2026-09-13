import assert from "node:assert/strict"
import type { ThreadRef } from "@mako/sessions"
import { createContinuationPlanner } from "../electron/continuation.ts"
import { planContinuation, type ContinuationInputs } from "../electron/contracts/thread-continuation.ts"

const ref: ThreadRef = { harness: "cursor", nativeId: "agent-1", path: "/home/.cursor/acp-sessions/agent-1/store.db", cwd: "/repo" }
const inputs: ContinuationInputs = { live: { available: true, canResume: true }, nativeInstalled: true, running: false, external: null }

assert.deepEqual(planContinuation(ref, inputs), { transport: "live", provider: "cursor", nativeId: "agent-1" })
assert.deepEqual(planContinuation({ ...ref, liveResume: false }, inputs), { transport: "native", provider: "cursor" }, "a store the live transport cannot load continues through its CLI")
assert.deepEqual(planContinuation(ref, { ...inputs, live: { available: true, canResume: false } }), { transport: "native", provider: "cursor" }, "a provider without live resume runs natively when its CLI is installed")
assert.equal(planContinuation(ref, { ...inputs, running: true }).transport, "native", "a reply while a native run owns the path queues behind it")
assert.equal(planContinuation(ref, { ...inputs, live: { available: false, canResume: true } }).transport, "native")
const handoff = planContinuation({ ...ref, liveResume: false }, { ...inputs, nativeInstalled: false })
assert.equal(handoff.transport, "handoff")
assert.ok(handoff.transport === "handoff" && handoff.reason.includes("cannot reopen"), "a handoff says why")
assert.equal(planContinuation(ref, { ...inputs, live: null, nativeInstalled: false }).transport, "refused", "nothing installed is refused, not guessed")
assert.equal(planContinuation({ ...ref, archived: true }, inputs).transport, "handoff", "archived history never reopens on its CLI")
assert.equal(planContinuation({ ...ref, resumeUnavailable: "Cursor Desktop chats are not resumable" }, inputs).transport, "handoff")
assert.equal(planContinuation({ ...ref, locked: true }, inputs).transport, "refused")
const held = planContinuation({ ...ref, heldBy: "the installed Mako app" }, inputs)
assert.ok(held.transport === "refused" && held.reason.includes("live in the installed Mako app"), "a session another Mako host has live is refused by name")
assert.equal(planContinuation(ref, { ...inputs, external: "open" }).transport, "refused")
assert.equal(planContinuation(ref, { ...inputs, external: "active" }).transport, "refused")
assert.equal(planContinuation(ref, { ...inputs, external: "needs-input" }).transport, "refused")

// The host asserts its own plan at both entry points, so a stale renderer
// cannot route a reply to the other transport.
let canResume = false
let external: ContinuationInputs["external"] = null
const planner = createContinuationPlanner({
  ref: async (path) => (path === ref.path ? ref : undefined),
  live: () => ({ available: true, canResume }),
  nativeInstalled: () => true,
  running: () => false,
  external: () => external,
})
assert.equal((await planner.plan(ref.path)).transport, "native")
await assert.rejects(planner.assertLive(ref.path, "cursor", "agent-1"), /continues through the cursor CLI/, "a live load is refused while the plan says native")
await planner.assertNative(ref.path)
canResume = true
assert.equal((await planner.plan(ref.path)).transport, "live")
await assert.rejects(planner.assertNative(ref.path), /reopens live on cursor/, "a native run is refused for a store the driver can load")
await planner.assertLive(ref.path, "cursor", "agent-1")
await assert.rejects(planner.assertLive(ref.path, "cursor", "other"), /reopens live/, "the resume id must be the store's own")
await assert.rejects(planner.assertLive(ref.path, "claude", "agent-1"), /reopens live/, "the provider must be the store's own")
external = "open"
await assert.rejects(planner.assertLive(ref.path, "cursor", "agent-1"), /open in another app/)
await assert.rejects(planner.assertNative(ref.path), /open in another app/)
await assert.rejects(planner.assertNative("/missing"), /no longer in the catalog/)
console.log("Continuation plan: live, native, handoff and refusal rules; host refuses a transport its plan did not choose")
