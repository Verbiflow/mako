/**
 * How the host delivers a batch: whatever a harness sends, a receiver
 * holding the same blocks reaches the host's result from the delivered
 * updates, a call's growing input or output travels as its new end, and
 * storage appends it too.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  MAX_STREAMED_TOOL_OUTPUT,
  deliverLiveUpdates,
  liveUpdateWeight,
  mergeLiveUpdates,
  reduceLiveUpdates,
  type LiveBlock,
  type LiveUpdate,
} from "@mako/sessions/live-content"
import { changesSession, requestsAfter, requestsDelta, sessionAfter, sessionDelta, sharedSession, type LiveRequest } from "../electron/contracts/live-conversations"
import { LiveJournal } from "../electron/live-journal"
import { auditSnapshot } from "./performance-audit-fixtures"

const opened: LiveBlock[] = reduceLiveUpdates([], [
  { kind: "user", text: "Run the suite" },
  { kind: "tool", id: "call", title: "Run tests", status: "in_progress", input: "", output: "" },
])

/** Updates as the host sends them, batch by batch, with what each batch costs to send. */
function stream(batches: LiveUpdate[][], from = opened) {
  let host = from
  let receiver = from
  let sent = 0
  for (const batch of batches) {
    const delivery = deliverLiveUpdates(host, batch)
    host = delivery.blocks
    receiver = reduceLiveUpdates(receiver, delivery.updates)
    assert.deepEqual(receiver, host, "A receiver reaches the host's blocks from what was delivered")
    sent += delivery.updates.reduce((sum, update) => sum + JSON.stringify(update).length, 0)
  }
  return { blocks: host, sent }
}

function tool(blocks: LiveBlock[]): Extract<LiveBlock, { type: "tool" }> {
  const block = blocks.find((candidate) => candidate.type === "tool")
  assert.ok(block?.type === "tool")
  return block
}

const chunk = "x".repeat(255) + "\n"
const chunks = Array.from({ length: 64 }, (_, index) => `${index}`.padStart(4, "0") + chunk)
const total = chunks.join("")

// Every way a harness reports a growing call reaches the same block for about what was new.
const reports = {
  "native output deltas (Codex, Cursor)": chunks.map((text) => [{ kind: "tool-update", id: "call", outputAppend: text }]),
  "whole output sent again (ACP, OpenCode)": chunks.map((_, index) => [{
    kind: "tool-update", id: "call", status: "in_progress", title: "Run tests",
    output: chunks.slice(0, index + 1).join(""),
  }]),
  "native input deltas (Claude)": chunks.map((text) => [{ kind: "tool-update", id: "call", inputAppend: text }]),
  "whole input sent again": chunks.map((_, index) => [{ kind: "tool-update", id: "call", input: chunks.slice(0, index + 1).join("") }]),
} satisfies Record<string, LiveUpdate[][]>
for (const [report, batches] of Object.entries(reports)) {
  const { blocks, sent } = stream(batches)
  const field = report.includes("input") ? tool(blocks).input : tool(blocks).output
  assert.equal(field, total, report)
  assert.ok(sent < total.length * 1.25, `${report}: ${sent} characters sent for ${total.length} new`)
}

// A field sent again unchanged does not travel.
{
  const delivery = deliverLiveUpdates(reduceLiveUpdates(opened, [{ kind: "tool-update", id: "call", input: "{\"a\":1}", output: "done" }]), [
    { kind: "tool-update", id: "call", input: "{\"a\":1}", output: "done", status: "completed" },
  ])
  assert.deepEqual(delivery.updates, [{ kind: "tool-update", id: "call", status: "completed" }])
}

// Output that no longer continues the block's is sent whole.
{
  const before = reduceLiveUpdates(opened, [{ kind: "tool-update", id: "call", output: "first attempt" }])
  const delivery = deliverLiveUpdates(before, [{ kind: "tool-update", id: "call", output: "second attempt" }])
  assert.deepEqual(delivery.updates, [{ kind: "tool-update", id: "call", output: "second attempt" }])
  assert.equal(delivery.grown.size, 0)
}

