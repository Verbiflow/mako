import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LiveJournal } from "../electron/live-journal"
import { reduceLiveUpdates } from "../electron/contracts/live-content"
import { auditSnapshot } from "./performance-audit-fixtures"

const root = await mkdtemp(join(tmpdir(), "mako-journal-deltas-"))
let snapshot = auditSnapshot(2, "fixture", 524288, 0)
let journal = new LiveJournal(root, snapshot.session.id)
try {
  journal.commit(snapshot)
  for (const text of [
    " next",
    "\ud835",
    "\udc9c",
    ...Array.from({ length: 24 }, () => " tail"),
  ]) {
    const previous = snapshot
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      blocks: reduceLiveUpdates(snapshot.blocks, [
        { kind: "text", id: "text-1", text },
      ]),
    }
    journal.commit(snapshot, previous)
  }
  const raw = new DatabaseSync(join(root, `${snapshot.session.id}.sqlite`), {
    readOnly: true,
  })
  try {
    const row = raw
      .prepare(
        "SELECT count(*) AS count, sum(length(value)) AS bytes FROM block_appends"
      )
      .get()
    assert.ok(
      row && Number(row.count) > 0 && Number(row.bytes) < 4096,
      "Growing text must persist small deltas instead of repeated half-megabyte prefixes"
    )
  } finally {
    raw.close()
  }
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
  const usage = { used: 40_000, size: 200_000, tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1 }, cost: { amount: 0.5, currency: "USD" } }
  const metered = { ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, usage } }
  journal.commit(metered, snapshot)
  snapshot = metered
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.session.usage, { used: 40_000, size: 200_000 }, "A restart reopens the conversation as full as it was, without the ended process's spend")
  const writer = new DatabaseSync(join(root, `${snapshot.session.id}.sqlite`))
  const rejected = {
    ...snapshot,
    revision: snapshot.revision + 1,
    blocks: reduceLiveUpdates(snapshot.blocks, [
      { kind: "text", id: "text-1", text: " retry" },
    ]),
  }
  try {
    writer.exec(
      "CREATE TRIGGER reject_append BEFORE INSERT ON block_appends BEGIN SELECT RAISE(ABORT, 'fixture append refusal'); END"
    )
    assert.throws(
      () => journal.commit(rejected, snapshot),
      /fixture append refusal/
    )
    assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
    writer.exec("DROP TRIGGER reject_append")
    journal.commit(rejected, snapshot)
    snapshot = rejected
    for (let index = 0; index < 140; index++) {
      const previous = snapshot
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        blocks: reduceLiveUpdates(snapshot.blocks, [
          { kind: "text", id: "text-1", text: " more" },
        ]),
      }
      journal.commit(snapshot, previous)
    }
    assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
    const row = writer
      .prepare("SELECT count(*) AS count FROM block_appends")
      .get()
    assert.ok(
      row && Number(row.count) <= 128,
      "Append replay remains bounded by compaction"
    )
  } finally {
    writer.close()
  }
  const before = snapshot
  snapshot = {
    ...snapshot,
    blocks: reduceLiveUpdates(snapshot.blocks, [
      { kind: "text", id: "text-1", text: "rewritten", replace: true },
    ]),
  }
  journal.commit(snapshot, before)
  assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
  const shorter = {
    ...snapshot,
    blocks: snapshot.blocks.slice(0, 2),
    session: { ...snapshot.session, status: "ready" as const },
  }
  journal.commit(shorter, snapshot)
  assert.deepEqual(journal.read()?.blocks, shorter.blocks)
  console.log(
    "Journal deltas: bounded prefix writes, reopen, split Unicode, authoritative replacement, and truncation preserve exact content"
  )
} finally {
  journal.close()
  await rm(root, { recursive: true, force: true })
}
