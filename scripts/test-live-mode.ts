import assert from "node:assert/strict"
import { mock } from "node:test"
import { toast } from "sonner"
import type { LiveActionInput, LiveSnapshot } from "@/lib/types"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

/**
 * A running session's access is shown from the person's pick and believed only from its host's answer
 * (`src/state/live-mode.ts`). Against a fake bridge whose mode call the test holds open:
 *
 * - the pick shows before the host answers, with one call to the host, and what the window holds of the session
 *   changes only by the host's word;
 * - a message, a steer, a goal and a review sent while a change is on its way reach the host only after it answered;
 * - a change to a narrower level the host refused goes back in the picker with its reason, and the message that
 *   waited on it isn't sent, since the session still allows more than its person chose;
 * - a refused change to a wider level lets the message go, under the narrower level the session kept;
 * - picks made while one is on its way go to the host one at a time, in order, and the last one is the one shown.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/test-live-mode.ts
 */
const kept = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return kept.size },
    key: (index: number) => [...kept.keys()][index] ?? null,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  },
})
Object.defineProperty(globalThis, "window", { value: { addEventListener() {}, removeEventListener() {} }, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acp } = await import("../src/state/acp")
const { acpStore } = await import("../src/state/acp-state")
// What the window's own code writes of a conversation goes through the door (`receiveLive`), or the suite fails.
const { failAroundTheDoor } = await import("./live-door-watch")
const { receivingLive, readingLive } = await import("../src/state/live-door")
failAroundTheDoor(acpStore, receivingLive, readingLive)
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { sendTo, steerTo } = await import("../src/state/acp-queue")
const { modeSettled, shownMode, switchLiveMode, widerThanChosen } = await import("../src/state/live-mode")
installMockBridge()
const errors = mock.method(toast, "error", () => "fixture")
const bridge = getMako()
mock.method(bridge, "liveRead", async () => { throw new Error("Unknown Mako host method") })

const conversation = auditId(940)
const turn = auditId(941)
const MODES = [
  { id: "plan", name: "Plan", access: "plan" as const },
  { id: "ask", name: "Ask before acting", access: "ask" as const },
  { id: "edits", name: "Accept edits", access: "edits" as const },
  { id: "full", name: "Full access", access: "full" as const },
  { id: "custom", name: "A custom agent" },
]
let revision = 10
/** The conversation as its host says it: in `mode`, its turn running or not. */
function snapshot(mode: string, running = false): LiveSnapshot {
  const base = auditSnapshot(1, "claude")
  base.session.id = conversation
  base.session.status = running ? "running" : "ready"
  base.session.modes = MODES
  base.session.currentMode = mode
  base.revision = ++revision
  base.requests = running ? [{ id: turn, text: "a long turn", attachments: [], status: "dispatching" }] : []
  return base
}
const held = () => {
  const live = acpStore.get().conversations[conversation]
  return live?.kind === "live" ? live.session.currentMode : undefined
}
const shown = () => shownMode(conversation, held())
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Everything the host was asked, in the order it arrived. */
const asked: string[] = []
/** The mode calls the host hasn't answered: each test answers its own. */
const open: { mode: string; take: () => void; refuse: (why: string) => void }[] = []
mock.method(bridge, "liveSetMode", (_id: string, mode: string) => new Promise<void>((resolve, reject) => {
  asked.push(`mode ${mode}`)
  open.push({ mode, take: resolve, refuse: (why) => reject(new Error(why)) })
}))
mock.method(bridge, "livePrompt", async (_id: string, _request: string, text: string) => { asked.push(`prompt ${text}`) })
mock.method(bridge, "liveAction", async (_id: string, input: LiveActionInput) => {
  asked.push(`steer ${input.kind === "compact" ? "" : input.text}`)
  return { input, digest: "fixture", bindingId: auditId(942), createdAt: 1, state: { kind: "accepted" as const } }
})
mock.method(bridge, "liveGoal", async () => { asked.push("goal"); return snapshot(held() ?? "full") })
mock.method(bridge, "liveReview", async () => { asked.push("review"); return snapshot(held() ?? "full") })
mock.method(bridge, "liveSnapshot", async () => snapshot(held() ?? "full"))

// The tiers decide what a refusal means for a message that waited on it.
assert.equal(widerThanChosen(MODES, "full", "ask"), true, "full stays wider than the ask the person chose")
assert.equal(widerThanChosen(MODES, "ask", "full"), false, "ask is narrower than the full the person chose")
assert.equal(widerThanChosen(MODES, "ask", "ask"), false)
assert.equal(widerThanChosen(MODES, "full", "custom"), true, "a mode with no tier is treated as narrower: a refusal stops the message")
assert.equal(widerThanChosen(MODES, null, "ask"), true, "a session that says no mode is treated as wider")

// 1. Shown at once, one call, and only the host's word changes the session.
applyLiveSnapshot(snapshot("full"))
acpStore.set({ activeKey: conversation })
asked.length = 0
const narrowing = switchLiveMode(conversation, "ask")
assert.equal(shown(), "ask", "the pick shows before the host answers")
assert.equal(held(), "full", "what the window holds of the session is still the host's last word")
await tick()
assert.deepEqual(asked, ["mode ask"], "one call to the host")

// 2. A message, a steer, a goal and a review sent meanwhile wait for the answer.
const message = sendTo(conversation, "under ask", [], crypto.randomUUID())
const goal = acp.goal({ kind: "pause" }, conversation)
const review = acp.review({ kind: "changes" }, conversation)
await tick()
await tick()
assert.deepEqual(asked, ["mode ask"], "nothing that starts a turn reaches the host while the change is on its way")
open.shift()!.take()
assert.deepEqual(await narrowing, { kind: "taken" })
assert.equal(shown(), "ask", "taken, the pick stays shown until the session says it")
applyLiveSnapshot(snapshot("ask"))
assert.equal(held(), "ask")
assert.equal(shown(), "ask")
assert.equal(await message, true)
await Promise.all([goal, review])
assert.equal(asked[0], "mode ask")
assert.deepEqual(asked.slice(1).sort(), ["goal", "prompt under ask", "review"], "each went once the host had answered the change")
assert.equal(errors.mock.callCount(), 0)

// 3. A narrower level refused: the picker goes back, the reason is given, and the message that waited isn't sent.
applyLiveSnapshot(snapshot("full"))
asked.length = 0
const refusedNarrow = switchLiveMode(conversation, "plan")
assert.equal(shown(), "plan")
const waited = sendTo(conversation, "must not go under full", [], crypto.randomUUID())
await tick()
open.shift()!.refuse("Plan mode is set when a session starts.")
assert.deepEqual(await refusedNarrow, { kind: "refused", mode: "plan", reason: "Plan mode is set when a session starts.", narrowing: true })
assert.equal(shown(), "full", "refused, the picker shows where the session is")
assert.equal(await waited, false, "the message that waited on a refused narrowing isn't sent")
assert.deepEqual(asked, ["mode plan"], "no prompt went under the wider level")
assert.equal(errors.mock.callCount(), 1, "the person hears why")
assert.match(String(errors.mock.calls[0]?.arguments[0]), /still allows more than you chose.*Plan mode is set when a session starts/)

// The same through the window's own action, which says the refusal itself.
errors.mock.resetCalls()
const picked = acp.setMode("ask")
await tick()
open.shift()!.refuse("Not now.")
await picked
assert.equal(shown(), "full")
assert.equal(errors.mock.callCount(), 1)
assert.equal(errors.mock.calls[0]?.arguments[0], "The access wasn't changed")

// A steer that waited on a refused narrowing isn't sent either, as a steer or as the next message.
applyLiveSnapshot(snapshot("full", true))
errors.mock.resetCalls()
asked.length = 0
const refusedForSteer = switchLiveMode(conversation, "ask")
const steer = steerTo(conversation, "steer under full", [], crypto.randomUUID())
await tick()
open.shift()!.refuse("Not now.")
await refusedForSteer
assert.equal(await steer, false)
assert.deepEqual(asked, ["mode ask"])
assert.equal(errors.mock.callCount(), 1)

// 4. A wider level refused: the message goes, under the narrower level the session kept.
applyLiveSnapshot(snapshot("ask"))
errors.mock.resetCalls()
asked.length = 0
const refusedWide = switchLiveMode(conversation, "full")
const under = sendTo(conversation, "goes under ask", [], crypto.randomUUID())
await tick()
assert.deepEqual(asked, ["mode full"], "it still waits for the answer")
open.shift()!.refuse("Full access is set when a session starts.")
assert.deepEqual(await refusedWide, { kind: "refused", mode: "full", reason: "Full access is set when a session starts.", narrowing: false })
assert.equal(await under, true)
assert.deepEqual(asked, ["mode full", "prompt goes under ask"])
assert.equal(shown(), "ask")
assert.equal(errors.mock.callCount(), 0, "the change's own caller says a refusal; the message has nothing to add")

// 5. Picks made while one is on its way: one at a time, in order, the last one shown; a message waits for them all.
applyLiveSnapshot(snapshot("full"))
asked.length = 0
const first = switchLiveMode(conversation, "edits")
const second = switchLiveMode(conversation, "ask")
assert.equal(shown(), "ask", "the last pick is the one shown")
const after = sendTo(conversation, "after both", [], crypto.randomUUID())
await tick()
assert.deepEqual(asked, ["mode edits"], "the second waits for the first's answer")
open.shift()!.take()
await first
await tick()
assert.deepEqual(asked, ["mode edits", "mode ask"])
assert.equal(shown(), "ask")
open.shift()!.take()
await second
assert.equal(await after, true)
assert.deepEqual(asked, ["mode edits", "mode ask", "prompt after both"])
applyLiveSnapshot(snapshot("ask"))
assert.deepEqual(await modeSettled(conversation), { kind: "taken" }, "with nothing on its way, a message doesn't wait")

console.log("PASS: A session's access shows at once, and nothing is sent under a wider level than chosen while it changes")
process.exit(0)
