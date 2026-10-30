import assert from "node:assert/strict"
import { test } from "node:test"
import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs"
import type { GitDiff } from "@mako/host/contracts/git-workspace-search"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import type { TurnChanges } from "@mako/host/contracts/turn-changes"
import type { TurnFileHunks, TurnFileWriters } from "@mako/host/contracts/turn-review"
import { readMessage } from "@mako/sessions/context-wire"
import { textHunks } from "@mako/host/conversations/turn-hunks"
import { changedRequests, commentDetails, hunksDiff, hunksWriters, sessionPath, fileView, hunksFromParsed, largeByRecord, largeByView, rangeLabel, readsAsEdit, reviewFiles, wordRanges, type FileView } from "../src/web-client/review-model"
import { addReviewNotes, reviewNotes, sendWithReviewNotes, withReviewNotes, type ReviewNote } from "../src/web-client/review-notes"
import { evictions, HunksReader, hunksKeyOf, type DeviceStore, type HunksKey, type HunksSource } from "../src/web-client/review-data"

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

test("a laptop's desk draws the bounded read with the desktop's own review: the stretches as a patch it parses, the writers beside", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  const after = before.replace("line 7\n", "line seven\n").replace("line 30\n", "line 30\nline 30b\n")
  const writers = [{ side: "additions" as const, start: 7, length: 1, writer: "person" as const }]
  const read: TurnFileHunks = { kind: "text", path: "src/f.ts", ...textHunks(before, after), writers, body: "journal" }
  const diff = hunksDiff(read)
  assert.equal(diff.preview?.kind, "patch")
  // Parsed as the desk parses a shortened patch, it is the same stretches the phone draws.
  const parsed = getSingularPatch(diff.preview?.kind === "patch" ? diff.preview.contents : "")
  assert.equal(parsed.name, "src/f.ts")
  assert.deepEqual(hunksFromParsed("src/f.ts", parsed, undefined, "journal").hunks, read.hunks)
  assert.deepEqual(hunksWriters(read), { path: "src/f.ts", runs: writers, body: "journal" } satisfies TurnFileWriters)
  assert.equal(hunksWriters({ ...read, writers: undefined }), null)
  // A new file and a rename keep what they are; a cut file says it was shortened.
  const created = hunksDiff({ kind: "text", path: "n.ts", ...textHunks(null, "a\nb\n"), body: "journal" })
  assert.equal(getSingularPatch(created.preview?.kind === "patch" ? created.preview.contents : "").type, "new")
  const renamed = hunksDiff({ ...read, from: "src/old.ts", limited: true })
  assert.equal(getSingularPatch(renamed.preview?.kind === "patch" ? renamed.preview.contents : "").prevName, "src/old.ts")
  assert.equal(renamed.preview?.kind === "patch" && renamed.preview.limited, true)
  // A binary file and one that couldn't be read come through as the desk reads them.
  assert.deepEqual(hunksDiff({ kind: "binary", path: "a.png", before: null, after: 2048 }), { path: "a.png", binary: true, oldFile: null, newFile: null, before: null, after: { bytes: 2048 } } satisfies GitDiff)
  assert.deepEqual(hunksDiff({ kind: "unavailable", path: "x", reason: "Too large" }).preview, { kind: "unavailable", reason: "Too large" })
})

test("the turns to review are those that changed something, or kept both checkpoints from before the record", () => {
  const request = (id: string, fields: Partial<LiveRequest>): LiveRequest => ({ id, text: id, attachments: [], status: "completed", ...fields })
  const none = { ...record, own: { files: 0, added: 0, removed: 0 }, files: [] }
  const unsure = { ...record, own: { files: 0, added: 0, removed: 0 }, maybe: { files: 1, added: 2, removed: 0 }, files: [{ ...record.files[0]!, own: undefined, maybe: { added: 2, removed: 0 } }] }
  const ready = { kind: "ready" as const, snapshot: { id: "00000000-0000-4000-8000-000000000001", scope: "/repo", createdAt: 0, files: 1 } }
  const picked = changedRequests([
    request("counted", { changes: record }),
    request("nothing", { changes: none }),
    request("unsure", { changes: unsure }),
    request("pending", { changes: { version: 1, state: "pending" } }),
    request("old", { snapshots: { before: ready, after: ready } }),
    request("old-half", { snapshots: { before: ready } }),
  ])
  assert.deepEqual(picked.map((each) => each.id), ["counted", "unsure", "old"])
})

/** A Session's owner for the reader: each read answered when the test says, every call counted. */
function owner(options: { older?: boolean } = {}) {
  const asked: string[] = []
  const waiting = new Map<string, () => void>()
  const answer = (path: string): TurnFileHunks => text(" +", ["a", path])
  const source: HunksSource = {
    hunks: async (key) => {
      asked.push(`hunks ${key.path}`)
      if (options.older) throw new Error("This host has no such call")
      await new Promise<void>((resolve) => waiting.set(key.path, resolve))
      return answer(key.path)
    },
    diff: async (key) => {
      asked.push(`diff ${key.path}`)
      return { path: key.path, binary: false, oldFile: { name: key.path, contents: "a\n" }, newFile: { name: key.path, contents: `a\n${key.path}\n` } }
    },
    writers: async (key) => {
      asked.push(`writers ${key.path}`)
      return null
    },
  }
  const stored = new Map<string, TurnFileHunks>()
  const device: DeviceStore = {
    get: async (key) => stored.get(key),
    put: async (key, value) => void stored.set(key, value),
  }
  return { asked, waiting, stored, device, source, finish: (path: string) => waiting.get(path)?.() }
}

