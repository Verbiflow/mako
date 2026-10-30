import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDiffFromFile } from "@pierre/diffs"
import type { TurnChanges } from "@mako/host/contracts/turn-changes"
import type { TurnFileHunks } from "@mako/host/contracts/turn-review"
import { readMessage } from "@mako/sessions/context-wire"
import { textHunks } from "@mako/host/conversations/turn-hunks"
import { commentDetails, sessionPath, fileView, hunksFromParsed, largeByRecord, largeByView, rangeLabel, readsAsEdit, reviewFiles, wordRanges, type FileView } from "../src/web-client/review-model"
import { withReviewNotes, type ReviewNote } from "../src/web-client/review-notes"

/*
 * The phone's Changes screen, without a page: a turn's files from its
 * record, a file's stretches as numbered rows, the words marked inside a
 * line, who wrote a line where another writer shares its block, which files
 * wait behind "Load diff", the comments a picked range becomes, and the
 * message they go out in.
 */

const record: TurnChanges = {
  version: 1,
  state: "settled",
  thread: "T1",
  turn: "r1",
  own: { files: 2, added: 5, removed: 2 },
  maybe: { files: 0, added: 0, removed: 0 },
  others: { files: 0, added: 0, removed: 0 },
  files: [
    { path: "/repo/src/retry.ts", root: "/repo", relative: "src/retry.ts", kind: "modify", own: { added: 3, removed: 2 }, before: "a", after: "b", entries: { first: 1, last: 2 } },
    { path: "/repo/src/clock.ts", root: "/repo", relative: "src/clock.ts", kind: "rename", from: "/repo/src/timer.ts", own: { added: 2, removed: 0 }, maybe: { added: 1, removed: 0 }, before: "c", after: "d", entries: { first: 3, last: 3 } },
  ],
  more: 0,
  journal: "j",
  through: 3,
  at: 0,
}

const text = (kinds: string, lines: string[], oldStart = 1, newStart = 1): Extract<TurnFileHunks, { kind: "text" }> => ({ kind: "text", path: "src/retry.ts", hunks: [{ oldStart, newStart, kinds, lines }], oldLines: 10, newLines: 10, limited: false, body: "journal" })

test("a turn's files are its record's, with its own counts and a rename's old path", () => {
  const files = reviewFiles(record)
  assert.deepEqual(files.map((file) => [file.path, file.kind, file.added, file.removed, file.unsure, file.from]), [
    ["src/retry.ts", "modify", 3, 2, 0, undefined],
    ["src/clock.ts", "rename", 2, 0, 1, "src/timer.ts"],
  ])
  assert.equal(largeByRecord(files[0]!), false)
  assert.equal(largeByRecord({ ...files[0]!, added: 300, removed: 101 }), true)
})

test("a comment names the file as the Session's folder does, /tmp and /private/tmp alike", () => {
  const file = { path: "src/retry.ts", absolute: "/private/tmp/run/api/src/retry.ts" }
  assert.equal(sessionPath(file, "/tmp/run/api"), "src/retry.ts")
  assert.equal(sessionPath(file, "/tmp/run"), "api/src/retry.ts")
  assert.equal(sessionPath(file, "/elsewhere"), "src/retry.ts")
  assert.equal(sessionPath(file, undefined), "src/retry.ts")
})

test("rows are numbered on each side; a new file's are all on the new side", () => {
  const view = fileView(text(" -+ ", ["a", "b", "B", "c"], 4, 4))
  assert.deepEqual(view.hunks[0]!.rows.map((row) => [row.kind, row.old, row.new]), [[" ", 4, 4], ["-", 5, null], ["+", null, 5], [" ", 6, 6]])
  assert.equal(view.digits, 1)
  const made = fileView(text("++", ["one", "two"], 0, 1))
  assert.deepEqual(made.hunks[0]!.rows.map((row) => [row.old, row.new]), [[null, 1], [null, 2]])
})

test("changed words are marked only when they read as an edit: at most 4 stretches over at most 45% of the line", () => {
  const edit = wordRanges("const delay = backoff(attempt) * 2", "const delay = backoff(attempt) * jitter()")
  assert.ok(edit)
  assert.equal(edit.added.length, 1)
  assert.equal(readsAsEdit("const delay = backoff(attempt) * jitter()", edit.added), true)
  // Rewritten: most of the line changed, so nothing is marked.
  const rewrite = wordRanges("return a + b", "throw new Error(message)")!
  assert.equal(readsAsEdit("throw new Error(message)", rewrite.added), false)
  // Five scattered changes are noise, however small.
  assert.equal(readsAsEdit("a b c d e f g h i j k l m n o p q r s t", [{ start: 0, end: 1 }, { start: 4, end: 5 }, { start: 8, end: 9 }, { start: 12, end: 13 }, { start: 16, end: 17 }]), false)
  const view = fileView(text("-+", ["  retries: 3,", "  retries: 5,"]))
  assert.deepEqual(view.hunks[0]!.rows.map((row) => row.words), [[{ start: 11, end: 12 }], [{ start: 11, end: 12 }]])
})

