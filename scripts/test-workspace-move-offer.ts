import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { mock } from "node:test"
import type { WorkspaceMoveHold, WorkspaceMoveTarget } from "@mako/host/contracts/workspace-moves"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

// The composer's offer to move the Thread onto its own branch says, before
// it's chosen, which Sessions come along and what still holds the move, and
// asks the host again as that changes.
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { moveOffer, watchMoveHold } = await import("../src/state/thread-workspace")
installMockBridge()

const place = { changed: 0 }
const helper = { id: auditId(2), title: "Helper" }
const docs = { id: auditId(3), title: "Docs" }

// What it says.
assert.deepEqual(moveOffer("ready", { companions: [] }, place), { detail: "Moves the thread to a worktree on a new branch", disabled: false }, "a Thread with one Session here moves alone")
assert.equal(moveOffer("ready", { companions: [helper] }, place).detail, "Moves the thread to a worktree on a new branch. “Helper” comes along")
assert.equal(moveOffer("ready", { companions: [helper, docs] }, { changed: 1 }).detail, "Moves the thread to a worktree on a new branch. Its 2 other sessions here and the 1 changed file come along")
assert.equal(moveOffer("ready", { companions: [{ id: auditId(4) }] }, { changed: 0 }).detail, "Moves the thread to a worktree on a new branch. Its other session here comes along", "an untitled Session isn't named")
assert.equal(moveOffer("ready", { companions: [] }, { changed: 3 }).detail, "Moves the thread to a worktree on a new branch. The 3 changed files come along")
assert.equal(moveOffer("ready", { companions: [helper] }, { threadBranch: "mako/thread", changed: 3 }).detail, "Joins this thread's branch, mako/thread, with “Helper”. Nothing in the project folder moves")
assert.equal(moveOffer("ready", undefined, { changed: 2 }).detail, "Moves the thread to a worktree on a new branch. Its sessions here and the 2 changed files come along", "before the host has said, it speaks of the Thread's sessions in general")
assert.deepEqual(
  moveOffer("ready", { companions: [helper], held: "“Helper” is running a turn" }, place),
  { detail: "“Helper” is running a turn. Move once that's done", disabled: true },
  "a companion mid-turn holds the move, named",
)
assert.equal(moveOffer("ready", { companions: [helper], held: "this session has background tasks running; “Helper” is running a turn" }, place).detail, "This session has background tasks running; “Helper” is running a turn. Move once they're done")
assert.deepEqual(moveOffer("ready", { companions: [], moving: true }, place), { detail: "Mako is moving this thread onto its own branch now", disabled: true })
assert.deepEqual(moveOffer("running", { companions: [], held: "this session is running a turn" }, place), { detail: "After this answer finishes", disabled: true }, "the Session on screen says its own state first")
assert.equal(moveOffer("unsupported", { companions: [helper] }, place).disabled, true)

// When it asks.
const lead = auditSnapshot(1, "claude")
lead.session.id = auditId(1)
applyLiveSnapshot(lead)
acpStore.set({ ...acpStore.get(), activeKey: lead.session.id })
const asked: WorkspaceMoveTarget[] = []
let answers: (WorkspaceMoveHold | Error | Promise<WorkspaceMoveHold>)[] = []
mock.method(getMako(), "workspaceMoveHold", async (target: WorkspaceMoveTarget) => {
  asked.push(target)
  const next = answers.shift() ?? { companions: [helper] }
  if (next instanceof Error) throw next
  return next
})
const told: (WorkspaceMoveHold | undefined)[] = []
const until = async (check: () => boolean, what: string, ms = 3_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await delay(20)
  }
}

answers = [{ companions: [helper], held: "“Helper” is running a turn" }, { companions: [helper], held: "“Helper” is running a turn" }, { companions: [helper] }]
const stop = watchMoveHold({ thread: "thread", cwd: "/project" }, (hold) => told.push(hold))
await until(() => told.length === 1, "the first answer")
assert.deepEqual(asked[0], { thread: "thread", cwd: "/project", conversation: lead.session.id }, "it asks about the live Session on screen")
assert.equal(told[0]?.held, "“Helper” is running a turn")
await delay(500)
assert.equal(asked.length, 1, "a held move isn't asked about again at once")
await until(() => told.length === 3, "asked each second while held", 3_000)
assert.equal(told[2]?.held, undefined, "and hears when it's free")
await delay(1_300)
assert.equal(asked.length, 3, "a free move isn't asked about again on a timer")

// A conversation starting or ending a turn asks again, once for a burst of changes.
const other = auditSnapshot(1, "codex")
other.session.id = auditId(5)
other.session.status = "running"
applyLiveSnapshot(other)
applyLiveSnapshot({ ...other, session: { ...other.session, status: "ready" } })
await until(() => asked.length === 4, "a turn's change asked about")
await delay(400)
assert.equal(asked.length, 4, "a burst of changes asks once")

// A slow answer that a newer question overtook isn't told.
let release: (hold: WorkspaceMoveHold) => void = () => {}
answers = [new Promise<WorkspaceMoveHold>((resolve) => { release = resolve }), { companions: [docs] }]
applyLiveSnapshot({ ...other, session: { ...other.session, status: "running" } })
await until(() => asked.length === 5, "the slow question")
applyLiveSnapshot({ ...other, session: { ...other.session, status: "ready" } })
await until(() => told.at(-1)?.companions[0]?.id === docs.id, "the newer answer")
release({ companions: [], held: "stale" })
await delay(50)
assert.equal(told.at(-1)?.companions[0]?.id, docs.id, "the overtaken answer is dropped")

// A host that can't say leaves the offer as it was before it asked.
answers = [new Error("No handler for mako:workspace-move-hold")]
applyLiveSnapshot({ ...other, session: { ...other.session, status: "running" } })
await until(() => told.length > 0 && told.at(-1) === undefined, "an older host's refusal")

stop()
const after = asked.length
applyLiveSnapshot({ ...other, session: { ...other.session, status: "ready" } })
await delay(400)
assert.equal(asked.length, after, "a closed menu asks nothing")
console.log("Workspace move offer: the composer names the Sessions that come along and what holds the move, asking again as turns start and end, each second while held, and not once closed")
