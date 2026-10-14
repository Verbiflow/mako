import assert from "node:assert/strict"
import { mock } from "node:test"
import { toast } from "sonner"
import type { MoveOutcome } from "@mako/host/contracts/workspace-moves"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

// What each window says when a Thread moves onto its own branch on the host:
// the window showing a Session that moved follows it, and the window showing
// the Session it followed names those that came along.
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { moveReviews, moveReviewsStore, workspaceMoved } = await import("../src/state/workspace-moves")
installMockBridge()

const lead = auditId(1)
const helper = auditId(2)
const other = auditId(3)
const fork = auditId(4)
type Shown = ReturnType<typeof toast.getHistory>[number]
const text = (item: Shown | undefined) => item && "title" in item ? { title: item.title, description: item.description } : undefined
const shown = (id: string) => text(toast.getToasts().find((item) => item.id === id))
const latest = () => text(toast.getHistory().at(-1))
const onScreen = (id: string) => acpStore.set({ ...acpStore.get(), activeKey: id })
mock.method(getMako(), "liveSnapshot", async (id: string) => {
  const snapshot = auditSnapshot(1, "claude")
  snapshot.session.id = id
  return snapshot
})

onScreen(lead)
await workspaceMoved({ type: "workspace-moved", from: helper, to: helper, changed: 0, told: true, branch: "mako/thread", lead, title: "Helper" })
assert.equal(shown(`moved-with:${lead}`)?.title, "“Helper” came along too", "the person's window names the Session that followed")
assert.equal(shown(`moved-with:${lead}`)?.description, "This Thread's other Session here is on mako/thread as well.")
await workspaceMoved({ type: "workspace-moved", from: other, to: fork, changed: 0, told: false, branch: "mako/thread", lead, title: "Elsewhere" })
assert.equal(shown(`moved-with:${lead}`)?.title, "2 more Sessions came along", "and counts them in the same notice as more follow")
assert.equal(shown(`moved-with:${lead}`)?.description, "“Helper”, “Elsewhere”")
assert.equal(acpStore.get().activeKey, lead, "the window stays on the Session it moved")

onScreen(other)
const before = toast.getHistory().length
await workspaceMoved({ type: "workspace-moved", from: other, to: fork, changed: 0, told: false, branch: "mako/thread", lead, title: "Elsewhere" })
assert.equal(acpStore.get().activeKey, fork, "a window showing a Session that forked follows it onto the branch")
assert.equal(toast.getHistory().length, before + 1)
assert.equal(latest()?.title, "Now on its own branch, mako/thread")
assert.equal(latest()?.description, "It moved with the rest of its Thread.", "it doesn't claim the agent carries on, since it was moved quietly")

onScreen(lead)
await workspaceMoved({ type: "workspace-moved", from: lead, to: lead, changed: 2, told: true, branch: "mako/thread" })
assert.equal(latest()?.description, "2 changed files came along; the project folder is clean again. The agent carries on there.", "the agent that asked carries on there")

await workspaceMoved({ type: "workspace-moved", from: lead, to: lead, changed: 0, branch: "mako/thread" })
assert.equal(latest()?.description, "The agent carries on there.", "an older host's event, without `told`, reads as before")

onScreen(auditId(9))
const quiet = toast.getHistory().length
await workspaceMoved({ type: "workspace-moved", from: helper, to: helper, changed: 0, told: false, lead, title: "Helper" })
assert.equal(toast.getHistory().length, quiet, "a window showing something else says nothing")

// A move that took files on a best guess, or left some Mako couldn't place: a card waits above the composer.
const share = (paths: string[], lines = 0) => ({ files: paths.length, lines, paths })
const outcome: MoveOutcome = {
  came: share(["gen.ts", "lib/a.ts", "bg.ts"], 12),
  likely: share(["bg.ts", "gen.ts"]),
  stayed: { others: share([]), person: share([]), uncertain: share(["maybe.ts"]), unattributed: share([]), kept: 0 },
  split: [],
  brought: false,
  unstaged: [],
}
onScreen(lead)
await workspaceMoved({ type: "workspace-moved", from: lead, to: lead, changed: 3, told: true, branch: "mako/thread", outcome })
assert.equal(latest()?.description, "Its changes in 3 files came along, 2 on a best guess. Stayed in the project folder: 1 file that might be its. The agent carries on there.")
assert.equal(moveReviewsStore.get().reviews[lead]?.outcome, outcome, "the card shows what the move did")
const offScreen = auditId(10)
await workspaceMoved({ type: "workspace-moved", from: offScreen, to: offScreen, changed: 3, told: true, branch: "mako/other", outcome })
assert.ok(moveReviewsStore.get().reviews[offScreen], "a move off screen leaves its card for when the conversation is opened")
moveReviews.dismiss(offScreen)
assert.equal(moveReviewsStore.get().reviews[offScreen], undefined)

// Put back one: the card lists it as back, and keeps the other.
const afterPutBack: MoveOutcome = { ...outcome, came: share(["lib/a.ts", "bg.ts"], 10), likely: share(["bg.ts"]), returned: ["gen.ts"] }
mock.method(getMako(), "putBackMovedFiles", async (_id: string, paths: string[]) => ({ outcome: paths.includes("gen.ts") ? afterPutBack : outcome, left: paths.includes("bg.ts") ? ["bg.ts"] : [] }))
const toasts = toast.getHistory().length
await moveReviews.putBack(lead, ["gen.ts"])
assert.deepEqual(moveReviewsStore.get().reviews[lead]?.returned, ["gen.ts"])
assert.equal(moveReviewsStore.get().reviews[lead]?.outcome, afterPutBack)
assert.equal(moveReviewsStore.get().reviews[lead]?.busy, null)
assert.equal(toast.getHistory().length, toasts, "the card says it went back; no toast on top")
await moveReviews.putBack(lead, ["bg.ts"])
assert.equal(latest()?.title, "Some files stayed in the worktree", "a file changed since the move stays, and says so")
assert.equal(latest()?.description, "bg.ts changed since the move, so it stayed as it is.")

// Bring what stayed, with nothing left on a best guess and nothing put back: the card has done its work.
mock.method(getMako(), "bringStayedChanges", async () => ({ outcome: { ...outcome, likely: undefined, brought: true, stayed: { ...outcome.stayed, uncertain: share([]) } }, left: [] }))
const elsewhere = auditId(11)
moveReviews.open(elsewhere, "mako/x", { ...outcome, likely: undefined })
await moveReviews.bring(elsewhere)
assert.equal(moveReviewsStore.get().reviews[elsewhere], undefined)
assert.equal(latest()?.title, "The rest came along", "the card closes, so a toast says it worked")
assert.equal(latest()?.description, "They're in the worktree now. The agent hears on its next turn.")
console.log("Workspace moved UI: a window follows its Session onto the branch, and the lead's window names the Sessions that came along; a move's best guesses wait on a card, file by file")