// Streamed output keeps its newest end; a whole value is kept as sent, so one past the limit travels whole.
{
  const long = "y".repeat(MAX_STREAMED_TOOL_OUTPUT)
  const streamed = stream([[{ kind: "tool-update", id: "call", outputAppend: long }], [{ kind: "tool-update", id: "call", outputAppend: "end" }]])
  assert.equal(tool(streamed.blocks).output, long.slice(3) + "end")
  const whole = deliverLiveUpdates(opened, [{ kind: "tool-update", id: "call", output: long + "end" }])
  assert.equal(tool(whole.blocks).output, long + "end")
  assert.equal(whole.updates[0]?.kind === "tool-update" && whole.updates[0].output, long + "end")
}

// Merging two updates is applying them in turn, for every mix of whole values and appends.
{
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
  const fields = (): Partial<Extract<LiveUpdate, { kind: "tool-update" }>> => {
    const value = () => pick(["a", "bc", "", "z".repeat(MAX_STREAMED_TOOL_OUTPUT - 1), "w".repeat(MAX_STREAMED_TOOL_OUTPUT + 5)])
    const out: Partial<Extract<LiveUpdate, { kind: "tool-update" }>> = {}
    if (random() < 0.4) out.input = value()
    if (random() < 0.4) out.inputAppend = value()
    if (random() < 0.4) out.output = value()
    if (random() < 0.5) out.outputAppend = value()
    if (random() < 0.2) out.status = pick(["in_progress", "completed"])
    return out
  }
  for (let round = 0; round < 2_000; round++) {
    const first: LiveUpdate = { kind: "tool-update", id: "call", ...fields() }
    const second: LiveUpdate = { kind: "tool-update", id: "call", ...fields() }
    const merged = mergeLiveUpdates(first, second)
    assert.ok(merged)
    const start = reduceLiveUpdates(opened, [{ kind: "tool-update", id: "call", ...fields() }])
    assert.deepEqual(reduceLiveUpdates(start, [merged]), reduceLiveUpdates(start, [first, second]), `round ${round}`)
    const delivered = deliverLiveUpdates(start, [first, second])
    assert.deepEqual(reduceLiveUpdates(start, delivered.updates), delivered.blocks, `round ${round} delivered`)
    assert.deepEqual(delivered.blocks, reduceLiveUpdates(start, [first, second]), `round ${round} reduced`)
  }
}

// The weight follows what an update carries without serializing it.
{
  const text: LiveUpdate = { kind: "text", text: "a".repeat(10_000) }
  assert.ok(Math.abs(liveUpdateWeight(text) - JSON.stringify(text).length) < 64)
  const call: LiveUpdate = { kind: "tool-update", id: "call", outputAppend: "b".repeat(20_000), details: [{ type: "diff", path: "/a", oldText: "c".repeat(500), newText: "d".repeat(500) }] }
  assert.ok(Math.abs(liveUpdateWeight(call) - JSON.stringify(call).length) < 128)
}

// A batch carries the requests that changed; the receiver rebuilds the rest in order.
{
  const [first, second, third] = auditSnapshot(3).requests
  assert.ok(first && second && third)
  const running = { ...second, status: "dispatching" as const }
  const cases: [LiveRequest[], LiveRequest[]][] = [
    [[first, second], [first, running]],
    [[first, second], [first, running, third]],
    [[first], [first, second, third]],
    [[first, second, third], [first, third]],
    [[first, second], [second, first]],
    [[], [first]],
  ]
  for (const [previous, next] of cases) {
    const delta = requestsDelta(previous, next)
    assert.deepEqual(requestsAfter(previous, delta), next)
    if (delta.requestChanges) assert.ok(!delta.requestChanges.includes(first) || !previous.includes(first), "an unchanged request stays home")
  }
  assert.deepEqual(requestsDelta([first, second], [first, running]), { requestChanges: [running] })
  const same = [first]
  assert.deepEqual(requestsDelta(same, same), {})
  assert.equal(requestsAfter(same, {}), undefined)
}

