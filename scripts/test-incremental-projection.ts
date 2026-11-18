import assert from "node:assert/strict"
import { mock } from "node:test"
import { auditSnapshot, auditId } from "./performance-audit-fixtures"
import { projectLive } from "../src/state/live-projection"
import {
  reduceLiveUpdates,
  mergeLiveUpdates,
  type LiveUpdate,
} from "@mako/sessions/live-content"

let snapshot = auditSnapshot(1000)
const oldText = snapshot.blocks[2]
assert.ok(oldText?.type === "text")
const value = oldText.text
let historicalReads = 0
Object.defineProperty(oldText, "text", {
  get() {
    historicalReads++
    return value
  },
  enumerable: true,
})
let projection = projectLive(snapshot)
const firstMessage = projection.messages[0]
const firstFiles = projection.files
snapshot = {
  ...snapshot,
  blocks: reduceLiveUpdates(snapshot.blocks, [
    { kind: "text", id: "text-999", text: " tail" },
  ]),
}
historicalReads = 0
projection = projectLive(snapshot, projection)
assert.equal(
  historicalReads,
  0,
  "A tail update must not read settled historical text"
)
assert.equal(projection.messages[0], firstMessage)
assert.equal(
  projection.files,
  firstFiles,
  "Prose must not invalidate tool-derived context"
)
assert.deepEqual(projection, projectLive(snapshot))
const edits: LiveUpdate[][] = [
  [
    {
      kind: "text",
      id: "text-999",
      text: "same-length rewrite",
      replace: true,
    },
  ],
  [{ kind: "thinking", id: "thought", text: "Think" }],
  [
    {
      kind: "tool",
      id: "fresh",
      title: "Read",
      toolKind: "read",
      status: "running",
      input: '{"path":"src/fresh.ts"}',
    },
  ],
  [
    {
      kind: "tool-update",
      id: "fresh",
      output: "content",
      status: "completed",
    },
  ],
  [{ kind: "plan", entries: [{ content: "Check", status: "pending" }] }],
  [
    { kind: "user", requestId: auditId(1001), text: "Next" },
    { kind: "text", id: "next", text: "Answer" },
  ],
  [
    {
      kind: "user",
      requestId: auditId(1002),
      steeringFor: auditId(1001),
      text: "Steer",
    },
  ],
  [{ kind: "text", id: "next", text: " continued" }],
  [
    {
      kind: "user",
      requestId: auditId(1003),
      steeringFor: auditId(1),
      text: "Historical steer",
    },
  ],
  [{ kind: "proposed-plan", id: "proposal", status: "drafting", text: "Plan" }],
  [{ kind: "provider-turn", reason: 'Background command "Sleep" completed (exit code 0)' }],
  [{ kind: "thinking", id: "provider-thought", text: "Read the output" }],
  [{ kind: "tool", id: "fresh", title: "Read", status: "running" }],
  [{ kind: "tool-update", id: "fresh", status: "completed", output: "BG-DONE" }],
  [{ kind: "text", id: "provider-answer", text: "It printed BG-DONE." }],
  [
    { kind: "user", requestId: auditId(1004), text: "After the provider turn" },
    { kind: "text", id: "after", text: "Answer" },
  ],
]
for (const updates of edits) {
  snapshot = {
    ...snapshot,
    blocks: reduceLiveUpdates(snapshot.blocks, updates),
  }
  projection = projectLive(snapshot, projection)
  assert.deepEqual(projection, projectLive(snapshot))
}
snapshot = {
  ...snapshot,
  blocks: snapshot.blocks.slice(0, 90),
  base: {
    ref: { harness: "fixture", nativeId: "base", path: "/base" },
    start: 0,
    total: 2,
    hasEarlier: false,
    entries: [
      { type: "user", id: "u1", text: "Base prompt" },
      { type: "text", id: "a1", text: "Base reply" },
    ],
  },
}
projection = projectLive(snapshot, projection)
assert.deepEqual(projection, projectLive(snapshot))
snapshot = { ...snapshot, session: { ...snapshot.session, status: "ready" } }
projection = projectLive(snapshot, projection)
assert.deepEqual(projection, projectLive(snapshot))
const sequence: LiveUpdate[] = [
  { kind: "text", id: "a", text: "before" },
  { kind: "text", id: "a", text: "replaced", replace: true },
  { kind: "text", id: "a", text: " tail" },
  { kind: "tool", id: "t", title: "Read", status: "running" },
  { kind: "tool-update", id: "t", input: "input", status: "running" },
  { kind: "tool-update", id: "t", output: "output", input: undefined },
  { kind: "tool-update", id: "t", status: "completed" },
]
const coalesced: LiveUpdate[] = []
for (const update of sequence) {
  const merged = mergeLiveUpdates(coalesced.at(-1), update)
  if (merged) coalesced[coalesced.length - 1] = merged
  else coalesced.push(update)
}
assert.deepEqual(
  reduceLiveUpdates([], coalesced),
  reduceLiveUpdates([], sequence)
)

