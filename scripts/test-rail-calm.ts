import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repoAvatar } from "@mako/host/git/github"
import { AVATAR_HUES, avatarHue, monogram, titleTone } from "@/lib/rail-marks"
import { githubOwner } from "@/state/repo-avatars"
import { orderByHand, placeProject, placedByHand, projectOrderStore, UNPLACED } from "@/state/project-order"
import { clearPicked, pickRange, railSelectionStore, togglePicked, type PickedRow } from "@/state/rail-selection"
import { phoneLinked } from "@/state/setup-checklist"
import { failedAutomationRuns } from "@/state/automations"

/**
 * The calm rail's rules that hold without a window: avatars' hues and letters, a row's title tone, the GitHub owner a
 * project's avatar is asked by (and the host's kept picture, asked of nobody), projects in the person's order with the
 * rest as worked in, rows picked by ⌘ and ⇧, a phone among the account's browsers, and failed automations in the Inbox.
 */

// Avatars: one hue a seed, the same every time, spread over all eight; a letter or digit of the name.
assert.equal(avatarHue("/Users/you/api"), avatarHue("/Users/you/api"))
const hues = new Set(Array.from({ length: 64 }, (_, index) => avatarHue(`/Users/you/project-${index}`)))
assert.equal(hues.size, AVATAR_HUES, "64 projects take every hue")
assert.deepEqual(["api", "@scope/x", "9lives", "", "élan"].map(monogram), ["A", "S", "9", "?", "É"])

// A title's tone: lit, then what needs the person or waits to be read, then Done faded, then quiet.
assert.equal(titleTone(true, { kind: "needs-permission", since: 0 }), "font-medium text-foreground")
assert.equal(titleTone(false, { kind: "needs-permission", since: 0 }), "text-foreground")
assert.equal(titleTone(false, { kind: "review", at: 1, unread: true }), "text-foreground")
assert.equal(titleTone(false, { kind: "idle" }, { unread: true }), "text-foreground", "Mark as unread reads as news")
assert.equal(titleTone(false, { kind: "idle" }, { work: "done" }), "text-foreground/45")
assert.equal(titleTone(false, { kind: "idle" }, { work: "in-review" }), "text-foreground/72")

