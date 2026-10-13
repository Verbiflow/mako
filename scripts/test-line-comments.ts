import assert from "node:assert/strict"
import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs"
import { CommentDetailSchema, type CommentDetail } from "../src/lib/context-detail.ts"
import {
  commentInput,
  commentLabel,
  diffCommentDetails,
  fileCommentDetail,
  splitLines,
  workspacePath,
} from "../src/lib/line-comments.ts"

// Picked lines become the `CommentDetail` a chip carries: the file viewer's
// lines (source "file", always the new side) and a diff's (source "diff",
// either side, with what it compares against). Every detail made here must
// also pass the contract's own schema.
const valid = (detail: CommentDetail | null): CommentDetail => {
  assert.ok(detail, "a detail was made")
  return CommentDetailSchema.parse(detail)
}

// ---- Files -----------------------------------------------------------------

const source = "import { a } from \"a\"\n\nexport function f() {\n  return a\n}\n"

assert.deepEqual(
  valid(fileCommentDetail({ path: "src/f.ts", contents: source, range: { start: 3, end: 5 }, comment: "  rename f  " })),
  { kind: "comment", path: "src/f.ts", startLine: 3, endLine: 5, side: "new", source: "file", code: "export function f() {\n  return a\n}", comment: "rename f" },
  "a range of a file is its lines, without numbers, the comment trimmed"
)
assert.deepEqual(
  valid(fileCommentDetail({ path: "src/f.ts", contents: source, range: { start: 4, end: 4 } })),
  { kind: "comment", path: "src/f.ts", startLine: 4, endLine: 4, side: "new", source: "file", code: "  return a", comment: "" },
  "one line, no comment"
)
assert.deepEqual(
  fileCommentDetail({ path: "src/f.ts", contents: source, range: { start: 5, end: 3 } }),
  fileCommentDetail({ path: "src/f.ts", contents: source, range: { start: 3, end: 5 } }),
  "a selection dragged upward is the same lines"
)
assert.equal(
  valid(fileCommentDetail({ path: "w.ts", contents: "one\r\ntwo\r\nthree\r\n", range: { start: 1, end: 2 } })).code,
  "one\ntwo",
  "CRLF endings never reach the code"
)
assert.equal(valid(fileCommentDetail({ path: "w.ts", contents: "last line without ending", range: { start: 1, end: 1 } })).code, "last line without ending")
assert.equal(valid(fileCommentDetail({ path: "w.ts", contents: "a\nb\n", range: { start: 2, end: 9 } })).endLine, 2, "a range past the end stops at the last line")
assert.equal(fileCommentDetail({ path: "w.ts", contents: "a\nb\n", range: { start: 3, end: 4 } }), null, "a range wholly past the end is nothing")
assert.deepEqual(splitLines("a\r\nb\nc"), ["a", "b", "c"])
assert.deepEqual(splitLines(""), [])

// ---- Labels and paths ---------------------------------------------------------

assert.equal(commentLabel({ path: "src/state/review.ts", startLine: 200, endLine: 208 }), "review.ts:200–208")
assert.equal(commentLabel({ path: "src/state/review.ts", startLine: 200, endLine: 200 }), "review.ts:200")
assert.equal(commentLabel({ path: "Makefile", startLine: 1, endLine: 2 }), "Makefile:1–2")
assert.equal(workspacePath("/work/mako/src/a.ts", "/work/mako"), "src/a.ts")
assert.equal(workspacePath("/work/mako/src/a.ts", "/work/mako/"), "src/a.ts")
assert.equal(workspacePath("/elsewhere/a.ts", "/work/mako"), "/elsewhere/a.ts", "a file outside the workspace keeps its whole path")
assert.equal(workspacePath("/work/makomono/a.ts", "/work/mako"), "/work/makomono/a.ts", "a sibling folder sharing a prefix is outside")
assert.equal(workspacePath("src/a.ts", undefined), "src/a.ts")
{
  const detail = valid(fileCommentDetail({ path: "src/state/review.ts", contents: "x\n".repeat(300), range: { start: 200, end: 208 }, comment: "why" }))
  assert.deepEqual(commentInput(detail), { detail, label: "review.ts:200–208" }, "the chip carries the comment in its detail only")
}

// ---- Diffs read from both files ---------------------------------------------------

const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n"
const after = "one\ntwo\nTHREE\nthree and a half\nfour\nfive\nsix\nseven\neight\nnine\n"
const full = parseDiffFromFile({ name: "n.ts", contents: before }, { name: "n.ts", contents: after })
const diffDetail = (range: Parameters<typeof diffCommentDetails>[0]["range"], extra: { base?: string; comment?: string } = {}) =>
  diffCommentDetails({ path: "src/n.ts", diff: full, range, ...extra }).map(valid)