// A session travels as the fields that changed: a harness's commands and models go once.
{
  const commands = Array.from({ length: 300 }, (_, index) => ({ name: `skill-${index}`, description: "x".repeat(200) }))
  const held = { ...auditSnapshot(1).session, status: "ready" as const, commands, nativeRunId: undefined, error: "earlier" }
  // SAFETY: a JSON round trip of a session keeps its shape and drops only undefined fields, as a report from a child process does.
  const reported = JSON.parse(JSON.stringify({ ...held, status: "running", nativeRunId: "run-1", error: undefined })) as typeof held
  const shared = sharedSession(held, reported)
  assert.equal(shared.commands, held.commands, "Commands reported again, equal in content, keep their identity")
  const delta = sessionDelta(held, shared)
  assert.deepEqual(delta, { sessionChanges: { status: "running", nativeRunId: "run-1" }, sessionCleared: ["error"] })
  // SAFETY: the delta is JSON by construction; the round trip is the web host's transport.
  const received = JSON.parse(JSON.stringify(delta)) as typeof delta
  assert.deepEqual(sessionAfter(held, received), JSON.parse(JSON.stringify(shared)), "The receiver rebuilds the session the host holds")
  assert.ok(changesSession(received) && !changesSession({}))
  assert.equal(sessionAfter(held, {}), held)
  assert.deepEqual(sessionDelta(held, held), {})
  const renamed = sharedSession(held, { ...reported, commands: commands.slice(1) })
  assert.notEqual(renamed.commands, held.commands, "A changed list travels")
}

// Storage appends what a call gained and reopens to the same blocks.
const stored = (blocks: LiveBlock[]): LiveBlock[] => JSON.parse(JSON.stringify(blocks))
const root = await mkdtemp(join(tmpdir(), "mako-live-delivery-"))
try {
  let snapshot = { ...auditSnapshot(1), blocks: opened }
  const written = snapshot.revision
  let journal = new LiveJournal(root, snapshot.session.id)
  journal.commit(snapshot)
  for (const batch of [...reports["native output deltas (Codex, Cursor)"], ...reports["native input deltas (Claude)"].slice(0, 8)]) {
    const delivery = deliverLiveUpdates(snapshot.blocks, batch)
    const previous = snapshot
    snapshot = { ...snapshot, revision: snapshot.revision + 1, blocks: delivery.blocks }
    journal.commit(snapshot, previous, delivery.grown)
  }
  const raw = new DatabaseSync(join(root, `${snapshot.session.id}.sqlite`), { readOnly: true })
  try {
    const row = raw.prepare("SELECT count(*) AS count, sum(length(value)) AS bytes FROM block_appends").get()
    assert.ok(row && Number(row.count) > 0 && Number(row.bytes) < total.length * 1.5,
      "A growing call stores its new end, not its whole output again")
    const metadata = raw.prepare("SELECT value FROM metadata WHERE id=1").get()
    assert.equal(JSON.parse(String(metadata?.value)).revision, written, "A streamed flush leaves the session's metadata row as it was written")
  } finally {
    raw.close()
  }
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.blocks, stored(snapshot.blocks), "Appended calls reopen as they were")
  assert.equal(journal.read()?.revision, snapshot.revision, "and at the last flush's revision")
  assert.equal(journal.summary()?.revision, snapshot.revision)
  const settled = { ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, status: "ready" as const } }
  journal.commit(settled, snapshot)
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.blocks, stored(snapshot.blocks), "A settled turn folds appends into whole blocks")
  journal.close()
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("Live delivery: every harness's growing calls travel and persist as their new end, and receivers match the host")
