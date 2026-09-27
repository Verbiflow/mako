import assert from "node:assert/strict"
import { auditSnapshot, auditId } from "./performance-audit-fixtures"
import { projectLive } from "../src/state/live-projection"
import {
  reduceLiveUpdates,
  mergeLiveUpdates,
  type LiveUpdate,
} from "../electron/contracts/live-content"

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
      { kind: "user", text: "Base prompt" },
      { kind: "assistant", blocks: [{ type: "text", text: "Base reply" }] },
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
console.log(
  "Incremental projection preserves full-oracle output, history identity, tool IDs, plans, steering, base history, truncation and completion"
)