assert.deepEqual(
  diffDetail({ start: 3, end: 4, side: "additions", endSide: "additions" }, { base: "HEAD", comment: "say why" }),
  [{ kind: "comment", path: "src/n.ts", startLine: 3, endLine: 4, side: "new", source: "diff", base: "HEAD", code: "THREE\nthree and a half", comment: "say why" }],
  "added lines are the new side, with the base they are compared against"
)
assert.deepEqual(
  diffDetail({ start: 3, end: 3, side: "deletions" }),
  [{ kind: "comment", path: "src/n.ts", startLine: 3, endLine: 3, side: "old", source: "diff", code: "three", comment: "" }],
  "a removed line is the old side, numbered in the old file; no base, no field"
)
assert.deepEqual(
  diffDetail({ start: 8, end: 6, side: "additions", endSide: "additions" }),
  diffDetail({ start: 6, end: 8, side: "additions", endSide: "additions" }),
  "a diff selection dragged upward is the same lines"
)
assert.equal(diffDetail({ start: 7, end: 9, side: "additions" })[0]?.code, "six\nseven\neight", "context lines read from the new file")
{
  const long = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
  const edited = long.map((text, index) => (index === 1 || index === 27 ? text.toUpperCase() : text))
  const far = parseDiffFromFile({ name: "l.ts", contents: `${long.join("\n")}\n` }, { name: "l.ts", contents: `${edited.join("\n")}\n` })
  assert.ok(far.hunks.length === 2 && far.hunks[1]!.additionStart > 15, "two hunks with unchanged lines between them")
  const [between] = diffCommentDetails({ path: "l.ts", diff: far, range: { start: 12, end: 14, side: "additions" } }).map(valid)
  assert.equal(between?.code, "line 12\nline 13\nline 14", "unchanged lines the view expands between hunks are read from the whole file")
  const across = diffCommentDetails({ path: "l.ts", diff: far, range: { start: 2, end: 28, side: "deletions", endSide: "additions" } }).map(valid)
  assert.deepEqual(
    across.map(({ side, startLine, endLine }) => [side, startLine, endLine]),
    [["old", 2, 28], ["new", 2, 28]],
    "a cross-side selection spanning both hunks covers both removed lines and every new line between"
  )
}
assert.equal(diffDetail({ start: 1, end: 1, side: "deletions" })[0]?.code, "one", "an unchanged line picked on the old side reads the old file")
assert.deepEqual(
  diffDetail({ start: 3, end: 4, side: "deletions", endSide: "additions" }).map(({ side, startLine, endLine, code }) => ({ side, startLine, endLine, code })),
  [
    { side: "old", startLine: 3, endLine: 3, code: "three" },
    { side: "new", startLine: 3, endLine: 4, code: "THREE\nthree and a half" },
  ],
  "a selection from a removed line to an added one is the lines of each file it covers"
)
assert.deepEqual(
  diffDetail({ start: 4, end: 3, side: "additions", endSide: "deletions" }).map(({ side, startLine, endLine }) => ({ side, startLine, endLine })),
  [
    { side: "old", startLine: 3, endLine: 3 },
    { side: "new", startLine: 3, endLine: 4 },
  ],
  "and so is the same selection made upward"
)

// ---- CRLF diffs --------------------------------------------------------------

{
  const crlf = parseDiffFromFile({ name: "w.ts", contents: "a\r\nb\r\nc\r\n" }, { name: "w.ts", contents: "a\r\nB\r\nc\r\nd\r\n" })
  const [added] = diffCommentDetails({ path: "w.ts", diff: crlf, range: { start: 2, end: 4, side: "additions" } }).map(valid)
  assert.equal(added?.code, "B\nc\nd", "CRLF endings never reach a diff's code either")
  const [removed] = diffCommentDetails({ path: "w.ts", diff: crlf, range: { start: 2, end: 2, side: "deletions" } }).map(valid)
  assert.equal(removed?.code, "b")
}

// ---- Diffs read from a patch --------------------------------------------------

{
  const patch = getSingularPatch("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+newer\n ctx2\n")
  assert.equal(patch.isPartial, true)
  const [lines] = diffCommentDetails({ path: "x.ts", base: "abc1234^", diff: patch, range: { start: 10, end: 12, side: "additions" } }).map(valid)
  assert.deepEqual(
    lines,
    { kind: "comment", path: "x.ts", startLine: 10, endLine: 12, side: "new", source: "diff", base: "abc1234^", code: "ctx\nnew\nnewer", comment: "" },
    "a patch's lines are numbered from its hunk header"
  )
  const [wider] = diffCommentDetails({ path: "x.ts", diff: patch, range: { start: 8, end: 11, side: "additions" } }).map(valid)
  assert.equal(wider?.code, "ctx\nnew", "lines the patch does not hold are left out of the code, not invented")
  assert.equal(wider?.startLine, 8, "but the range still says where the selection began")
  const [removed] = diffCommentDetails({ path: "x.ts", diff: patch, range: { start: 11, end: 11, side: "deletions" } }).map(valid)
  assert.equal(removed?.code, "old")
}

// ---- A new file and a deleted one ---------------------------------------------

{
  const created = parseDiffFromFile(null, { name: "new.ts", contents: "x\ny\n" })
  assert.deepEqual(diffCommentDetails({ path: "new.ts", diff: created, range: { start: 1, end: 2, side: "additions" } }).map((detail) => valid(detail).code), ["x\ny"])
  const removed = parseDiffFromFile({ name: "gone.ts", contents: "x\ny\n" }, null)
  assert.deepEqual(diffCommentDetails({ path: "gone.ts", diff: removed, range: { start: 2, end: 2, side: "deletions" } }).map((detail) => valid(detail).code), ["y"])
}

console.log("Line comments: file and diff ranges map to comment details, both sources and sides, single lines, reversed and cross-side selections, CRLF, patches")