const keyFor = (path: string, fields: Partial<HunksKey> = {}): HunksKey => ({ conversation: "c1", requestId: "r1", path, journal: "j1", through: 3, settled: true, ...fields })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("the reader asks four at a time, nearest the screen first, each file once, and holds what it read", async () => {
  const mac = owner()
  const reader = new HunksReader(mac.source, mac.device)
  const reads = ["a", "b", "c", "d", "e", "f"].map((path, index) => reader.read(keyFor(path), index))
  // The same file asked again, nearer the screen, is the same read, moved up the queue.
  const again = reader.read(keyFor("f"), -1)
  await tick()
  assert.deepEqual(mac.asked, ["hunks a", "hunks b", "hunks c", "hunks d"])
  mac.finish("a")
  await tick()
  await tick()
  assert.equal(mac.asked[4], "hunks f", "the file moved nearer the screen goes next")
  for (const path of ["b", "c", "d", "e", "f"]) {
    mac.finish(path)
    await tick()
    await tick()
  }
  await Promise.all([...reads, again])
  assert.equal(mac.asked.length, 6)
  // Held for this page: asked again, nothing is read.
  assert.ok(reader.held(keyFor("a")))
  await reader.read(keyFor("a"))
  assert.equal(mac.asked.length, 6)
})

test("a settled record's read is kept on the device and paints from there next time; a settling one is read again once it settles", async () => {
  const mac = owner()
  const first = new HunksReader(mac.source, mac.device)
  const settling = first.read(keyFor("a", { settled: false }))
  await tick()
  mac.finish("a")
  await settling
  assert.equal(mac.stored.size, 0, "nothing kept while the record may still move")
  assert.equal(await first.kept(keyFor("a", { settled: false })), undefined)
  // Settled: its writers may have moved, so it's read again, and kept.
  const settled = first.read(keyFor("a"))
  await tick()
  mac.finish("a")
  await settled
  assert.deepEqual([...mac.stored.keys()], [hunksKeyOf(keyFor("a"))])
  // The next visit's page paints from the device without asking the owner.
  const next = new HunksReader(mac.source, mac.device)
  const asked = mac.asked.length
  assert.deepEqual(await next.read(keyFor("a")), text(" +", ["a", "a"]))
  assert.equal(mac.asked.length, asked)
  // Another journal, or a recount, is another record: read again.
  assert.notEqual(hunksKeyOf(keyFor("a", { journal: "j2" })), hunksKeyOf(keyFor("a")))
  assert.notEqual(hunksKeyOf(keyFor("a", { through: 4 })), hunksKeyOf(keyFor("a")))
})

test("an older Mac without the bounded read is asked the older way, once found, and gives the same stretches", async () => {
  const mac = owner({ older: true })
  const reader = new HunksReader(mac.source, mac.device)
  const first = await reader.read(keyFor("a"))
  const second = await reader.read(keyFor("b"))
  assert.deepEqual(mac.asked, ["hunks a", "diff a", "writers a", "diff b", "writers b"])
  assert.equal(first.kind, "text")
  assert.deepEqual(first.kind === "text" && first.hunks.map((hunk) => hunk.kinds), [" +"])
  assert.equal(second.kind === "text" && second.hunks[0]!.lines.at(-1), "b")
  // Any other refusal is the read's own failure, not an older Mac.
  const failing = new HunksReader({ ...mac.source, hunks: async () => Promise.reject(new Error("Not connected")) }, mac.device)
  await assert.rejects(failing.read(keyFor("c", { conversation: "c2" })), /Not connected/)
})

test("the device's budget lets go of the least recently opened first, never the one just written", () => {
  const sizes = new Map([
    ["old-but-opened", { chars: 40, at: 50 }],
    ["written-first", { chars: 40, at: 10 }],
    ["middle", { chars: 40, at: 20 }],
    ["new", { chars: 40, at: 60 }],
  ])
  assert.deepEqual(evictions(sizes, "new", 200), [])
  assert.deepEqual(evictions(sizes, "new", 120), ["written-first", "middle"])
  assert.deepEqual(evictions(new Map([["new", { chars: 500, at: 1 }]]), "new", 100), [])
})

test("comments leave the draft only with the message that carried them: kept on a refusal or a failure, sent once", async () => {
  const detail = commentDetails({ path: "src/retry.ts", base: "the start of that turn", view: fileView(text(" -+", ["one", "two", "new two"])), from: { hunk: 0, row: 2 }, to: { hunk: 0, row: 2 }, comment: "Use jitter here" })
  addReviewNotes("c-send", detail)
  const sent: string[] = []
  // Refused: nothing goes, the comment waits.
  assert.equal(await sendWithReviewNotes("c-send", "First try", async (message) => (sent.push(message), false)), false)
  assert.equal(reviewNotes("c-send").length, 1)
  // Failed on its way (Finish review's start of a new Session, say): kept as well.
  await assert.rejects(sendWithReviewNotes("c-send", "Second try", async () => Promise.reject(new Error("offline"))))
  assert.equal(reviewNotes("c-send").length, 1)
  // Taken: the message carries the comment, and the draft lets go of it; one written meanwhile waits for the next.
  assert.equal(await sendWithReviewNotes("c-send", "Third try", async (message) => {
    sent.push(message)
    addReviewNotes("c-send", detail)
    return true
  }), true)
  assert.equal(readMessage(sent.at(-1)!).items.length, 1)
  assert.match(readMessage(sent.at(-1)!).body, /^Third try/)
  assert.equal(reviewNotes("c-send").length, 1, "the comment written while it was on its way")
  // Finish review with no words: the comments are the message.
  assert.equal(await sendWithReviewNotes("c-send", "", async (message) => (sent.push(message), true)), true)
  assert.equal(readMessage(sent.at(-1)!).items.length, 1)
  assert.equal(reviewNotes("c-send").length, 0)
})
