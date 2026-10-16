import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage } from "@mako/sessions"
import type { Entry, RecordRef } from "@mako/sessions/entries"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { copiedBaseBytes, LiveJournal } from "@mako/host/conversations/live-journal"
import { StreamMismatches, STREAM_MISMATCH_FILE } from "@mako/host/base/stream-mismatches"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveHistoryAddress } from "@mako/host/contracts/live-history"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { EntryOriginalSchema, type EntryOriginal } from "@mako/sessions/record-original"
import { projectLive } from "../src/state/live-projection.ts"

// The host shows one history of a turn once its record lands: the record's
// entries, naming the stream frames they came from, with what only the stream
// says, as its harness declares. Every reading of the base is that merge:
// the refresh, the journal read on load, and the session read back once the
// journal holds only its source. What the two disagree on beyond that is
// logged once, with both sides, by harness and version.

const harness = "codex"
const path = "/tmp/rollout-merged.jsonl"
const frames = (from: number, to: number): RecordRef => ({ file: "mako-streams:codex/rollout-merged.jsonl", ranges: [[from, to]] })
const blocks: Entry[] = [
  { type: "user", requestId: "r1", text: "Review the changes", stream: frames(0, 100) },
  { type: "event", id: "setup-1", label: "MCP server failed", detail: "docs: exited 1", setup: true, stream: frames(100, 200) },
  { type: "text", id: "m1", text: "Looking at ", stream: frames(200, 260) },
  { type: "text", id: "m1b", text: "them.", stream: frames(260, 300) },
  { type: "tool", id: "call_1", name: "Bash", status: "completed", input: "{\"command\":\"git status\"}", output: "clean", stream: frames(300, 400) },
  { type: "text", id: "m2", text: "Said live and never recorded.", stream: frames(400, 500) },
]
const record: Entry[] = [
  { type: "user", id: "u1", text: "<environment_context>…</environment_context>\n\nReview the changes", record: { ranges: [[0, 90]] } },
  { type: "text", id: "t1", text: "Looking at them.", record: { ranges: [[90, 180]] } },
  { type: "tool", id: "call_1", name: "Bash", status: "completed", input: "{\"command\":\"git status\"}", record: { ranges: [[180, 300]] } },
]
let revision = 1
const page = (): ThreadPage => ({
  ref: { harness, nativeId: "native-1", path, bytes: revision * 100 },
  entries: record, start: 0, total: record.length, hasEarlier: false, checkpoint: revision, translator: "build-1",
})

const root = mkdtempSync(join(tmpdir(), "mako-merged-history-"))
const logs = join(root, "logs")
const streams = join(root, "streams")
const mismatches = new StreamMismatches(logs, streams)
// The stream the blocks name, in lines of 100 bytes: the fifth, at 400, is what only it said.
const streamLine = (n: number, said = "") => {
  const line = (pad: string) => `${JSON.stringify({ at: "t", message: { n, said, pad } })}\n`
  return line("x".repeat(100 - line("").length))
}
mkdirSync(join(streams, harness), { recursive: true })
writeFileSync(join(streams, harness, "rollout-merged.jsonl"), [0, 1, 2, 3].map((n) => streamLine(n)).join("") + streamLine(4, "Said live and never recorded."))
const unfollow = mismatches.follow()
let reads = 0
let holds = 0
const host = (hold = false) => new LiveConversations({
  root, appPath: root, driver: () => undefined, emit: (event) => { if (event.type === "notice") console.error(event) },
  history: async (at) => { reads++; return at === path ? page() : null },
  ...hold && { holdHistory: async () => { holds++; return true } },
})
const journalled = (id: string): LiveSnapshot => ({
  session: {
    id, harness, nativeId: "native-1", cwd: root, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [],
    executionContext: {
      transport: "app-server", runtime: { kind: "reported", version: "0.48.0", via: "fixture" },
      account: { kind: "unavailable", reason: "fixture" }, identity: { kind: "unavailable", reason: "fixture" }, store: { kind: "unavailable", reason: "fixture" },
    },
  },
  revision: 0, createdAt: 1, base: null, permissions: [], requests: [], blocks,
  control: { activeBindingId: id, transfers: [], actions: [], merges: [], bindings: [{ id, provider: harness, nativeId: "native-1", path, includesBase: true, coveredBlocks: blocks.length }] },
})

