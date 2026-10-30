import assert from "node:assert/strict"
import type { ContextInput } from "../src/lib/context-detail.ts"
import { CommentDetailSchema } from "../src/lib/context-detail.ts"

// Diff notes leave the diff as chips in the message, one per note, beside
// what is already written: `reviewContext` makes them and
// `addReviewToMessage` adds them and takes them off the diff. Nothing
// replaces the draft any more.
const target = new EventTarget()
Object.assign(globalThis, { window: target })
const added: ContextInput[] = []
// The composer on screen, as the desk's takes a chip: one about another conversation isn't its to take.
const { AddContextEvent } = await import("../src/state/composer-context.ts")
const ON_SCREEN = "conversation-on-screen"
target.addEventListener("mako:add-context", (event) => {
  if (!(event instanceof AddContextEvent) || (event.conversation !== undefined && event.conversation !== ON_SCREEN)) return
  added.push(event.detail)
  event.preventDefault()
})

const { addReviewToMessage, review, reviewContext, reviewStore } = await import("../src/state/review.ts")

const start = (path: string, line: number, side: "additions" | "deletions", body: string, base?: string, workspace = "/work/mako") => {
  review.start({ workspace, path, line, side, code: `code ${line}`, base })
  review.save(body)
}

start("src/b.ts", 12, "additions", "second file", "HEAD")
start("src/a.ts", 40, "additions", "later line", "HEAD")
start("src/a.ts", 3, "deletions", "  removed one  ", "HEAD")
start("src/a.ts", 3, "additions", "added one", "HEAD")
start("src/elsewhere.ts", 1, "additions", "another repository", undefined, "/other")
start("src/blank.ts", 1, "additions", "   ")

const comments = reviewStore.get().comments
assert.equal(comments.length, 5, "an empty note is not kept")
assert.equal(comments[0]?.base, "HEAD", "a note keeps what its diff compared against")

const chips = reviewContext(comments.filter((comment) => comment.workspace === "/work/mako"), "/work/mako")
assert.deepEqual(chips.map((chip) => chip.label), ["b.ts:12", "a.ts:3", "a.ts:3", "a.ts:40"], "grouped by file, then by line, the old side first")
for (const chip of chips) CommentDetailSchema.parse(chip.detail)
assert.deepEqual(chips[1], {
  label: "a.ts:3",
  detail: { kind: "comment", path: "src/a.ts", startLine: 3, endLine: 3, side: "old", source: "diff", base: "HEAD", code: "code 3", comment: "removed one" },
})
assert.equal(chips[2]?.detail.kind === "comment" ? chips[2].detail.side : undefined, "new")
{
  const [chip] = reviewContext(comments.filter((comment) => comment.workspace === "/other"), "/work/mako")
  assert.equal(chip?.detail.kind === "comment" ? chip.detail.path : undefined, "/other/src/elsewhere.ts", "a repository outside the workspace keeps its whole path")
}
{
  const [chip] = reviewContext([{ id: "x", workspace: "/work/mako", path: "x.ts", line: 2, side: "additions", body: "no code" }], "/work/mako")
  assert.deepEqual(chip?.detail, { kind: "comment", path: "x.ts", startLine: 2, endLine: 2, side: "new", source: "diff", code: "", comment: "no code" }, "a note without its line or base still makes a chip")
}

// One note to the message: its chip goes in, the note leaves the diff.
const one = comments.find((comment) => comment.path === "src/b.ts")
assert.ok(one)
addReviewToMessage([one], "/work/mako")
assert.deepEqual(added.map((chip) => chip.label), ["b.ts:12"])
assert.equal(reviewStore.get().comments.some((comment) => comment.id === one.id), false)

// Every note of a workspace: one chip each, in order, and none left behind.
addReviewToMessage(reviewStore.get().comments.filter((comment) => comment.workspace === "/work/mako"), "/work/mako")
assert.deepEqual(added.map((chip) => chip.label), ["b.ts:12", "a.ts:3", "a.ts:3", "a.ts:40"], "chips accumulate; nothing is replaced")
assert.deepEqual(reviewStore.get().comments.map((comment) => comment.workspace), ["/other"], "another workspace's notes stay")

// Editing keeps the base.
const other = reviewStore.get().comments[0]
assert.ok(other)
review.edit(other)
review.save("edited")
assert.equal(reviewStore.get().comments[0]?.body, "edited")
start("src/c.ts", 5, "additions", "with base", "main")
const withBase = reviewStore.get().comments.find((comment) => comment.path === "src/c.ts")
assert.ok(withBase)
review.edit(withBase)
review.save("with base, edited")
assert.equal(reviewStore.get().comments.find((comment) => comment.path === "src/c.ts")?.base, "main")

console.log("Review notes: each note becomes a chip with its side, base and line, ordered by file and line, and leaves the diff once added")

// A review of one Session's turn names that Session: its notes go only into that Session's composer, and a note no
// composer took stays on the diff.
{
  start("src/c.ts", 5, "additions", "for the open Session", "the start of that turn")
  const note = reviewStore.get().comments.find((comment) => comment.path === "src/c.ts")
  assert.ok(note)
  const before = added.length
  addReviewToMessage([note], "/work/mako", "another-conversation")
  assert.equal(added.length, before, "another conversation's composer isn't on screen")
  assert.equal(reviewStore.get().comments.some((comment) => comment.id === note.id), true, "kept, to add once it is")
  addReviewToMessage([note], "/work/mako", ON_SCREEN)
  assert.equal(added.at(-1)?.label, "c.ts:5")
  assert.equal(reviewStore.get().comments.some((comment) => comment.id === note.id), false)
}