// What a turn's start, its end and its settled changes move (a request's status, the session's) is the tail's: none of
// it reads a settled turn again, and each projection is what one made from nothing would be.
{
  let held = auditSnapshot(400)
  const reads = watchReads(held.blocks.slice(0, -3))
  let drawn = projectLive(held)
  const settled = drawn.messages.slice(0, -2)
  const turns = drawn.exchanges.slice(0, -1)
  const steps: ((snapshot: typeof held) => typeof held)[] = [
    (snapshot) => ({ ...snapshot, requests: snapshot.requests.map((request, index) => index === snapshot.requests.length - 1 ? { ...request, status: "completed" as const } : request) }),
    (snapshot) => ({ ...snapshot, session: { ...snapshot.session, status: "ready" as const } }),
    (snapshot) => ({ ...snapshot, requests: [...snapshot.requests, { id: auditId(5000), text: "Next", attachments: [], status: "dispatching" as const }],
      session: { ...snapshot.session, status: "running" as const },
      blocks: reduceLiveUpdates(snapshot.blocks, [{ kind: "user", requestId: auditId(5000), text: "Next" }, { kind: "text", id: "next-answer", text: "Answer" }]) }),
    (snapshot) => ({ ...snapshot, requests: snapshot.requests.map((request) => request.id === auditId(5000) ? { ...request, status: "completed" as const } : request),
      session: { ...snapshot.session, status: "ready" as const } }),
  ]
  for (const [index, step] of steps.entries()) {
    held = step(held)
    reads.count = 0
    const before = drawn
    drawn = projectLive(held, drawn)
    assert.equal(reads.count, 0, `Step ${index}: a change of the newest request or of the status reads no settled turn`)
    assert.ok(settled.every((message, at) => drawn.messages[at] === message), `Step ${index}: settled messages are the objects they were`)
    assert.ok(turns.every((exchange, at) => drawn.exchanges[at] === exchange), `Step ${index}: settled turns are the objects they were`)
    assert.deepEqual(drawn, projectLive(held), `Step ${index}: the tail's projection is the whole one`)
    if (index === 0) assert.equal(drawn, before, "A request's status alone draws nothing again")
  }
  assert.equal(drawn.messages.at(-1)?.streaming, undefined, "The last reply stops streaming with its turn")
  // A request that becomes the name of a prompt in the saved history changes that prompt: read whole, and still right.
  const ref = { harness: "fixture", nativeId: "base", path: "/base" }
  let based = { ...auditSnapshot(3), base: { ref, start: 0, total: 2, hasEarlier: false,
    entries: [{ type: "user" as const, id: "u1", text: "Base prompt" }, { type: "text" as const, id: "a1", text: "Base reply" }] } }
  let named = projectLive(based)
  based = { ...based, requests: based.requests.map((request, index) => index === 2 ? { ...request, status: "completed" as const } : request) }
  const quiet = watchReads(based.base.entries)
  named = projectLive(based, named)
  assert.equal(quiet.count, 0, "With a saved history, a request's status still reads none of it")
  assert.deepEqual(named, projectLive(based))
  const receipt = { attemptId: auditId(9001), bindingId: "binding" }
  based = { ...based, requests: [{ id: auditId(9000), text: "Base prompt", attachments: [], status: "completed" as const,
    nativePrompt: { provider: "fixture", nativeId: "base", path: "/base", messageId: "u1", ...receipt },
    nativeDelivery: { ...receipt, ownerEpoch: "fixture", evidence: { kind: "accepted" as const, source: "native-echo" as const, referenceId: "u1" } } }, ...based.requests] }
  named = projectLive(based, named)
  assert.equal(named.messages[0]?.requestId, auditId(9000), "A request that names a saved prompt is read into it")
  assert.deepEqual(named, projectLive(based))
}

// Read whole against what it held, a conversation whose entries are the objects they were serializes nothing to say so.
{
  const held = auditSnapshot(300)
  for (const [index, block] of held.blocks.entries())
    if (block.type === "tool" && index % 2) block.details = [{ type: "plan", entries: [{ content: `Step ${index}`, status: "pending" }] }]
  const before = projectLive(held)
  const edited = { ...held, blocks: held.blocks.map((block, index) => index === 2 && block.type === "text" ? { ...block, text: `${block.text} edited` } : block) }
  const serialized = mock.method(JSON, "stringify")
  let after: ReturnType<typeof projectLive>
  let calls: number
  try {
    after = projectLive(edited, before)
    calls = serialized.mock.callCount()
  } finally { serialized.mock.restore() }
  assert.equal(calls, 0, "Entries that are the same objects are compared by identity, never serialized")
  assert.notEqual(after.messages[1], before.messages[1], "The edited reply is new")
  assert.equal(after.messages[1]?.blocks[0], before.messages[1]?.blocks[0], "An edited reply keeps the call it didn't change")
  assert.ok(after.messages.every((message, index) => index === 1 || message === before.messages[index]), "Every other message is the object it was")
  assert.ok(after.exchanges.every((exchange, index) => index === 0 || exchange === before.exchanges[index]), "Every other turn is the object it was")
  // Entries read again (a snapshot's) are new objects saying the same: compared by what they say, and kept.
  const reread = { ...held, blocks: structuredClone(held.blocks) }
  const again = projectLive(reread, before)
  assert.ok(again.messages.every((message, index) => message === before.messages[index]), "A conversation read again keeps every message")
  assert.equal(again.exchanges.length, before.exchanges.length)
  assert.ok(again.exchanges.every((exchange, index) => exchange === before.exchanges[index]), "A conversation read again keeps every turn")
}

/** Counts every read of these entries' kind, which any conversion of them makes first. */
function watchReads(entries: readonly { type: string }[]) {
  const reads = { count: 0 }
  for (const entry of entries) {
    const type = entry.type
    Object.defineProperty(entry, "type", { get() { reads.count += 1; return type }, enumerable: true, configurable: true })
  }
  return reads
}

console.log(
  "Incremental projection preserves full-oracle output, history identity, tool IDs, plans, steering, base history, truncation and completion"
)