test("who wrote a line shows only where another writer shares its block, each stretch counted", () => {
  const hunks = { ...text(" -+  -++", ["a", "b", "B", "c", "d", "e", "E", "E2"]), writers: [
    { side: "deletions" as const, start: 2, length: 1, writer: "turn" as const },
    { side: "additions" as const, start: 2, length: 1, writer: "turn" as const },
    { side: "deletions" as const, start: 5, length: 1, writer: "turn" as const },
    { side: "additions" as const, start: 5, length: 1, writer: "turn" as const },
    { side: "additions" as const, start: 6, length: 1, writer: "person" as const },
  ] }
  const rows = fileView(hunks).hunks[0]!.rows
  // The first block is the turn's alone: nothing drawn.
  assert.deepEqual(rows.slice(0, 4).map((row) => row.writer), [undefined, undefined, undefined, undefined])
  // The second is shared: every row its writer, the turn's two lines counted on its last, the person's one on theirs.
  assert.deepEqual(rows.slice(5).map((row) => row.writer), [{ writer: "turn" }, { writer: "turn", lines: 2 }, { writer: "person", lines: 1 }])
})

test("a picked range is a comment per side it covers, as the desk's diff comments are", () => {
  const view: FileView = fileView(text(" --++ ", ["keep", "old one", "old two", "new one", "new two", "after"], 10, 10))
  const one = commentDetails({ path: "src/retry.ts", base: "the start of that turn", view, from: { hunk: 0, row: 3 }, to: { hunk: 0, row: 3 }, comment: " use jitter " })
  assert.deepEqual(one, [{ kind: "comment", path: "src/retry.ts", startLine: 11, endLine: 11, side: "new", source: "diff", base: "the start of that turn", code: "new one", comment: "use jitter" }])
  assert.equal(rangeLabel(one), "retry.ts:11")
  const both = commentDetails({ path: "src/retry.ts", base: "the start of that turn", view, from: { hunk: 0, row: 4 }, to: { hunk: 0, row: 1 }, comment: "why" })
  assert.deepEqual(both.map((detail) => [detail.side, detail.startLine, detail.endLine, detail.code]), [["old", 11, 12, "old one\nold two"], ["new", 11, 12, "new one\nnew two"]])
  assert.equal(rangeLabel(both), "retry.ts:11–12 before, retry.ts:11–12 after")
})

test("a file past 400 lines or 24k characters waits behind Load diff", () => {
  const long = fileView(text("+".repeat(401), Array.from({ length: 401 }, (_, i) => `line ${i}`)))
  assert.equal(largeByView(long), true)
  const wide = fileView(text("+", ["x".repeat(24_001)]))
  assert.equal(largeByView(wide), true)
  assert.equal(largeByView(fileView(text("-+", ["a", "b"]))), false)
})

test("comments go out in Mako's context format with the words, never alone", () => {
  assert.equal(withReviewNotes("Looks good", []), "Looks good")
  const notes: ReviewNote[] = [{ id: "n1", at: 0, detail: { kind: "comment", path: "src/retry.ts", startLine: 11, endLine: 12, side: "new", source: "diff", base: "the start of that turn", code: "new one\nnew two", comment: "Use jitter here" } }]
  const message = readMessage(withReviewNotes("Two things before merging.", notes))
  assert.match(message.body, /^Two things before merging\./)
  assert.equal(message.items.length, 1)
  assert.equal(message.items[0]!.kind, "comment")
  assert.equal(message.items[0]!.attrs["path"], "src/retry.ts")
  assert.match(message.items[0]!.body, /Use jitter here/)
  assert.match(message.items[0]!.body, /new two/)
  // With no words, the comments are the message.
  assert.equal(readMessage(withReviewNotes("", notes)).items.length, 1)
})

test("an older host's whole versions make the same changed rows the bounded read does", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  const after = before.replace("line 7\n", "line seven\n").replace("line 30\n", "line 30\nline 30b\n")
  const host = fileView({ kind: "text", path: "f.ts", ...textHunks(before, after), body: "journal" })
  const fallback = fileView(hunksFromParsed("f.ts", parseDiffFromFile({ name: "f.ts", contents: before }, { name: "f.ts", contents: after }), undefined, "journal"))
  // The diff engine keeps a line more around each change; the changes themselves, and their numbers, are the same.
  const rows = (view: FileView) => view.hunks.flatMap((hunk) => hunk.rows.filter((row) => row.kind !== " ").map((row) => `${row.kind}${row.old ?? "."}/${row.new ?? "."} ${row.text}`))
  assert.deepEqual(rows(fallback), rows(host))
})