const expected: Entry[] = [
  { type: "user", id: "u1", text: "Review the changes", requestId: "r1", record: { ranges: [[0, 90]] }, stream: frames(0, 100) },
  { type: "event", id: "setup-1", label: "MCP server failed", detail: "docs: exited 1", setup: true, stream: frames(100, 200) },
  { type: "text", id: "t1", text: "Looking at them.", record: { ranges: [[90, 180]] }, stream: frames(200, 300) },
  { type: "tool", id: "call_1", name: "Bash", status: "completed", input: "{\"command\":\"git status\"}", output: "clean", record: { ranges: [[180, 300]] }, stream: frames(300, 400) },
]

try {
  const id = randomUUID()
  const journal = new LiveJournal(root, id)
  journal.commit(journalled(id))
  journal.close()

  const first = host()
  const refreshed = (await first.refreshedSnapshot(id))!
  assert.equal(refreshed.baseCoveredBlocks, blocks.length)
  assert.equal(refreshed.baseLiveStart, 0)
  assert.deepEqual(refreshed.base!.entries, expected,
    "the record's entries with Mako's prompt, their frames, the call's streamed output, and the setup notice where it streamed")
  assert.equal(refreshed.base!.total, record.length, "the page keeps the record's own count")
  const shown = projectLive(refreshed).messages
  const prompts = shown.filter((message) => message.role === "user")
  assert.equal(prompts.length, 1, "one prompt")
  assert.ok(JSON.stringify(prompts[0]).includes("Review the changes") && !JSON.stringify(prompts[0]).includes("environment_context"), "as Mako showed it")
  assert.ok(!JSON.stringify(shown).includes("never recorded"), "the record stands for what it holds")

  await mismatches.flush()
  const kept = readFileSync(join(logs, STREAM_MISMATCH_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(kept.length, 1, "one finding, written whole")
  assert.equal(kept[0].conversation, id)
  assert.deepEqual([kept[0].harness, kept[0].version, kept[0].kind, kept[0].type], [harness, "0.48.0", "stream-only", "text"])
  assert.deepEqual(kept[0].stream.stream, [frames(400, 500)], "with the frames it streamed in")
  assert.equal(kept[0].stream.entries[0].text, "Said live and never recorded.")
  assert.deepEqual(kept[0].stream.originals.stream.map((part: { kind: string; text: string }) => part.kind === "range" && JSON.parse(part.text).message.said), ["Said live and never recorded."],
    "and the bytes it streamed in, read when it was found")
  assert.deepEqual(kept[0].record, { entries: [], record: [], stream: [], originals: { record: [], stream: [] } })
  assert.deepEqual(mismatches.kinds().map(({ harness, version, kind, type, count }) => [harness, version, kind, type, count]), [[harness, "0.48.0", "stream-only", "text", 1]])

  revision++
  const again = (await first.refreshedSnapshot(id))!
  assert.deepEqual(again.base!.entries, expected, "a new revision of the same record merges to the same history")
  assert.equal(mismatches.kinds()[0]!.count, 1, "blocks compared before aren't reported again")
  await first.stop()

  const reopened = host()
  assert.deepEqual(reopened.snapshot(id)!.base!.entries, expected, "the journal's reading merges as it was")
  const before = reads
  await reopened.refreshedSnapshot(id)
  assert.equal(reads - before, 1, "an unchanged record reads as unchanged after reload")
  assert.deepEqual(reopened.snapshot(id)!.base!.entries, expected)
  await reopened.stop()

  // A journal an earlier build wrote kept the record unmerged; it reads as merged.
  const old = randomUUID()
  const oldJournal = new LiveJournal(root, old)
  oldJournal.commit({ ...journalled(old), base: page(), baseCoveredBlocks: blocks.length, baseLiveStart: 0 })
  oldJournal.close()
  const older = host()
  assert.deepEqual(older.snapshot(old)!.base!.entries, expected, "an unmerged base from an earlier build reads merged")
  await older.stop()

  // Continued in another harness: its runtime wrote neither side, so the finding names no version.
  const moved = randomUUID()
  const movedJournal = new LiveJournal(root, moved)
  const movedSnapshot = journalled(moved)
  movedJournal.commit({ ...movedSnapshot, session: { ...movedSnapshot.session, harness: "cursor", executionContext: { ...movedSnapshot.session.executionContext!, transport: "cursor-sdk-child", runtime: { kind: "reported", version: "1.0.31", via: "fixture" } } } })
  movedJournal.close()
  const continued = host()
  assert.deepEqual((await continued.refreshedSnapshot(moved))!.base!.entries, expected, "the record merges with what its own harness streamed")
  assert.deepEqual(mismatches.kinds().map(({ harness, version, count }) => [harness, version, count]).sort(), [[harness, "0.48.0", 1], [harness, "unknown", 1]].sort())
  await continued.stop()

  // Held: the journal names its source and keeps no copy; reading it back merges the same way.
  const held = randomUUID()
  const heldJournal = new LiveJournal(root, held)
  heldJournal.commit(journalled(held))
  heldJournal.close()
  const holding = host(true)
  await holding.refreshedSnapshot(held)
  const deadline = Date.now() + 3_000
  while (!holding.snapshot(held)?.baseSource && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(holding.snapshot(held)?.baseSource, "held by its source")
  assert.equal(holds, 1)
  assert.equal(copiedBaseBytes(root, held), 0, "the journal keeps no copy")
  await holding.stop()
  const readBack = host(true)
  assert.equal(readBack.snapshot(held)!.base, null, "unread until its session answers")
  await readBack.refreshedSnapshot(held)
  assert.deepEqual(readBack.snapshot(held)!.base!.entries, expected, "read back from its session, merged as before")
  await readBack.stop()
  console.log("PASS: the host shows the record merged with its stream on refresh, on reload, for an earlier build's journal and read back from a held source; one undeclared difference logged once with both sides by harness and version")

  // Show original reads an entry of the window's view by its address: the record's bytes and the stream lines it names.
  const lines = [{ method: "item/agentMessage/delta", delta: "Looking at " }, { method: "item/agentMessage/delta", delta: "them." }].map((line) => `${JSON.stringify(line)}\n`)
  // The launch's file took the session's id once the harness named it.
  writeFileSync(join(streams, harness, "native-1@launch-1.jsonl"), lines.join(""))
  const recordFile = join(root, "rollout.jsonl")
  const recordLine = `${JSON.stringify({ type: "response_item", payload: { type: "message", text: "Looking at them." } })}\n`
  writeFileSync(recordFile, recordLine)
  const ref = (from: number, to: number): RecordRef => ({ file: "mako-streams:codex/launch-1.jsonl", ranges: [[from, to]] })
  const viewed: LiveSnapshot = {
    ...journalled(randomUUID()),
    base: { ref: { harness, nativeId: "native-1", path: recordFile }, start: 0, total: 1, hasEarlier: false,
      entries: [{ type: "text", id: "t1", text: "Looking at them.", record: { ranges: [[0, recordLine.length]] }, stream: ref(0, lines[0]!.length + lines[1]!.length) }] },
    blocks: [{ type: "text", text: "them.", stream: ref(lines[0]!.length, lines[0]!.length + lines[1]!.length) }],
    baseCoveredBlocks: 0,
  }
  const reader = new LiveHistoryReader(undefined, undefined, { record: async () => null, streams })
  const token = reader.capture(viewed).history!.token
  const original = async (at: LiveHistoryAddress): Promise<EntryOriginal> => {
    const chunk = await reader.read(viewed.session.id, { kind: "original", token, at }, async () => viewed)
    assert.equal(chunk.next, null)
    return EntryOriginalSchema.parse(JSON.parse(chunk.data))
  }
  const merged = await original({ kind: "base", id: "t1" })
  assert.deepEqual(merged.parts.map((part) => part.kind === "range" && part.text), [recordLine], "the record's bytes, by the view's own reference when the catalog doesn't have the entry")
  assert.deepEqual(merged.stream?.map((part) => part.kind === "range" && part.text), [lines.join("")], "and the stream lines it came from, in the file the launch's took the session's name")
  const streamedOnly = await original({ kind: "live", index: 0 })
  assert.deepEqual(streamedOnly.parts, [], "a live block has no record yet")
  assert.deepEqual(streamedOnly.stream?.map((part) => part.kind === "range" && [part.from, part.text]), [[lines[0]!.length, lines[1]]], "its own line, by its offset")
  writeFileSync(join(streams, harness, "native-1@launch-1.jsonl"), lines[0]!.slice(0, -2))
  const torn = await original({ kind: "live", index: 0 })
  assert.equal(torn.stream?.[0]?.kind, "missing", "bytes that are no longer whole lines are reported, not shown as something else")
  await assert.rejects(original({ kind: "live", index: 9 }), /unavailable/)
  console.log("PASS: an entry's original reads its record's bytes and its stream lines from the view the window holds; torn or absent lines are reported")
} finally {
  unfollow()
  rmSync(root, { recursive: true, force: true })
}