// Only a GitHub login leaves the Mac, and only the owner of `owner/name`.
assert.equal(githubOwner("acme/api"), "acme")
assert.equal(githubOwner("a-b/c"), "a-b")
for (const bad of [null, undefined, "", "-acme/x", "acme-/x", "ac--me/x", "../etc/x", "a".repeat(40) + "/x", "ac me/x"]) assert.equal(githubOwner(bad), undefined, String(bad))
const avatars = mkdtempSync(join(tmpdir(), "mako-rail-avatars-"))
try {
  mkdirSync(avatars, { recursive: true })
  writeFileSync(join(avatars, "acme.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.equal(await repoAvatar("acme/api", avatars), "data:image/png;base64,iVBORw==", "a kept picture is read from disk, asked of nobody")
  assert.equal(await repoAvatar("../../etc/passwd", avatars), undefined, "a name that isn't a login is never fetched")
  assert.equal(await repoAvatar("", avatars), undefined)
} finally {
  rmSync(avatars, { recursive: true, force: true })
}

// Projects: each one the person dragged holds the place it was dropped at; the rest fill the other places as worked in.
const folders = ["a", "b", "c", "d"].map((key) => ({ key }))
const keys = (list: readonly { key: string }[]) => list.map((folder) => folder.key)
assert.deepEqual(keys(orderByHand(folders, [])), ["a", "b", "c", "d"])
// A list from before places were kept one project at a time reads as it always did: its projects first, in its order.
assert.deepEqual(keys(orderByHand(folders, ["c", "gone", "a"])), ["c", "a", "b", "d"])
assert.deepEqual([...placedByHand(["c", "gone", "a"])], [], "and names no project the person placed themselves")
projectOrderStore.set({ order: ["a", "b", "c", "d", "gone"] })
assert.deepEqual(placeProject("d", "b", ["a", "b", "c", "d"]), [UNPLACED, "d", UNPLACED], "dropped before b: d holds the second place, and no other project is placed, though the list before placed them all")
assert.deepEqual(keys(orderByHand(folders, projectOrderStore.get().order)), ["a", "d", "b", "c"], "the list reads as it was left")
assert.deepEqual(keys(orderByHand(["c", "b", "a", "d"].map((key) => ({ key })), projectOrderStore.get().order)), ["c", "d", "b", "a"], "and the projects never dragged go on ordering as they are worked in, around it")
assert.deepEqual(placeProject("a", null, ["a", "d", "b", "c"]), ["d", UNPLACED, UNPLACED, "a", UNPLACED], "dropped last: d keeps the place it now shows at, and a takes the fourth")
assert.deepEqual([...placedByHand(projectOrderStore.get().order)].sort(), ["a", "d"])
assert.deepEqual(keys(orderByHand(["c", "b", "a", "d"].map((key) => ({ key })), projectOrderStore.get().order)), ["d", "c", "b", "a"])
assert.deepEqual(keys(orderByHand(["c", "b", "a", "d", "e", "f"].map((key) => ({ key })), projectOrderStore.get().order)), ["d", "c", "b", "a", "e", "f"], "a project worked in for the first time takes a place nobody chose")
// One placed earlier and not shown now keeps a place after the ones shown; a place with no project left to fill it is passed over.
assert.deepEqual(placeProject("c", "d", ["d", "c"]), ["c", "d", "a", UNPLACED])
assert.deepEqual(keys(orderByHand(folders, ["c", "d", "a", UNPLACED])), ["c", "d", "a", "b"])
assert.deepEqual(keys(orderByHand(folders, [UNPLACED, "gone", "c", "c", UNPLACED, UNPLACED, UNPLACED, UNPLACED, "b"])), ["a", "c", "d", "b"], "a project that's gone or named twice takes no place")
projectOrderStore.set({ order: [] })
assert.deepEqual(placeProject("b", "a", ["a", "b"]), ["b", UNPLACED], "the first drag")
projectOrderStore.set({ order: Array.from({ length: 400 }, (_, index) => (index === 399 ? UNPLACED : `p-${index}`)) })
const full = placeProject("new", "p-0", ["p-0"])
assert.deepEqual([full.length, full[0], full.at(-1)], [400, "new", UNPLACED], "never more than the preference holds, and still told from a list from before")
projectOrderStore.set({ order: [] })

// Rows picked: ⌘ toggles one, ⇧ picks from the last picked through the clicked, in the rail's order.
const rows: PickedRow[] = ["r1", "r2", "r3", "r4", "r5"].map((key) => ({ key, thread: `t-${key}`, target: { kind: "live", id: key } }))
togglePicked(rows[1]!)
pickRange(rows[3]!, rows)
assert.deepEqual(railSelectionStore.get().picked.map((row) => row.key), ["r2", "r3", "r4"])
togglePicked(rows[2]!)
assert.deepEqual(railSelectionStore.get().picked.map((row) => row.key), ["r2", "r4"])
pickRange(rows[0]!, rows)
assert.deepEqual(railSelectionStore.get().picked.map((row) => row.key).sort(), ["r1", "r2", "r3", "r4"], "a range up from the last picked")
assert.equal(railSelectionStore.get().picked.at(-1)?.key, "r1", "the row clicked anchors the next range")
clearPicked()
pickRange(rows[2]!, rows)
assert.deepEqual(railSelectionStore.get().picked.map((row) => row.key), ["r3"], "⇧ with nothing picked picks the one")
clearPicked()

// Get Mako on your phone: a browser session on a phone or a tablet.
assert.equal(phoneLinked(undefined), false)
assert.equal(phoneLinked([{ os: "macOS" }, { os: null }]), false)
assert.equal(phoneLinked([{ os: "macOS" }, { os: "iOS" }]), true)
assert.equal(phoneLinked([{ os: "Android" }]), true)

// Failed automations count in the Inbox from when Automations was last opened.
const state = { projects: [{ automations: [{ lastRun: { status: "failed" as const, at: 50 } }, { lastRun: { status: "failed-to-start" as const, at: 150 } }, { lastRun: { status: "failed" as const, at: 20, endedAt: 250 } }, {}] }] }
assert.equal(failedAutomationRuns(state, 0), 3)
assert.equal(failedAutomationRuns(state, 100), 2, "what failed before Automations was opened is read")
assert.equal(failedAutomationRuns(state, 200), 1, "a run counts from when it ended")
assert.equal(failedAutomationRuns(state, 300), 0)
console.log("Calm rail checks clean: avatars, title tones, GitHub owners, project order, picking rows, phones, failed automations")
